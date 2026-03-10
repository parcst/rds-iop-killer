import { Router, Request, Response } from 'express';
import {
  findTsh,
  getClusters,
  getLoginStatus,
  loginToCluster,
  listMysqlInstances,
  discoverDatabases,
  cleanupAll,
} from '../services/teleport.js';
import { openSession, closeSession } from '../services/connection-manager.js';

const router = Router();

/**
 * GET /api/teleport/status
 * Check if tsh binary is available.
 */
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const tshPath = await findTsh();
    res.json({ available: true, tshPath });
  } catch {
    res.json({ available: false, tshPath: null });
  }
});

/**
 * GET /api/teleport/clusters
 * List clusters from ~/.tsh/*.yaml.
 */
router.get('/clusters', async (_req: Request, res: Response) => {
  try {
    const clusters = await getClusters();
    res.json({ clusters });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/teleport/login-status?cluster=X
 * Check login status for a cluster.
 */
router.get('/login-status', async (req: Request, res: Response) => {
  try {
    const cluster = req.query.cluster as string | undefined;
    const tsh = await findTsh();
    const status = await getLoginStatus(tsh, cluster);
    res.json(status);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/teleport/login
 * Start SSO login (opens browser).
 */
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { cluster } = req.body;
    if (!cluster) {
      res.status(400).json({ error: 'cluster is required' });
      return;
    }
    const tsh = await findTsh();
    const proc = loginToCluster(tsh, cluster);

    // Fire and forget — the client will poll login-status
    proc.on('exit', () => {});
    proc.on('error', () => {});

    res.json({ started: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/teleport/instances?cluster=X
 * List MySQL instances on a cluster.
 */
router.get('/instances', async (req: Request, res: Response) => {
  try {
    const cluster = req.query.cluster as string;
    if (!cluster) {
      res.status(400).json({ error: 'cluster query param is required' });
      return;
    }
    const tsh = await findTsh();
    const instances = await listMysqlInstances(tsh, cluster);
    res.json({ instances });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/teleport/databases
 * Discover databases on an instance (opens temp tunnel).
 */
router.post('/databases', async (req: Request, res: Response) => {
  try {
    const { cluster, instance } = req.body;
    if (!cluster || !instance) {
      res.status(400).json({ error: 'cluster and instance are required' });
      return;
    }
    const databases = await discoverDatabases(cluster, instance);
    res.json({ databases });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/teleport/connect
 * Open a persistent connection to a database (or all databases).
 * The tunnel stays alive for subsequent IOPS queries.
 */
router.post('/connect', async (req: Request, res: Response) => {
  try {
    const { cluster, instance, database } = req.body;
    if (!cluster || !instance || !database) {
      res.status(400).json({ error: 'cluster, instance, and database are required' });
      return;
    }

    const { version, databases } = await openSession(cluster, instance, database);

    res.json({
      connected: true,
      database: database === '__ALL__' ? 'All Databases' : database,
      databases,
      version,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/teleport/disconnect
 * Close the active session (tunnel + connection).
 */
router.post('/disconnect', async (_req: Request, res: Response) => {
  try {
    await closeSession();
    res.json({ disconnected: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/teleport/shutdown
 * Clean up all tunnels. Target for navigator.sendBeacon on page close.
 */
router.post('/shutdown', async (_req: Request, res: Response) => {
  await closeSession();
  await cleanupAll();
  res.json({ ok: true });
});

export default router;
