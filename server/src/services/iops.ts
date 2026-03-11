import { getConnection } from './connection-manager.js';
import type { TopStatement, TopConsumer } from '../types.js';

/**
 * Safety: All queries here read from performance_schema (in-memory, lock-free)
 * and DBA.events_statements_summary_by_digest_history (read-only snapshots).
 * - MAX_EXECUTION_TIME hint auto-kills queries as a safety net.
 * - No user table access, no disk I/O, no row locks, no mutex contention.
 */

const MAX_EXEC_MS = 30000;

/**
 * Compute offset between JS process time and MySQL NOW().
 * The DBA history table uses `datetime` (no TZ info), so we need this
 * to correctly convert JS ISO dates to DB-comparable values.
 */
async function getDbTimeOffset(): Promise<{ offsetMs: number; jsNow: Date }> {
  const conn = getConnection();
  const [timeRows] = await conn.query('SELECT NOW() as db_now');
  const dbNow = new Date((timeRows as any[])[0].db_now);
  const jsNow = new Date();
  return { offsetMs: dbNow.getTime() - jsNow.getTime(), jsNow };
}

/**
 * Top IOP individual statements for a time range.
 * Uses DBA history to compute actual delta rows examined per digest
 * within the selected window — so zooming into a spike shows exactly
 * which queries caused it.
 */
