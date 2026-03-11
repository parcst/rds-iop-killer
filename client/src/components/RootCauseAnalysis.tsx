import { useState, useEffect } from 'react';
import { useAppStore } from '../store/app-store';
import type { TopStatement, TopConsumer, CloudWatchIopsPoint } from '../api/types';

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
  severity: 'critical' | 'high' | 'medium';
  // Full data for detailed modal
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
  storageSaturated: boolean;
  memoryPressure: boolean;
  burstExhausted: boolean;
  cpuHot: boolean;
  connectionSurge: boolean;
}

function buildHitList(
  statements: TopStatement[],
  consumers: TopConsumer[],
  cloudwatch: CloudWatchIopsPoint[],
): { summary: RcaSegment[][]; items: HitListItem[]; cwInsights: CwInsights } {
  const totalRows = statements.reduce((sum, s) => sum + s.totalRowsExamined, 0);
  const emptyCw: CwInsights = { avgQueueDepth: 0, maxQueueDepth: 0, avgReadLatency: 0, maxReadLatency: 0, avgWriteLatency: 0, maxWriteLatency: 0, avgCpu: 0, maxCpu: 0, avgMemMb: 0, minMemMb: 0, avgConns: 0, maxConns: 0, avgBurst: -1, minBurst: -1, storageSaturated: false, memoryPressure: false, burstExhausted: false, cpuHot: false, connectionSurge: false };
  if (totalRows === 0) return { summary: [], items: [], cwInsights: emptyCw };

  // Build digest → consumer lookup for concurrency data
  const consumerByDigest = new Map<string, TopConsumer>();
  for (const c of consumers) {
    consumerByDigest.set(c.digest, c);
  }

  const summary: RcaSegment[][] = [];

  // ── CloudWatch infrastructure analysis ──
  // Compute aggregate metrics once for use in both summary and per-statement scoring
  let cwInsights: CwInsights = {
    avgQueueDepth: 0, maxQueueDepth: 0,
    avgReadLatency: 0, maxReadLatency: 0,
    avgWriteLatency: 0, maxWriteLatency: 0,
    avgCpu: 0, maxCpu: 0,
    avgMemMb: 0, minMemMb: Infinity,
    avgConns: 0, maxConns: 0,
    avgBurst: -1, minBurst: -1,
    storageSaturated: false,
    memoryPressure: false,
    burstExhausted: false,
    cpuHot: false,
    connectionSurge: false,
  };

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

    const burstPoints = cloudwatch.filter(p => p.burstBalance >= 0);
    if (burstPoints.length > 0) {
      cwInsights.avgBurst = burstPoints.reduce((s, p) => s + p.burstBalance, 0) / burstPoints.length;
      cwInsights.minBurst = Math.min(...burstPoints.map(p => p.burstBalance));
    }

    // Classify infrastructure-level problems
    cwInsights.storageSaturated = cwInsights.avgQueueDepth > 2 && cwInsights.avgReadLatency > 5;
    cwInsights.memoryPressure = cwInsights.minMemMb < 500 || (cwInsights.avgMemMb > 0 && cwInsights.minMemMb < cwInsights.avgMemMb * 0.5);
    cwInsights.burstExhausted = cwInsights.minBurst >= 0 && cwInsights.minBurst < 20;
    cwInsights.cpuHot = cwInsights.avgCpu > 80;
    cwInsights.connectionSurge = cwInsights.maxConns > cwInsights.avgConns * 2 && cwInsights.maxConns > 50;

    // Storage saturation
    if (cwInsights.storageSaturated) {
      summary.push([{
        type: 'text',
        value: `Storage is saturated \u2014 avg disk queue depth ${cwInsights.avgQueueDepth.toFixed(1)} (peak ${cwInsights.maxQueueDepth.toFixed(1)}) with ${cwInsights.avgReadLatency.toFixed(1)}ms read / ${cwInsights.avgWriteLatency.toFixed(1)}ms write latency. IOPS are bottlenecked at the storage layer.`,
      }]);
    } else if (cwInsights.avgQueueDepth > 1) {
      summary.push([{
        type: 'text',
        value: `Disk queue depth elevated at ${cwInsights.avgQueueDepth.toFixed(1)} avg (peak ${cwInsights.maxQueueDepth.toFixed(1)}) with ${cwInsights.avgReadLatency.toFixed(1)}ms read latency \u2014 storage is under pressure but not fully saturated.`,
      }]);
    }

    // Burst balance exhaustion — very common gp2/gp3 root cause
    if (cwInsights.burstExhausted) {
      summary.push([{
        type: 'text',
        value: `Burst balance critically low at ${cwInsights.minBurst.toFixed(0)}% (avg ${cwInsights.avgBurst.toFixed(0)}%) \u2014 IOPS have likely dropped to baseline. This is a storage-tier bottleneck independent of query efficiency. Consider upgrading to provisioned IOPS (io1/io2) or increasing gp3 baseline IOPS.`,
      }]);
    } else if (cwInsights.avgBurst >= 0 && cwInsights.avgBurst < 50) {
      summary.push([{
        type: 'text',
        value: `Burst balance declining \u2014 avg ${cwInsights.avgBurst.toFixed(0)}% (low ${cwInsights.minBurst.toFixed(0)}%). Sustained IOPS are consuming burst credits; may degrade to baseline if load continues.`,
      }]);
    }

    // Memory pressure — causes buffer pool evictions → more disk reads
    if (cwInsights.memoryPressure) {
      summary.push([{
        type: 'text',
        value: `Memory pressure detected \u2014 freeable memory dropped to ${cwInsights.minMemMb.toFixed(0)}MB (avg ${cwInsights.avgMemMb.toFixed(0)}MB). Low memory forces the buffer pool to evict cached pages, converting queries that would normally be memory-hits into disk reads that spike IOPS.`,
      }]);
    }

    // CPU saturation
    if (cwInsights.cpuHot) {
      summary.push([{
        type: 'text',
        value: `CPU utilization high at ${cwInsights.avgCpu.toFixed(0)}% avg (peak ${cwInsights.maxCpu.toFixed(0)}%). CPU-bound workload may be queuing I/O requests, increasing latency and queue depth.`,
      }]);
    }

    // Connection surge
    if (cwInsights.connectionSurge) {
      summary.push([{
        type: 'text',
        value: `Connection surge \u2014 peak ${cwInsights.maxConns} connections (avg ${cwInsights.avgConns.toFixed(0)}). ${(cwInsights.maxConns / cwInsights.avgConns).toFixed(1)}x spike in connections amplifies concurrent query load and IOPS.`,
      }]);
    }
  }

  // ── Cross-statement pattern detection ──
  // Systemic themes across all statements — infrastructure or schema-level issues.
  const meaningful = statements.filter(s => s.totalExecutions > 5);
  if (meaningful.length >= 3) {
    const p99Spiked = meaningful.filter(s => s.p99Sec > 0 && s.avgTimeSec > 0 && s.p99Sec > s.avgTimeSec * 5);
    const noIndexCount = meaningful.filter(s => s.noIndexUsed > 0);
    const lockBound = meaningful.filter(s => s.totalTimeSec > 0 && s.totalLockTimeSec > s.totalTimeSec * 0.3);
    const tmpDiskCount = meaningful.filter(s => s.tmpDiskTables > 0);
    const highScanCount = meaningful.filter(s => s.avgRowsExamined > 500);

    if (p99Spiked.length >= meaningful.length * 0.5) {
      const avgMultiple = p99Spiked.reduce((s, q) => s + q.p99Sec / q.avgTimeSec, 0) / p99Spiked.length;
      let cause = 'This points to intermittent infrastructure-level contention affecting all queries';
      if (cwInsights.storageSaturated) {
        cause = 'Storage saturation is the likely cause \u2014 disk queue depth is forcing all queries to wait for I/O';
      } else if (cwInsights.burstExhausted) {
        cause = 'Burst balance exhaustion is throttling IOPS, causing intermittent stalls across all queries';
      } else if (cwInsights.memoryPressure) {
        cause = 'Low freeable memory is causing buffer pool churn \u2014 pages are being evicted mid-query, forcing repeated disk reads';
      } else if (cwInsights.connectionSurge) {
        cause = 'Connection surge is creating I/O contention as queries compete for disk resources';
      }
      summary.push([{
        type: 'text',
        value: `Systemic latency pattern: ${p99Spiked.length} of ${meaningful.length} queries have P99 latency ${avgMultiple.toFixed(0)}x their average. ${cause} \u2014 not just individual query problems.`,
      }]);
    }

    if (noIndexCount.length >= meaningful.length * 0.4) {
      summary.push([{
        type: 'text',
        value: `Indexing gap: ${noIndexCount.length} of ${meaningful.length} active query patterns are running without indexes. This is a schema-level issue \u2014 consider a bulk index review rather than fixing queries one at a time.`,
      }]);
    }

    if (lockBound.length >= meaningful.length * 0.3) {
      summary.push([{
        type: 'text',
        value: `Widespread lock contention: ${lockBound.length} of ${meaningful.length} queries are spending >30% of their time waiting for locks. This suggests long-running transactions, hot rows, or overly broad locking \u2014 a transaction design issue, not an indexing issue.`,
      }]);
    }

    if (tmpDiskCount.length >= meaningful.length * 0.3) {
      summary.push([{
        type: 'text',
        value: `Widespread temp table spills: ${tmpDiskCount.length} of ${meaningful.length} queries are creating on-disk temp tables. Consider increasing tmp_table_size and max_heap_table_size at the instance level.`,
      }]);
    }

    if (highScanCount.length >= meaningful.length * 0.5) {
      summary.push([{
        type: 'text',
        value: `Scan-heavy workload: ${highScanCount.length} of ${meaningful.length} queries examine >500 rows per execution. This volume of full/partial scans is the primary IOPS driver \u2014 targeted indexing on the top offenders will have the biggest impact.`,
      }]);
    }
  }

  // Summary paragraph — include concurrency overview
  const totalConcurrent = consumers.reduce((sum, c) => sum + c.concurrentCount, 0);
  const concurrentQueries = consumers.filter(c => c.concurrentCount > 0);
  const summaryParts: RcaSegment[] = [
    { type: 'text', value: `During this window, ${formatNumber(totalRows)} total rows were examined across ${statements.length} distinct query patterns.` },
  ];
  if (totalConcurrent > 0) {
    summaryParts.push({
      type: 'text',
      value: ` ${concurrentQueries.length} query pattern${concurrentQueries.length !== 1 ? 's' : ''} currently running with ${totalConcurrent} total concurrent sessions \u2014 amplifying real-time IOPS load.`,
    });
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
    tablePara.push({ type: 'text', value: `${table} (${pct}% — ` });
    data.stmtNums.slice(0, 3).forEach((num, ri) => {
      if (ri > 0) tablePara.push({ type: 'text', value: ' ' });
      tablePara.push({ type: 'ref', num });
    });
    if (data.stmtNums.length > 3) tablePara.push({ type: 'text', value: ` +${data.stmtNums.length - 3}` });
    tablePara.push({ type: 'text', value: ')' });
  });
  tablePara.push({ type: 'text', value: '.' });
  summary.push(tablePara);

  // Score each statement and build hit list
  const items: HitListItem[] = [];

  for (let i = 0; i < statements.length; i++) {
    const s = statements[i];
    const consumer = consumerByDigest.get(s.digest);
    const pct = (s.totalRowsExamined / totalRows) * 100;
    const table = extractTable(s.queryText);
    const verb = extractVerb(s.queryText);
    const problems: string[] = [];

    // Score is driven primarily by actual IOPS impact (rows examined),
    // with problems acting as multipliers/tiebreakers — not overrides.
    // Base: percentage of total rows (0-100 points) — this IS the IOPS impact
    let score = pct;

    // Problems add a multiplier on top of impact, not flat points
    let multiplier = 1.0;

    // Concurrency amplifier from consumers — this is the real-time multiplier
    const concurrent = consumer?.concurrentCount ?? 0;
    const effectiveIops = consumer?.effectiveIops ?? 0;
    if (concurrent > 1) {
      problems.push(`${concurrent} concurrent sessions`);
      // Concurrency directly multiplies IOPS — significant scoring boost
      multiplier += Math.min(concurrent * 0.2, 1.0);
    }

    // No index: makes the impact worse (full table scans)
    if (s.noIndexUsed > 0) {
      problems.push(`no index (${formatNumber(s.noIndexUsed)}x)`);
      multiplier += 0.3;
    }

    // High rows per exec: inefficient scan pattern
    if (s.avgRowsExamined > 500 && s.totalExecutions > 10) {
      problems.push(`${formatNumber(s.avgRowsExamined)} rows/exec`);
      multiplier += 0.2;
    }

    // Tmp disk: extra write IOPS
    if (s.tmpDiskTables > 0) {
      problems.push(`${formatNumber(s.tmpDiskTables)} tmp disk writes`);
      multiplier += 0.15;
    }

    // Sort spill: extra disk I/O
    if (s.sortMergePasses > 0) {
      problems.push(`${formatNumber(s.sortMergePasses)} sort spills`);
      multiplier += 0.15;
    }

    // Full join: no index on joined table (cartesian-style)
    if (s.fullJoinCount > 0) {
      problems.push(`full join (${formatNumber(s.fullJoinCount)}x)`);
      multiplier += 0.25;
    }

    // P99 tail latency
    if (s.p99Sec > s.avgTimeSec * 10 && s.p99Sec > 1) {
      problems.push(`P99 ${formatTime(s.p99Sec)} (${Math.round(s.p99Sec / s.avgTimeSec)}x avg)`);
      multiplier += 0.15;
    }

    // Lock-bound detection
    if (s.totalLockTimeSec > s.totalTimeSec * 0.5 && s.totalLockTimeSec > 1) {
      problems.push(`lock-bound (${((s.totalLockTimeSec / s.totalTimeSec) * 100).toFixed(0)}%)`);
      multiplier += 0.2;
    }

    // CPU vs I/O classification
    const cpuRatio = s.totalTimeSec > 0 ? s.totalCpuTimeSec / s.totalTimeSec : 0;
    if (cpuRatio > 0.7 && s.totalTimeSec > 1) {
      problems.push(`CPU-bound (${(cpuRatio * 100).toFixed(0)}%)`);
      multiplier -= 0.1; // CPU-bound = less disk I/O impact
    } else if (cpuRatio < 0.3 && s.totalTimeSec > 1 && s.totalCpuTimeSec > 0) {
      problems.push(`I/O-bound (${(cpuRatio * 100).toFixed(0)}% CPU)`);
      multiplier += 0.1;
    }

    // High frequency amplifier
    if (s.totalExecutions > 10000) {
      problems.push(`${formatNumber(s.totalExecutions)} executions`);
      multiplier += 0.1;
    }

    // Infrastructure-aware multipliers from CloudWatch
    // When memory is low, every I/O-heavy query is worse because buffer pool can't cache
    if (cwInsights.memoryPressure && s.totalRowsExamined > 0) {
      multiplier += 0.2;
    }
    // When burst is exhausted, IOPS are throttled — high-IOPS queries are the cause
    if (cwInsights.burstExhausted && pct > 5) {
      multiplier += 0.25;
    }
    // When storage is saturated, I/O-bound queries compound the queue depth
    if (cwInsights.storageSaturated && cpuRatio < 0.5) {
      multiplier += 0.15;
    }

    score *= multiplier;

    // Effective IOPS from consumers can further boost score for concurrency-amplified queries
    if (effectiveIops > 0 && concurrent > 1) {
      const totalEffective = consumers.reduce((sum, c) => sum + c.effectiveIops, 0);
      if (totalEffective > 0) {
        const effectivePct = (effectiveIops / totalEffective) * 100;
        score = Math.max(score, (score + effectivePct) / 2);
      }
    }

    // Build suggestion — prioritize by severity of the problem
    // Infrastructure context shapes advice when relevant
    let suggestion = '';
    if (concurrent > 3 && s.avgRowsExamined > 500) {
      suggestion = `${concurrent} concurrent sessions each scanning ${formatNumber(s.avgRowsExamined)} rows \u2014 multiplying IOPS ${concurrent}x. Fix query efficiency first (index on ${table}), then reduce concurrency`;
    } else if (concurrent > 3) {
      suggestion = `${concurrent} concurrent sessions amplifying IOPS \u2014 consider connection pooling, query caching, or batching to reduce parallel load on ${table}`;
    } else if (s.fullJoinCount > 0) {
      suggestion = `Add an index on the joined table's join column \u2014 MySQL is doing a full scan of the joined table for every row (${formatNumber(s.fullJoinCount)}x)`;
    } else if (s.totalLockTimeSec > s.totalTimeSec * 0.5 && s.totalLockTimeSec > 1) {
      suggestion = `Lock-bound \u2014 ${((s.totalLockTimeSec / s.totalTimeSec) * 100).toFixed(0)}% of time in locks. Investigate row-level locking conflicts, long-running transactions, or reduce transaction scope`;
    } else if (s.noIndexUsed > 0 && s.avgRowsExamined > 500) {
      suggestion = `Add an index on ${table} covering this ${verb} query's WHERE/JOIN columns \u2014 full table scans`;
      if (cwInsights.memoryPressure) suggestion += '. Memory pressure means these scans bypass the buffer pool entirely';
    } else if (s.noIndexUsed > 0) {
      suggestion = `Add an index on ${table} for this ${verb} \u2014 MySQL is scanning without any index`;
    } else if (cpuRatio > 0.7 && s.totalTimeSec > 1) {
      suggestion = `CPU-bound query \u2014 optimize computation (simplify expressions, reduce result set) rather than adding indexes`;
    } else if (s.avgRowsExamined > 5000) {
      suggestion = `Review the index on ${table} \u2014 scanning ${formatNumber(s.avgRowsExamined)} rows/exec suggests the index isn't selective enough. Consider a composite index`;
    } else if (s.avgRowsExamined > 500) {
      suggestion = `Optimize the index on ${table} \u2014 ${formatNumber(s.avgRowsExamined)} rows/exec could be reduced with a more selective index`;
    } else if (s.tmpDiskTables > 0 && s.sortMergePasses > 0) {
      suggestion = `Increase tmp_table_size/sort_buffer_size or restructure this ${verb} to avoid disk-spill temp tables and sorts`;
    } else if (s.tmpDiskTables > 0) {
      suggestion = `This ${verb} creates on-disk temp tables \u2014 simplify GROUP BY/DISTINCT or increase tmp_table_size`;
    } else if (s.sortMergePasses > 0) {
      suggestion = `Sort spills to disk \u2014 add an index that matches the ORDER BY, or increase sort_buffer_size`;
    } else if (s.p99Sec > s.avgTimeSec * 10 && s.p99Sec > 1) {
      suggestion = `Tail latency issue \u2014 P99 is ${Math.round(s.p99Sec / s.avgTimeSec)}x the average. Likely intermittent I/O contention or lock waits`;
    } else if (s.totalExecutions > 10000 && pct > 5) {
      suggestion = `Called ${formatNumber(s.totalExecutions)} times \u2014 consider caching results, reducing call frequency, or batching`;
    } else if (pct > 10) {
      suggestion = `High volume ${verb} on ${table} \u2014 review if all these rows need to be examined, or if the query can be narrowed`;
    } else {
      suggestion = `Lower priority \u2014 but review if this ${verb} on ${table} can be optimized with better filtering`;
    }

    // Append infrastructure context when it compounds the per-query problem
    const infraNotes: string[] = [];
    if (concurrent > 1 && !suggestion.startsWith(`${concurrent} concurrent`)) {
      infraNotes.push(`${concurrent} concurrent sessions amplifying impact`);
    }
    if (cwInsights.burstExhausted && pct > 5) {
      infraNotes.push('burst credits exhausted \u2014 IOPS throttled to baseline');
    }
    if (cwInsights.memoryPressure && s.avgRowsExamined > 500 && !suggestion.includes('buffer pool')) {
      infraNotes.push('low memory forcing disk reads');
    }
    if (infraNotes.length > 0) {
      suggestion += ` (${infraNotes.join('; ')})`;
    }

    const severity: HitListItem['severity'] =
      score >= 10 ? 'critical' : score >= 5 ? 'high' : 'medium';

    // Only include items that have some meaningful impact or problems
    if (pct >= 3 || problems.length > 0) {
      items.push({ rank: 0, stmtNum: i + 1, score, table, verb, pct, problems, suggestion, severity, statement: s, concurrent, effectiveIops });
    }
  }

  // Sort by score descending and assign ranks
  items.sort((a, b) => b.score - a.score);
  items.forEach((item, i) => { item.rank = i + 1; });

  return { summary, items: items.slice(0, 10), cwInsights };
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
  const isInvestigating = useAppStore((s) => s.timeRange.label === 'Custom');
  const setHighlightedStmt = useAppStore((s) => s.setHighlightedStmt);
  const [selectedItem, setSelectedItem] = useState<HitListItem | null>(null);
  const [detailCwInsights, setDetailCwInsights] = useState<CwInsights | null>(null);

  if (!isInvestigating || statements.length === 0) return null;

  const { summary, items, cwInsights: cw } = buildHitList(statements, consumers, cloudwatchData);
  if (summary.length === 0) return null;

  const handleSelect = (num: number) => {
    setHighlightedStmt(num);
    setTimeout(() => {
      useAppStore.getState().setHighlightedStmt(null);
    }, 3000);
  };

  const openDetail = (item: HitListItem) => {
    setSelectedItem(item);
    setDetailCwInsights(cw);
  };

  return (
    <div className="rounded bg-gray-800 border border-gray-700 px-3 py-3 space-y-3">
      <div className="text-[10px] text-gray-500 uppercase tracking-wider font-medium">Root Cause Analysis</div>

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
                  </div>
                  {item.problems.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {item.problems.map((p, i) => (
                        <span key={i} className="text-[9px] px-1.5 py-0.5 rounded bg-gray-900/60 text-red-300 border border-red-900/40">
                          {p}
                        </span>
                      ))}
                    </div>
                  )}
                  <p className="text-[10px] text-gray-400 leading-snug">{item.suggestion}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Detail Modal */}
      {selectedItem && detailCwInsights && (
        <FixDetailModal item={selectedItem} cwInsights={detailCwInsights} onClose={() => setSelectedItem(null)} />
      )}
    </div>
  );
}

