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
 * Historical 7-day baseline for a specific digest.
 * Returns daily aggregates so the client can show "normal" vs current.
 */
export async function getDigestHistory(
  digest: string,
  database?: string,
): Promise<{
  avgPerDay: {
    totalRowsExamined: number;
    totalExecutions: number;
    avgRowsExamined: number;
    totalTimeSec: number;
    avgTimeSec: number;
    p99Sec: number;
    totalLockTimeSec: number;
    totalCpuTimeSec: number;
    noIndexUsed: number;
    fullJoinCount: number;
    tmpDiskTables: number;
    sortMergePasses: number;
  };
  dailyPoints: {
    date: string;
    totalRowsExamined: number;
    totalExecutions: number;
    avgTimeSec: number;
  }[];
  daysWithData: number;
}> {
  const conn = getConnection();
  const { offsetMs, jsNow } = await getDbTimeOffset();

  // 7 days ago to now
  const sevenDaysAgo = new Date(jsNow.getTime() - 7 * 24 * 60 * 60 * 1000);
  const dbSince = new Date(sevenDaysAgo.getTime() + offsetMs);
  const dbUntil = new Date(jsNow.getTime() + offsetMs);
  const dbExtendedSince = new Date(dbSince.getTime() - 10 * 60 * 1000);

  const filters: string[] = ['h.AsOfDate >= ?', 'h.AsOfDate <= ?', 'h.DIGEST = ?'];
  const params: any[] = [dbExtendedSince, dbUntil, digest];

  if (database && database !== '__ALL__') {
    filters.push('h.SCHEMA_NAME = ?');
    params.push(database);
  }

  const [rows] = await conn.query(`
    SELECT /*+ MAX_EXECUTION_TIME(${MAX_EXEC_MS * 3}) */
      DATE(AsOfDate) AS day,
      SUM(GREATEST(delta_rows_examined, 0)) AS total_rows_examined,
      SUM(GREATEST(delta_count, 0)) AS total_executions,
      ROUND(SUM(GREATEST(delta_rows_examined, 0)) / GREATEST(SUM(GREATEST(delta_count, 0)), 1)) AS avg_rows_examined,
      ROUND(SUM(GREATEST(delta_timer, 0)) / 1000000000000, 4) AS total_time_sec,
      ROUND(SUM(GREATEST(delta_timer, 0)) / GREATEST(SUM(GREATEST(delta_count, 0)), 1) / 1000000000000, 4) AS avg_time_sec,
      ROUND(MAX(COALESCE(QUANTILE_99, 0)) / 1000000000000, 4) AS p99_sec,
      ROUND(SUM(GREATEST(delta_lock_time, 0)) / 1000000000000, 4) AS total_lock_time_sec,
      ROUND(SUM(GREATEST(delta_cpu_time, 0)) / 1000000000000, 4) AS total_cpu_time_sec,
      SUM(GREATEST(delta_no_index, 0)) AS no_index_used,
      SUM(GREATEST(delta_full_join, 0)) AS full_join_count,
      SUM(GREATEST(delta_tmp_disk, 0)) AS tmp_disk_tables,
      SUM(GREATEST(delta_sort_merge, 0)) AS sort_merge_passes
    FROM (
      SELECT
        h.AsOfDate,
        h.QUANTILE_99,
        CAST(h.SUM_ROWS_EXAMINED AS SIGNED) - CAST(LAG(h.SUM_ROWS_EXAMINED) OVER w AS SIGNED) AS delta_rows_examined,
        CAST(h.COUNT_STAR AS SIGNED) - CAST(LAG(h.COUNT_STAR) OVER w AS SIGNED) AS delta_count,
        CAST(h.SUM_TIMER_WAIT AS SIGNED) - CAST(LAG(h.SUM_TIMER_WAIT) OVER w AS SIGNED) AS delta_timer,
        CAST(h.SUM_LOCK_TIME AS SIGNED) - CAST(LAG(h.SUM_LOCK_TIME) OVER w AS SIGNED) AS delta_lock_time,
        CAST(h.SUM_CPU_TIME AS SIGNED) - CAST(LAG(h.SUM_CPU_TIME) OVER w AS SIGNED) AS delta_cpu_time,
        CAST(h.SUM_NO_INDEX_USED AS SIGNED) - CAST(LAG(h.SUM_NO_INDEX_USED) OVER w AS SIGNED) AS delta_no_index,
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
    GROUP BY DATE(AsOfDate)
    ORDER BY day
  `, [...params, dbSince]);

  const dailyData = (rows as any[]).map(r => ({
    date: r.day instanceof Date ? r.day.toISOString().split('T')[0] : String(r.day),
    totalRowsExamined: Number(r.total_rows_examined),
    totalExecutions: Number(r.total_executions),
    avgRowsExamined: Number(r.avg_rows_examined),
    totalTimeSec: Number(r.total_time_sec),
    avgTimeSec: Number(r.avg_time_sec),
    p99Sec: Number(r.p99_sec),
    totalLockTimeSec: Number(r.total_lock_time_sec),
    totalCpuTimeSec: Number(r.total_cpu_time_sec),
    noIndexUsed: Number(r.no_index_used),
    fullJoinCount: Number(r.full_join_count),
    tmpDiskTables: Number(r.tmp_disk_tables),
    sortMergePasses: Number(r.sort_merge_passes),
  }));

  const daysWithData = dailyData.length;

  // Compute averages per day
  const avg = {
    totalRowsExamined: 0,
    totalExecutions: 0,
    avgRowsExamined: 0,
    totalTimeSec: 0,
    avgTimeSec: 0,
    p99Sec: 0,
    totalLockTimeSec: 0,
    totalCpuTimeSec: 0,
    noIndexUsed: 0,
    fullJoinCount: 0,
    tmpDiskTables: 0,
    sortMergePasses: 0,
  };

  if (daysWithData > 0) {
    for (const d of dailyData) {
      avg.totalRowsExamined += d.totalRowsExamined;
      avg.totalExecutions += d.totalExecutions;
      avg.totalTimeSec += d.totalTimeSec;
      avg.totalLockTimeSec += d.totalLockTimeSec;
      avg.totalCpuTimeSec += d.totalCpuTimeSec;
      avg.noIndexUsed += d.noIndexUsed;
      avg.fullJoinCount += d.fullJoinCount;
      avg.tmpDiskTables += d.tmpDiskTables;
      avg.sortMergePasses += d.sortMergePasses;
      avg.p99Sec = Math.max(avg.p99Sec, d.p99Sec);
    }
    avg.totalRowsExamined = Math.round(avg.totalRowsExamined / daysWithData);
    avg.totalExecutions = Math.round(avg.totalExecutions / daysWithData);
    avg.avgRowsExamined = avg.totalExecutions > 0 ? Math.round(avg.totalRowsExamined / (avg.totalExecutions || 1)) : 0;
    avg.totalTimeSec = Math.round((avg.totalTimeSec / daysWithData) * 10000) / 10000;
    avg.avgTimeSec = avg.totalExecutions > 0 ? Math.round((avg.totalTimeSec / avg.totalExecutions) * 10000) / 10000 : 0;
    avg.totalLockTimeSec = Math.round((avg.totalLockTimeSec / daysWithData) * 10000) / 10000;
    avg.totalCpuTimeSec = Math.round((avg.totalCpuTimeSec / daysWithData) * 10000) / 10000;
    avg.noIndexUsed = Math.round(avg.noIndexUsed / daysWithData);
    avg.fullJoinCount = Math.round(avg.fullJoinCount / daysWithData);
    avg.tmpDiskTables = Math.round(avg.tmpDiskTables / daysWithData);
    avg.sortMergePasses = Math.round(avg.sortMergePasses / daysWithData);
  }

  return {
    avgPerDay: avg,
    dailyPoints: dailyData.map(d => ({
      date: d.date,
      totalRowsExamined: d.totalRowsExamined,
      totalExecutions: d.totalExecutions,
      avgTimeSec: d.avgTimeSec,
    })),
    daysWithData,
  };
}

/**
 * Chart data from DBA.events_statements_summary_by_digest_history.
 * Computes deltas between consecutive snapshots per digest to derive
 * actual rows examined per interval — real historical I/O rate.
 */
