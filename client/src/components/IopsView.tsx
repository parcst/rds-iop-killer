import { useState, useRef, useEffect, useCallback } from 'react';
import { useAppStore } from '../store/app-store';
import { useIops } from '../hooks/useIops';
import { IopsChart } from './IopsChart';
import { TimeRangePicker } from './TimeRangePicker';
import { HistoryModal } from './HistoryModal';
import type { TopStatement, TopConsumer } from '../api/types';

function Th({ children, tip, className = '' }: { children: React.ReactNode; tip: string; className?: string }) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const thRef = useRef<HTMLTableCellElement>(null);

  const handleEnter = () => {
    setShow(true);
    if (thRef.current) {
      const rect = thRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 6, left: rect.left + rect.width / 2 });
    }
  };

  return (
    <th
      ref={thRef}
      className={`px-4 py-2 font-medium cursor-help ${className}`}
      onMouseEnter={handleEnter}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      {show && pos && (
        <div
          className="fixed z-[9999] w-64 px-3 py-2 rounded bg-gray-700 text-gray-100 text-[11px] leading-relaxed font-normal normal-case tracking-normal shadow-lg pointer-events-none"
          style={{ top: pos.top, left: pos.left, transform: 'translateX(-50%)' }}
        >
          <div className="absolute bottom-full left-1/2 -translate-x-1/2 border-4 border-transparent border-b-gray-700" />
          {tip}
        </div>
      )}
    </th>
  );
}

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

function truncateQuery(text: string, max = 120): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '...';
}

/**
 * Lightweight SQL pretty-printer for MySQL digest queries.
 * Adds newlines + indentation at major clause boundaries.
 */
function formatSql(sql: string): string {
  // Normalize whitespace
  let s = sql.replace(/\s+/g, ' ').trim();

  // Major clauses that start on a new line (no indent)
  const topClauses = [
    'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY',
    'LIMIT', 'INSERT INTO', 'UPDATE', 'DELETE FROM', 'SET',
    'VALUES', 'ON DUPLICATE KEY UPDATE', 'UNION ALL', 'UNION',
    'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'OUTER JOIN',
    'CROSS JOIN', 'JOIN', 'ON', 'USING',
  ];

  // Build regex: match clause keywords at word boundaries (case-insensitive)
  // Sort longest first so "GROUP BY" matches before "GROUP"
  const sorted = [...topClauses].sort((a, b) => b.length - a.length);
  const clauseRe = new RegExp(
    `\\b(${sorted.map(c => c.replace(/ /g, '\\s+')).join('|')})\\b`,
    'gi',
  );

  // Replace clause keywords with newline + keyword
  s = s.replace(clauseRe, (match) => {
    const upper = match.replace(/\s+/g, ' ').toUpperCase();
    // JOIN/ON get indented
    if (/JOIN|^ON$|^USING$/i.test(upper)) {
      return '\n  ' + upper;
    }
    return '\n' + upper;
  });

  // Indent column lists after SELECT (comma-separated items)
  const lines = s.split('\n');
  const result: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // For SELECT line, split columns by commas
    if (/^SELECT\b/i.test(trimmed)) {
      const afterSelect = trimmed.replace(/^SELECT\s*/i, '');
      const cols = splitTopLevelCommas(afterSelect);
      if (cols.length > 1) {
        result.push('SELECT');
        cols.forEach((col, i) => {
          result.push('  ' + col.trim() + (i < cols.length - 1 ? ',' : ''));
        });
        continue;
      }
    }

    result.push(trimmed.startsWith('\n') ? trimmed : line.trimEnd());
  }

  // Indent AND/OR within WHERE
  return result.join('\n').replace(/\b(AND|OR)\b/gi, '\n  $1');
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

function QueryCell({ text, sampleText, onHistory }: { text: string; sampleText?: string; onHistory?: () => void }) {
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);
  // Prefer sample text (real query with actual values) for copy
  const copyTarget = sampleText || text;
  const formatted = formatSql(copyTarget);
  const formattedDigest = sampleText ? formatSql(text) : null;

  const handleClick = () => {
    navigator.clipboard.writeText(formatted).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <td
      className="px-4 py-2 text-gray-200 font-mono relative cursor-pointer max-w-[340px]"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => { setShow(false); setCopied(false); }}
      onClick={handleClick}
    >
      <div className="flex items-center gap-1.5">
        {onHistory && (
          <button
            onClick={(e) => { e.stopPropagation(); onHistory(); }}
            className="shrink-0 text-blue-400 hover:text-blue-300 transition-colors"
            title="Compare with 7-day history"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </button>
        )}
        <span className="truncate">{truncateQuery(text, 80)}</span>
      </div>
      {show && (
        <div className="absolute z-50 left-0 top-full mt-1 max-w-[600px] max-h-[400px] overflow-auto bg-gray-900 border border-gray-600 rounded-lg shadow-xl px-3 py-2 text-[11px] text-gray-200 font-mono whitespace-pre break-all">
          {copied && <div className="text-green-400 text-[10px] mb-1 font-sans">Copied to clipboard!</div>}
          {sampleText && (
            <>
              <div className="text-[9px] text-amber-400 font-sans font-medium mb-1 uppercase tracking-wider">Sample Query (click to copy)</div>
              <div className="mb-2">{formatted}</div>
              <div className="text-[9px] text-gray-500 font-sans font-medium mb-1 uppercase tracking-wider border-t border-gray-700 pt-1.5">Digest Pattern</div>
            </>
          )}
          {formattedDigest || formatted}
        </div>
      )}
    </td>
  );
}

