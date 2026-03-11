import { useState, useEffect } from 'react';
import { fetchDigestHistory } from '../api/client';
import type { DigestHistoryResult, TopStatement, TopConsumer } from '../api/types';

function formatNumber(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(Math.round(n));
}

function formatTime(sec: number): string {
  if (sec >= 3600) return (sec / 3600).toFixed(1) + 'h';
  if (sec >= 60) return (sec / 60).toFixed(1) + 'm';
  if (sec >= 1) return sec.toFixed(2) + 's';
  return (sec * 1000).toFixed(1) + 'ms';
}

function pctChange(current: number, baseline: number): number | null {
  if (baseline === 0 && current === 0) return null;
  if (baseline === 0) return current > 0 ? 100 : null;
  return ((current - baseline) / baseline) * 100;
}

function ChangeBadge({ current, baseline, inverted = false, format = 'number' }: {
  current: number;
  baseline: number;
  inverted?: boolean; // true = higher is worse (default), false = higher is better
  format?: 'number' | 'time';
}) {
  const pct = pctChange(current, baseline);
  if (pct === null) return <span className="text-gray-600">-</span>;

  const isUp = pct > 0;
  // For most metrics, going up is bad (red). For CPU%, going up could be neutral.
  const isBad = inverted ? !isUp : isUp;
  const color = Math.abs(pct) < 5
    ? 'text-gray-400'
    : isBad
      ? 'text-red-400'
      : 'text-green-400';

  const arrow = isUp ? '\u2191' : '\u2193';
  const sign = isUp ? '+' : '';

  return (
    <span className={`text-[10px] font-medium ${color}`} title={`${sign}${pct.toFixed(1)}% vs 7-day avg`}>
      {arrow} {sign}{pct.toFixed(0)}%
    </span>
  );
}

interface CompareRow {
  label: string;
  current: number;
  baseline: number;
  format: 'number' | 'time';
  inverted?: boolean;
  tip?: string;
}

function truncateQuery(text: string, max = 80): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '...';
}

interface HistoryModalProps {
  digest: string;
  database: string;
  queryText: string;
  currentStats: {
    totalRowsExamined: number;
    totalExecutions: number;
    avgRowsExamined: number;
    totalTimeSec: number;
    avgTimeSec: number;
    p99Sec: number;
    totalLockTimeSec: number;
    totalCpuTimeSec: number;
    noIndexUsed?: number;
    fullJoinCount: number;
    tmpDiskTables?: number;
    sortMergePasses?: number;
  };
  onClose: () => void;
}