export async function getTopStatements(
  database?: string,
  limit = 25,
  since?: string,
  until?: string,
): Promise<TopStatement[]> {
  const conn = getConnection();
  const { offsetMs, jsNow } = await getDbTimeOffset();

  const sinceDate = since ? new Date(since) : new Date(jsNow.getTime() - 60 * 60 * 1000);
  const untilDate = until ? new Date(until) : jsNow;

  const dbSince = new Date(sinceDate.getTime() + offsetMs);
  const dbUntil = new Date(untilDate.getTime() + offsetMs);
  const dbExtendedSince = new Date(dbSince.getTime() - 10 * 60 * 1000);

  const filters: string[] = ['h.AsOfDate >= ?', 'h.AsOfDate <= ?'];
  const params: any[] = [dbExtendedSince, dbUntil];

  if (database && database !== '__ALL__') {
    filters.push('h.SCHEMA_NAME = ?');
    params.push(database);
  }

  const [rows] = await conn.query(`
    SELECT /*+ MAX_EXECUTION_TIME(${MAX_EXEC_MS * 3}) */
      SCHEMA_NAME AS db,
      DIGEST AS digest,
      DIGEST_TEXT AS query_text,
      MAX(QUERY_SAMPLE_TEXT) AS query_sample_text,
      SUM(GREATEST(delta_rows_examined, 0)) AS total_rows_examined,
      SUM(GREATEST(delta_count, 0)) AS total_executions,
      SUM(GREATEST(delta_rows_sent, 0)) AS total_rows_sent,
      SUM(GREATEST(delta_rows_affected, 0)) AS total_rows_affected,
      ROUND(SUM(GREATEST(delta_rows_examined, 0)) / GREATEST(SUM(GREATEST(delta_count, 0)), 1)) AS avg_rows_examined,
      ROUND(SUM(GREATEST(delta_timer, 0)) / 1000000000000, 4) AS total_time_sec,
      ROUND(SUM(GREATEST(delta_timer, 0)) / GREATEST(SUM(GREATEST(delta_count, 0)), 1) / 1000000000000, 4) AS avg_time_sec,
      ROUND(MAX(COALESCE(QUANTILE_99, 0)) / 1000000000000, 4) AS p99_sec,
      ROUND(SUM(GREATEST(delta_lock_time, 0)) / 1000000000000, 4) AS total_lock_time_sec,
      ROUND(SUM(GREATEST(delta_cpu_time, 0)) / 1000000000000, 4) AS total_cpu_time_sec,
      SUM(GREATEST(delta_no_index, 0)) AS no_index_used,
      SUM(GREATEST(delta_no_good_index, 0)) AS no_good_index_used,
      SUM(GREATEST(delta_full_join, 0)) AS full_join_count,
      SUM(GREATEST(delta_tmp_disk, 0)) AS tmp_disk_tables,
      SUM(GREATEST(delta_sort_merge, 0)) AS sort_merge_passes,
      MAX(LAST_SEEN) AS last_seen,
      MIN(FIRST_SEEN) AS first_seen
    FROM (
      SELECT
        h.SCHEMA_NAME,
        h.DIGEST,
        h.DIGEST_TEXT,
        h.QUERY_SAMPLE_TEXT,
        h.QUANTILE_99,
        h.LAST_SEEN,
        h.FIRST_SEEN,
        h.AsOfDate,
        CAST(h.SUM_ROWS_EXAMINED AS SIGNED) - CAST(LAG(h.SUM_ROWS_EXAMINED) OVER w AS SIGNED) AS delta_rows_examined,
        CAST(h.COUNT_STAR AS SIGNED) - CAST(LAG(h.COUNT_STAR) OVER w AS SIGNED) AS delta_count,
        CAST(h.SUM_ROWS_SENT AS SIGNED) - CAST(LAG(h.SUM_ROWS_SENT) OVER w AS SIGNED) AS delta_rows_sent,
        CAST(h.SUM_ROWS_AFFECTED AS SIGNED) - CAST(LAG(h.SUM_ROWS_AFFECTED) OVER w AS SIGNED) AS delta_rows_affected,
        CAST(h.SUM_TIMER_WAIT AS SIGNED) - CAST(LAG(h.SUM_TIMER_WAIT) OVER w AS SIGNED) AS delta_timer,
        CAST(h.SUM_LOCK_TIME AS SIGNED) - CAST(LAG(h.SUM_LOCK_TIME) OVER w AS SIGNED) AS delta_lock_time,
        CAST(h.SUM_CPU_TIME AS SIGNED) - CAST(LAG(h.SUM_CPU_TIME) OVER w AS SIGNED) AS delta_cpu_time,
        CAST(h.SUM_NO_INDEX_USED AS SIGNED) - CAST(LAG(h.SUM_NO_INDEX_USED) OVER w AS SIGNED) AS delta_no_index,
        CAST(h.SUM_NO_GOOD_INDEX_USED AS SIGNED) - CAST(LAG(h.SUM_NO_GOOD_INDEX_USED) OVER w AS SIGNED) AS delta_no_good_index,
        CAST(h.SUM_SELECT_FULL_JOIN AS SIGNED) - CAST(LAG(h.SUM_SELECT_FULL_JOIN) OVER w AS SIGNED) AS delta_full_join,
        CAST(h.SUM_CREATED_TMP_DISK_TABLES AS SIGNED) - CAST(LAG(h.SUM_CREATED_TMP_DISK_TABLES) OVER w AS SIGNED) AS delta_tmp_disk,
        CAST(h.SUM_SORT_MERGE_PASSES AS SIGNED) - CAST(LAG(h.SUM_SORT_MERGE_PASSES) OVER w AS SIGNED) AS delta_sort_merge
      FROM dba.events_statements_summary_by_digest_history h
      WHERE ${filters.join(' AND ')}
      WINDOW w AS (PARTITION BY h.SCHEMA_NAME, h.DIGEST ORDER BY h.AsOfDate)
    ) deltas
    WHERE delta_rows_examined IS NOT NULL
      AND delta_rows_examined >= 0
      AND AsOfDate >= ?
    GROUP BY SCHEMA_NAME, DIGEST, DIGEST_TEXT
    ORDER BY total_rows_examined DESC
    LIMIT ?
  `, [...params, dbSince, limit]);

  return (rows as any[]).map(r => ({
    db: r.db,
    queryText: r.query_text,
    querySampleText: r.query_sample_text || '',
    digest: r.digest,
    totalExecutions: Number(r.total_executions),
    totalRowsExamined: Number(r.total_rows_examined),
    totalRowsSent: Number(r.total_rows_sent),
    totalRowsAffected: Number(r.total_rows_affected),
    avgRowsExamined: Number(r.avg_rows_examined),
    totalTimeSec: Number(r.total_time_sec),
    avgTimeSec: Number(r.avg_time_sec),
    p99Sec: Number(r.p99_sec),
    totalLockTimeSec: Number(r.total_lock_time_sec),
    totalCpuTimeSec: Number(r.total_cpu_time_sec),
    noIndexUsed: Number(r.no_index_used),
    noGoodIndexUsed: Number(r.no_good_index_used),
    fullJoinCount: Number(r.full_join_count),
    tmpDiskTables: Number(r.tmp_disk_tables),
    sortMergePasses: Number(r.sort_merge_passes),
    lastSeen: r.last_seen ? new Date(r.last_seen).toISOString() : '',
    firstSeen: r.first_seen ? new Date(r.first_seen).toISOString() : '',
  }));
}

