import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';

const execFileAsync = promisify(execFile);

const SSO_REGION = process.env.AWS_SSO_REGION || 'us-east-1';

/** Read the real SSO start URL from existing AWS config (default profile), with env var override. */
async function getSsoStartUrl(): Promise<string> {
  if (process.env.AWS_SSO_START_URL) return process.env.AWS_SSO_START_URL;
  try {
    const configPath = path.join(os.homedir(), '.aws', 'config');
    const content = await fs.readFile(configPath, 'utf-8');
    // Find sso_start_url from the [default] profile or any profile
    const match = content.match(/sso_start_url\s*=\s*(https:\/\/\S+)/);
    if (match) return match[1];
  } catch { /* ignore */ }
  throw new Error('No AWS SSO start URL found. Set AWS_SSO_START_URL or configure a profile with sso_start_url in ~/.aws/config');
}

// Cached after first resolution
let _ssoStartUrl: string | null = null;
async function ssoStartUrl(): Promise<string> {
  if (!_ssoStartUrl) _ssoStartUrl = await getSsoStartUrl();
  return _ssoStartUrl;
}

export interface RdsInstanceConfig {
  provisionedIops: number;
  storageType: string;
  allocatedStorageGb: number;
  instanceClass: string;
  engine: string;
  engineVersion: string;
}

/**
 * Get the SSO access token from the cached SSO session.
 */
export async function getSsoAccessToken(): Promise<string | null> {
  const cacheDir = path.join(os.homedir(), '.aws', 'sso', 'cache');
  try {
    const files = await fs.readdir(cacheDir);
    // Find the most recent file with an accessToken
    let bestToken: string | null = null;
    let bestTime = 0;
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(cacheDir, file);
      const stat = await fs.stat(filePath);
      if (stat.mtimeMs <= bestTime) continue;
      try {
        const data = JSON.parse(await fs.readFile(filePath, 'utf-8'));
        if (data.accessToken && data.expiresAt) {
          const expires = new Date(data.expiresAt).getTime();
          if (expires > Date.now()) {
            bestToken = data.accessToken;
            bestTime = stat.mtimeMs;
          }
        }
      } catch { /* skip corrupt files */ }
    }
    return bestToken;
  } catch {
    return null;
  }
}

/**
 * Find an SSO role that can read RDS config for the given account.
 * Prefers DBALimited > DeveloperAccessReadOnly > any role with ReadOnly/DBA in name.
 */
async function findSsoRole(accountId: string, accessToken: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('aws', [
      'sso', 'list-account-roles',
      '--account-id', accountId,
      '--access-token', accessToken,
      '--region', SSO_REGION,
      '--output', 'json',
    ], { timeout: 10_000 });

    const data = JSON.parse(stdout);
    const roles: string[] = (data.roleList || []).map((r: any) => r.roleName);

    // Priority order
    const preferred = ['DBALimited', 'DeveloperAccessReadOnly'];
    for (const pref of preferred) {
      if (roles.includes(pref)) return pref;
    }
    // Fallback: anything with ReadOnly or DBA
    const fallback = roles.find(r => /readonly|dba/i.test(r));
    return fallback || roles[0] || null;
  } catch {
    return null;
  }
}

/**
 * Ensure an AWS CLI profile exists for the given account/role combo.
 * Creates it in ~/.aws/config if missing.
 */
async function ensureProfile(accountId: string, region: string, roleName: string): Promise<string> {
  const profileName = `rds-iop-${accountId}`;
  const configPath = path.join(os.homedir(), '.aws', 'config');

  let existing = '';
  try {
    existing = await fs.readFile(configPath, 'utf-8');
  } catch { /* file doesn't exist yet */ }

  const startUrl = await ssoStartUrl();
  const profileHeader = `[profile ${profileName}]`;
  if (!existing.includes(profileHeader)) {
    const block = `\n${profileHeader}\nsso_start_url = ${startUrl}\nsso_region = ${SSO_REGION}\nsso_account_id = ${accountId}\nsso_role_name = ${roleName}\nregion = ${region}\n`;
    await fs.appendFile(configPath, block);
  }

  return profileName;
}

/**
 * Resolve an AWS CLI profile name for the given account, creating it if needed.
 */
export async function getAwsProfile(accountId: string, region: string): Promise<string> {
  const accessToken = await getSsoAccessToken();
  if (!accessToken) {
    throw new Error('No valid AWS SSO session. Run "aws sso login" first.');
  }
  const roleName = await findSsoRole(accountId, accessToken);
  if (!roleName) {
    throw new Error(`No SSO roles available for account ${accountId}`);
  }
  return ensureProfile(accountId, region, roleName);
}

/**
 * Fetch RDS instance config (provisioned IOPS, storage type, etc.)
 * using AWS CLI with SSO credentials.
 */
export async function getRdsInstanceConfig(
  accountId: string,
  region: string,
  instanceId: string,
): Promise<RdsInstanceConfig | null> {
  const profileName = await getAwsProfile(accountId, region);

  // Call describe-db-instances
  const { stdout } = await execFileAsync('aws', [
    'rds', 'describe-db-instances',
    '--db-instance-identifier', instanceId,
    '--region', region,
    '--profile', profileName,
    '--query', 'DBInstances[0].{Iops:Iops,StorageType:StorageType,AllocatedStorage:AllocatedStorage,DBInstanceClass:DBInstanceClass,Engine:Engine,EngineVersion:EngineVersion}',
    '--output', 'json',
  ], { timeout: 15_000 });

  const data = JSON.parse(stdout);
  if (!data) return null;

  return {
    provisionedIops: data.Iops || 0,
    storageType: data.StorageType || '',
    allocatedStorageGb: data.AllocatedStorage || 0,
    instanceClass: data.DBInstanceClass || '',
    engine: data.Engine || '',
    engineVersion: data.EngineVersion || '',
  };
}
