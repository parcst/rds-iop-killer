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

function buildRcaNarrative(statements: TopStatement[]): RcaSegment[][] {
  if (statements.length === 0) return [];

  const totalRows = statements.reduce((sum, s) => sum + s.totalRowsExamined, 0);
  if (totalRows === 0) return [];

  const paragraphs: RcaSegment[][] = [];

  const tableMap = new Map<string, { rows: number; stmtNums: number[]; noIndex: number; tmpDisk: number; sortSpill: number }>();
  for (let i = 0; i < statements.length; i++) {
    const s = statements[i];
    const table = extractTable(s.queryText);
    const existing = tableMap.get(table) || { rows: 0, stmtNums: [], noIndex: 0, tmpDisk: 0, sortSpill: 0 };
    existing.rows += s.totalRowsExamined;
    existing.stmtNums.push(i + 1);
    existing.noIndex += s.noIndexUsed;
    existing.tmpDisk += s.tmpDiskTables;
    existing.sortSpill += s.sortMergePasses;
    tableMap.set(table, existing);
  }

  const topTables = [...tableMap.entries()]
    .sort((a, b) => b[1].rows - a[1].rows)
    .slice(0, 5);

  // Opening
  paragraphs.push([
    { type: 'text', value: `During this window, ${formatNumber(totalRows)} total rows were examined across ${statements.length} distinct query patterns.` },
  ]);

  // Table breakdown with refs
  const tablePara: RcaSegment[] = [{ type: 'text', value: 'The heaviest tables were: ' }];
  topTables.forEach(([table, data], idx) => {
    if (idx > 0) tablePara.push({ type: 'text', value: ', ' });
    const pct = ((data.rows / totalRows) * 100).toFixed(0);
    tablePara.push({ type: 'text', value: `${table} (${pct}%, ${formatNumber(data.rows)} rows — ` });
    data.stmtNums.slice(0, 3).forEach((num, ri) => {
      if (ri > 0) tablePara.push({ type: 'text', value: ' ' });
      tablePara.push({ type: 'ref', num });
    });
    if (data.stmtNums.length > 3) tablePara.push({ type: 'text', value: ` +${data.stmtNums.length - 3} more` });
    tablePara.push({ type: 'text', value: ')' });
  });
  tablePara.push({ type: 'text', value: '.' });
  paragraphs.push(tablePara);

  // Top offender
  const top = statements[0];
  if (top) {
    const topPct = ((top.totalRowsExamined / totalRows) * 100).toFixed(0);
    const topTable = extractTable(top.queryText);
    const verb = top.queryText.split(/\s/)[0];
    paragraphs.push([
      { type: 'text', value: `The single largest contributor ` },
      { type: 'ref', num: 1 },
      { type: 'text', value: ` was a ${verb} on ${topTable}, responsible for ${topPct}% of all rows examined (${formatNumber(top.totalRowsExamined)} rows across ${formatNumber(top.totalExecutions)} executions, averaging ${formatNumber(top.avgRowsExamined)} rows per call).` },
    ]);
  }

  // Issues with refs
  const noIndexStmts = statements.map((s, i) => ({ num: i + 1, val: s.noIndexUsed })).filter(x => x.val > 0);
  const tmpDiskStmts = statements.map((s, i) => ({ num: i + 1, val: s.tmpDiskTables })).filter(x => x.val > 0);
  const sortSpillStmts = statements.map((s, i) => ({ num: i + 1, val: s.sortMergePasses })).filter(x => x.val > 0);
  const highAvgStmts = statements.map((s, i) => ({ num: i + 1, s })).filter(x => x.s.avgRowsExamined > 500 && x.s.totalExecutions > 10);

  const issueParts: RcaSegment[][] = [];

  if (noIndexStmts.length > 0) {
    const part: RcaSegment[] = [{ type: 'text', value: `${formatNumber(noIndexStmts.reduce((s, x) => s + x.val, 0))} queries without an index (` }];
    noIndexStmts.slice(0, 5).forEach((x, i) => {
      if (i > 0) part.push({ type: 'text', value: ' ' });
      part.push({ type: 'ref', num: x.num });
    });
    if (noIndexStmts.length > 5) part.push({ type: 'text', value: ` +${noIndexStmts.length - 5} more` });
    part.push({ type: 'text', value: ')' });
    issueParts.push(part);
  }

  if (tmpDiskStmts.length > 0) {
    const part: RcaSegment[] = [{ type: 'text', value: `${formatNumber(tmpDiskStmts.reduce((s, x) => s + x.val, 0))} temp tables to disk (` }];
    tmpDiskStmts.slice(0, 5).forEach((x, i) => {
      if (i > 0) part.push({ type: 'text', value: ' ' });
      part.push({ type: 'ref', num: x.num });
    });
    if (tmpDiskStmts.length > 5) part.push({ type: 'text', value: ` +${tmpDiskStmts.length - 5} more` });
    part.push({ type: 'text', value: ')' });
    issueParts.push(part);
  }

  if (sortSpillStmts.length > 0) {
    const part: RcaSegment[] = [{ type: 'text', value: `${formatNumber(sortSpillStmts.reduce((s, x) => s + x.val, 0))} sort spills to disk (` }];
    sortSpillStmts.slice(0, 5).forEach((x, i) => {
      if (i > 0) part.push({ type: 'text', value: ' ' });
      part.push({ type: 'ref', num: x.num });
    });
    if (sortSpillStmts.length > 5) part.push({ type: 'text', value: ` +${sortSpillStmts.length - 5} more` });
    part.push({ type: 'text', value: ')' });
    issueParts.push(part);
  }

  if (highAvgStmts.length > 0) {
    const part: RcaSegment[] = [{ type: 'text', value: `${highAvgStmts.length} ${highAvgStmts.length === 1 ? 'query scans' : 'queries scan'} >500 rows/exec (` }];
    highAvgStmts.slice(0, 5).forEach((x, i) => {
      if (i > 0) part.push({ type: 'text', value: ' ' });
      part.push({ type: 'ref', num: x.num });
    });
    if (highAvgStmts.length > 5) part.push({ type: 'text', value: ` +${highAvgStmts.length - 5} more` });
    part.push({ type: 'text', value: ')' });
    issueParts.push(part);
  }

  if (issueParts.length > 0) {
    const combined: RcaSegment[] = [{ type: 'text', value: 'Key issues: ' }];
    issueParts.forEach((part, i) => {
      if (i > 0) combined.push({ type: 'text', value: '; ' });
      combined.push(...part);
    });
    combined.push({ type: 'text', value: '.' });
    paragraphs.push(combined);
  }

  return paragraphs;
}

