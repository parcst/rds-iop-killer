import { Router, Request, Response } from 'express';
import { getTopStatements, getTopConsumers, getInnodbMetrics } from '../services/iops.js';

const router = Router();

/**
 * GET /api/iops/top-statements?database=X&limit=25&since=ISO&until=ISO
 */
router.get('/top-statements', async (req: Request, res: Response) => {
  try {
    const database = req.query.database as string | undefined;
    const limit = parseInt(req.query.limit as string) || 25;
    const since = req.query.since as string | undefined;
    const until = req.query.until as string | undefined;
    const statements = await getTopStatements(database, limit, since, until);
    res.json({ statements });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/iops/top-consumers?database=X&limit=25&since=ISO&until=ISO
 */
router.get('/top-consumers', async (req: Request, res: Response) => {
  try {
    const database = req.query.database as string | undefined;
    const limit = parseInt(req.query.limit as string) || 25;
    const since = req.query.since as string | undefined;
    const until = req.query.until as string | undefined;
    const consumers = await getTopConsumers(database, limit, since, until);
    res.json({ consumers });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/iops/cloudwatch?accountId=X&region=Y&instanceId=Z&since=ISO&until=ISO
 * Fetch real ReadIOPS + WriteIOPS from CloudWatch.
 */
router.get('/cloudwatch', async (req: Request, res: Response) => {
  try {
    const accountId = req.query.accountId as string;
    const region = req.query.region as string;
    const instanceId = req.query.instanceId as string;
    const since = req.query.since as string;
    const until = req.query.until as string;
    if (!accountId || !region || !instanceId || !since || !until) {
      res.status(400).json({ error: 'accountId, region, instanceId, since, and until are required' });
      return;
    }
    const { getAwsProfile } = await import('../services/aws-rds.js');
    const { getCloudWatchIops } = await import('../services/cloudwatch.js');
    const profileName = await getAwsProfile(accountId, region);
    const data = await getCloudWatchIops(instanceId, region, profileName, since, until);
    res.json({ cloudwatch: data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/iops/innodb-metrics?since=ISO&until=ISO
 * Buffer pool hit ratio and InnoDB physical I/O counters from dba.global_status_history.
 */
router.get('/innodb-metrics', async (req: Request, res: Response) => {
  try {
    const since = req.query.since as string | undefined;
    const until = req.query.until as string | undefined;
    const metrics = await getInnodbMetrics(since, until);
    res.json(metrics);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/iops/discover-dba — Explore the DBA schema for historical performance data
 */
router.get('/discover-dba', async (_req: Request, res: Response) => {
  try {
    const { getConnection } = await import('../services/connection-manager.js');
    const conn = getConnection();

    // Check if DBA schema exists (case-insensitive)
    const [schemas] = await conn.query(
      "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE UPPER(SCHEMA_NAME) = 'DBA'"
    );
    if ((schemas as any[]).length === 0) {
      // Return all available schemas so we can find the right one
      const [allSchemas] = await conn.query(
        "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME"
      );
      res.json({ exists: false, tables: [], availableSchemas: (allSchemas as any[]).map((s: any) => s.SCHEMA_NAME) });
      return;
    }

    const dbaSchemaName = (schemas as any[])[0].SCHEMA_NAME;

    // List all tables in DBA schema with row counts
    const [tables] = await conn.query(`
      SELECT TABLE_NAME, TABLE_ROWS, TABLE_COMMENT
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME
    `, [dbaSchemaName]);

    // For each table, get columns
    const tableDetails: any[] = [];
    for (const t of tables as any[]) {
      const [cols] = await conn.query(`
        SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_COMMENT
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION
      `, [dbaSchemaName, t.TABLE_NAME]);

      // Sample 3 rows
      let sample: any[] = [];
      try {
        const [rows] = await conn.query(
          `SELECT * FROM ${conn.escapeId(dbaSchemaName)}.${conn.escapeId(t.TABLE_NAME)} ORDER BY 1 DESC LIMIT 3`
        );
        sample = rows as any[];
      } catch { /* table might be empty or inaccessible */ }

      tableDetails.push({
        name: t.TABLE_NAME,
        rows: Number(t.TABLE_ROWS),
        comment: t.TABLE_COMMENT,
        columns: (cols as any[]).map(c => ({
          name: c.COLUMN_NAME,
          type: c.COLUMN_TYPE,
          comment: c.COLUMN_COMMENT,
        })),
        sample,
      });
    }

    res.json({ exists: true, tables: tableDetails });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/discover-global-status', async (_req: Request, res: Response) => {
  try {
    const { getConnection } = await import('../services/connection-manager.js');
    const conn = getConnection();
    const [rows] = await conn.query(`
      SELECT DISTINCT VARIABLE_NAME
      FROM dba.global_status_history
      ORDER BY VARIABLE_NAME
    `);
    res.json({ variables: (rows as any[]).map(r => r.VARIABLE_NAME) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/debug-time', async (_req: Request, res: Response) => {
  try {
    const { getConnection } = await import('../services/connection-manager.js');
    const conn = getConnection();
    const [rows] = await conn.query("SELECT NOW() as db_now, UTC_TIMESTAMP() as db_utc, @@session.time_zone as tz, @@global.time_zone as global_tz");
    const [dbaRows] = await conn.query("SELECT MAX(AsOfDate) as latest_asofdate FROM dba.events_statements_summary_by_digest_history");
    res.json({ ...(rows as any[])[0], latest_asofdate: (dbaRows as any[])[0]?.latest_asofdate, server_js_now: new Date().toISOString() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/iops/rds-config?accountId=X&region=Y&instanceId=Z
 * Fetch RDS instance config (provisioned IOPS, storage type, etc.) from AWS API via SSO.
 */
router.get('/rds-config', async (req: Request, res: Response) => {
  try {
    const accountId = req.query.accountId as string;
    const region = req.query.region as string;
    const instanceId = req.query.instanceId as string;
    if (!accountId || !region || !instanceId) {
      res.status(400).json({ error: 'accountId, region, and instanceId are required' });
      return;
    }
    const { getRdsInstanceConfig } = await import('../services/aws-rds.js');
    const config = await getRdsInstanceConfig(accountId, region, instanceId);
    res.json(config);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/iops/parameter-group?accountId=X&region=Y&parameterGroupName=Z
 * Fetch IOPS-relevant MySQL parameters from the RDS parameter group.
 */
router.get('/parameter-group', async (req: Request, res: Response) => {
  try {
    const accountId = req.query.accountId as string;
    const region = req.query.region as string;
    const parameterGroupName = req.query.parameterGroupName as string;
    if (!accountId || !region || !parameterGroupName) {
      res.status(400).json({ error: 'accountId, region, and parameterGroupName are required' });
      return;
    }
    const { getRdsParameterGroup } = await import('../services/aws-rds.js');
    const group = await getRdsParameterGroup(accountId, region, parameterGroupName);
    res.json(group);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
