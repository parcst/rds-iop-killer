import { useState, useRef, useEffect } from 'react';
import { useAppStore } from '../store/app-store';
import { useIops } from '../hooks/useIops';
import { IopsChart } from './IopsChart';
import { TimeRangePicker } from './TimeRangePicker';
import type { IopsTab } from '../api/types';

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

function QueryCell({ text }: { text: string }) {
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleClick = () => {
    navigator.clipboard.writeText(text).then(() => {
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
        <div className="absolute z-50 left-0 top-full mt-1 max-w-[600px] max-h-[300px] overflow-auto bg-gray-900 border border-gray-600 rounded-lg shadow-xl px-3 py-2 text-[11px] text-gray-200 font-mono whitespace-pre-wrap break-all">
          {copied && <div className="text-green-400 text-[10px] mb-1 font-sans">Copied to clipboard!</div>}
          {text}
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
            <th className="px-4 py-2 font-medium">#</th>
            <th className="px-4 py-2 font-medium text-right" title="Percentage of total I/O in this time window">Impact</th>
            <th className="px-4 py-2 font-medium">Database</th>
            <th className="px-4 py-2 font-medium">Query <span className="text-gray-600 normal-case tracking-normal font-normal">(click to copy)</span></th>
            <th className="px-4 py-2 font-medium text-right">Total Rows Examined</th>
            <th className="px-4 py-2 font-medium text-right">Avg Rows/Exec</th>
            <th className="px-4 py-2 font-medium text-right">Executions</th>
            <th className="px-4 py-2 font-medium text-right">Total Time</th>
            <th className="px-4 py-2 font-medium text-right">Avg Time</th>
            <th className="px-4 py-2 font-medium text-right">No Index</th>
            <th className="px-4 py-2 font-medium text-right" title="Temp tables written to disk — high disk I/O">Tmp Disk</th>
            <th className="px-4 py-2 font-medium text-right" title="Sort merge passes — spills to disk">Sort Spill</th>
            <th className="px-4 py-2 font-medium text-right">Last Seen</th>
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
            <th className="px-4 py-2 font-medium">#</th>
            <th className="px-4 py-2 font-medium text-right" title="Percentage of total effective IOPS">Impact</th>
            <th className="px-4 py-2 font-medium">Database</th>
            <th className="px-4 py-2 font-medium">Query <span className="text-gray-600 normal-case tracking-normal font-normal">(click to copy)</span></th>
            <th className="px-4 py-2 font-medium text-right">Effective IOPS</th>
            <th className="px-4 py-2 font-medium text-right">Concurrent</th>
            <th className="px-4 py-2 font-medium text-right">Avg Rows/Exec</th>
            <th className="px-4 py-2 font-medium text-right">Total Rows Examined</th>
            <th className="px-4 py-2 font-medium text-right">Executions</th>
            <th className="px-4 py-2 font-medium text-right">Avg Time</th>
            <th className="px-4 py-2 font-medium text-right">Last Seen</th>
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