function ImpactCell({ pct }: { pct: number }) {
  const color = pct >= 20 ? 'text-red-400' : pct >= 10 ? 'text-orange-400' : pct >= 5 ? 'text-amber-400' : 'text-gray-500';
  return (
    <td className={`px-4 py-2 text-right text-xs font-medium ${color}`}>
      {pct.toFixed(1)}%
    </td>
  );
}


function useResizable(initial: number, min: number, max: number) {
  const [height, setHeight] = useState(initial);
  const dragging = useRef(false);
  const startY = useRef(0);
  const startH = useRef(0);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    startY.current = e.clientY;
    startH.current = height;

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const delta = ev.clientY - startY.current;
      setHeight(Math.max(min, Math.min(max, startH.current + delta)));
    };
    const onMouseUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [height, min, max]);

  return { height, onMouseDown };
}

interface HistoryTarget {
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
}

export function IopsView() {
  const store = useAppStore();
  const { refresh } = useIops();

  const isInvestigating = store.timeRange.label === 'Custom';
  const [showChart, setShowChart] = useState(true);
  const [historyTarget, setHistoryTarget] = useState<HistoryTarget | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const highlightedStmt = useAppStore((s) => s.highlightedStmt);
  const { height: chartHeight, onMouseDown: onResizeStart } = useResizable(200, 80, 600);

  // Scroll to highlighted statement when it changes
  useEffect(() => {
    if (highlightedStmt !== null && tableRef.current) {
      const row = tableRef.current.querySelector(`[data-stmt="${highlightedStmt}"]`);
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }, [highlightedStmt]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Time Range Picker */}
      <div className="px-6 py-2 border-b border-gray-800 bg-gray-900">
        <TimeRangePicker />
      </div>

      {/* Chart section — collapsible when investigating, always resizable */}
      {isInvestigating ? (
        <div className="border-b border-gray-800">
          <button
            onClick={() => setShowChart(!showChart)}
            className="w-full flex items-center gap-1.5 px-4 py-1 text-[10px] text-gray-500 hover:text-gray-400 bg-gray-900/50"
          >
            <span className={`transition-transform ${showChart ? 'rotate-90' : ''}`}>&#9654;</span>
            IOPS Chart
          </button>
          {showChart && (
            <>
              <div className="bg-gray-950">
                <IopsChart chartHeight={chartHeight} />
              </div>
              <div
                onMouseDown={onResizeStart}
                className="h-1.5 cursor-row-resize bg-gray-800 hover:bg-gray-600 transition-colors flex items-center justify-center"
              >
                <div className="w-8 h-0.5 rounded bg-gray-600" />
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="border-b border-gray-800">
          <div className="bg-gray-950" style={{ height: chartHeight }}>
            <IopsChart />
          </div>
          <div
            onMouseDown={onResizeStart}
            className="h-1.5 cursor-row-resize bg-gray-800 hover:bg-gray-600 transition-colors flex items-center justify-center"
          >
            <div className="w-8 h-0.5 rounded bg-gray-600" />
          </div>
        </div>
      )}

      {/* Prompt to investigate */}
      {!isInvestigating && !store.iopsLoading && store.cloudwatchData.length > 0 && (
        <div className="px-6 py-6 text-center">
          <p className="text-gray-300 text-sm font-medium">Drag across a spike on the chart to investigate root cause</p>
          <p className="text-gray-500 text-xs mt-1">Select a time range on the IOPS chart above to drill into query-level analysis</p>
        </div>
      )}

      {/* Error */}
      {store.iopsError && (
        <div className="mx-6 mt-3 rounded bg-red-900/30 border border-red-700 px-3 py-2 text-xs text-red-300">
          {store.iopsError}
        </div>
      )}

      {/* Investigation section */}
      {isInvestigating && (
        <>
          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-4 px-6 py-2 bg-gray-900 border-b border-gray-800">
            <span className="text-xs font-medium text-gray-300">Top Statements</span>

            <button
              onClick={refresh}
              disabled={store.iopsLoading}
              className="px-3 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-200 disabled:opacity-50 transition-colors"
            >
              {store.iopsLoading ? 'Loading...' : 'Refresh'}
            </button>

            <span className="text-[10px] text-gray-600 ml-auto">
              Highest I/O per individual query pattern
              {store.lastRefreshed && (
                <> &middot; {store.lastRefreshed.toLocaleTimeString()}</>
              )}
            </span>
          </div>

          {/* Table */}
          <div className="flex-1 overflow-auto overflow-x-auto" ref={tableRef}>
            <StatementsTable highlightedStmt={highlightedStmt} onShowHistory={setHistoryTarget} />
          </div>
        </>
      )}

      {/* History Modal */}
      {historyTarget && (
        <HistoryModal
          digest={historyTarget.digest}
          database={historyTarget.database}
          queryText={historyTarget.queryText}
          currentStats={historyTarget.currentStats}
          onClose={() => setHistoryTarget(null)}
        />
      )}
    </div>
  );
}

function formatLastSeen(iso: string, utc: boolean): string {
  if (!iso) return '';
  const d = new Date(iso);
  return utc
    ? d.toLocaleTimeString([], { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : d.toLocaleTimeString();
}

function StatementsTable({ highlightedStmt, onShowHistory }: { highlightedStmt: number | null; onShowHistory: (target: HistoryTarget) => void }) {
  const statements = useAppStore((s) => s.topStatements);
  const loading = useAppStore((s) => s.iopsLoading);
  const showUtc = useAppStore((s) => s.showUtc);

  if (loading && statements.length === 0) return <LoadingState />;
  if (statements.length === 0) return <EmptyState />;

  const totalRows = statements.reduce((sum, s) => sum + s.totalRowsExamined, 0);

  return (
    <div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-gray-500 uppercase tracking-wider border-b border-gray-800 sticky top-0 bg-gray-900 z-10">
            <Th tip="Rank by total I/O impact — #1 is the biggest contributor to IOPS consumption">#</Th>
            <Th tip="Percentage of total rows examined in this time window — shows how much of the IOPS breach this single query is responsible for" className="text-right">Impact</Th>
            <Th tip="The schema/database this query runs against">Database</Th>
            <Th tip="Normalized query pattern (digest) — click to copy the full query text for analysis">Query <span className="text-gray-600 normal-case tracking-normal font-normal">(click to copy)</span></Th>
            <Th tip="Total rows scanned by this query during the time window — each row examined translates to disk reads (IOPS) when data isn't cached in the buffer pool" className="text-right">Total Rows Examined</Th>
            <Th tip="Average rows scanned per execution — high values (>500) suggest missing or inefficient indexes causing full table scans that spike IOPS" className="text-right">Avg Rows/Exec</Th>
            <Th tip="Number of times this query ran during the window — a moderate query executed thousands of times can consume more IOPS than a single heavy query" className="text-right">Executions</Th>
            <Th tip="Average execution time per call — slow queries often indicate disk waits from high IOPS consumption" className="text-right">Avg Time</Th>
            <Th tip="99th percentile latency — worst-case execution time. A low average but high P99 indicates intermittent I/O contention or lock waits" className="text-right">P99</Th>
            <Th tip="Time spent waiting for row/table locks — high lock time means query is lock-bound, not I/O-bound" className="text-right">Lock</Th>
            <Th tip="Executions where MySQL used no index at all — these force full table scans, reading every row from disk and directly spiking IOPS" className="text-right">No Index</Th>
            <Th tip="JOINs with no index on the joined table — causes a full scan of the joined table per row, exponentially multiplying IOPS" className="text-right">Full Join</Th>
            <Th tip="Temporary tables written to disk instead of memory — happens when results exceed tmp_table_size, causing additional disk writes that increase IOPS" className="text-right">Tmp Disk</Th>
            <Th tip="Sort operations that spilled to disk — occurs when sort_buffer_size is exceeded, generating extra disk I/O that adds to IOPS" className="text-right">Sort Spill</Th>
            <Th tip="Most recent time this query was observed — helps identify if it's still actively contributing to IOPS" className="text-right">Last Seen</Th>
          </tr>
        </thead>
        <tbody>
          {statements.map((s, i) => {
            const num = i + 1;
            const pct = totalRows > 0 ? (s.totalRowsExamined / totalRows) * 100 : 0;
            const isCritical = pct >= 15;
            const isHigh = pct >= 8 && !isCritical;
            const isHighlighted = highlightedStmt === num;
            const rowBg = isHighlighted
              ? 'bg-blue-950/60 border-blue-700 ring-1 ring-blue-500/50'
              : isCritical
                ? 'bg-red-950/40 border-red-900/50 hover:bg-red-950/60'
                : isHigh
                  ? 'bg-orange-950/20 border-orange-900/30 hover:bg-orange-950/30'
                  : 'border-gray-800/50 hover:bg-gray-800/50';
            return (
              <tr key={s.digest} data-stmt={num} className={`border-b transition-colors ${rowBg}`}>
                <td className="px-4 py-2 text-gray-600">{num}</td>
                <ImpactCell pct={pct} />
                <td className="px-4 py-2 text-gray-400">{s.db}</td>
                <QueryCell
                  text={s.queryText}
                  sampleText={s.querySampleText || undefined}
                  onHistory={() => onShowHistory({
                    digest: s.digest,
                    database: s.db,
                    queryText: s.queryText,
                    currentStats: {
                      totalRowsExamined: s.totalRowsExamined,
                      totalExecutions: s.totalExecutions,
                      avgRowsExamined: s.avgRowsExamined,
                      totalTimeSec: s.totalTimeSec,
                      avgTimeSec: s.avgTimeSec,
                      p99Sec: s.p99Sec,
                      totalLockTimeSec: s.totalLockTimeSec,
                      totalCpuTimeSec: s.totalCpuTimeSec,
                      noIndexUsed: s.noIndexUsed,
                      fullJoinCount: s.fullJoinCount,
                      tmpDiskTables: s.tmpDiskTables,
                      sortMergePasses: s.sortMergePasses,
                    },
                  })}
                />
                <td className="px-4 py-2 text-right text-orange-400 font-medium">{formatNumber(s.totalRowsExamined)}</td>
                <td className="px-4 py-2 text-right">
                  {s.avgRowsExamined > 500
                    ? <span className="text-amber-400 font-medium" title="High scan count — possible missing index">{formatNumber(s.avgRowsExamined)}</span>
                    : <span className="text-gray-300">{formatNumber(s.avgRowsExamined)}</span>
                  }
                </td>
                <td className="px-4 py-2 text-right text-gray-400">{formatNumber(s.totalExecutions)}</td>
                <td className="px-4 py-2 text-right text-gray-400">{formatTime(s.avgTimeSec)}</td>
                <td className="px-4 py-2 text-right">
                  {s.p99Sec > 0 && s.avgTimeSec > 0 && s.p99Sec > s.avgTimeSec * 5
                    ? <span className="text-amber-400 font-medium" title={`${(s.p99Sec / s.avgTimeSec).toFixed(0)}x avg`}>{formatTime(s.p99Sec)}</span>
                    : <span className="text-gray-400">{s.p99Sec > 0 ? formatTime(s.p99Sec) : '-'}</span>
                  }
                </td>
                <td className="px-4 py-2 text-right">
                  {s.totalTimeSec > 0 && s.totalLockTimeSec > s.totalTimeSec * 0.3
                    ? <span className="text-red-400 font-medium" title={`${((s.totalLockTimeSec / s.totalTimeSec) * 100).toFixed(0)}% of time in locks`}>{formatTime(s.totalLockTimeSec)}</span>
                    : <span className="text-gray-400">{s.totalLockTimeSec > 0 ? formatTime(s.totalLockTimeSec) : '-'}</span>
                  }
                </td>
                <td className="px-4 py-2 text-right">
                  {s.noIndexUsed > 0 ? <span className="text-red-400">{formatNumber(s.noIndexUsed)}</span> : <span className="text-gray-600">0</span>}
                </td>
                <td className="px-4 py-2 text-right">
                  {s.fullJoinCount > 0 ? <span className="text-red-400">{formatNumber(s.fullJoinCount)}</span> : <span className="text-gray-600">0</span>}
                </td>
                <td className="px-4 py-2 text-right">
                  {s.tmpDiskTables > 0 ? <span className="text-red-400">{formatNumber(s.tmpDiskTables)}</span> : <span className="text-gray-600">0</span>}
                </td>
                <td className="px-4 py-2 text-right">
                  {s.sortMergePasses > 0 ? <span className="text-red-400">{formatNumber(s.sortMergePasses)}</span> : <span className="text-gray-600">0</span>}
                </td>
                <td className="px-4 py-2 text-right text-gray-500 text-[10px]">
                  {formatLastSeen(s.lastSeen, showUtc)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex items-center justify-center h-32 text-gray-500">
      <div className="flex items-center gap-2">
        <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <span className="text-xs">Analyzing root cause...</span>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex items-center justify-center h-32 text-gray-600">
      <p className="text-xs">No statement data found for this time range.</p>
    </div>
  );
}