function FixDetailModal({ item, cwInsights, onClose }: { item: HitListItem; cwInsights: CwInsights; onClose: () => void }) {
  const s = item.statement;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Build detailed diagnosis sections
  const diagnosis: { title: string; content: string; severity: 'critical' | 'warning' | 'info' }[] = [];

  // 1. Core I/O impact
  diagnosis.push({
    title: 'I/O Impact',
    content: `This ${item.verb} on \`${item.table}\` is responsible for ${item.pct.toFixed(1)}% of all rows examined in this time window. It scanned ${formatNumber(s.totalRowsExamined)} total rows across ${formatNumber(s.totalExecutions)} executions (${formatNumber(s.avgRowsExamined)} rows per execution). ${s.avgRowsExamined > 5000 ? 'This is an extremely high scan rate per execution \u2014 the query is likely performing full or near-full table scans.' : s.avgRowsExamined > 500 ? 'This scan rate suggests the query is using an index but it\'s not selective enough, or part of the query bypasses the index.' : 'The per-execution scan rate is moderate, but the frequency of execution makes it a significant IOPS contributor.'}`,
    severity: item.pct >= 15 ? 'critical' : item.pct >= 5 ? 'warning' : 'info',
  });

  // 2. Index problems
  if (s.noIndexUsed > 0) {
    diagnosis.push({
      title: 'Missing Index',
      content: `MySQL executed this query ${formatNumber(s.noIndexUsed)} times without using any index at all. This forces a full table scan of \`${item.table}\` for every execution, reading every row from disk. This is the most common and impactful cause of IOPS spikes.\n\nTo fix: Run \`EXPLAIN\` on this query and add an index covering the columns in the WHERE, JOIN, and ORDER BY clauses. A composite index matching the query's access pattern will eliminate the full scans entirely.`,
      severity: 'critical',
    });
  } else if (s.avgRowsExamined > 500) {
    diagnosis.push({
      title: 'Inefficient Index',
      content: `The query uses an index but still scans ${formatNumber(s.avgRowsExamined)} rows per execution. This typically means the index isn't selective enough \u2014 MySQL finds the right starting point but has to scan many rows to filter down to the result.\n\nTo fix: Run \`EXPLAIN\` and check the \`rows\` estimate. Consider a composite index that includes the filtering columns (WHERE conditions) as the leading columns, followed by any columns used in ORDER BY. Adding covered columns can also avoid table lookups.`,
      severity: 'warning',
    });
  }

  // 3. Full joins
  if (s.fullJoinCount > 0) {
    diagnosis.push({
      title: 'Full Table Join',
      content: `This query performed ${formatNumber(s.fullJoinCount)} JOINs where MySQL had to do a full scan of the joined table for every row in the driving table. This creates a multiplicative effect \u2014 if the driving table has 1,000 rows and the joined table has 10,000 rows, MySQL examines up to 10 million row combinations.\n\nTo fix: Add an index on the joined table's column that appears in the ON/USING clause. This converts the full scan into an index lookup, typically reducing IOPS by 99%+.`,
      severity: 'critical',
    });
  }

  // 4. Lock contention
  if (s.totalLockTimeSec > s.totalTimeSec * 0.3 && s.totalLockTimeSec > 0.5) {
    const lockPct = ((s.totalLockTimeSec / s.totalTimeSec) * 100).toFixed(0);
    diagnosis.push({
      title: 'Lock Contention',
      content: `${lockPct}% of this query's total time (${formatTime(s.totalLockTimeSec)} of ${formatTime(s.totalTimeSec)}) is spent waiting for locks. The query itself may be fast, but it's blocked by other transactions holding row or table locks.\n\nTo fix: Look for long-running transactions that touch the same rows in \`${item.table}\`. Reduce transaction scope (commit earlier), avoid SELECT ... FOR UPDATE when not needed, and ensure transactions don't hold locks while doing slow operations (API calls, computations). If this is a write-heavy table, consider splitting hot rows or using optimistic locking.`,
      severity: 'warning',
    });
  }

  // 5. Temp tables and sort spills
  if (s.tmpDiskTables > 0 || s.sortMergePasses > 0) {
    const parts: string[] = [];
    if (s.tmpDiskTables > 0) parts.push(`${formatNumber(s.tmpDiskTables)} temporary tables spilled to disk`);
    if (s.sortMergePasses > 0) parts.push(`${formatNumber(s.sortMergePasses)} sort operations spilled to disk`);
    diagnosis.push({
      title: 'Disk Spills',
      content: `This query caused ${parts.join(' and ')}. When intermediate results exceed memory limits (tmp_table_size / sort_buffer_size), MySQL writes them to disk, generating additional write IOPS on top of the read IOPS from the query itself.\n\nTo fix: (1) Restructure the query to reduce intermediate result size \u2014 add WHERE clauses to filter earlier, avoid SELECT *, limit GROUP BY cardinality. (2) Add an index that matches the ORDER BY to eliminate the sort entirely. (3) As a last resort, increase tmp_table_size and sort_buffer_size at the session or instance level, but this trades memory for I/O.`,
      severity: 'warning',
    });
  }

  // 6. P99 tail latency
  if (s.p99Sec > 0 && s.avgTimeSec > 0 && s.p99Sec > s.avgTimeSec * 5) {
    const multiple = Math.round(s.p99Sec / s.avgTimeSec);
    diagnosis.push({
      title: 'Tail Latency',
      content: `The P99 latency (${formatTime(s.p99Sec)}) is ${multiple}x the average (${formatTime(s.avgTimeSec)}). This means 1% of executions are dramatically slower than normal. This is typically caused by intermittent I/O contention (other queries saturating the disk), lock waits (another transaction holding a lock), or buffer pool churn (the data being evicted between executions).\n\nThis is often an infrastructure problem rather than a query problem \u2014 the query is fine most of the time but occasionally hits a wall.`,
      severity: 'info',
    });
  }

  // 7. Concurrency amplification
  if (item.concurrent > 1) {
    diagnosis.push({
      title: 'Concurrency Amplification',
      content: `${item.concurrent} sessions are currently running this query simultaneously, multiplying its IOPS impact by ${item.concurrent}x (effective IOPS: ${formatNumber(item.effectiveIops)}). Each concurrent session does independent disk reads, competing for the same I/O bandwidth.\n\nTo fix: (1) Add application-level caching (Redis, memcached) to reduce how often this query runs. (2) Use connection pooling to limit concurrent executions. (3) If this is a read query, consider read replicas to distribute the load. (4) Batch multiple requests into a single query where possible.`,
      severity: item.concurrent > 3 ? 'critical' : 'warning',
    });
  }

  // 8. High frequency
  if (s.totalExecutions > 10000) {
    diagnosis.push({
      title: 'High Execution Frequency',
      content: `This query ran ${formatNumber(s.totalExecutions)} times in the selected window. Even if each execution is efficient, the sheer volume generates significant cumulative IOPS.\n\nTo fix: (1) Cache results \u2014 if the data doesn't change frequently, cache it at the application layer for even a few seconds. (2) Batch requests \u2014 instead of N individual queries, combine them into a single query with IN(...) or bulk operations. (3) Debounce \u2014 if this is triggered by user actions, add a short delay to coalesce rapid-fire requests.`,
      severity: 'warning',
    });
  }

  // 9. Infrastructure context
  const infraProblems: string[] = [];
  if (cwInsights.storageSaturated) infraProblems.push(`Storage is saturated (queue depth ${cwInsights.avgQueueDepth.toFixed(1)}, read latency ${cwInsights.avgReadLatency.toFixed(1)}ms) \u2014 all queries are competing for limited I/O bandwidth, making this query's impact worse than it would be on a healthy instance.`);
  if (cwInsights.burstExhausted) infraProblems.push(`Burst balance is critically low (${cwInsights.minBurst.toFixed(0)}%) \u2014 IOPS are throttled to baseline. This query is both a cause and a victim: it's consuming burst credits AND suffering from the throttling.`);
  if (cwInsights.memoryPressure) infraProblems.push(`Freeable memory is low (${cwInsights.minMemMb.toFixed(0)}MB min) \u2014 the buffer pool is under pressure, so rows that would normally be cached in memory must be re-read from disk. This inflates the I/O cost of every scan this query does.`);
  if (cwInsights.cpuHot) infraProblems.push(`CPU utilization is high (${cwInsights.avgCpu.toFixed(0)}% avg) \u2014 the instance may be queuing I/O operations behind CPU-bound work, increasing latency.`);
  if (cwInsights.connectionSurge) infraProblems.push(`Connection count spiked to ${cwInsights.maxConns} (${(cwInsights.maxConns / cwInsights.avgConns).toFixed(1)}x normal) \u2014 more connections means more concurrent queries competing for I/O.`);

  if (infraProblems.length > 0) {
    diagnosis.push({
      title: 'Infrastructure Context',
      content: infraProblems.join('\n\n'),
      severity: 'warning',
    });
  }

  const diagColors = {
    critical: 'border-red-800/60 bg-red-950/20',
    warning: 'border-orange-800/50 bg-orange-950/15',
    info: 'border-gray-700 bg-gray-800/40',
  };
  const diagIconColors = { critical: 'text-red-400', warning: 'text-orange-400', info: 'text-blue-400' };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-700 rounded-lg shadow-2xl w-[640px] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-3 border-b border-gray-700 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${severityBadge[item.severity]}`}>
                #{item.rank} {item.severity.toUpperCase()}
              </span>
              <span className="text-xs text-orange-400 font-medium">{item.pct.toFixed(1)}% of IOPS</span>
            </div>
            <div className="text-sm text-gray-200 font-medium">
              {item.verb} on <span className="text-white">{item.table}</span>
            </div>
            <div className="text-[10px] text-gray-500 font-mono mt-1 truncate" title={s.queryText}>
              {s.queryText.length > 100 ? s.queryText.slice(0, 100) + '...' : s.queryText}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none shrink-0 mt-0.5">
            &times;
          </button>
        </div>

        {/* Stats bar */}
        <div className="px-5 py-2 border-b border-gray-800 flex flex-wrap gap-x-4 gap-y-1 text-[10px]">
          <span className="text-gray-500">Rows: <span className="text-gray-300">{formatNumber(s.totalRowsExamined)}</span></span>
          <span className="text-gray-500">Rows/exec: <span className="text-gray-300">{formatNumber(s.avgRowsExamined)}</span></span>
          <span className="text-gray-500">Executions: <span className="text-gray-300">{formatNumber(s.totalExecutions)}</span></span>
          <span className="text-gray-500">Avg time: <span className="text-gray-300">{formatTime(s.avgTimeSec)}</span></span>
          <span className="text-gray-500">P99: <span className="text-gray-300">{s.p99Sec > 0 ? formatTime(s.p99Sec) : '-'}</span></span>
          {item.concurrent > 0 && <span className="text-gray-500">Concurrent: <span className="text-orange-400">{item.concurrent}</span></span>}
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
