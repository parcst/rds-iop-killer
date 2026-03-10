import { execFile, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { TeleportTunnel, TeleportInstance, TeleportStatus } from '../types.js';

const execFileAsync = promisify(execFile);

const TELEPORT_CONNECT_TSH =
  '/Applications/Teleport Connect.app/Contents/MacOS/tsh.app/Contents/MacOS/tsh';
const TSH_DIR = path.join(os.homedir(), '.tsh');
const TUNNEL_READY_TIMEOUT = 15_000; // 15 seconds

// ===== Tunnel Registry =====
const activeTunnels = new Map<string, TeleportTunnel>();

export function registerTunnel(tunnel: TeleportTunnel): void {
  activeTunnels.set(tunnel.dbName, tunnel);
}

export function unregisterTunnel(dbName: string): void {
  activeTunnels.delete(dbName);
}

export function getActiveTunnel(dbName: string): TeleportTunnel | undefined {
  return activeTunnels.get(dbName);
}

/**
 * Kill all registered tunnels and run `tsh db logout` for each.
 * Idempotent — safe to call multiple times.
 */
export async function cleanupAll(): Promise<void> {
  if (activeTunnels.size === 0) return;

  const entries = Array.from(activeTunnels.entries());
  activeTunnels.clear();

  let tsh: string | null = null;
  try {
    tsh = await findTsh();
  } catch { /* ignore — we'll still kill processes */ }

  for (const [dbName, tunnel] of entries) {
    try {
      tunnel.process.kill('SIGTERM');
    } catch { /* ignore */ }

    if (tsh) {
      try {
        await execFileAsync(tsh, ['db', 'logout', dbName], { timeout: 5_000 });
      } catch { /* ignore */ }
    }
  }

  console.log(`[cleanup] Cleaned up ${entries.length} tunnel(s)`);
}

/**
 * Locate the tsh binary. Checks PATH first, then Teleport Connect app bundle.
 */
export async function findTsh(override?: string): Promise<string> {
  if (override) {
    try {
      await fs.access(override, fs.constants.X_OK);
      return override;
    } catch {
      throw new Error(`Configured tsh path not found: ${override}`);
    }
  }

  // Check PATH via `which`
  try {
    const { stdout } = await execFileAsync('which', ['tsh']);
    const tshPath = stdout.trim();
    if (tshPath) return tshPath;
  } catch {
    // not in PATH
  }

  // Check Teleport Connect app bundle
  try {
    await fs.access(TELEPORT_CONNECT_TSH, fs.constants.X_OK);
    return TELEPORT_CONNECT_TSH;
  } catch {
    // not installed
  }

  throw new Error('Could not find tsh binary. Install Teleport or set tsh_path.');
}

/**
 * Return cluster names from ~/.tsh/*.yaml profile files.
 */
export async function getClusters(): Promise<string[]> {
  try {
    const files = await fs.readdir(TSH_DIR);
    return files
      .filter(f => f.endsWith('.yaml'))
      .map(f => f.replace(/\.yaml$/, ''))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Check login status for a specific cluster.
 * Parses `tsh status --format=json` and checks both active and profiles for cluster match.
 * Never throws on exit code 1 (tsh returns 1 even when logged in).
 */
export async function getLoginStatus(tsh: string, cluster?: string): Promise<TeleportStatus> {
  try {
    const { stdout } = await execFileAsync(tsh, ['status', '--format=json'], {
      timeout: 10_000,
    }).catch(err => {
      // tsh status returns exit code 1 even when logged in — use stdout anyway
      if (err.stdout) return { stdout: err.stdout as string };
      throw err;
    });

    if (!stdout.trim()) {
      return { loggedIn: false, username: '' };
    }

    const status = JSON.parse(stdout);

    // Check active profile first
    const active = status?.active ?? {};
    if (!cluster || active.cluster === cluster) {
      if (active.username) {
        return { loggedIn: true, username: active.username, cluster: active.cluster };
      }
    }

    // Check inactive profiles
    const profiles: any[] = status?.profiles ?? [];
    for (const profile of profiles) {
      if (profile.cluster === cluster && profile.username) {
        return { loggedIn: true, username: profile.username, cluster: profile.cluster };
      }
    }

    // If no cluster specified, return whatever active gives us
    if (!cluster && active.username) {
      return { loggedIn: true, username: active.username, cluster: active.cluster };
    }

    return { loggedIn: false, username: '' };
  } catch {
    return { loggedIn: false, username: '' };
  }
}

/**
 * Start SSO login for a cluster. Opens browser. Returns the child process.
 */
export function loginToCluster(tsh: string, cluster: string): ChildProcess {
  return spawn(tsh, ['login', cluster], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * List MySQL database instances on a cluster via `tsh db ls`.
 */
export async function listMysqlInstances(tsh: string, cluster: string): Promise<TeleportInstance[]> {
  const { stdout } = await execFileAsync(
    tsh,
    ['db', 'ls', `--proxy=${cluster}`, '--format=json'],
    { timeout: 30_000 },
  );

  let raw = JSON.parse(stdout);
  if (!Array.isArray(raw)) raw = [raw];

  const instances: TeleportInstance[] = [];
  for (const entry of raw) {
    const spec = entry?.spec ?? {};
    if (spec.protocol !== 'mysql') continue;

    const aws = spec.aws ?? {};
    const rds = aws.rds ?? {};
    instances.push({
      name: entry?.metadata?.name ?? '',
      uri: spec.uri ?? '',
      accountId: aws.account_id ?? '',
      region: aws.region ?? '',
      instanceId: rds.instance_id ?? '',
    });
  }

  return instances;
}

/**
 * Start a local tunnel to a Teleport database.
 * 3-step: tsh db login -> tsh proxy db --tunnel --port 0 -> parse port from stdout.
 */
export async function startTunnel(
  tsh: string,
  dbName: string,
  dbUser: string,
  cluster?: string,
): Promise<TeleportTunnel> {
  const clusterArgs = cluster ? [`--proxy=${cluster}`] : [];

  // Step 1: Authenticate to the database
  await execFileAsync(
    tsh,
    ['db', 'login', dbName, `--db-user=${dbUser}`, ...clusterArgs],
    { timeout: 30_000 },
  );

  // Step 2: Start tunnel with random port
  const proc = spawn(
    tsh,
    ['proxy', 'db', '--tunnel', '--port', '0', dbName, ...clusterArgs],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  // Step 3: Parse port from stdout
  const port = await waitForTunnelPort(proc);

  return {
    process: proc,
    host: '127.0.0.1',
    port,
    dbName,
    dbUser,
  };
}

/**
 * Read process stdout until we find the listening port or timeout.
 */
function waitForTunnelPort(proc: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    const pattern = /127\.0\.0\.1:(\d+)/;
    let collected = '';

    const timeout = setTimeout(() => {
      cleanup();
      proc.kill();
      reject(new Error(`Timed out waiting for tsh tunnel port. Output:\n${collected}`));
    }, TUNNEL_READY_TIMEOUT);

    function cleanup() {
      clearTimeout(timeout);
      proc.stdout?.removeAllListeners('data');
      proc.stderr?.removeAllListeners('data');
      proc.removeAllListeners('exit');
    }

    function onData(chunk: Buffer | string) {
      const text = chunk.toString();
      collected += text;
      const m = pattern.exec(text);
      if (m) {
        cleanup();
        resolve(parseInt(m[1], 10));
      }
    }

    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);

    proc.on('exit', (code) => {
      cleanup();
      reject(new Error(`tsh proxy exited with code ${code}. Output:\n${collected}`));
    });
  });
}

/**
 * Terminate a tunnel process and log out of the database.
 */
export async function stopTunnel(tsh: string, tunnel: TeleportTunnel): Promise<void> {
  try {
    tunnel.process.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        tunnel.process.kill('SIGKILL');
        resolve();
      }, 5_000);
      tunnel.process.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  } catch {
    try { tunnel.process.kill('SIGKILL'); } catch { /* ignore */ }
  }

  try {
    await execFileAsync(tsh, ['db', 'logout', tunnel.dbName], { timeout: 10_000 });
  } catch {
    console.warn(`Failed to logout from ${tunnel.dbName}`);
  }
}

/**
 * Discover databases on a MySQL instance by querying information_schema.
 */
export async function discoverDatabases(cluster: string, instance: string): Promise<string[]> {
  const tsh = await findTsh();
  const status = await getLoginStatus(tsh, cluster);
  if (!status.loggedIn || !status.username) {
    throw new Error('Not logged in to Teleport');
  }

  const tunnel = await startTunnel(tsh, instance, status.username, cluster);
  registerTunnel(tunnel);

  try {
    const mysql = await import('mysql2/promise');
    const conn = await mysql.createConnection({
      host: tunnel.host,
      port: tunnel.port,
      user: tunnel.dbUser,
      database: 'information_schema',
    });

    const [rows] = await conn.query(
      "SELECT SCHEMA_NAME FROM SCHEMATA WHERE SCHEMA_NAME NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys') ORDER BY SCHEMA_NAME"
    );

    await conn.end();
    return (rows as any[]).map(r => r.SCHEMA_NAME);
  } finally {
    unregisterTunnel(instance);
    await stopTunnel(tsh, tunnel);
  }
}

/**
 * Connect to a specific database via Teleport tunnel.
 * Returns the tunnel and a mysql2 connection for the caller to use.
 */
export async function connectToDatabase(
  cluster: string,
  instance: string,
  database: string,
): Promise<{ tunnel: TeleportTunnel; connection: any }> {
  const tsh = await findTsh();
  const status = await getLoginStatus(tsh, cluster);
  if (!status.loggedIn || !status.username) {
    throw new Error('Not logged in to Teleport');
  }

  const tunnel = await startTunnel(tsh, instance, status.username, cluster);
  registerTunnel(tunnel);

  try {
    const mysql = await import('mysql2/promise');
    const connection = await mysql.createConnection({
      host: tunnel.host,
      port: tunnel.port,
      user: tunnel.dbUser,
      database,
    });

    return { tunnel, connection };
  } catch (err) {
    unregisterTunnel(instance);
    await stopTunnel(tsh, tunnel);
    throw err;
  }
}