/**
 * Top IOP consumers weighted by concurrent connections, for a time range.
 * Delta-based from DBA history + live concurrent count from performance_schema.
 */
export async function getTopConsumers(
  database?: string,
  limit = 25,
  since?: string,
  until?: string,
): Promise<TopConsumer[]> {
  const conn = getConnection();
  const { offsetMs, jsNow } = await getDbTimeOffset();

  const sinceDate = since ? new Date(since) : new Date(jsNow.getTime() - 60 * 60 * 1000);
  const untilDate = until ? new Date(until) : jsNow;

  const dbSince = new Date(sinceDate.getTime() + offsetMs);
  const dbUntil = new Date(untilDate.getTime() + offsetMs);
  const dbExtendedSince = new Date(dbSince.getTime() - 10 * 60 * 1000);

  const hasDbFilter = !!database && database !== '__ALL__';
  const threadDbFilter = hasDbFilter ? 'WHERE BINARY t.PROCESSLIST_DB = BINARY ?' : '';

  const filters: string[] = ['h.AsOfDate >= ?', 'h.AsOfDate <= ?'];
  const params: any[] = [dbExtendedSince, dbUntil];

  if (hasDbFilter) {
    filters.push('h.SCHEMA_NAME = ?');
    params.push(database);
  }

  // Concurrent count subquery params come after the main params
  const concurrentParams = hasDbFilter ? [database] : [];

  const [rows] = await conn.query(`
    SELECT /*+ MAX_EXECUTION_TIME(${MAX_EXEC_MS * 3}) */
      digest_stats.db,
      digest_stats.query_text,
      digest_stats.query_sample_text,
      digest_stats.digest,
      digest_stats.total_executions,
      digest_stats.total_rows_examined,
      digest_stats.avg_rows_examined,
      digest_stats.total_time_sec,
      digest_stats.avg_time_sec,
      digest_stats.p99_sec,
      digest_stats.total_lock_time_sec,
      digest_stats.total_cpu_time_sec,
      digest_stats.full_join_count,
      COALESCE(active.concurrent_count, 0) AS concurrent_count,
      ROUND(digest_stats.avg_rows_examined * GREATEST(COALESCE(active.concurrent_count, 0), 1)) AS effective_iops,
      digest_stats.last_seen,
      digest_stats.first_seen
    FROM (
      SELECT
        SCHEMA_NAME AS db,
        DIGEST AS digest,
        DIGEST_TEXT AS query_text,
        MAX(QUERY_SAMPLE_TEXT) AS query_sample_text,
        SUM(GREATEST(delta_rows_examined, 0)) AS total_rows_examined,
        SUM(GREATEST(delta_count, 0)) AS total_executions,
        ROUND(SUM(GREATEST(delta_rows_examined, 0)) / GREATEST(SUM(GREATEST(delta_count, 0)), 1)) AS avg_rows_examined,
        ROUND(SUM(GREATEST(delta_timer, 0)) / 1000000000000, 4) AS total_time_sec,
        ROUND(SUM(GREATEST(delta_timer, 0)) / GREATEST(SUM(GREATEST(delta_count, 0)), 1) / 1000000000000, 4) AS avg_time_sec,
        ROUND(MAX(COALESCE(QUANTILE_99, 0)) / 1000000000000, 4) AS p99_sec,
        ROUND(SUM(GREATEST(delta_lock_time, 0)) / 1000000000000, 4) AS total_lock_time_sec,
        ROUND(SUM(GREATEST(delta_cpu_time, 0)) / 1000000000000, 4) AS total_cpu_time_sec,
        SUM(GREATEST(delta_full_join, 0)) AS full_join_count,
        MAX(LAST_SEEN) AS last_seen,
        MIN(FIRST_SEEN) AS first_seen
      FROM (
        SELECT
          h.SCHEMA_NAME,
          h.DIGEST,
          h.DIGEST_TEXT,
          h.QUERY_SAMPLE_TEXT,
          h.QUANTILE_99,
          h.LAST_SEEN,
          h.FIRST_SEEN,
          h.AsOfDate,
          CAST(h.SUM_ROWS_EXAMINED AS SIGNED) - CAST(LAG(h.SUM_ROWS_EXAMINED) OVER w AS SIGNED) AS delta_rows_examined,
          CAST(h.COUNT_STAR AS SIGNED) - CAST(LAG(h.COUNT_STAR) OVER w AS SIGNED) AS delta_count,
          CAST(h.SUM_TIMER_WAIT AS SIGNED) - CAST(LAG(h.SUM_TIMER_WAIT) OVER w AS SIGNED) AS delta_timer,
          CAST(h.SUM_LOCK_TIME AS SIGNED) - CAST(LAG(h.SUM_LOCK_TIME) OVER w AS SIGNED) AS delta_lock_time,
          CAST(h.SUM_CPU_TIME AS SIGNED) - CAST(LAG(h.SUM_CPU_TIME) OVER w AS SIGNED) AS delta_cpu_time,
          CAST(h.SUM_SELECT_FULL_JOIN AS SIGNED) - CAST(LAG(h.SUM_SELECT_FULL_JOIN) OVER w AS SIGNED) AS delta_full_join
        FROM dba.events_statements_summary_by_digest_history h
        WHERE ${filters.join(' AND ')}
        WINDOW w AS (PARTITION BY h.SCHEMA_NAME, h.DIGEST ORDER BY h.AsOfDate)
      ) deltas
      WHERE delta_rows_examined IS NOT NULL
        AND delta_rows_examined >= 0
        AND AsOfDate >= ?
      GROUP BY SCHEMA_NAME, DIGEST, DIGEST_TEXT
    ) digest_stats
    LEFT JOIN (
      SELECT
        esc.DIGEST,
        COUNT(*) AS concurrent_count
      FROM performance_schema.events_statements_current esc
      INNER JOIN performance_schema.threads t
        ON esc.THREAD_ID = t.THREAD_ID
        AND t.TYPE = 'FOREGROUND'
        AND t.PROCESSLIST_COMMAND != 'Sleep'
        AND t.PROCESSLIST_INFO IS NOT NULL
      ${threadDbFilter}
      GROUP BY esc.DIGEST
    ) active ON BINARY active.DIGEST = BINARY digest_stats.digest
    ORDER BY effective_iops DESC
    LIMIT ?
  `, [...params, dbSince, ...concurrentParams, limit]);

  return (rows as any[]).map(r => ({
    db: r.db,
    queryText: r.query_text,
    querySampleText: r.query_sample_text || '',
    digest: r.digest,
    totalExecutions: Number(r.total_executions),
    totalRowsExamined: Number(r.total_rows_examined),
    avgRowsExamined: Number(r.avg_rows_examined),
    totalTimeSec: Number(r.total_time_sec),
    avgTimeSec: Number(r.avg_time_sec),
    p99Sec: Number(r.p99_sec),
    totalLockTimeSec: Number(r.total_lock_time_sec),
    totalCpuTimeSec: Number(r.total_cpu_time_sec),
    fullJoinCount: Number(r.full_join_count),
    concurrentCount: Number(r.concurrent_count),
    effectiveIops: Number(r.effective_iops),
    lastSeen: r.last_seen ? new Date(r.last_seen).toISOString() : '',
    firstSeen: r.first_seen ? new Date(r.first_seen).toISOString() : '',
  }));
}

