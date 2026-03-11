import { useState, useEffect } from 'react';
import { useAppStore } from '../store/app-store';

interface ParamRecommendation {
  param: string;
  currentValue: string;
  suggestedValue: string;
  applyType: 'dynamic' | 'static';
  severity: 'critical' | 'warning' | 'info';
  summary: string;
  pros: string[];
  cons: string[];
  details: string;
}

/** MySQL parameters that require a reboot (static) vs can be applied live (dynamic) */
const STATIC_PARAMS = new Set([
  'innodb_buffer_pool_size', // dynamic in MySQL 8.0+ but RDS may still require reboot for large changes
  'innodb_log_file_size',
  'innodb_redo_log_capacity',
  'innodb_read_io_threads',
  'innodb_write_io_threads',
  'innodb_page_cleaners',
  'max_connections',
  'table_open_cache_instances',
  'innodb_doublewrite',
]);

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(1) + 'GB';
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(0) + 'MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + 'KB';
  return String(bytes);
}

function buildRecommendations(
  params: Record<string, { value: string; source: string }>,
  rdsConfig: { provisionedIops: number; storageType: string; allocatedStorageGb: number; instanceClass: string } | null,
  cwAvgTotalIops: number,
  cwAvgWriteIops: number,
  cwAvgReadIops: number,
  cwAvgMemMb: number,
  hasTmpSpills: boolean,
  hasSortSpills: boolean,
  readIopsPct: number,
): ParamRecommendation[] {
  const recs: ParamRecommendation[] = [];

  // innodb_buffer_pool_size
  const bps = params['innodb_buffer_pool_size'];
  if (bps) {
    const bpBytes = parseInt(bps.value);
    const bpGb = bpBytes / (1024 * 1024 * 1024);
    if (cwAvgMemMb > 0 && bpBytes > 0) {
      const totalEstMb = cwAvgMemMb + bpBytes / (1024 * 1024);
      const bpPct = (bpBytes / (1024 * 1024)) / totalEstMb * 100;
      if (bpPct < 60) {
        const suggestedGb = (totalEstMb * 0.75) / 1024;
        recs.push({
          param: 'innodb_buffer_pool_size',
          currentValue: `${bpGb.toFixed(1)}GB (~${bpPct.toFixed(0)}% of memory)`,
          suggestedValue: `${suggestedGb.toFixed(1)}GB (~75% of memory)`,
          applyType: 'static',
          severity: bpPct < 40 ? 'critical' : 'warning',
          summary: `Buffer pool is ${bpGb.toFixed(1)}GB (~${bpPct.toFixed(0)}% of memory) — increase to 70-80%`,
          pros: [
            'More data cached in memory = fewer disk reads',
            'Reduces ReadIOPS directly — biggest single impact on read-heavy workloads',
            'Improves buffer pool hit ratio, reducing latency for all queries',
          ],
          cons: [
            'Requires instance reboot to apply on RDS',
            'Less memory for OS page cache, tmp tables, and per-connection buffers',
            'If set too high, OS may start swapping — leave ~20-25% for non-InnoDB use',
          ],
          details: `The InnoDB buffer pool is the main memory cache for table and index data. Currently using ${bpGb.toFixed(1)}GB out of an estimated ${(totalEstMb / 1024).toFixed(1)}GB total instance memory (${bpPct.toFixed(0)}%).\n\nAWS recommends 70-80% for dedicated database instances. Every page that fits in the buffer pool is a disk read that doesn't happen. With the current freeable memory at ${cwAvgMemMb.toFixed(0)}MB, there is room to increase.\n\nSet to: ${Math.round(suggestedGb * 1024 * 1024 * 1024)} (${suggestedGb.toFixed(1)}GB)`,
        });
      }
    }
  }

  // innodb_io_capacity
  const ioc = params['innodb_io_capacity'];
  if (ioc) {
    const cap = parseInt(ioc.value);
    const iocMax = params['innodb_io_capacity_max'];
    const capMax = iocMax ? parseInt(iocMax.value) : 0;

    if (rdsConfig && rdsConfig.provisionedIops > 0 && cap < rdsConfig.provisionedIops * 0.5) {
      const suggested = Math.round(rdsConfig.provisionedIops * 0.5);
      recs.push({
        param: 'innodb_io_capacity',
        currentValue: String(cap),
        suggestedValue: `${suggested}-${rdsConfig.provisionedIops}`,
        applyType: 'dynamic',
        severity: 'warning',
        summary: `io_capacity=${cap} is far below provisioned IOPS (${rdsConfig.provisionedIops})`,
        pros: [
          'InnoDB background flushing (dirty pages, change buffer merges) will keep up with write load',
          'Reduces dirty page backlog, preventing stalls during checkpoint flushes',
          'Better utilizes storage IOPS you are already paying for',
        ],
        cons: [
          'Higher background I/O may increase overall IOPS consumption',
          'If storage is already saturated, faster flushing may compete with foreground queries',
        ],
        details: `innodb_io_capacity tells InnoDB how many IOPS to use for background operations (flushing dirty pages, merging change buffer). At ${cap}, InnoDB is throttled far below your provisioned ${rdsConfig.provisionedIops} IOPS.\n\nThis means dirty pages accumulate faster than they're written, leading to periodic burst flushes that cause latency spikes. Set to 50-100% of provisioned IOPS.\n\nAlso ensure innodb_io_capacity_max (currently ${capMax || 'default'}) is at least 2x this value.`,
      });
    } else if (cap < 200 && cwAvgTotalIops > 500) {
      recs.push({
        param: 'innodb_io_capacity',
        currentValue: String(cap),
        suggestedValue: `${Math.min(2000, Math.round(cwAvgTotalIops * 0.5))}`,
        applyType: 'dynamic',
        severity: 'info',
        summary: `io_capacity=${cap} is low for this workload (avg ${Math.round(cwAvgTotalIops)} IOPS)`,
        pros: ['Faster background flushing keeps dirty page count low', 'Reduces checkpoint stalls'],
        cons: ['May increase background IOPS slightly'],
        details: `With an average workload of ${Math.round(cwAvgTotalIops)} IOPS, innodb_io_capacity at ${cap} is conservative. InnoDB will defer flushing, then catch up in bursts that cause latency spikes. Increase to match ~50% of your average IOPS.`,
      });
    }

    if (capMax > 0 && capMax <= cap) {
      recs.push({
        param: 'innodb_io_capacity_max',
        currentValue: String(capMax),
        suggestedValue: `${cap * 2}`,
        applyType: 'dynamic',
        severity: 'warning',
        summary: `io_capacity_max (${capMax}) <= io_capacity (${cap}) — should be 2x or higher`,
        pros: ['Allows InnoDB to burst-flush dirty pages during load spikes', 'Prevents dirty page accumulation'],
        cons: ['Burst flushes may temporarily increase IOPS during recovery'],
        details: `innodb_io_capacity_max sets the ceiling for background flushing during urgent situations (e.g., checkpoint age nearing limit). When max <= capacity, InnoDB cannot burst-flush and may stall foreground queries waiting for free pages.\n\nSet to at least 2x innodb_io_capacity.`,
      });
    }
  }

  // innodb_flush_log_at_trx_commit
  const fltc = params['innodb_flush_log_at_trx_commit'];
  if (fltc && fltc.value === '1' && cwAvgWriteIops > cwAvgReadIops * 2) {
    recs.push({
      param: 'innodb_flush_log_at_trx_commit',
      currentValue: '1 (flush + sync every commit)',
      suggestedValue: '2 (flush every commit, sync once/sec)',
      applyType: 'dynamic',
      severity: 'warning',
      summary: 'Full durability mode with write-heavy workload — setting to 2 reduces write IOPS',
      pros: [
        'Significantly reduces write IOPS — log is flushed to OS cache per commit but only synced to disk once/sec',
        'Can reduce write latency by 50-80% for high-commit workloads',
        'Still very safe — only lose last ~1 second of commits on OS crash (not MySQL crash)',
      ],
      cons: [
        'Up to 1 second of committed transactions can be lost on OS/power failure (MySQL crash is still safe)',
        'Not suitable for financial or compliance workloads requiring strict ACID durability',
        'Replication may see brief inconsistency during crash recovery',
      ],
      details: `With innodb_flush_log_at_trx_commit=1, every COMMIT forces a redo log flush AND fsync to disk. This is the safest setting but generates one disk sync per transaction.\n\nWith value=2, the redo log is written to the OS buffer per commit but only fsynced once per second. MySQL crash is still safe (OS buffer survives). Only OS crash or power failure risks losing the last second.\n\nWith your write-heavy profile (${Math.round(cwAvgWriteIops)} write IOPS vs ${Math.round(cwAvgReadIops)} read IOPS), this change alone could reduce write IOPS substantially.\n\nValue=0 is fastest but risky: redo log only written/fsynced once per second — any crash loses 1 second.`,
    });
  }

  // sync_binlog
  const sb = params['sync_binlog'];
  if (sb && sb.value === '1' && cwAvgWriteIops > 500) {
    recs.push({
      param: 'sync_binlog',
      currentValue: '1 (sync every commit)',
      suggestedValue: '0 or 100-1000',
      applyType: 'dynamic',
      severity: 'info',
      summary: `sync_binlog=1 with ${Math.round(cwAvgWriteIops)} write IOPS — each commit forces a binlog sync`,
      pros: [
        'Setting to 0 lets OS decide when to flush — reduces write IOPS from binlog syncs',
        'Setting to N (e.g., 1000) syncs every N commits — controlled trade-off',
      ],
      cons: [
        'On crash, up to N un-synced binlog events may be lost',
        'Replicas may drift from primary if binlog events are lost during crash',
        'Not recommended if using binlog-based PITR or strict replication guarantees',
      ],
      details: `sync_binlog=1 means every transaction commit also forces an fsync of the binary log. Combined with innodb_flush_log_at_trx_commit=1, this means TWO fsyncs per commit.\n\nFor non-critical workloads or when using crash-safe replication (GTID + semi-sync), setting to 0 or a larger value (100-1000) significantly reduces write I/O.`,
    });
  }

  // tmp_table_size / max_heap_table_size
  const tts = params['tmp_table_size'];
  const mhts = params['max_heap_table_size'];
  if (hasTmpSpills && tts && mhts) {
    const ttsVal = parseInt(tts.value);
    const mhtsVal = parseInt(mhts.value);
    const effectiveMb = Math.min(ttsVal, mhtsVal) / (1024 * 1024);
    if (effectiveMb < 64) {
      const suggestedMb = Math.min(256, Math.max(64, effectiveMb * 4));
      recs.push({
        param: 'tmp_table_size + max_heap_table_size',
        currentValue: `${formatBytes(Math.min(ttsVal, mhtsVal))} effective (tmp=${formatBytes(ttsVal)}, heap=${formatBytes(mhtsVal)})`,
        suggestedValue: `${suggestedMb}MB (set both)`,
        applyType: 'dynamic',
        severity: 'warning',
        summary: `Temp table limit ${effectiveMb.toFixed(0)}MB — queries spilling to disk`,
        pros: [
          'Larger in-memory temp tables mean fewer disk writes for GROUP BY, DISTINCT, UNION, ORDER BY',
          'Directly reduces write IOPS from temp table I/O',
          'Can be applied immediately without reboot',
        ],
        cons: [
          'Each connection can allocate up to this much memory for temp tables',
          'With high max_connections, total memory usage can spike: connections x tmp_table_size',
          'Does not help if query uses BLOB/TEXT columns (always goes to disk)',
        ],
        details: `MySQL creates in-memory temp tables for queries that need intermediate storage (GROUP BY, DISTINCT, subqueries, UNION). The effective limit is the MINIMUM of tmp_table_size and max_heap_table_size — both must be raised together.\n\nCurrently: tmp_table_size=${formatBytes(ttsVal)}, max_heap_table_size=${formatBytes(mhtsVal)} → effective ${effectiveMb.toFixed(0)}MB.\n\nWhen a temp table exceeds this limit, MySQL converts it to an on-disk MyISAM/InnoDB temp table, generating extra disk I/O. Your workload has queries spilling to disk — increasing to ${suggestedMb}MB should reduce this.`,
      });
    }
  }

  // sort_buffer_size
  const sbs = params['sort_buffer_size'];
  if (hasSortSpills && sbs) {
    const sbVal = parseInt(sbs.value);
    const sbKb = sbVal / 1024;
    if (sbKb < 4096) {
      recs.push({
        param: 'sort_buffer_size',
        currentValue: formatBytes(sbVal),
        suggestedValue: '4-8MB',
        applyType: 'dynamic',
        severity: 'info',
        summary: `sort_buffer_size=${formatBytes(sbVal)} with sort spills detected`,
        pros: [
          'Larger sort buffer keeps sorts in memory, avoiding merge passes to disk',
          'Reduces write IOPS from sort file I/O',
        ],
        cons: [
          'Allocated per-connection per-sort — memory usage = connections x sorts x buffer size',
          'Diminishing returns above 8MB; very large values waste memory',
          'Better to add ORDER BY indexes than to increase buffer for chronic sort issues',
        ],
        details: `When a sort operation exceeds sort_buffer_size, MySQL writes intermediate results to disk (sort merge passes). Currently at ${formatBytes(sbVal)}, some queries are spilling.\n\nIncrease to 4-8MB. For persistent sort issues, add an index that matches the ORDER BY clause — this eliminates the sort entirely.`,
      });
    }
  }

  // innodb_read_io_threads / innodb_write_io_threads
  const rit = params['innodb_read_io_threads'];
  if (rit && parseInt(rit.value) < 4 && cwAvgTotalIops > 1000) {
    recs.push({
      param: 'innodb_read_io_threads',
      currentValue: rit.value,
      suggestedValue: '8-16',
      applyType: 'static',
      severity: 'info',
      summary: `read_io_threads=${rit.value} — low for ${Math.round(cwAvgTotalIops)} avg IOPS workload`,
      pros: [
        'More read-ahead and I/O completion threads can process more concurrent read requests',
        'Reduces I/O wait time when multiple queries need disk reads simultaneously',
      ],
      cons: [
        'Requires instance reboot',
        'Marginal benefit if bottleneck is storage throughput rather than thread count',
        'Diminishing returns above 16 threads',
      ],
      details: `innodb_read_io_threads controls how many background threads handle read I/O requests. With ${rit.value} threads and ${Math.round(cwAvgTotalIops)} average IOPS, the thread pool may be a bottleneck.\n\nSet to 8-16 for high-IOPS workloads. Requires reboot.`,
    });
  }

  const wit = params['innodb_write_io_threads'];
  if (wit && parseInt(wit.value) < 4 && cwAvgWriteIops > 500) {
    recs.push({
      param: 'innodb_write_io_threads',
      currentValue: wit.value,
      suggestedValue: '8-16',
      applyType: 'static',
      severity: 'info',
      summary: `write_io_threads=${wit.value} — low for ${Math.round(cwAvgWriteIops)} avg write IOPS`,
      pros: [
        'More write threads can flush dirty pages and handle write completions faster',
        'Reduces write latency under concurrent write load',
      ],
      cons: [
        'Requires instance reboot',
        'Marginal benefit if storage throughput is the bottleneck',
      ],
      details: `innodb_write_io_threads controls background threads for write I/O. With ${wit.value} threads and ${Math.round(cwAvgWriteIops)} average write IOPS, increasing to 8-16 may help.\n\nRequires reboot.`,
    });
  }

  // innodb_lru_scan_depth
  const lsd = params['innodb_lru_scan_depth'];
  if (lsd) {
    const lsdVal = parseInt(lsd.value);
    if (lsdVal > 1024 && cwAvgTotalIops > 500) {
      recs.push({
        param: 'innodb_lru_scan_depth',
        currentValue: String(lsdVal),
        suggestedValue: '256-512',
        applyType: 'dynamic',
        severity: 'info',
        summary: `lru_scan_depth=${lsdVal} — high value increases background I/O`,
        pros: [
          'Lower value means page cleaner threads do less work per cycle, reducing background IOPS',
          'Can free up I/O capacity for foreground queries',
        ],
        cons: [
          'If too low, dirty pages may accumulate and cause checkpoint stalls',
          'May need to increase innodb_io_capacity to compensate',
        ],
        details: `innodb_lru_scan_depth controls how deep the page cleaner threads scan the LRU list per buffer pool instance. At ${lsdVal}, each cleaner iteration processes many pages, consuming background IOPS.\n\nReduce to 256-512 and monitor dirty page percentage. If dirty pages increase, also raise innodb_io_capacity.`,
      });
    }
  }

  // innodb_adaptive_hash_index
  const ahi = params['innodb_adaptive_hash_index'];
  if (ahi && ahi.value === '0' && readIopsPct > 60) {
    recs.push({
      param: 'innodb_adaptive_hash_index',
      currentValue: 'OFF',
      suggestedValue: 'ON',
      applyType: 'dynamic',
      severity: 'info',
      summary: 'Adaptive hash index is OFF — enable for read-heavy point-lookup workloads',
      pros: [
        'Caches frequently accessed index pages in an in-memory hash table',
        'Can significantly speed up point lookups (WHERE id = X) by bypassing B-tree traversal',
        'Reduces CPU cycles and potentially reduces buffer pool page reads',
      ],
      cons: [
        'Uses additional memory from the buffer pool for the hash index',
        'Can cause contention (AHI latch) under very high concurrency — monitor Innodb_adaptive_hash_searches vs Innodb_adaptive_hash_searches_btree',
        'Not beneficial for range scans or analytics workloads',
      ],
      details: `The adaptive hash index (AHI) builds an in-memory hash table for frequently accessed B-tree leaf pages. When a query like WHERE pk = X is common, AHI can resolve it in O(1) instead of O(log n) B-tree traversal.\n\nWith a read-dominated workload (${readIopsPct.toFixed(0)}% reads), enabling AHI may reduce read I/O. Monitor Innodb_adaptive_hash_searches_btree — if it doesn't decrease, AHI isn't helping and can be disabled again.`,
    });
  }

  return recs;
}