export function HistoryModal({ digest, database, queryText, currentStats, onClose }: HistoryModalProps) {
  const [history, setHistory] = useState<DigestHistoryResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    setError('');
    fetchDigestHistory(digest, database)
      .then(setHistory)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [digest, database]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const avg = history?.avgPerDay;

  const rows: CompareRow[] = avg ? [
    { label: 'Total Rows Examined', current: currentStats.totalRowsExamined, baseline: avg.totalRowsExamined, format: 'number', tip: 'Total rows scanned in the selected window vs daily average' },
    { label: 'Executions', current: currentStats.totalExecutions, baseline: avg.totalExecutions, format: 'number', tip: 'How many times this query ran' },
    { label: 'Avg Rows/Exec', current: currentStats.avgRowsExamined, baseline: avg.avgRowsExamined, format: 'number', tip: 'Average rows per execution' },
    { label: 'Total Time', current: currentStats.totalTimeSec, baseline: avg.totalTimeSec, format: 'time', tip: 'Cumulative wall-clock time' },
    { label: 'Avg Time', current: currentStats.avgTimeSec, baseline: avg.avgTimeSec, format: 'time', tip: 'Average execution time' },
    { label: 'P99 Latency', current: currentStats.p99Sec, baseline: avg.p99Sec, format: 'time', tip: '99th percentile latency' },
    { label: 'Lock Time', current: currentStats.totalLockTimeSec, baseline: avg.totalLockTimeSec, format: 'time', tip: 'Time spent waiting for locks' },
    { label: 'CPU Time', current: currentStats.totalCpuTimeSec, baseline: avg.totalCpuTimeSec, format: 'time', tip: 'CPU time consumed' },
    ...(currentStats.noIndexUsed !== undefined ? [{ label: 'No Index', current: currentStats.noIndexUsed, baseline: avg.noIndexUsed, format: 'number' as const, tip: 'Executions without an index' }] : []),
    { label: 'Full Joins', current: currentStats.fullJoinCount, baseline: avg.fullJoinCount, format: 'number', tip: 'JOINs without index on joined table' },
    ...(currentStats.tmpDiskTables !== undefined ? [{ label: 'Tmp Disk Tables', current: currentStats.tmpDiskTables, baseline: avg.tmpDiskTables, format: 'number' as const, tip: 'Temp tables spilled to disk' }] : []),
    ...(currentStats.sortMergePasses !== undefined ? [{ label: 'Sort Spills', current: currentStats.sortMergePasses, baseline: avg.sortMergePasses, format: 'number' as const, tip: 'Sort operations spilled to disk' }] : []),
  ] : [];

  const fmt = (val: number, format: 'number' | 'time') =>
    format === 'time' ? formatTime(val) : formatNumber(val);

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-700 rounded-lg shadow-2xl w-[560px] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-gray-700 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] text-gray-500 uppercase tracking-wider font-medium mb-1">
              7-Day Historical Comparison
            </div>
            <div className="text-xs text-gray-300 font-mono truncate" title={queryText}>
              {truncateQuery(queryText)}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 text-lg leading-none shrink-0 mt-0.5"
          >
            &times;
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto px-4 py-3">
          {loading && (
            <div className="flex items-center justify-center h-32 text-gray-500">
              <div className="flex items-center gap-2">
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span className="text-xs">Loading 7-day history...</span>
              </div>
            </div>
          )}

          {error && (
            <div className="rounded bg-red-900/30 border border-red-700 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}

          {!loading && !error && history && (
            <div className="space-y-4">
              {/* Data coverage note */}
              <div className="text-[10px] text-gray-500">
                Based on {history.daysWithData} day{history.daysWithData !== 1 ? 's' : ''} of data from the last 7 days.
                {history.daysWithData < 3 && ' Limited data may affect accuracy.'}
              </div>

              {/* Comparison table */}
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-500 uppercase tracking-wider text-[10px] border-b border-gray-700">
                    <th className="text-left py-1.5 font-medium">Metric</th>
                    <th className="text-right py-1.5 font-medium">Current</th>
                    <th className="text-right py-1.5 font-medium">7-Day Avg/Day</th>
                    <th className="text-right py-1.5 font-medium">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const pct = pctChange(r.current, r.baseline);
                    const isSignificant = pct !== null && Math.abs(pct) >= 20;
                    return (
                      <tr key={r.label} className={`border-b border-gray-800/50 ${isSignificant ? 'bg-gray-800/30' : ''}`}>
                        <td className="py-1.5 text-gray-400" title={r.tip}>{r.label}</td>
                        <td className="py-1.5 text-right text-gray-200 font-medium">{fmt(r.current, r.format)}</td>
                        <td className="py-1.5 text-right text-gray-400">{fmt(r.baseline, r.format)}</td>
                        <td className="py-1.5 text-right">
                          <ChangeBadge current={r.current} baseline={r.baseline} inverted={r.inverted} format={r.format} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {/* Mini sparkline of daily activity */}
              {history.dailyPoints.length > 1 && (
                <div>
                  <div className="text-[10px] text-gray-500 uppercase tracking-wider font-medium mb-1.5">
                    Daily Rows Examined (7 days)
                  </div>
                  <DailySparkline points={history.dailyPoints} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DailySparkline({ points }: { points: DigestHistoryResult['dailyPoints'] }) {
  const max = Math.max(...points.map(p => p.totalRowsExamined), 1);
  const barWidth = 100 / points.length;

  return (
    <div className="flex items-end gap-0.5 h-12">
      {points.map((p, i) => {
        const h = (p.totalRowsExamined / max) * 100;
        const dayLabel = p.date.slice(5); // MM-DD
        return (
          <div
            key={i}
            className="flex-1 flex flex-col items-center gap-0.5"
            title={`${p.date}: ${formatNumber(p.totalRowsExamined)} rows, ${formatNumber(p.totalExecutions)} execs`}
          >
            <div className="w-full flex items-end justify-center" style={{ height: 32 }}>
              <div
                className="w-full max-w-[20px] rounded-t bg-blue-500/60 hover:bg-blue-500/80 transition-colors"
                style={{ height: `${Math.max(h, 2)}%` }}
              />
            </div>
            <span className="text-[8px] text-gray-600">{dayLabel}</span>
          </div>
        );
      })}
    </div>
  );
}