/**
 * InnoDB metrics from dba.global_status_history for buffer pool hit ratio
 * and physical I/O counters. Uses delta computation between snapshots.
 */
export async function getInnodbMetrics(
  since?: string,
  until?: string,
): Promise<{
  bufferPool: {
    avgHitRatio: number;
    minHitRatio: number;
    dataPoints: { timestamp: string; hitRatio: number; physicalReads: number; logicalReads: number }[];
  };
  ioCounters: {
    totalDataReads: number;
    totalDataWrites: number;
    readWriteRatio: number;
    dataPoints: { timestamp: string; dataReads: number; dataWrites: number }[];
  };
}> {
  const conn = getConnection();
  const { offsetMs, jsNow } = await getDbTimeOffset();

  const sinceDate = since ? new Date(since) : new Date(jsNow.getTime() - 60 * 60 * 1000);
  const untilDate = until ? new Date(until) : jsNow;

  const dbSince = new Date(sinceDate.getTime() + offsetMs);
  const dbUntil = new Date(untilDate.getTime() + offsetMs);
  const dbExtendedSince = new Date(dbSince.getTime() - 10 * 60 * 1000);

  const variables = [
    'Innodb_buffer_pool_read_requests',
    'Innodb_buffer_pool_reads',
    'Innodb_data_reads',
    'Innodb_data_writes',
  ];

  const [rows] = await conn.query(`
    SELECT /*+ MAX_EXECUTION_TIME(${MAX_EXEC_MS}) */
      AsOfDate,
      VARIABLE_NAME,
      CAST(VARIABLE_VALUE AS SIGNED) AS val,
      CAST(VARIABLE_VALUE AS SIGNED) - CAST(LAG(CAST(VARIABLE_VALUE AS SIGNED)) OVER (
        PARTITION BY VARIABLE_NAME ORDER BY AsOfDate
      ) AS SIGNED) AS delta
    FROM dba.global_status_history
    WHERE VARIABLE_NAME IN (${variables.map(() => '?').join(',')})
      AND AsOfDate >= ?
      AND AsOfDate <= ?
    ORDER BY AsOfDate
  `, [...variables, dbExtendedSince, dbUntil]);

  // Group deltas by timestamp
  const byTimestamp = new Map<string, Record<string, number>>();
  for (const r of rows as any[]) {
    if (r.delta === null || r.delta < 0) continue; // skip first row (no LAG) and counter resets
    const ts = new Date(r.AsOfDate);
    if (ts < dbSince) continue; // extended range was for LAG baseline
    const tsKey = new Date(ts.getTime() - offsetMs).toISOString();
    if (!byTimestamp.has(tsKey)) byTimestamp.set(tsKey, {});
    byTimestamp.get(tsKey)![r.VARIABLE_NAME] = Number(r.delta);
  }

  // Build buffer pool and I/O data points
  const bpPoints: { timestamp: string; hitRatio: number; physicalReads: number; logicalReads: number }[] = [];
  const ioPoints: { timestamp: string; dataReads: number; dataWrites: number }[] = [];
  let totalLogical = 0, totalPhysical = 0, totalDataReads = 0, totalDataWrites = 0;
  let minHitRatio = 100;

  for (const [ts, vars] of byTimestamp) {
    const logical = vars['Innodb_buffer_pool_read_requests'] || 0;
    const physical = vars['Innodb_buffer_pool_reads'] || 0;
    const hitRatio = logical > 0 ? ((logical - physical) / logical) * 100 : 100;

    totalLogical += logical;
    totalPhysical += physical;
    if (logical > 0) minHitRatio = Math.min(minHitRatio, hitRatio);

    bpPoints.push({ timestamp: ts, hitRatio: Math.round(hitRatio * 100) / 100, physicalReads: physical, logicalReads: logical });

    const dr = vars['Innodb_data_reads'] || 0;
    const dw = vars['Innodb_data_writes'] || 0;
    totalDataReads += dr;
    totalDataWrites += dw;
    ioPoints.push({ timestamp: ts, dataReads: dr, dataWrites: dw });
  }

  const avgHitRatio = totalLogical > 0 ? ((totalLogical - totalPhysical) / totalLogical) * 100 : 100;

  return {
    bufferPool: {
      avgHitRatio: Math.round(avgHitRatio * 100) / 100,
      minHitRatio: bpPoints.length > 0 ? Math.round(minHitRatio * 100) / 100 : 100,
      dataPoints: bpPoints,
    },
    ioCounters: {
      totalDataReads,
      totalDataWrites,
      readWriteRatio: (totalDataReads + totalDataWrites) > 0
        ? Math.round((totalDataReads / (totalDataReads + totalDataWrites)) * 100) / 100
        : 0.5,
      dataPoints: ioPoints,
    },
  };
}

/**
 * Chart data from DBA.events_statements_summary_by_digest_history.
 * Computes deltas between consecutive snapshots per digest to derive
 * actual rows examined per interval — real historical I/O rate.
 */