export function RootCauseAnalysis() {
  const statements = useAppStore((s) => s.topStatements);
  const isInvestigating = useAppStore((s) => s.timeRange.label === 'Custom');
  const setHighlightedStmt = useAppStore((s) => s.setHighlightedStmt);

  if (!isInvestigating || statements.length === 0) return null;

  const paragraphs = buildRcaNarrative(statements);
  if (paragraphs.length === 0) return null;

  const handleSelect = (num: number) => {
    setHighlightedStmt(num);
    // Auto-clear after 3s
    setTimeout(() => {
      useAppStore.getState().setHighlightedStmt(null);
    }, 3000);
  };

  return (
    <div className="rounded bg-gray-800 border border-gray-700 px-3 py-3 space-y-1.5">
      <div className="text-[10px] text-gray-500 uppercase tracking-wider font-medium">Root Cause Analysis</div>
      <div className="text-[11px] text-gray-300 leading-relaxed space-y-2">
        {paragraphs.map((segs, pi) => (
          <p key={pi}>
            {segs.map((seg, si) =>
              seg.type === 'text'
                ? <span key={si}>{seg.value}</span>
                : <StmtRef key={si} num={seg.num} onSelect={handleSelect} />
            )}
          </p>
        ))}
      </div>
    </div>
  );
}
