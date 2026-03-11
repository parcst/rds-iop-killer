import { useState, useRef, useEffect } from 'react';
import { useAppStore } from '../store/app-store';
import { useIops } from '../hooks/useIops';
import { IopsChart } from './IopsChart';
import { TimeRangePicker } from './TimeRangePicker';
import type { IopsTab } from '../api/types';

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

function QueryCell({ text }: { text: string }) {
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);
  const formatted = formatSql(text);

  const handleClick = () => {
    navigator.clipboard.writeText(formatted).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <td
      className="px-4 py-2 text-gray-200 font-mono relative cursor-pointer"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => { setShow(false); setCopied(false); }}
      onClick={handleClick}
    >
      {truncateQuery(text)}
      {show && (
        <div className="absolute z-50 left-0 top-full mt-1 max-w-[600px] max-h-[300px] overflow-auto bg-gray-900 border border-gray-600 rounded-lg shadow-xl px-3 py-2 text-[11px] text-gray-200 font-mono whitespace-pre break-all">
          {copied && <div className="text-green-400 text-[10px] mb-1 font-sans">Copied to clipboard!</div>}
          {formatted}
        </div>
      )}
    </td>
  );
}

function ImpactBar({ pct }: { pct: number }) {
  const color = pct >= 20 ? 'bg-red-500' : pct >= 10 ? 'bg-orange-500' : pct >= 5 ? 'bg-amber-500' : 'bg-gray-600';
  return (
    <td className="px-4 py-2 text-right">
      <div className="flex items-center gap-1.5 justify-end">
        <span className={`text-[10px] font-medium ${pct >= 20 ? 'text-red-400' : pct >= 10 ? 'text-orange-400' : pct >= 5 ? 'text-amber-400' : 'text-gray-500'}`}>
          {pct.toFixed(1)}%
        </span>
        <div className="w-16 h-1.5 bg-gray-800 rounded-full overflow-hidden">
          <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(pct, 100)}%` }} />
        </div>
      </div>
    </td>
  );
}

const tabConfig: { key: IopsTab; label: string; description: string }[] = [
  { key: 'statements', label: 'Top Statements', description: 'Highest I/O per individual query pattern' },
  { key: 'consumers', label: 'Top Consumers', description: 'Query I/O weighted by concurrent connections' },
];

export function IopsView() {
  const store = useAppStore();
  const { refresh } = useIops();

  const isInvestigating = store.timeRange.label === 'Custom';
  const [showChart, setShowChart] = useState(true);
  const tableRef = useRef<HTMLDivElement>(null);
  const highlightedStmt = useAppStore((s) => s.highlightedStmt);

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

      {/* Chart section — collapsible when investigating */}
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
            <div className="bg-gray-950">
              <IopsChart />
            </div>
          )}
        </div>
      ) : (
        <div className="border-b border-gray-800 bg-gray-950">
          <IopsChart />
        </div>
      )}

      {/* Prompt to investigate */}
      {!isInvestigating && !store.iopsLoading && store.cloudwatchData.length > 0 && (
        <div className="px-6 py-4 text-center text-gray-500 text-xs">
          Drag across a spike on the chart to investigate root cause
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
            <div className="flex rounded-lg overflow-hidden border border-gray-700">
              {tabConfig.map(({ key, label }) => (
                <button
                  key={key}
                  onClick={() => store.setIopsTab(key)}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                    store.iopsTab === key
                      ? 'bg-red-600 text-white'
                      : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <button
              onClick={refresh}
              disabled={store.iopsLoading}
              className="px-3 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-200 disabled:opacity-50 transition-colors"
            >
              {store.iopsLoading ? 'Loading...' : 'Refresh'}
            </button>

            <span className="text-[10px] text-gray-600 ml-auto">
              {tabConfig.find(t => t.key === store.iopsTab)?.description}
              {store.lastRefreshed && (
                <> &middot; {store.lastRefreshed.toLocaleTimeString()}</>
              )}
            </span>
          </div>

          {/* Table */}
          <div className="flex-1 overflow-auto" ref={tableRef}>
            {store.iopsTab === 'statements'
              ? <StatementsTable highlightedStmt={highlightedStmt} />
              : <ConsumersTable />
            }
          </div>
        </>
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

function StatementsTable({ highlightedStmt }: { highlightedStmt: number | null }) {
  const statements = useAppStore((s) => s.topStatements);
  const loading = useAppStore((s) => s.iopsLoading);
  const showUtc = useAppStore((s) => s.showUtc);

  if (loading && statements.length === 0) return <LoadingState />;
  if (statements.length === 0) return <EmptyState />;

  const totalRows = statements.reduce((sum, s) => sum + s.totalRowsExamined, 0);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-gray-500 uppercase tracking-wider border-b border-gray-800">
            <Th tip="Rank by total I/O impact — #1 is the biggest contributor to IOPS consumption">#</Th>
            <Th tip="Percentage of total rows examined in this time window — shows how much of the IOPS breach this single query is responsible for" className="text-right">Impact</Th>
            <Th tip="The schema/database this query runs against">Database</Th>
            <Th tip="Normalized query pattern (digest) — click to copy the full query text for analysis">Query <span className="text-gray-600 normal-case tracking-normal font-normal">(click to copy)</span></Th>
            <Th tip="Total rows scanned by this query during the time window — each row examined translates to disk reads (IOPS) when data isn't cached in the buffer pool" className="text-right">Total Rows Examined</Th>
            <Th tip="Average rows scanned per execution — high values (>500) suggest missing or inefficient indexes causing full table scans that spike IOPS" className="text-right">Avg Rows/Exec</Th>
            <Th tip="Number of times this query ran during the window — a moderate query executed thousands of times can consume more IOPS than a single heavy query" className="text-right">Executions</Th>
            <Th tip="Cumulative wall-clock time spent executing this query — long-running queries hold I/O resources and sustain IOPS pressure" className="text-right">Total Time</Th>
            <Th tip="Average execution time per call — slow queries often indicate disk waits from high IOPS consumption" className="text-right">Avg Time</Th>
            <Th tip="Executions where MySQL used no index at all — these force full table scans, reading every row from disk and directly spiking IOPS" className="text-right">No Index</Th>
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
                <ImpactBar pct={pct} />
                <td className="px-4 py-2 text-gray-400">{s.db}</td>
                <QueryCell text={s.queryText} />
                <td className="px-4 py-2 text-right text-orange-400 font-medium">{formatNumber(s.totalRowsExamined)}</td>
                <td className="px-4 py-2 text-right">
                  {s.avgRowsExamined > 500
                    ? <span className="text-amber-400 font-medium" title="High scan count — possible missing index">{formatNumber(s.avgRowsExamined)}</span>
                    : <span className="text-gray-300">{formatNumber(s.avgRowsExamined)}</span>
                  }
                </td>
                <td className="px-4 py-2 text-right text-gray-400">{formatNumber(s.totalExecutions)}</td>
                <td className="px-4 py-2 text-right text-gray-400">{formatTime(s.totalTimeSec)}</td>
                <td className="px-4 py-2 text-right text-gray-400">{formatTime(s.avgTimeSec)}</td>
                <td className="px-4 py-2 text-right">
                  {s.noIndexUsed > 0 ? <span className="text-red-400">{formatNumber(s.noIndexUsed)}</span> : <span className="text-gray-600">0</span>}
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

function ConsumersTable() {
  const consumers = useAppStore((s) => s.topConsumers);
  const loading = useAppStore((s) => s.iopsLoading);
  const showUtc = useAppStore((s) => s.showUtc);

  if (loading && consumers.length === 0) return <LoadingState />;
  if (consumers.length === 0) return <EmptyState />;

  const totalEffective = consumers.reduce((sum, c) => sum + c.effectiveIops, 0);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-gray-500 uppercase tracking-wider border-b border-gray-800">
            <Th tip="Rank by effective IOPS impact — #1 is the biggest contributor when factoring in concurrency">#</Th>
            <Th tip="Percentage of total effective IOPS — shows how much of the combined I/O pressure this query is responsible for" className="text-right">Impact</Th>
            <Th tip="The schema/database this query runs against">Database</Th>
            <Th tip="Normalized query pattern (digest) — click to copy the full query text for analysis">Query <span className="text-gray-600 normal-case tracking-normal font-normal">(click to copy)</span></Th>
            <Th tip="Rows examined multiplied by concurrent connections — represents the amplified IOPS load when multiple sessions run the same expensive query simultaneously" className="text-right">Effective IOPS</Th>
            <Th tip="Number of connections running this query at the same time — concurrent execution multiplies IOPS impact since each session does independent disk reads" className="text-right">Concurrent</Th>
            <Th tip="Average rows scanned per execution — high values suggest missing indexes causing full scans that spike IOPS" className="text-right">Avg Rows/Exec</Th>
            <Th tip="Total rows scanned across all executions — each row examined can translate to disk reads when data isn't in the buffer pool" className="text-right">Total Rows Examined</Th>
            <Th tip="Number of times this query ran — frequent execution amplifies IOPS even for moderately expensive queries" className="text-right">Executions</Th>
            <Th tip="Average execution time per call — slow queries sustain I/O pressure longer and hold buffer pool resources" className="text-right">Avg Time</Th>
            <Th tip="Most recent time this query was observed — helps identify if it's still actively contributing to IOPS" className="text-right">Last Seen</Th>
          </tr>
        </thead>
        <tbody>
          {consumers.map((c, i) => {
            const pct = totalEffective > 0 ? (c.effectiveIops / totalEffective) * 100 : 0;
            const isCritical = pct >= 15;
            const isHigh = pct >= 8 && !isCritical;
            const rowBg = isCritical
              ? 'bg-red-950/40 border-red-900/50 hover:bg-red-950/60'
              : isHigh
                ? 'bg-orange-950/20 border-orange-900/30 hover:bg-orange-950/30'
                : 'border-gray-800/50 hover:bg-gray-800/50';
            return (
              <tr key={c.digest} className={`border-b transition-colors ${rowBg}`}>
                <td className="px-4 py-2 text-gray-600">{i + 1}</td>
                <ImpactBar pct={pct} />
                <td className="px-4 py-2 text-gray-400">{c.db}</td>
                <QueryCell text={c.queryText} />
                <td className="px-4 py-2 text-right text-red-400 font-bold">{formatNumber(c.effectiveIops)}</td>
                <td className="px-4 py-2 text-right">
                  {c.concurrentCount > 0 ? <span className="text-orange-400 font-medium">{c.concurrentCount}</span> : <span className="text-gray-600">0</span>}
                </td>
                <td className="px-4 py-2 text-right">
                  {c.avgRowsExamined > 500
                    ? <span className="text-amber-400 font-medium">{formatNumber(c.avgRowsExamined)}</span>
                    : <span className="text-gray-300">{formatNumber(c.avgRowsExamined)}</span>
                  }
                </td>
                <td className="px-4 py-2 text-right text-gray-400">{formatNumber(c.totalRowsExamined)}</td>
                <td className="px-4 py-2 text-right text-gray-400">{formatNumber(c.totalExecutions)}</td>
                <td className="px-4 py-2 text-right text-gray-400">{formatTime(c.avgTimeSec)}</td>
                <td className="px-4 py-2 text-right text-gray-500 text-[10px]">
                  {formatLastSeen(c.lastSeen, showUtc)}
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