function ParamDetailModal({ rec, onClose }: { rec: ParamRecommendation; onClose: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const sevColors = {
    critical: 'border-red-600/60 bg-red-950/40 text-red-200',
    warning: 'border-orange-600/50 bg-orange-950/30 text-orange-200',
    info: 'border-blue-600/40 bg-blue-950/20 text-blue-200',
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-lg shadow-2xl w-[560px] max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="px-5 py-3 border-b border-gray-700 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                rec.applyType === 'dynamic' ? 'bg-green-700 text-white' : 'bg-amber-700 text-white'
              }`}>
                {rec.applyType === 'dynamic' ? 'DYNAMIC' : 'STATIC (reboot)'}
              </span>
              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                rec.severity === 'critical' ? 'bg-red-600 text-white' : rec.severity === 'warning' ? 'bg-orange-600 text-white' : 'bg-gray-600 text-gray-200'
              }`}>
                {rec.severity.toUpperCase()}
              </span>
            </div>
            <div className="text-sm text-white font-mono font-medium">{rec.param}</div>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none shrink-0 mt-0.5">&times;</button>
        </div>

        {/* Values */}
        <div className="px-5 py-2 border-b border-gray-800 text-[11px] space-y-1">
          <div className="flex gap-2">
            <span className="text-gray-500 w-16 shrink-0">Current:</span>
            <span className="text-red-300 font-mono">{rec.currentValue}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-gray-500 w-16 shrink-0">Suggested:</span>
            <span className="text-green-300 font-mono">{rec.suggestedValue}</span>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto px-5 py-4 space-y-3">
          {/* Summary */}
          <div className={`rounded border px-3 py-2 text-[11px] leading-snug ${sevColors[rec.severity]}`}>
            {rec.summary}
          </div>

          {/* Pros */}
          <div>
            <div className="text-[10px] text-green-400 uppercase tracking-wider font-medium mb-1.5">Pros</div>
            <div className="space-y-1">
              {rec.pros.map((p, i) => (
                <div key={i} className="flex gap-2 text-[11px] text-gray-300 leading-snug">
                  <span className="text-green-500 shrink-0 mt-0.5">+</span>
                  <span>{p}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Cons */}
          <div>
            <div className="text-[10px] text-red-400 uppercase tracking-wider font-medium mb-1.5">Cons</div>
            <div className="space-y-1">
              {rec.cons.map((c, i) => (
                <div key={i} className="flex gap-2 text-[11px] text-gray-300 leading-snug">
                  <span className="text-red-500 shrink-0 mt-0.5">-</span>
                  <span>{c}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Details */}
          <div>
            <div className="text-[10px] text-gray-500 uppercase tracking-wider font-medium mb-1.5">Details</div>
            <div className="text-[11px] text-gray-300 leading-relaxed whitespace-pre-line">{rec.details}</div>
          </div>

          {/* Apply type callout */}
          <div className={`rounded border px-3 py-2 text-[11px] leading-snug ${
            rec.applyType === 'dynamic'
              ? 'border-green-800/40 bg-green-950/15 text-green-200'
              : 'border-amber-800/40 bg-amber-950/15 text-amber-200'
          }`}>
            {rec.applyType === 'dynamic'
              ? 'This parameter can be changed live via the RDS parameter group without a reboot. Changes take effect immediately for new connections (some within seconds for all connections).'
              : 'This is a STATIC parameter — changing it in the RDS parameter group will set the instance status to "pending-reboot". The change only takes effect after a manual reboot or during the next maintenance window.'}
          </div>
        </div>
      </div>
    </div>
  );
}

export function ParameterGroupPanel() {
  const rdsConfig = useAppStore((s) => s.rdsConfig);
  const parameterGroup = useAppStore((s) => s.parameterGroup);
  const cloudwatchData = useAppStore((s) => s.cloudwatchData);
  const statements = useAppStore((s) => s.topStatements);
  const isInvestigating = useAppStore((s) => s.timeRange.label === 'Custom');
  const [selectedRec, setSelectedRec] = useState<ParamRecommendation | null>(null);

  if (!parameterGroup || !rdsConfig) {
    if (rdsConfig?.parameterGroupName) {
      return (
        <div className="rounded bg-gray-800 border border-gray-700 px-3 py-3">
          <div className="text-[10px] text-gray-500 uppercase tracking-wider font-medium">Parameter Group</div>
          <div className="text-[10px] text-gray-500 mt-1">Loading parameter group settings...</div>
        </div>
      );
    }
    return null;
  }

  // Compute CloudWatch averages for recommendation context
  const n = cloudwatchData.length || 1;
  const cwAvgTotalIops = cloudwatchData.reduce((s, p) => s + p.totalIops, 0) / n;
  const cwAvgWriteIops = cloudwatchData.reduce((s, p) => s + p.writeIops, 0) / n;
  const cwAvgReadIops = cloudwatchData.reduce((s, p) => s + p.readIops, 0) / n;
  const cwAvgMemMb = cloudwatchData.reduce((s, p) => s + p.freeableMemoryMb, 0) / n;
  const readIopsPct = (cwAvgReadIops + cwAvgWriteIops) > 0
    ? (cwAvgReadIops / (cwAvgReadIops + cwAvgWriteIops)) * 100 : 50;

  const hasTmpSpills = statements.some(s => s.tmpDiskTables > 0);
  const hasSortSpills = statements.some(s => s.sortMergePasses > 0);

  const recs = buildRecommendations(
    parameterGroup.parameters, rdsConfig,
    cwAvgTotalIops, cwAvgWriteIops, cwAvgReadIops, cwAvgMemMb,
    hasTmpSpills, hasSortSpills, readIopsPct,
  );

  // Build current values display
  const p = parameterGroup.parameters;
  const keyValues: { label: string; value: string; modified: boolean }[] = [];
  if (p['innodb_buffer_pool_size']) {
    const gb = parseInt(p['innodb_buffer_pool_size'].value) / (1024 * 1024 * 1024);
    keyValues.push({ label: 'buffer_pool', value: `${gb.toFixed(1)}GB`, modified: p['innodb_buffer_pool_size'].source === 'user' });
  }
  if (p['innodb_io_capacity']) {
    keyValues.push({ label: 'io_cap', value: p['innodb_io_capacity'].value, modified: p['innodb_io_capacity'].source === 'user' });
  }
  if (p['innodb_flush_log_at_trx_commit']) {
    keyValues.push({ label: 'flush_trx', value: p['innodb_flush_log_at_trx_commit'].value, modified: p['innodb_flush_log_at_trx_commit'].source === 'user' });
  }
  if (p['max_connections']) {
    keyValues.push({ label: 'max_conn', value: p['max_connections'].value, modified: p['max_connections'].source === 'user' });
  }
  if (p['tmp_table_size']) {
    const mb = parseInt(p['tmp_table_size'].value) / (1024 * 1024);
    keyValues.push({ label: 'tmp_tbl', value: `${mb.toFixed(0)}MB`, modified: p['tmp_table_size'].source === 'user' });
  }
  if (p['sort_buffer_size']) {
    const kb = parseInt(p['sort_buffer_size'].value) / 1024;
    keyValues.push({ label: 'sort_buf', value: kb >= 1024 ? `${(kb / 1024).toFixed(1)}MB` : `${kb.toFixed(0)}KB`, modified: p['sort_buffer_size'].source === 'user' });
  }

  return (
    <div className="rounded bg-gray-800 border border-gray-700 px-3 py-3 space-y-2">
      <div className="text-[10px] text-gray-500 uppercase tracking-wider font-medium">
        Parameter Group: <span className="text-gray-400">{parameterGroup.name}</span>
      </div>

      {/* Key values */}
      <div className="flex flex-wrap gap-x-2.5 gap-y-0.5">
        {keyValues.map((kv, i) => (
          <span key={i} className="text-[10px]">
            <span className="text-gray-500">{kv.label}:</span>{' '}
            <span className={kv.modified ? 'text-blue-300' : 'text-gray-400'}>{kv.value}</span>
          </span>
        ))}
      </div>

      {/* Recommendations */}
      {recs.length > 0 ? (
        <div className="space-y-1">
          {recs.map((rec, i) => (
            <div
              key={i}
              className={`rounded border px-2.5 py-1.5 cursor-pointer hover:brightness-125 transition flex items-start gap-2 ${
                rec.severity === 'critical' ? 'border-red-500/50 bg-red-950/25'
                  : rec.severity === 'warning' ? 'border-orange-500/40 bg-orange-950/15'
                  : 'border-gray-600 bg-gray-800/50'
              }`}
              onClick={() => setSelectedRec(rec)}
            >
              <span className={`shrink-0 text-[8px] font-bold px-1 py-0.5 rounded mt-0.5 ${
                rec.applyType === 'dynamic' ? 'bg-green-800 text-green-200' : 'bg-amber-800 text-amber-200'
              }`}>
                {rec.applyType === 'dynamic' ? 'DYN' : 'RST'}
              </span>
              <div className="min-w-0">
                <div className="text-[10px] text-gray-200 leading-snug">{rec.summary}</div>
                <div className="text-[9px] text-gray-500 font-mono mt-0.5">{rec.param}</div>
              </div>
            </div>
          ))}
        </div>
      ) : isInvestigating ? (
        <div className="text-[10px] text-green-400/70">No parameter tuning issues detected for this workload.</div>
      ) : (
        <div className="text-[10px] text-gray-500">Investigate a time range for workload-specific recommendations.</div>
      )}

      {/* Detail Modal */}
      {selectedRec && (
        <ParamDetailModal rec={selectedRec} onClose={() => setSelectedRec(null)} />
      )}
    </div>
  );
}
