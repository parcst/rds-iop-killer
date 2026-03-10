import type { Connection } from 'mysql2/promise';
import { TeleportTunnel } from '../types.js';
import {
  findTsh,
  getLoginStatus,
  startTunnel,
  stopTunnel,
  registerTunnel,
  unregisterTunnel,
} from './teleport.js';

/**
 * Manages a persistent tunnel + MySQL connection for IOPS queries.
 * Only one active session at a time.
 */

let activeTunnel: TeleportTunnel | null = null;
let activeConnection: Connection | null = null;
let activeMetadata: { cluster: string; instance: string; database: string } | null = null;

export function getActiveSession() {
  return activeMetadata
    ? { ...activeMetadata, connected: !!activeConnection }
    : null;
}

export async function openSession(
  cluster: string,
  instance: string,
  database: string,
): Promise<{ version: string; databases?: string[] }> {
  // Close any existing session first
  await closeSession();

  const tsh = await findTsh();
  const status = await getLoginStatus(tsh, cluster);
  if (!status.loggedIn || !status.username) {
    throw new Error('Not logged in to Teleport');
  }

  const connectDb = database === '__ALL__' ? 'information_schema' : database;

  const tunnel = await startTunnel(tsh, instance, status.username, cluster);
  registerTunnel(tunnel);
  activeTunnel = tunnel;

  const mysql = await import('mysql2/promise');
  const connection = await mysql.createConnection({
    host: tunnel.host,
    port: tunnel.port,
    user: tunnel.dbUser,
    database: connectDb,
    charset: 'utf8mb4_general_ci',
  });

  activeConnection = connection;
  activeMetadata = { cluster, instance, database };

  // Verify
  const [versionRows] = await connection.query('SELECT VERSION() as version');
  const version = (versionRows as any[])[0]?.version ?? 'unknown';

  // If all databases, fetch the list
  let databases: string[] | undefined;
  if (database === '__ALL__') {
    const [rows] = await connection.query(
      "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys') ORDER BY SCHEMA_NAME"
    );
    databases = (rows as any[]).map((r: any) => r.SCHEMA_NAME);
  }

  return { version, databases };
}

export async function closeSession(): Promise<void> {
  if (activeConnection) {
    try { await activeConnection.end(); } catch { /* ignore */ }
    activeConnection = null;
  }
  if (activeTunnel) {
    const instance = activeMetadata?.instance;
    if (instance) unregisterTunnel(instance);
    try {
      const tsh = await findTsh();
      await stopTunnel(tsh, activeTunnel);
    } catch { /* ignore */ }
    activeTunnel = null;
  }
  activeMetadata = null;
}

/**
 * Get the active MySQL connection. Throws if not connected.
 */
export function getConnection(): Connection {
  if (!activeConnection) {
    throw new Error('No active database connection. Connect first.');
  }
  return activeConnection;
}
