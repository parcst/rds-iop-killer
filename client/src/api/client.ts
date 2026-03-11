import type { TeleportInstance, TeleportStatus, ConnectionResult, TopStatement, TopConsumer, CloudWatchIopsPoint, DigestHistoryResult } from './types';

async function post<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

// ===== Teleport API =====

export function teleportStatus(): Promise<{ available: boolean; tshPath: string | null }> {
  return get('/api/teleport/status');
}

export function teleportClusters(): Promise<{ clusters: string[] }> {
  return get('/api/teleport/clusters');
}

export function teleportLoginStatus(cluster?: string): Promise<TeleportStatus> {
  const params = cluster ? `?cluster=${encodeURIComponent(cluster)}` : '';
  return get(`/api/teleport/login-status${params}`);
}

export function teleportLogin(cluster: string): Promise<{ started: boolean }> {
  return post('/api/teleport/login', { cluster });
}

export function teleportInstances(cluster: string): Promise<{ instances: TeleportInstance[] }> {
  return get(`/api/teleport/instances?cluster=${encodeURIComponent(cluster)}`);
}

export function teleportConnect(cluster: string, instance: string, database: string): Promise<ConnectionResult> {
  return post('/api/teleport/connect', { cluster, instance, database });
}

export function teleportDisconnect(): Promise<{ disconnected: boolean }> {
  return post('/api/teleport/disconnect', {});
}

// ===== AWS SSO API =====

export function awsSsoStatus(): Promise<{ loggedIn: boolean }> {
  return get('/api/aws/sso-status');
}

export function awsSsoLogin(): Promise<{ started: boolean }> {
  return post('/api/aws/sso-login', {});
}

// ===== IOPS API =====

export function fetchTopStatements(
  database?: string, limit = 25, since?: string, until?: string,
): Promise<{ statements: TopStatement[] }> {
  const params = new URLSearchParams();
  if (database) params.set('database', database);
  params.set('limit', String(limit));
  if (since) params.set('since', since);
  if (until) params.set('until', until);
  return get(`/api/iops/top-statements?${params.toString()}`);
}

export function fetchTopConsumers(
  database?: string, limit = 25, since?: string, until?: string,
): Promise<{ consumers: TopConsumer[] }> {
  const params = new URLSearchParams();
  if (database) params.set('database', database);
  params.set('limit', String(limit));
  if (since) params.set('since', since);
  if (until) params.set('until', until);
  return get(`/api/iops/top-consumers?${params.toString()}`);
}

export function fetchRdsConfig(accountId: string, region: string, instanceId: string): Promise<{
  provisionedIops: number;
  storageType: string;
  allocatedStorageGb: number;
  instanceClass: string;
  engine: string;
  engineVersion: string;
}> {
  const params = new URLSearchParams({ accountId, region, instanceId });
  return get(`/api/iops/rds-config?${params.toString()}`);
}

export function fetchDigestHistory(
  digest: string, database?: string,
): Promise<DigestHistoryResult> {
  const params = new URLSearchParams({ digest });
  if (database) params.set('database', database);
  return get(`/api/iops/digest-history?${params.toString()}`);
}

export function fetchCloudWatchIops(
  accountId: string, region: string, instanceId: string, since: string, until: string,
): Promise<{ cloudwatch: CloudWatchIopsPoint[] }> {
  const params = new URLSearchParams({ accountId, region, instanceId, since, until });
  return get(`/api/iops/cloudwatch?${params.toString()}`);
}

