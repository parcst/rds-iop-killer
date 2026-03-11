import { useState, useEffect } from 'react';
import { useAppStore } from '../store/app-store';
import type { TopStatement, TopConsumer, CloudWatchIopsPoint, InnodbMetrics } from '../api/types';

function formatNumber(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function formatTime(sec: number): string {
  if (sec >= 3600) return (sec / 3600).toFixed(1) + 'h';
  if (sec >= 60) return (sec / 60).toFixed(1) + 'm';
  if (sec >= 1) return sec.toFixed(2) + 's';
  return (sec * 1000).toFixed(1) + 'ms';
}

function extractTable(queryText: string): string {
  const m = queryText.match(/(?:FROM|JOIN|UPDATE|INTO)\s+`?(\w+)`?/i);
  return m ? m[1] : 'unknown';
}

function extractVerb(queryText: string): string {
  return queryText.split(/\s/)[0]?.toUpperCase() || 'QUERY';
}

/** Parse WHERE/JOIN/ORDER BY columns from sample SQL for index suggestions */
function suggestIndexColumns(sampleText: string, table: string): string | null {
  if (!sampleText) return null;
  const cols: string[] = [];
  const seen = new Set<string>();
  const add = (col: string) => {
    const clean = col.replace(/[`'"]/g, '').replace(/^\w+\./, '').toLowerCase();
    if (clean && !seen.has(clean) && clean !== '*' && !/^\d/.test(clean)) {
      seen.add(clean);
      cols.push(clean);
    }
  };

  // Equality conditions in WHERE (highest selectivity — lead the index)
  const whereEq = sampleText.matchAll(/WHERE\s+.*?(?:`?(\w+)`?\s*=\s*(?!NULL))/gi);
  for (const m of whereEq) if (m[1]) add(m[1]);

  // Other WHERE columns
  const whereCols = sampleText.matchAll(/(?:WHERE|AND|OR)\s+`?(?:\w+\.)?`?(\w+)`?\s*(?:=|>|<|IN|BETWEEN|LIKE|IS)/gi);
  for (const m of whereCols) if (m[1]) add(m[1]);

  // JOIN ON columns
  const joinCols = sampleText.matchAll(/ON\s+`?(?:\w+\.)?`?(\w+)`?\s*=\s*`?(?:\w+\.)?`?(\w+)`?/gi);
  for (const m of joinCols) { if (m[1]) add(m[1]); if (m[2]) add(m[2]); }

  // ORDER BY columns (append last — useful for covering index)
  const orderCols = sampleText.matchAll(/ORDER\s+BY\s+`?(?:\w+\.)?`?(\w+)`?/gi);
  for (const m of orderCols) if (m[1]) add(m[1]);

  if (cols.length === 0) return null;
  return `ALTER TABLE \`${table}\` ADD INDEX idx_${table}_${cols.slice(0, 3).join('_')} (${cols.slice(0, 4).map(c => `\`${c}\``).join(', ')})`;
}

/** Detect if a query looks like an analytics/reporting candidate that could be offloaded to OLAP */
function isAnalyticsCandidate(s: TopStatement): { candidate: boolean; reasons: string[] } {
  const q = s.queryText.toUpperCase();
  const reasons: string[] = [];

  // Aggregation patterns
  const hasAgg = /\b(COUNT|SUM|AVG|MIN|MAX|GROUP\s+BY|HAVING)\b/.test(q);
  if (hasAgg) reasons.push('aggregation/GROUP BY');

  // Large scans with low efficiency (examining way more than returning)
  const efficiency = s.totalRowsSent > 0 && s.totalRowsExamined > 0 ? s.totalRowsSent / s.totalRowsExamined : 1;
  if (s.totalRowsExamined > 100000 && efficiency < 0.1) reasons.push('large scan with low return ratio');

  // DISTINCT, subqueries, UNION — common in reporting
  if (/\b(DISTINCT|UNION)\b/.test(q)) reasons.push('DISTINCT/UNION pattern');

  // Date/time range patterns common in reporting
  if (/\b(DATE|BETWEEN|INTERVAL|YEAR|MONTH|WEEK|DAY)\b/.test(q) && hasAgg) reasons.push('time-range aggregation');

  // Very high rows examined per execution (analytical scan)
  if (s.avgRowsExamined > 10000) reasons.push(`${formatNumber(s.avgRowsExamined)} rows/exec scan`);

  // SELECT-only (not a transactional write)
  const isSelect = q.startsWith('SELECT');

  return { candidate: isSelect && reasons.length >= 2, reasons };
}

/** Split by commas that aren't inside parentheses */
function splitTopLevelCommas(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (s[i] === ',' && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

function formatSql(sql: string): string {
  let s = sql.replace(/\s+/g, ' ').trim();
  const topClauses = [
    'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY',
    'LIMIT', 'INSERT INTO', 'UPDATE', 'DELETE FROM', 'SET',
    'VALUES', 'ON DUPLICATE KEY UPDATE', 'UNION ALL', 'UNION',
    'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'OUTER JOIN',
    'CROSS JOIN', 'JOIN', 'ON', 'USING',
  ];
  const sorted = [...topClauses].sort((a, b) => b.length - a.length);
  const clauseRe = new RegExp(`\\b(${sorted.map(c => c.replace(/ /g, '\\s+')).join('|')})\\b`, 'gi');
  s = s.replace(clauseRe, (match) => {
    const upper = match.replace(/\s+/g, ' ').toUpperCase();
    if (/JOIN|^ON$|^USING$/i.test(upper)) return '\n  ' + upper;
    return '\n' + upper;
  });
  const lines = s.split('\n');
  const result: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^SELECT\b/i.test(trimmed)) {
      const afterSelect = trimmed.replace(/^SELECT\s*/i, '');
      const cols = splitTopLevelCommas(afterSelect);
      if (cols.length > 1) {
        result.push('SELECT');
        cols.forEach((col, i) => { result.push('  ' + col.trim() + (i < cols.length - 1 ? ',' : '')); });
        continue;
      }
    }
    result.push(trimmed.startsWith('\n') ? trimmed : line.trimEnd());
  }
  return result.join('\n').replace(/\b(AND|OR)\b/gi, '\n  $1');
}

function StmtRef({ num, onSelect }: { num: number; onSelect: (n: number) => void }) {
  return (
    <button
      onClick={() => onSelect(num)}
      className="inline text-blue-400 hover:text-blue-300 hover:underline font-medium"
      title={`Jump to statement #${num}`}
    >
      [#{num}]
    </button>
  );
}

type RcaSegment = { type: 'text'; value: string } | { type: 'ref'; num: number };

interface HitListItem {
  rank: number;
  stmtNum: number;
  score: number;
  table: string;
  verb: string;
  pct: number;
  problems: string[];
  suggestion: string;
  indexSuggestion: string | null;
  estimatedSavings: number; // estimated rows saveable
  severity: 'critical' | 'high' | 'medium';
  statement: TopStatement;
  concurrent: number;
  effectiveIops: number;
}

interface CwInsights {
  avgQueueDepth: number; maxQueueDepth: number;
  avgReadLatency: number; maxReadLatency: number;
  avgWriteLatency: number; maxWriteLatency: number;
  avgCpu: number; maxCpu: number;
  avgMemMb: number; minMemMb: number;
  avgConns: number; maxConns: number;
  avgBurst: number; minBurst: number;
  avgReadIops: number; avgWriteIops: number; avgTotalIops: number; maxTotalIops: number;
  readIopsPct: number;
  storageSaturated: boolean;
  memoryPressure: boolean;
  burstExhausted: boolean;
  cpuHot: boolean;
  connectionSurge: boolean;
}

interface RdsConfig {
  provisionedIops: number;
  storageType: string;
  allocatedStorageGb: number;
  instanceClass: string;
  engine: string;
  engineVersion: string;
  readReplicaSource: string | null;
  readReplicaIds: string[];
}

function buildHitList(
  statements: TopStatement[],
  consumers: TopConsumer[],
  cloudwatch: CloudWatchIopsPoint[],
  rdsConfig: RdsConfig | null,
  timeRange: { since: string; until: string },
  innodbMetrics: InnodbMetrics | null,
): { executiveSummary: string; summary: RcaSegment[][]; items: HitListItem[]; cwInsights: CwInsights } {
  const totalRows = statements.reduce((sum, s) => sum + s.totalRowsExamined, 0);
  const emptyCw: CwInsights = { avgQueueDepth: 0, maxQueueDepth: 0, avgReadLatency: 0, maxReadLatency: 0, avgWriteLatency: 0, maxWriteLatency: 0, avgCpu: 0, maxCpu: 0, avgMemMb: 0, minMemMb: 0, avgConns: 0, maxConns: 0, avgBurst: -1, minBurst: -1, avgReadIops: 0, avgWriteIops: 0, avgTotalIops: 0, maxTotalIops: 0, readIopsPct: 50, storageSaturated: false, memoryPressure: false, burstExhausted: false, cpuHot: false, connectionSurge: false };
  if (totalRows === 0) return { executiveSummary: '', summary: [], items: [], cwInsights: emptyCw };

  const consumerByDigest = new Map<string, TopConsumer>();
  for (const c of consumers) consumerByDigest.set(c.digest, c);

  const summary: RcaSegment[][] = [];

  // ── CloudWatch infrastructure analysis ──
  let cwInsights: CwInsights = { ...emptyCw, minMemMb: Infinity };

  if (cloudwatch.length > 0) {
    const n = cloudwatch.length;
    const sum = (fn: (p: CloudWatchIopsPoint) => number) => cloudwatch.reduce((s, p) => s + fn(p), 0);
    const max = (fn: (p: CloudWatchIopsPoint) => number) => Math.max(...cloudwatch.map(fn));
    const min = (fn: (p: CloudWatchIopsPoint) => number) => Math.min(...cloudwatch.map(fn));

    cwInsights.avgQueueDepth = sum(p => p.diskQueueDepth) / n;
    cwInsights.maxQueueDepth = max(p => p.diskQueueDepth);
    cwInsights.avgReadLatency = sum(p => p.readLatencyMs) / n;
    cwInsights.maxReadLatency = max(p => p.readLatencyMs);
    cwInsights.avgWriteLatency = sum(p => p.writeLatencyMs) / n;
    cwInsights.maxWriteLatency = max(p => p.writeLatencyMs);
    cwInsights.avgCpu = sum(p => p.cpuUtilization) / n;
    cwInsights.maxCpu = max(p => p.cpuUtilization);
    cwInsights.avgMemMb = sum(p => p.freeableMemoryMb) / n;
    cwInsights.minMemMb = min(p => p.freeableMemoryMb);
    cwInsights.avgConns = sum(p => p.databaseConnections) / n;
    cwInsights.maxConns = max(p => p.databaseConnections);

    // Read vs Write IOPS (Improvement #9)
    cwInsights.avgReadIops = sum(p => p.readIops) / n;
    cwInsights.avgWriteIops = sum(p => p.writeIops) / n;
    cwInsights.avgTotalIops = sum(p => p.totalIops) / n;
    cwInsights.maxTotalIops = max(p => p.totalIops);
    cwInsights.readIopsPct = (cwInsights.avgReadIops + cwInsights.avgWriteIops) > 0
      ? (cwInsights.avgReadIops / (cwInsights.avgReadIops + cwInsights.avgWriteIops)) * 100 : 50;

    const burstPoints = cloudwatch.filter(p => p.burstBalance >= 0);
    if (burstPoints.length > 0) {
      cwInsights.avgBurst = burstPoints.reduce((s, p) => s + p.burstBalance, 0) / burstPoints.length;
      cwInsights.minBurst = Math.min(...burstPoints.map(p => p.burstBalance));
    }

    cwInsights.storageSaturated = cwInsights.avgQueueDepth > 2 && cwInsights.avgReadLatency > 5;
    cwInsights.memoryPressure = cwInsights.minMemMb < 500 || (cwInsights.avgMemMb > 0 && cwInsights.minMemMb < cwInsights.avgMemMb * 0.5);
    cwInsights.burstExhausted = cwInsights.minBurst >= 0 && cwInsights.minBurst < 20;
    cwInsights.cpuHot = cwInsights.avgCpu > 80;
    cwInsights.connectionSurge = cwInsights.maxConns > cwInsights.avgConns * 2 && cwInsights.maxConns > 50;

    // Storage saturation
    if (cwInsights.storageSaturated) {
      summary.push([{ type: 'text', value: `Storage is saturated \u2014 avg disk queue depth ${cwInsights.avgQueueDepth.toFixed(1)} (peak ${cwInsights.maxQueueDepth.toFixed(1)}) with ${cwInsights.avgReadLatency.toFixed(1)}ms read / ${cwInsights.avgWriteLatency.toFixed(1)}ms write latency. IOPS are bottlenecked at the storage layer.` }]);
    } else if (cwInsights.avgQueueDepth > 1) {
      summary.push([{ type: 'text', value: `Disk queue depth elevated at ${cwInsights.avgQueueDepth.toFixed(1)} avg (peak ${cwInsights.maxQueueDepth.toFixed(1)}) with ${cwInsights.avgReadLatency.toFixed(1)}ms read latency \u2014 storage is under pressure but not fully saturated.` }]);
    }

    // Burst balance
    if (cwInsights.burstExhausted) {
      summary.push([{ type: 'text', value: `Burst balance critically low at ${cwInsights.minBurst.toFixed(0)}% (avg ${cwInsights.avgBurst.toFixed(0)}%) \u2014 IOPS have likely dropped to baseline. Consider upgrading to provisioned IOPS (io1/io2) or increasing gp3 baseline IOPS.` }]);
    } else if (cwInsights.avgBurst >= 0 && cwInsights.avgBurst < 50) {
      summary.push([{ type: 'text', value: `Burst balance declining \u2014 avg ${cwInsights.avgBurst.toFixed(0)}% (low ${cwInsights.minBurst.toFixed(0)}%). Sustained IOPS are consuming burst credits.` }]);
    }

    // Memory pressure
    if (cwInsights.memoryPressure) {
      summary.push([{ type: 'text', value: `Memory pressure detected \u2014 freeable memory dropped to ${cwInsights.minMemMb.toFixed(0)}MB (avg ${cwInsights.avgMemMb.toFixed(0)}MB). Low memory forces the buffer pool to evict cached pages, converting memory-hits into disk reads.` }]);
    }

    // CPU saturation
    if (cwInsights.cpuHot) {
      summary.push([{ type: 'text', value: `CPU utilization high at ${cwInsights.avgCpu.toFixed(0)}% avg (peak ${cwInsights.maxCpu.toFixed(0)}%). CPU-bound workload may be queuing I/O requests.` }]);
    }

    // Connection surge
    if (cwInsights.connectionSurge) {
      summary.push([{ type: 'text', value: `Connection surge \u2014 peak ${cwInsights.maxConns} connections (avg ${cwInsights.avgConns.toFixed(0)}). ${(cwInsights.maxConns / cwInsights.avgConns).toFixed(1)}x spike amplifies concurrent query load.` }]);
    }

    // Provisioned IOPS headroom (Improvement #11)
    if (rdsConfig && rdsConfig.provisionedIops > 0) {
      const headroom = ((rdsConfig.provisionedIops - cwInsights.avgTotalIops) / rdsConfig.provisionedIops) * 100;
      const peakHeadroom = ((rdsConfig.provisionedIops - cwInsights.maxTotalIops) / rdsConfig.provisionedIops) * 100;
      if (peakHeadroom < 0) {
        summary.push([{ type: 'text', value: `IOPS exceeded provisioned capacity \u2014 peak ${Math.round(cwInsights.maxTotalIops)} IOPS vs ${rdsConfig.provisionedIops} provisioned (${Math.abs(peakHeadroom).toFixed(0)}% over limit). Storage is throttled during peaks.` }]);
      } else if (headroom < 15) {
        summary.push([{ type: 'text', value: `Only ${headroom.toFixed(0)}% IOPS headroom remaining (avg ${Math.round(cwInsights.avgTotalIops)} / ${rdsConfig.provisionedIops} provisioned). At risk of throttling under load spikes.` }]);
      }
    }

    // Read vs Write IOPS profile (Improvement #9)
    if (cwInsights.readIopsPct > 70) {
      summary.push([{ type: 'text', value: `IOPS are read-dominated (${cwInsights.readIopsPct.toFixed(0)}% reads, ${(100 - cwInsights.readIopsPct).toFixed(0)}% writes) \u2014 focus on indexing and buffer pool optimization to reduce disk reads.` }]);
    } else if (cwInsights.readIopsPct < 30) {
      summary.push([{ type: 'text', value: `IOPS are write-heavy (${(100 - cwInsights.readIopsPct).toFixed(0)}% writes) \u2014 focus on write amplification, batch operations, and reducing secondary index overhead.` }]);
    }
  }

  // Buffer pool hit ratio (Improvement #1)
  if (innodbMetrics) {
    const bp = innodbMetrics.bufferPool;
    if (bp.avgHitRatio < 99) {
      const missRate = (100 - bp.avgHitRatio).toFixed(2);
      summary.push([{ type: 'text', value: `Buffer pool hit ratio degraded to ${bp.avgHitRatio.toFixed(2)}% (low ${bp.minHitRatio.toFixed(2)}%) \u2014 ${missRate}% of reads are going to disk. Every row scan costs real I/O. ${bp.avgHitRatio < 95 ? 'This is a significant amplifier \u2014 queries that would be fast in memory are hitting disk on every execution.' : 'Slightly below optimal; monitor for further degradation.'}` }]);
    }

    // InnoDB I/O counters (Improvement #2)
    const io = innodbMetrics.ioCounters;
    if (io.totalDataReads > 0 || io.totalDataWrites > 0) {
      const readPct = Math.round(io.readWriteRatio * 100);
      summary.push([{ type: 'text', value: `InnoDB physical I/O: ${formatNumber(io.totalDataReads)} reads / ${formatNumber(io.totalDataWrites)} writes (${readPct}% read). ${io.totalDataReads > io.totalDataWrites * 3 ? 'Read-dominant \u2014 buffer pool misses and table scans are the primary I/O source.' : io.totalDataWrites > io.totalDataReads ? 'Write-dominant \u2014 DML operations, transaction logging, and secondary index maintenance are driving I/O.' : 'Balanced read/write I/O mix.'}` }]);
    }
  }

  // Storage type advice (Improvement #10)
  if (rdsConfig && cwInsights.avgTotalIops > 0) {
    const st = rdsConfig.storageType.toLowerCase();
    if (st.includes('gp2')) {
      const baseline = Math.max(100, rdsConfig.allocatedStorageGb * 3);
      if (cwInsights.avgTotalIops > baseline) {
        summary.push([{ type: 'text', value: `Storage upgrade needed: gp2 ${rdsConfig.allocatedStorageGb}GB has a ${baseline} IOPS baseline, but avg load is ${Math.round(cwInsights.avgTotalIops)} IOPS. Options: (1) switch to gp3 with ${Math.ceil(cwInsights.maxTotalIops / 100) * 100} provisioned IOPS, (2) increase volume to ${Math.ceil(cwInsights.avgTotalIops / 3)}GB for adequate gp2 baseline, (3) switch to io1/io2 for guaranteed IOPS.` }]);
      }
    } else if (st.includes('gp3')) {
      const baseline = rdsConfig.provisionedIops > 0 ? rdsConfig.provisionedIops : 3000;
      if (cwInsights.avgTotalIops > baseline * 0.85) {
        summary.push([{ type: 'text', value: `gp3 IOPS nearing limit \u2014 avg ${Math.round(cwInsights.avgTotalIops)} vs ${baseline} provisioned. Consider increasing provisioned IOPS to ${Math.ceil(cwInsights.maxTotalIops * 1.3 / 100) * 100}.` }]);
      }
    }
  }

  // Read replica opportunity
  if (rdsConfig && rdsConfig.readReplicaIds.length > 0) {
    const selectStmts = statements.filter(s => s.queryText.toUpperCase().startsWith('SELECT'));
    const selectPct = selectStmts.reduce((s, q) => s + q.totalRowsExamined, 0) / totalRows * 100;
    if (selectPct > 30) {
      summary.push([{ type: 'text', value: `Read replica available (${rdsConfig.readReplicaIds.join(', ')}): ${selectPct.toFixed(0)}% of I/O is from SELECT queries that could be routed to the replica, reducing IOPS on the primary by up to ${selectPct.toFixed(0)}%.` }]);
    }
  } else if (rdsConfig && rdsConfig.readReplicaIds.length === 0 && !rdsConfig.readReplicaSource) {
    // No replicas exist — suggest creating one if read-heavy
    const selectStmts = statements.filter(s => s.queryText.toUpperCase().startsWith('SELECT'));
    const selectPct = selectStmts.reduce((s, q) => s + q.totalRowsExamined, 0) / totalRows * 100;
    if (selectPct > 60 && cwInsights.avgTotalIops > 0) {
      summary.push([{ type: 'text', value: `No read replicas configured, but ${selectPct.toFixed(0)}% of I/O is from SELECTs. Creating a read replica and routing read traffic to it could significantly reduce primary IOPS.` }]);
    }
  }

  // ── Cross-statement pattern detection ──
  const meaningful = statements.filter(s => s.totalExecutions > 5);
  const investigationStart = new Date(timeRange.since);

  if (meaningful.length >= 3) {
    const p99Spiked = meaningful.filter(s => s.p99Sec > 0 && s.avgTimeSec > 0 && s.p99Sec > s.avgTimeSec * 5);
    const noIndexCount = meaningful.filter(s => s.noIndexUsed > 0);
    const noGoodIndexCount = meaningful.filter(s => s.noGoodIndexUsed > 0 && s.noIndexUsed === 0);
    const lockBound = meaningful.filter(s => s.totalTimeSec > 0 && s.totalLockTimeSec > s.totalTimeSec * 0.3);
    const tmpDiskCount = meaningful.filter(s => s.tmpDiskTables > 0);
    const highScanCount = meaningful.filter(s => s.avgRowsExamined > 500);
    // New queries that appeared during the window (Improvement #6)
    const newQueries = meaningful.filter(s => s.firstSeen && new Date(s.firstSeen) >= investigationStart);

    if (p99Spiked.length >= meaningful.length * 0.5) {
      const avgMultiple = p99Spiked.reduce((s, q) => s + q.p99Sec / q.avgTimeSec, 0) / p99Spiked.length;
      let cause = 'This points to intermittent infrastructure-level contention affecting all queries';
      if (cwInsights.storageSaturated) cause = 'Storage saturation is the likely cause \u2014 disk queue depth is forcing all queries to wait for I/O';
      else if (cwInsights.burstExhausted) cause = 'Burst balance exhaustion is throttling IOPS, causing intermittent stalls across all queries';
      else if (cwInsights.memoryPressure) cause = 'Low freeable memory is causing buffer pool churn \u2014 pages are being evicted mid-query';
      else if (cwInsights.connectionSurge) cause = 'Connection surge is creating I/O contention as queries compete for disk resources';
      else if (innodbMetrics && innodbMetrics.bufferPool.avgHitRatio < 98) cause = `Buffer pool hit ratio at ${innodbMetrics.bufferPool.avgHitRatio.toFixed(1)}% \u2014 frequent cache misses are forcing disk reads on most queries`;
      summary.push([{ type: 'text', value: `Systemic latency pattern: ${p99Spiked.length} of ${meaningful.length} queries have P99 latency ${avgMultiple.toFixed(0)}x their average. ${cause} \u2014 not just individual query problems.` }]);
    }

    if (noIndexCount.length >= meaningful.length * 0.4) {
      summary.push([{ type: 'text', value: `Indexing gap: ${noIndexCount.length} of ${meaningful.length} active queries running without indexes. Schema-level issue \u2014 bulk index review needed.` }]);
    }

    // noGoodIndexUsed systemic pattern (Improvement #5)
    if (noGoodIndexCount.length >= meaningful.length * 0.3) {
      summary.push([{ type: 'text', value: `Widespread suboptimal indexes: ${noGoodIndexCount.length} of ${meaningful.length} queries are using indexes that MySQL considers poor quality. Review composite index column ordering and selectivity.` }]);
    }

    if (lockBound.length >= meaningful.length * 0.3) {
      summary.push([{ type: 'text', value: `Widespread lock contention: ${lockBound.length} of ${meaningful.length} queries spending >30% of time waiting for locks. Transaction design issue.` }]);
    }

    if (tmpDiskCount.length >= meaningful.length * 0.3) {
      summary.push([{ type: 'text', value: `Widespread temp table spills: ${tmpDiskCount.length} of ${meaningful.length} queries creating on-disk temp tables. Consider increasing tmp_table_size and max_heap_table_size.` }]);
    }

    if (highScanCount.length >= meaningful.length * 0.5) {
      summary.push([{ type: 'text', value: `Scan-heavy workload: ${highScanCount.length} of ${meaningful.length} queries examine >500 rows/exec. Targeted indexing on top offenders will have the biggest impact.` }]);
    }

    // New query detection (Improvement #6 + #13 time correlation)
    if (newQueries.length > 0) {
      const newPct = newQueries.reduce((s, q) => s + q.totalRowsExamined, 0) / totalRows * 100;
      if (newPct > 5) {
        summary.push([{ type: 'text', value: `${newQueries.length} new query pattern${newQueries.length !== 1 ? 's' : ''} appeared during this window, responsible for ${newPct.toFixed(0)}% of I/O. Likely from a deployment or new code path.` }]);
      }
    }

    // OLAP offload pattern detection
    const olapCandidates = meaningful.filter(s => isAnalyticsCandidate(s).candidate);
    if (olapCandidates.length >= 2) {
      const olapPct = olapCandidates.reduce((s, q) => s + q.totalRowsExamined, 0) / totalRows * 100;
      summary.push([{ type: 'text', value: `${olapCandidates.length} of ${meaningful.length} queries are analytics/reporting patterns (aggregation, large scans, time-range queries) consuming ${olapPct.toFixed(0)}% of I/O. These queries already land in DataBricks/ClickHouse — consider offloading them to the OLAP layer.` }]);
    } else if (olapCandidates.length === 1) {
      const olapPct = olapCandidates[0].totalRowsExamined / totalRows * 100;
      if (olapPct > 10) {
        summary.push([{ type: 'text', value: `Analytics query detected consuming ${olapPct.toFixed(0)}% of I/O — this data already lands in DataBricks/ClickHouse. If latency allows, offload to the OLAP layer.` }]);
      }
    }
  }

  // Summary paragraph
  const totalConcurrent = consumers.reduce((sum, c) => sum + c.concurrentCount, 0);
  const concurrentQueries = consumers.filter(c => c.concurrentCount > 0);
  const summaryParts: RcaSegment[] = [
    { type: 'text', value: `During this window, ${formatNumber(totalRows)} total rows were examined across ${statements.length} distinct query patterns.` },
  ];
  if (totalConcurrent > 0) {
    summaryParts.push({ type: 'text', value: ` ${concurrentQueries.length} pattern${concurrentQueries.length !== 1 ? 's' : ''} running with ${totalConcurrent} concurrent sessions.` });
  }
  summary.push(summaryParts);

  // Table breakdown
  const tableMap = new Map<string, { rows: number; stmtNums: number[] }>();
  for (let i = 0; i < statements.length; i++) {
    const table = extractTable(statements[i].queryText);
    const existing = tableMap.get(table) || { rows: 0, stmtNums: [] };
    existing.rows += statements[i].totalRowsExamined;
    existing.stmtNums.push(i + 1);
    tableMap.set(table, existing);
  }
  const topTables = [...tableMap.entries()].sort((a, b) => b[1].rows - a[1].rows).slice(0, 5);

  const tablePara: RcaSegment[] = [{ type: 'text', value: 'Heaviest tables: ' }];
  topTables.forEach(([table, data], idx) => {
    if (idx > 0) tablePara.push({ type: 'text', value: ', ' });
    const pct = ((data.rows / totalRows) * 100).toFixed(0);
    tablePara.push({ type: 'text', value: `${table} (${pct}% \u2014 ` });
    data.stmtNums.slice(0, 3).forEach((num, ri) => {
      if (ri > 0) tablePara.push({ type: 'text', value: ' ' });
      tablePara.push({ type: 'ref', num });
    });
    if (data.stmtNums.length > 3) tablePara.push({ type: 'text', value: ` +${data.stmtNums.length - 3}` });
    tablePara.push({ type: 'text', value: ')' });
  });
  tablePara.push({ type: 'text', value: '.' });
  summary.push(tablePara);

  // ── Per-statement scoring ──
  const items: HitListItem[] = [];

  for (let i = 0; i < statements.length; i++) {
    const s = statements[i];
    const consumer = consumerByDigest.get(s.digest);
    const pct = (s.totalRowsExamined / totalRows) * 100;
    const table = extractTable(s.queryText);
    const verb = extractVerb(s.queryText);
    const problems: string[] = [];

    let score = pct;
    let multiplier = 1.0;

    const concurrent = consumer?.concurrentCount ?? 0;
    const effectiveIops = consumer?.effectiveIops ?? 0;
    if (concurrent > 1) {
      problems.push(`${concurrent} concurrent sessions`);
      multiplier += Math.min(concurrent * 0.2, 1.0);
    }

    if (s.noIndexUsed > 0) {
      problems.push(`no index (${formatNumber(s.noIndexUsed)}x)`);
      multiplier += 0.3;
    }

    // noGoodIndexUsed (Improvement #5)
    if (s.noGoodIndexUsed > 0 && s.noIndexUsed === 0) {
      problems.push(`suboptimal index (${formatNumber(s.noGoodIndexUsed)}x)`);
      multiplier += 0.15;
    }

    if (s.avgRowsExamined > 500 && s.totalExecutions > 10) {
      problems.push(`${formatNumber(s.avgRowsExamined)} rows/exec`);
      multiplier += 0.2;
    }

    // Rows Sent/Examined efficiency (Improvement #3)
    const efficiency = s.totalRowsExamined > 0 && s.totalRowsSent > 0
      ? s.totalRowsSent / s.totalRowsExamined : 1;
    if (efficiency < 0.01 && s.totalRowsExamined > 1000) {
      problems.push(`${(efficiency * 100).toFixed(2)}% efficient (${formatNumber(Math.round(1 / efficiency))} rows scanned per row returned)`);
      multiplier += 0.25;
    } else if (efficiency < 0.1 && s.totalRowsExamined > 1000) {
      problems.push(`${(efficiency * 100).toFixed(1)}% scan efficiency`);
      multiplier += 0.1;
    }

    // Write amplification (Improvement #4)
    if (['UPDATE', 'DELETE', 'REPLACE'].includes(verb) && s.totalRowsAffected > 0 && s.totalRowsExamined > 0) {
      const writeAmp = s.totalRowsExamined / s.totalRowsAffected;
      if (writeAmp > 10) {
        problems.push(`write amplification ${writeAmp.toFixed(0)}x (scans ${formatNumber(s.totalRowsExamined)} to modify ${formatNumber(s.totalRowsAffected)})`);
        multiplier += 0.2;
      }
    }

    // New query detection (Improvement #6)
    const isNewQuery = s.firstSeen && new Date(s.firstSeen) >= investigationStart;
    if (isNewQuery) {
      problems.push('NEW (first seen in window)');
      multiplier += 0.15;
    }

    if (s.tmpDiskTables > 0) {
      problems.push(`${formatNumber(s.tmpDiskTables)} tmp disk writes`);
      multiplier += 0.15;
    }

    if (s.sortMergePasses > 0) {
      problems.push(`${formatNumber(s.sortMergePasses)} sort spills`);
      multiplier += 0.15;
    }

    if (s.fullJoinCount > 0) {
      problems.push(`full join (${formatNumber(s.fullJoinCount)}x)`);
      multiplier += 0.25;
    }

    if (s.p99Sec > s.avgTimeSec * 10 && s.p99Sec > 1) {
      problems.push(`P99 ${formatTime(s.p99Sec)} (${Math.round(s.p99Sec / s.avgTimeSec)}x avg)`);
      multiplier += 0.15;
    }

    if (s.totalLockTimeSec > s.totalTimeSec * 0.5 && s.totalLockTimeSec > 1) {
      problems.push(`lock-bound (${((s.totalLockTimeSec / s.totalTimeSec) * 100).toFixed(0)}%)`);
      multiplier += 0.2;
    }

    const cpuRatio = s.totalTimeSec > 0 ? s.totalCpuTimeSec / s.totalTimeSec : 0;
    if (cpuRatio > 0.7 && s.totalTimeSec > 1) {
      problems.push(`CPU-bound (${(cpuRatio * 100).toFixed(0)}%)`);
      multiplier -= 0.1;
    } else if (cpuRatio < 0.3 && s.totalTimeSec > 1 && s.totalCpuTimeSec > 0) {
      problems.push(`I/O-bound (${(cpuRatio * 100).toFixed(0)}% CPU)`);
      multiplier += 0.1;
    }

    if (s.totalExecutions > 10000) {
      problems.push(`${formatNumber(s.totalExecutions)} executions`);
      multiplier += 0.1;
    }

    // Buffer pool amplifier (Improvement #1)
    if (innodbMetrics && innodbMetrics.bufferPool.avgHitRatio < 98 && s.totalRowsExamined > 0) {
      multiplier += 0.2; // Every scan is more expensive when buffer pool is missing
    }

    if (cwInsights.memoryPressure && s.totalRowsExamined > 0) multiplier += 0.2;
    if (cwInsights.burstExhausted && pct > 5) multiplier += 0.25;
    if (cwInsights.storageSaturated && cpuRatio < 0.5) multiplier += 0.15;

    score *= multiplier;

    if (effectiveIops > 0 && concurrent > 1) {
      const totalEffective = consumers.reduce((sum, c) => sum + c.effectiveIops, 0);
      if (totalEffective > 0) {
        const effectivePct = (effectiveIops / totalEffective) * 100;
        score = Math.max(score, (score + effectivePct) / 2);
      }
    }

    // Estimated IOPS savings (Improvement #8)
    const idealRows = Math.max(s.totalRowsSent, s.totalRowsAffected, s.totalExecutions);
    const estimatedSavings = Math.max(0, s.totalRowsExamined - idealRows);

    // Index suggestion (Improvement #12)
    const indexSuggestion = (s.noIndexUsed > 0 || s.noGoodIndexUsed > 0 || s.avgRowsExamined > 500)
      ? suggestIndexColumns(s.querySampleText, table) : null;

    // Analytics/OLAP offload candidate detection
    const analytics = isAnalyticsCandidate(s);
    if (analytics.candidate) {
      problems.push('OLAP candidate');
    }

    // Build suggestion
    let suggestion = '';
    if (isNewQuery && pct > 5) {
      suggestion = `New query pattern appeared during the spike \u2014 likely from a deployment or new code path. Review recent changes affecting \`${table}\``;
    } else if (concurrent > 3 && s.avgRowsExamined > 500) {
      suggestion = `${concurrent} concurrent sessions each scanning ${formatNumber(s.avgRowsExamined)} rows \u2014 multiplying IOPS ${concurrent}x. Fix query efficiency first, then reduce concurrency`;
    } else if (concurrent > 3) {
      suggestion = `${concurrent} concurrent sessions amplifying IOPS \u2014 consider connection pooling, query caching, or batching`;
    } else if (s.fullJoinCount > 0) {
      suggestion = `Add an index on the joined table's join column \u2014 MySQL is doing a full scan for every row (${formatNumber(s.fullJoinCount)}x)`;
    } else if (s.totalLockTimeSec > s.totalTimeSec * 0.5 && s.totalLockTimeSec > 1) {
      suggestion = `Lock-bound (${((s.totalLockTimeSec / s.totalTimeSec) * 100).toFixed(0)}% in locks). Investigate long-running transactions or reduce transaction scope`;
    } else if (efficiency < 0.01 && s.totalRowsExamined > 1000) {
      suggestion = `Scanning ${formatNumber(Math.round(1 / efficiency))} rows for every row returned \u2014 add a covering index or narrow the WHERE clause to match the result set`;
    } else if (['UPDATE', 'DELETE'].includes(verb) && s.totalRowsAffected > 0 && s.totalRowsExamined / s.totalRowsAffected > 10) {
      suggestion = `Write amplification: scanning ${formatNumber(s.totalRowsExamined)} rows to modify ${formatNumber(s.totalRowsAffected)} \u2014 add an index on the WHERE clause to locate target rows directly`;
    } else if (s.noIndexUsed > 0 && s.avgRowsExamined > 500) {
      suggestion = `Add an index on \`${table}\` covering this ${verb}'s WHERE/JOIN columns \u2014 full table scans`;
    } else if (s.noGoodIndexUsed > 0) {
      suggestion = `The existing index on \`${table}\` has poor selectivity \u2014 review composite index column order or add a more targeted index`;
    } else if (s.noIndexUsed > 0) {
      suggestion = `Add an index on \`${table}\` for this ${verb} \u2014 MySQL is scanning without any index`;
    } else if (cpuRatio > 0.7 && s.totalTimeSec > 1) {
      suggestion = `CPU-bound query \u2014 optimize computation rather than adding indexes`;
    } else if (s.avgRowsExamined > 5000) {
      suggestion = `Review the index on \`${table}\` \u2014 scanning ${formatNumber(s.avgRowsExamined)} rows/exec suggests low selectivity. Consider a composite index`;
    } else if (s.avgRowsExamined > 500) {
      suggestion = `Optimize the index on \`${table}\` \u2014 ${formatNumber(s.avgRowsExamined)} rows/exec could be reduced`;
    } else if (s.tmpDiskTables > 0 && s.sortMergePasses > 0) {
      suggestion = `Increase tmp_table_size/sort_buffer_size or restructure to avoid disk spills`;
    } else if (s.tmpDiskTables > 0) {
      suggestion = `Creates on-disk temp tables \u2014 simplify GROUP BY/DISTINCT or increase tmp_table_size`;
    } else if (s.sortMergePasses > 0) {
      suggestion = `Sort spills to disk \u2014 add an index matching ORDER BY, or increase sort_buffer_size`;
    } else if (s.p99Sec > s.avgTimeSec * 10 && s.p99Sec > 1) {
      suggestion = `Tail latency issue \u2014 P99 is ${Math.round(s.p99Sec / s.avgTimeSec)}x avg. Likely intermittent I/O contention`;
    } else if (s.totalExecutions > 10000 && pct > 5) {
      suggestion = `Called ${formatNumber(s.totalExecutions)} times \u2014 consider caching, reducing call frequency, or batching`;
    } else if (pct > 10) {
      suggestion = `High volume ${verb} on \`${table}\` \u2014 review if all rows need to be examined`;
    } else {
      suggestion = `Lower priority \u2014 review if this ${verb} on \`${table}\` can be optimized`;
    }

    // Append OLAP offload suggestion
    if (analytics.candidate) {
      suggestion += `\nOLAP offload: This query has ${analytics.reasons.join(', ')} — consider running it against DataBricks/ClickHouse instead of the primary RDS instance.`;
    }

    // Append replica redirect suggestion for read-heavy queries
    if (rdsConfig && rdsConfig.readReplicaIds.length > 0 && verb === 'SELECT' && pct > 3) {
      suggestion += `\nRead replica: Route this SELECT to a read replica (${rdsConfig.readReplicaIds.join(', ')}) to reduce IOPS on the primary.`;
    }

    // Append index suggestion to the text
    if (indexSuggestion) {
      suggestion += `\nSuggested index: ${indexSuggestion}`;
    }

    // Append infrastructure context
    const infraNotes: string[] = [];
    if (concurrent > 1 && !suggestion.startsWith(`${concurrent} concurrent`)) infraNotes.push(`${concurrent} concurrent sessions amplifying impact`);
    if (cwInsights.burstExhausted && pct > 5) infraNotes.push('burst credits exhausted');
    if (cwInsights.memoryPressure && s.avgRowsExamined > 500 && !suggestion.includes('buffer pool')) infraNotes.push('low memory forcing disk reads');
    if (innodbMetrics && innodbMetrics.bufferPool.avgHitRatio < 98) infraNotes.push(`buffer pool ${innodbMetrics.bufferPool.avgHitRatio.toFixed(1)}% hit rate`);
    if (infraNotes.length > 0) suggestion += ` (${infraNotes.join('; ')})`;

    const severity: HitListItem['severity'] = score >= 10 ? 'critical' : score >= 5 ? 'high' : 'medium';

    if (pct >= 3 || problems.length > 0) {
      items.push({ rank: 0, stmtNum: i + 1, score, table, verb, pct, problems, suggestion, indexSuggestion, estimatedSavings, severity, statement: s, concurrent, effectiveIops });
    }
  }

  items.sort((a, b) => b.score - a.score);
  items.forEach((item, i) => { item.rank = i + 1; });

  // Executive summary (Improvement #7)
  const topItems = items.slice(0, 3);
  const topTblNames = [...new Set(topItems.map(i => i.table))].slice(0, 2);
  const topPctSum = topItems.reduce((s, i) => s + i.pct, 0);
  const primaryCauses: string[] = [];
  if (topItems.some(i => i.statement.noIndexUsed > 0)) primaryCauses.push('unindexed queries');
  else if (topItems.some(i => i.statement.avgRowsExamined > 500)) primaryCauses.push('scan-heavy queries');
  if (topItems.some(i => i.concurrent > 3)) primaryCauses.push('high concurrency');
  if (cwInsights.burstExhausted) primaryCauses.push('burst exhaustion');
  else if (cwInsights.storageSaturated) primaryCauses.push('storage saturation');
  if (cwInsights.memoryPressure) primaryCauses.push('memory pressure');
  if (innodbMetrics && innodbMetrics.bufferPool.avgHitRatio < 98) primaryCauses.push(`${innodbMetrics.bufferPool.avgHitRatio.toFixed(1)}% buffer pool hit rate`);

  const causeStr = primaryCauses.length > 0 ? primaryCauses.join(', ') : 'high query volume';
  const tblStr = topTblNames.length > 0 ? ` on \`${topTblNames.join('`, `')}\`` : '';
  const savingsStr = items.slice(0, 3).reduce((s, i) => s + i.estimatedSavings, 0);

  let execSeverity = 'HIGH';
  if (rdsConfig && rdsConfig.provisionedIops > 0 && cwInsights.maxTotalIops > rdsConfig.provisionedIops) execSeverity = 'CRITICAL';
  else if (cwInsights.burstExhausted || cwInsights.storageSaturated) execSeverity = 'CRITICAL';
  else if (items.length > 0 && items[0].severity === 'critical') execSeverity = 'CRITICAL';

  const executiveSummary = `${execSeverity}: IOPS driven by ${causeStr}${tblStr} (top ${topItems.length} queries = ${topPctSum.toFixed(0)}% of I/O). ${savingsStr > 0 ? `Fixing top offenders could eliminate ~${formatNumber(savingsStr)} row scans.` : ''}`;

  return { executiveSummary, summary, items: items.slice(0, 10), cwInsights };
}

const severityColors = {
  critical: 'border-red-500/60 bg-red-950/30',
  high: 'border-orange-500/50 bg-orange-950/20',
  medium: 'border-gray-600 bg-gray-800/50',
};

const severityBadge = {
  critical: 'bg-red-600 text-white',
  high: 'bg-orange-600 text-white',
  medium: 'bg-gray-600 text-gray-200',
};

export function RootCauseAnalysis() {
  const statements = useAppStore((s) => s.topStatements);
  const consumers = useAppStore((s) => s.topConsumers);
  const cloudwatchData = useAppStore((s) => s.cloudwatchData);
  const rdsConfig = useAppStore((s) => s.rdsConfig);
  const timeRange = useAppStore((s) => s.timeRange);
  const innodbMetrics = useAppStore((s) => s.innodbMetrics);
  const isInvestigating = useAppStore((s) => s.timeRange.label === 'Custom');
  const setHighlightedStmt = useAppStore((s) => s.setHighlightedStmt);
  const [selectedItem, setSelectedItem] = useState<HitListItem | null>(null);
  const [detailCwInsights, setDetailCwInsights] = useState<CwInsights | null>(null);

  if (!isInvestigating || statements.length === 0) return null;

  const { executiveSummary, summary, items, cwInsights: cw } = buildHitList(
    statements, consumers, cloudwatchData, rdsConfig, timeRange, innodbMetrics,
  );
  if (summary.length === 0) return null;

  const handleSelect = (num: number) => {
    setHighlightedStmt(num);
    setTimeout(() => { useAppStore.getState().setHighlightedStmt(null); }, 3000);
  };

  const openDetail = (item: HitListItem) => {
    setSelectedItem(item);
    setDetailCwInsights(cw);
  };

  return (
    <div className="rounded bg-gray-800 border border-gray-700 px-3 py-3 space-y-3">
      <div className="text-[10px] text-gray-500 uppercase tracking-wider font-medium">Root Cause Analysis</div>

      {/* Executive Summary (Improvement #7) */}
      {executiveSummary && (
        <div className={`rounded border px-3 py-2 text-[11px] font-medium leading-snug ${
          executiveSummary.startsWith('CRITICAL') ? 'border-red-600/60 bg-red-950/40 text-red-200' : 'border-orange-600/50 bg-orange-950/30 text-orange-200'
        }`}>
          {executiveSummary}
        </div>
      )}

      {/* Summary */}
      <div className="text-[11px] text-gray-300 leading-relaxed space-y-1.5">
        {summary.map((segs, pi) => (
          <p key={pi}>
            {segs.map((seg, si) =>
              seg.type === 'text'
                ? <span key={si}>{seg.value}</span>
                : <StmtRef key={si} num={seg.num} onSelect={handleSelect} />
            )}
          </p>
        ))}
      </div>

      {/* Hit List */}
      {items.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] text-gray-500 uppercase tracking-wider font-medium pt-1 border-t border-gray-700">
            Fix Priority
          </div>
          {items.map((item) => (
            <div
              key={item.stmtNum}
              className={`rounded border px-2.5 py-2 cursor-pointer hover:brightness-125 transition ${severityColors[item.severity]}`}
              onClick={() => openDetail(item)}
            >
              <div className="flex items-start gap-2">
                <span className={`shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded ${severityBadge[item.severity]}`}>
                  #{item.rank}
                </span>
                <div className="min-w-0 space-y-1">
                  <div className="text-[11px] text-gray-200 flex items-center gap-1.5 flex-wrap">
                    <StmtRef num={item.stmtNum} onSelect={handleSelect} />
                    <span className="text-gray-400">{item.verb} on</span>
                    <span className="text-white font-medium">{item.table}</span>
                    <span className="text-gray-500">\u2014</span>
                    <span className="text-orange-400 font-medium">{item.pct.toFixed(0)}% impact</span>
                    {item.estimatedSavings > 0 && (
                      <span className="text-green-400 text-[9px]">~{formatNumber(item.estimatedSavings)} rows saveable</span>
                    )}
                  </div>
                  {item.problems.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {item.problems.map((p, i) => (
                        <span key={i} className={`text-[9px] px-1.5 py-0.5 rounded bg-gray-900/60 border ${
                          p.startsWith('NEW') ? 'text-blue-300 border-blue-900/40'
                            : p === 'OLAP candidate' ? 'text-violet-300 border-violet-900/40'
                            : 'text-red-300 border-red-900/40'
                        }`}>
                          {p}
                        </span>
                      ))}
                    </div>
                  )}
                  <p className="text-[10px] text-gray-400 leading-snug whitespace-pre-line">{item.suggestion}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Detail Modal */}
      {selectedItem && detailCwInsights && (
        <FixDetailModal item={selectedItem} cwInsights={detailCwInsights} innodbMetrics={innodbMetrics} onClose={() => setSelectedItem(null)} />
      )}
    </div>
  );
}

function FixDetailModal({ item, cwInsights, innodbMetrics, onClose }: { item: HitListItem; cwInsights: CwInsights; innodbMetrics: InnodbMetrics | null; onClose: () => void }) {
  const s = item.statement;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const diagnosis: { title: string; content: string; severity: 'critical' | 'warning' | 'info' }[] = [];

  // 1. Core I/O impact
  const efficiencyRatio = s.totalRowsExamined > 0 && s.totalRowsSent > 0 ? s.totalRowsSent / s.totalRowsExamined : 1;
  diagnosis.push({
    title: 'I/O Impact',
    content: `This ${item.verb} on \`${item.table}\` is responsible for ${item.pct.toFixed(1)}% of all rows examined. It scanned ${formatNumber(s.totalRowsExamined)} total rows across ${formatNumber(s.totalExecutions)} executions (${formatNumber(s.avgRowsExamined)} rows/exec).${
      s.totalRowsSent > 0 ? `\n\nScan efficiency: ${(efficiencyRatio * 100).toFixed(2)}% \u2014 ${efficiencyRatio < 0.01 ? 'extremely wasteful, scanning ' + formatNumber(Math.round(1 / efficiencyRatio)) + ' rows for every row returned. A proper index would eliminate >99% of these scans.' : efficiencyRatio < 0.1 ? 'poor efficiency, most scanned rows are discarded.' : 'reasonable efficiency.'}` : ''
    }${item.estimatedSavings > 0 ? `\n\nEstimated savings: ~${formatNumber(item.estimatedSavings)} fewer row scans with proper indexing.` : ''}`,
    severity: item.pct >= 15 ? 'critical' : item.pct >= 5 ? 'warning' : 'info',
  });

  // 2. Index problems
  if (s.noIndexUsed > 0) {
    diagnosis.push({
      title: 'Missing Index',
      content: `MySQL executed this query ${formatNumber(s.noIndexUsed)} times without any index. This forces a full table scan of \`${item.table}\` every time.\n\nTo fix: Run \`EXPLAIN\` and add an index covering the WHERE, JOIN, and ORDER BY columns.${item.indexSuggestion ? `\n\nSuggested: ${item.indexSuggestion}` : ''}`,
      severity: 'critical',
    });
  } else if (s.noGoodIndexUsed > 0) {
    diagnosis.push({
      title: 'Suboptimal Index',
      content: `MySQL found an index but considers it poor quality (${formatNumber(s.noGoodIndexUsed)} executions with bad index). The index exists but isn't selective enough \u2014 MySQL still scans many rows after the index lookup.\n\nTo fix: Review composite index column order. Leading columns should match equality conditions in the WHERE clause, followed by range conditions.${item.indexSuggestion ? `\n\nSuggested: ${item.indexSuggestion}` : ''}`,
      severity: 'warning',
    });
  } else if (s.avgRowsExamined > 500) {
    diagnosis.push({
      title: 'Inefficient Index',
      content: `Scanning ${formatNumber(s.avgRowsExamined)} rows/exec despite using an index. The index isn't selective enough.\n\nTo fix: Run \`EXPLAIN\` and consider a composite index with filtering columns first, then ORDER BY columns.${item.indexSuggestion ? `\n\nSuggested: ${item.indexSuggestion}` : ''}`,
      severity: 'warning',
    });
  }

  // 3. Write amplification
  if (['UPDATE', 'DELETE', 'REPLACE'].includes(item.verb) && s.totalRowsAffected > 0) {
    const writeAmp = s.totalRowsExamined / s.totalRowsAffected;
    if (writeAmp > 10) {
      diagnosis.push({
        title: 'Write Amplification',
        content: `This ${item.verb} scans ${formatNumber(s.totalRowsExamined)} rows to modify only ${formatNumber(s.totalRowsAffected)} (${writeAmp.toFixed(0)}x amplification). Each write also updates secondary indexes, multiplying the disk write cost.\n\nTo fix: Add an index on the WHERE clause columns so MySQL can locate the target rows directly instead of scanning. Also review if secondary indexes on \`${item.table}\` can be consolidated.`,
        severity: writeAmp > 50 ? 'critical' : 'warning',
      });
    }
  }

  // 4. Full joins
  if (s.fullJoinCount > 0) {
    diagnosis.push({
      title: 'Full Table Join',
      content: `${formatNumber(s.fullJoinCount)} JOINs did a full scan of the joined table for every driving row \u2014 multiplicative I/O.\n\nTo fix: Add an index on the joined table's ON/USING column. This typically reduces IOPS by 99%+.`,
      severity: 'critical',
    });
  }

  // 5. Lock contention
  if (s.totalLockTimeSec > s.totalTimeSec * 0.3 && s.totalLockTimeSec > 0.5) {
    diagnosis.push({
      title: 'Lock Contention',
      content: `${((s.totalLockTimeSec / s.totalTimeSec) * 100).toFixed(0)}% of time (${formatTime(s.totalLockTimeSec)}) spent waiting for locks.\n\nTo fix: Look for long-running transactions on \`${item.table}\`. Reduce transaction scope, avoid SELECT ... FOR UPDATE when not needed.`,
      severity: 'warning',
    });
  }

  // 6. Disk spills
  if (s.tmpDiskTables > 0 || s.sortMergePasses > 0) {
    const parts: string[] = [];
    if (s.tmpDiskTables > 0) parts.push(`${formatNumber(s.tmpDiskTables)} temp tables spilled to disk`);
    if (s.sortMergePasses > 0) parts.push(`${formatNumber(s.sortMergePasses)} sort spills`);
    diagnosis.push({
      title: 'Disk Spills',
      content: `${parts.join(' and ')}. Intermediate results exceed memory limits, generating extra write IOPS.\n\nTo fix: (1) Add WHERE clauses to reduce intermediate size, (2) add an index matching ORDER BY, (3) increase tmp_table_size/sort_buffer_size.`,
      severity: 'warning',
    });
  }

  // 7. P99
  if (s.p99Sec > 0 && s.avgTimeSec > 0 && s.p99Sec > s.avgTimeSec * 5) {
    diagnosis.push({
      title: 'Tail Latency',
      content: `P99 (${formatTime(s.p99Sec)}) is ${Math.round(s.p99Sec / s.avgTimeSec)}x the average (${formatTime(s.avgTimeSec)}). 1% of executions are dramatically slower \u2014 typically from I/O contention, lock waits, or buffer pool churn.`,
      severity: 'info',
    });
  }

  // 8. Concurrency
  if (item.concurrent > 1) {
    diagnosis.push({
      title: 'Concurrency Amplification',
      content: `${item.concurrent} sessions running this query simultaneously, multiplying IOPS by ${item.concurrent}x (effective: ${formatNumber(item.effectiveIops)}).\n\nTo fix: (1) Application-level caching, (2) connection pooling, (3) read replicas for SELECTs, (4) batch requests.`,
      severity: item.concurrent > 3 ? 'critical' : 'warning',
    });
  }

  // 9. High frequency
  if (s.totalExecutions > 10000) {
    diagnosis.push({
      title: 'High Execution Frequency',
      content: `Ran ${formatNumber(s.totalExecutions)} times. Even efficient queries generate significant cumulative IOPS at this volume.\n\nTo fix: (1) Cache results, (2) batch with IN(...), (3) debounce rapid-fire calls.`,
      severity: 'warning',
    });
  }

  // 10. New query
  if (item.problems.some(p => p.startsWith('NEW'))) {
    diagnosis.push({
      title: 'New Query Pattern',
      content: `This query pattern first appeared during the investigation window (first seen: ${s.firstSeen ? new Date(s.firstSeen).toLocaleString() : 'unknown'}). It correlates with the IOPS spike and is likely from a recent deployment or new code path.\n\nTo fix: Review recent deployments affecting \`${item.table}\`. If this is intentional new functionality, ensure it has proper indexes.`,
      severity: 'warning',
    });
  }

  // 11. OLAP offload candidate
  const analytics = isAnalyticsCandidate(s);
  if (analytics.candidate) {
    diagnosis.push({
      title: 'OLAP Offload Candidate',
      content: `This query exhibits analytics patterns: ${analytics.reasons.join(', ')}.\n\nSince all user databases land in DataBricks/ClickHouse, this query can potentially be offloaded to the OLAP layer instead of running on the primary RDS instance.\n\nConsiderations:\n• Latency: OLAP queries may have higher latency — suitable for dashboards, reports, and batch jobs, not real-time user-facing requests\n• Freshness: Data in the OLAP layer may lag behind RDS by minutes depending on replication\n• Impact: Offloading eliminates these row scans entirely from the primary, directly reducing IOPS`,
      severity: 'info',
    });
  }

  // 12. Read replica suggestion
  const rdsConfig = useAppStore.getState().rdsConfig;
  if (rdsConfig && item.verb === 'SELECT') {
    if (rdsConfig.readReplicaIds.length > 0 && item.pct > 3) {
      diagnosis.push({
        title: 'Read Replica Available',
        content: `This SELECT is responsible for ${item.pct.toFixed(1)}% of I/O. Read replica${rdsConfig.readReplicaIds.length > 1 ? 's' : ''} available: ${rdsConfig.readReplicaIds.join(', ')}.\n\nRouting this query to a read replica would eliminate its IOPS impact on the primary entirely. Consider:\n• Application-level read/write splitting\n• ProxySQL or MySQL Router for automatic read routing\n• Ensure replica lag is acceptable for this query's consistency requirements`,
        severity: 'warning',
      });
    } else if (rdsConfig.readReplicaIds.length === 0 && !rdsConfig.readReplicaSource && item.pct > 10) {
      diagnosis.push({
        title: 'Consider Read Replica',
        content: `No read replicas configured. This SELECT alone accounts for ${item.pct.toFixed(1)}% of I/O. Creating a read replica and routing read-heavy queries to it could significantly reduce primary IOPS.\n\nAWS RDS supports creating read replicas with minimal downtime.`,
        severity: 'info',
      });
    }
  }

  // 13. Buffer pool context
  if (innodbMetrics && innodbMetrics.bufferPool.avgHitRatio < 99) {
    diagnosis.push({
      title: 'Buffer Pool Impact',
      content: `Buffer pool hit ratio: ${innodbMetrics.bufferPool.avgHitRatio.toFixed(2)}% (low: ${innodbMetrics.bufferPool.minHitRatio.toFixed(2)}%). ${
        innodbMetrics.bufferPool.avgHitRatio < 95
          ? 'Significant miss rate \u2014 every row this query scans has a high chance of hitting disk rather than memory. Reducing scan volume through better indexes will have an amplified effect on actual IOPS.'
          : innodbMetrics.bufferPool.avgHitRatio < 99
            ? 'Slightly elevated miss rate. Rows from this query may be competing with other queries for buffer pool space.'
            : 'Buffer pool is healthy \u2014 most reads are served from memory.'
      }`,
      severity: innodbMetrics.bufferPool.avgHitRatio < 95 ? 'warning' : 'info',
    });
  }

  // 12. Parameter group tuning relevant to this query
  const pg = useAppStore.getState().parameterGroup;
  if (pg) {
    const paramNotes: string[] = [];
    const params = pg.parameters;

    // Buffer pool sizing
    if (params['innodb_buffer_pool_size'] && s.avgRowsExamined > 500) {
      const bpGb = parseInt(params['innodb_buffer_pool_size'].value) / (1024 * 1024 * 1024);
      if (bpGb > 0) paramNotes.push(`innodb_buffer_pool_size = ${bpGb.toFixed(1)}GB${bpGb < 4 ? ' (small — increase to reduce disk reads for this scan-heavy query)' : ''}`);
    }

    // IO capacity for write-heavy queries
    if (params['innodb_io_capacity'] && ['UPDATE', 'DELETE', 'INSERT', 'REPLACE'].includes(item.verb)) {
      paramNotes.push(`innodb_io_capacity = ${params['innodb_io_capacity'].value}${params['innodb_io_capacity_max'] ? `, max = ${params['innodb_io_capacity_max'].value}` : ''}`);
    }

    // Durability settings for write queries
    if (params['innodb_flush_log_at_trx_commit'] && ['UPDATE', 'DELETE', 'INSERT', 'REPLACE'].includes(item.verb)) {
      const v = params['innodb_flush_log_at_trx_commit'].value;
      paramNotes.push(`innodb_flush_log_at_trx_commit = ${v}${v === '1' ? ' (full durability — setting to 2 reduces write I/O per commit)' : v === '2' ? ' (flush once/sec — good write performance)' : ' (no flush — fastest but risky)'}`);
    }

    // Temp table / sort for queries with spills
    if (s.tmpDiskTables > 0 && params['tmp_table_size'] && params['max_heap_table_size']) {
      const ttsMb = parseInt(params['tmp_table_size'].value) / (1024 * 1024);
      const mhtsMb = parseInt(params['max_heap_table_size'].value) / (1024 * 1024);
      paramNotes.push(`tmp_table_size = ${ttsMb.toFixed(0)}MB, max_heap_table_size = ${mhtsMb.toFixed(0)}MB (effective limit: ${Math.min(ttsMb, mhtsMb).toFixed(0)}MB — increase both to reduce disk temp tables)`);
    }

    if (s.sortMergePasses > 0 && params['sort_buffer_size']) {
      const sbKb = parseInt(params['sort_buffer_size'].value) / 1024;
      paramNotes.push(`sort_buffer_size = ${sbKb.toFixed(0)}KB${sbKb < 4096 ? ' — increase to 4-8MB to reduce sort spills' : ''}`);
    }

    if (paramNotes.length > 0) {
      diagnosis.push({
        title: 'Parameter Group Settings',
        content: `From "${pg.name}":\n\n${paramNotes.join('\n')}`,
        severity: 'info',
      });
    }
  }

  // 13. Infrastructure context
  const infraProblems: string[] = [];
  if (cwInsights.storageSaturated) infraProblems.push(`Storage saturated (queue depth ${cwInsights.avgQueueDepth.toFixed(1)}, read latency ${cwInsights.avgReadLatency.toFixed(1)}ms).`);
  if (cwInsights.burstExhausted) infraProblems.push(`Burst balance critically low (${cwInsights.minBurst.toFixed(0)}%) \u2014 IOPS throttled to baseline.`);
  if (cwInsights.memoryPressure) infraProblems.push(`Low memory (${cwInsights.minMemMb.toFixed(0)}MB min) \u2014 buffer pool evictions forcing disk reads.`);
  if (cwInsights.cpuHot) infraProblems.push(`CPU high (${cwInsights.avgCpu.toFixed(0)}% avg) \u2014 may be queuing I/O.`);
  if (cwInsights.connectionSurge) infraProblems.push(`Connection spike to ${cwInsights.maxConns} (${(cwInsights.maxConns / cwInsights.avgConns).toFixed(1)}x normal).`);
  if (infraProblems.length > 0) {
    diagnosis.push({ title: 'Infrastructure Context', content: infraProblems.join('\n\n'), severity: 'warning' });
  }

  const diagColors = { critical: 'border-red-800/60 bg-red-950/20', warning: 'border-orange-800/50 bg-orange-950/15', info: 'border-gray-700 bg-gray-800/40' };
  const diagIconColors = { critical: 'text-red-400', warning: 'text-orange-400', info: 'text-blue-400' };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-lg shadow-2xl w-[640px] max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="px-5 py-3 border-b border-gray-700 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${severityBadge[item.severity]}`}>
                #{item.rank} {item.severity.toUpperCase()}
              </span>
              <span className="text-xs text-orange-400 font-medium">{item.pct.toFixed(1)}% of IOPS</span>
              {item.estimatedSavings > 0 && (
                <span className="text-xs text-green-400">~{formatNumber(item.estimatedSavings)} saveable</span>
              )}
            </div>
            <div className="text-sm text-gray-200 font-medium">
              {item.verb} on <span className="text-white">{item.table}</span>
            </div>
            <div className="text-[10px] text-gray-500 font-mono mt-1 truncate">
              {s.queryText.length > 100 ? s.queryText.slice(0, 100) + '...' : s.queryText}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none shrink-0 mt-0.5">&times;</button>
        </div>

        {/* Stats bar */}
        <div className="px-5 py-2 border-b border-gray-800 flex flex-wrap gap-x-4 gap-y-1 text-[10px]">
          <span className="text-gray-500">Rows: <span className="text-gray-300">{formatNumber(s.totalRowsExamined)}</span></span>
          <span className="text-gray-500">Returned: <span className="text-gray-300">{formatNumber(s.totalRowsSent)}</span></span>
          <span className="text-gray-500">Rows/exec: <span className="text-gray-300">{formatNumber(s.avgRowsExamined)}</span></span>
          <span className="text-gray-500">Execs: <span className="text-gray-300">{formatNumber(s.totalExecutions)}</span></span>
          <span className="text-gray-500">Avg: <span className="text-gray-300">{formatTime(s.avgTimeSec)}</span></span>
          <span className="text-gray-500">P99: <span className="text-gray-300">{s.p99Sec > 0 ? formatTime(s.p99Sec) : '-'}</span></span>
          {s.totalRowsAffected > 0 && <span className="text-gray-500">Affected: <span className="text-gray-300">{formatNumber(s.totalRowsAffected)}</span></span>}
          {item.concurrent > 0 && <span className="text-gray-500">Concurrent: <span className="text-orange-400">{item.concurrent}</span></span>}
        </div>

        {/* Full SQL */}
        <div className="px-5 pt-4 pb-0">
          <div
            className="rounded border border-gray-700 bg-gray-950 p-3 max-h-[200px] overflow-auto cursor-pointer hover:border-gray-500 transition"
            onClick={() => { navigator.clipboard.writeText(formatSql(s.querySampleText || s.queryText)); }}
            title="Click to copy formatted SQL"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-[9px] text-gray-500 uppercase tracking-wider font-medium">Full Query</span>
              <span className="text-[9px] text-gray-600">click to copy</span>
            </div>
            <pre className="text-[11px] text-gray-200 font-mono leading-relaxed whitespace-pre-wrap break-words">{formatSql(s.querySampleText || s.queryText)}</pre>
          </div>
        </div>

        {/* Diagnosis sections */}
        <div className="flex-1 overflow-auto px-5 py-4 space-y-3">
          {diagnosis.map((d, i) => (
            <div key={i} className={`rounded border px-3 py-2.5 ${diagColors[d.severity]}`}>
              <div className="flex items-center gap-1.5 mb-1.5">
                <span className={`text-xs font-semibold ${diagIconColors[d.severity]}`}>{d.title}</span>
              </div>
              <div className="text-[11px] text-gray-300 leading-relaxed whitespace-pre-line">{d.content}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
