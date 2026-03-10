import { useAppStore } from '../store/app-store';
import type { TopStatement } from '../api/types';

function formatNumber(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
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
}

function buildHitList(statements: TopStatement[]): { summary: RcaSegment[][]; items: HitListItem[] } {
  const totalRows = statements.reduce((sum, s) => sum + s.totalRowsExamined, 0);
  if (totalRows === 0) return { summary: [], items: [] };

  const summary: RcaSegment[][] = [];

  // Summary paragraph
  summary.push([
    { type: 'text', value: `During this window, ${formatNumber(totalRows)} total rows were examined across ${statements.length} distinct query patterns.` },
  ]);

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

    // High frequency amplifier
    if (s.totalExecutions > 10000) {
      problems.push(`${formatNumber(s.totalExecutions)} executions`);
      multiplier += 0.1;
    }

    score *= multiplier;

    // Build suggestion
    let suggestion = '';
    if (s.noIndexUsed > 0 && s.avgRowsExamined > 500) {
      suggestion = `Add an index on ${table} covering this ${verb} query's WHERE/JOIN columns — this is doing full table scans`;
    } else if (s.noIndexUsed > 0) {
      suggestion = `Add an index on ${table} for this ${verb} — MySQL is scanning without any index`;
    } else if (s.avgRowsExamined > 5000) {
      suggestion = `Review the index on ${table} — scanning ${formatNumber(s.avgRowsExamined)} rows/exec suggests the index isn't selective enough. Consider a composite index`;
    } else if (s.avgRowsExamined > 500) {
      suggestion = `Optimize the index on ${table} — ${formatNumber(s.avgRowsExamined)} rows/exec could be reduced with a more selective index`;
    } else if (s.tmpDiskTables > 0 && s.sortMergePasses > 0) {
      suggestion = `Increase tmp_table_size/sort_buffer_size or restructure this ${verb} to avoid disk-spill temp tables and sorts`;
    } else if (s.tmpDiskTables > 0) {
      suggestion = `This ${verb} creates on-disk temp tables — simplify GROUP BY/DISTINCT or increase tmp_table_size`;
    } else if (s.sortMergePasses > 0) {
      suggestion = `Sort spills to disk — add an index that matches the ORDER BY, or increase sort_buffer_size`;
    } else if (s.totalExecutions > 10000 && pct > 5) {
      suggestion = `Called ${formatNumber(s.totalExecutions)} times — consider caching results, reducing call frequency, or batching`;
    } else if (pct > 10) {
      suggestion = `High volume ${verb} on ${table} — review if all these rows need to be examined, or if the query can be narrowed`;
    } else {
      suggestion = `Lower priority — but review if this ${verb} on ${table} can be optimized with better filtering`;
    }

    const severity: HitListItem['severity'] =
      score >= 10 ? 'critical' : score >= 5 ? 'high' : 'medium';

    // Only include items that have some meaningful impact or problems
    if (pct >= 3 || problems.length > 0) {
      items.push({ rank: 0, stmtNum: i + 1, score, table, verb, pct, problems, suggestion, severity });
    }
  }

  // Sort by score descending and assign ranks
  items.sort((a, b) => b.score - a.score);
  items.forEach((item, i) => { item.rank = i + 1; });

  return { summary, items: items.slice(0, 10) };
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
  const isInvestigating = useAppStore((s) => s.timeRange.label === 'Custom');
  const setHighlightedStmt = useAppStore((s) => s.setHighlightedStmt);

  if (!isInvestigating || statements.length === 0) return null;

  const { summary, items } = buildHitList(statements);
  if (summary.length === 0) return null;

  const handleSelect = (num: number) => {
    setHighlightedStmt(num);
    setTimeout(() => {
      useAppStore.getState().setHighlightedStmt(null);
    }, 3000);
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
              className={`rounded border px-2.5 py-2 ${severityColors[item.severity]}`}
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
                    <span className="text-gray-500">—</span>
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
    </div>
  );
}
