import { getConnection } from './connection-manager.js';
import type { IopsChartPoint } from '../types.js';

const MAX_EXEC_MS = 3000;

/**
 * Periodically snapshots events_statements_summary_by_digest and computes
 * deltas (new rows examined per interval) to derive real I/O rate over time.
 *
 * All reads from performance_schema — in-memory, lock-free, zero production impact.
 */

interface DigestSnapshot {
  sumRowsExamined: number;
  countStar: number;
}

interface SamplePoint {
  timestamp: string;
  totalDeltaRowsExamined: number;
  maxDeltaRowsExamined: number;
  activeDigests: number;
  /** Per-schema breakdown for filtering */
  schemaDeltas: Map<string, { delta: number; maxDelta: number; count: number }>;
}

const MAX_SAMPLES = 8640; // 24h at 10s intervals
const SAMPLE_INTERVAL_MS = 10_000;

let samples: SamplePoint[] = [];
let lastSnapshot = new Map<string, DigestSnapshot>();
let samplerInterval: ReturnType<typeof setInterval> | null = null;
let samplerDatabase: string | undefined;

/**
 * Start the sampler. Called when a connection is established.
 */
export function startSampler(database?: string): void {
  stopSampler();
  samples = [];
  lastSnapshot = new Map();
  samplerDatabase = database;

  // Take first snapshot immediately (baseline — no deltas emitted)
  takeSnapshot().catch(() => {});

  samplerInterval = setInterval(() => {
    takeSnapshot().catch(() => {});
  }, SAMPLE_INTERVAL_MS);
}

/**
 * Stop the sampler. Called when disconnecting.
 */
export function stopSampler(): void {
  if (samplerInterval) {
    clearInterval(samplerInterval);
    samplerInterval = null;
  }
  samples = [];
  lastSnapshot = new Map();
}

async function takeSnapshot(): Promise<void> {
  let conn;
  try {
    conn = getConnection();
  } catch {
    return; // Not connected
  }

  const [rows] = await conn.query(`
    SELECT /*+ MAX_EXECUTION_TIME(${MAX_EXEC_MS}) */
      d.SCHEMA_NAME AS schema_name,
      d.DIGEST AS digest,
      d.SUM_ROWS_EXAMINED AS sum_rows_examined,
      d.COUNT_STAR AS count_star
    FROM performance_schema.events_statements_summary_by_digest d
    WHERE d.SCHEMA_NAME IS NOT NULL
      AND d.DIGEST IS NOT NULL
      AND d.DIGEST_TEXT IS NOT NULL
      AND d.DIGEST_TEXT NOT LIKE 'EXPLAIN%'
  `);

  const newSnapshot = new Map<string, DigestSnapshot>();
  const schemaDeltas = new Map<string, { delta: number; maxDelta: number; count: number }>();
  let totalDelta = 0;
  let maxDelta = 0;
  let activeCount = 0;

  for (const row of rows as any[]) {
    const key = `${row.schema_name}::${row.digest}`;
    const currentExamined = Number(row.sum_rows_examined);
    const currentCount = Number(row.count_star);

    newSnapshot.set(key, {
      sumRowsExamined: currentExamined,
      countStar: currentCount,
    });

    // Compute delta from last snapshot
    const prev = lastSnapshot.get(key);
    if (prev) {
      const delta = Math.max(0, currentExamined - prev.sumRowsExamined);
      if (delta > 0) {
        totalDelta += delta;
        maxDelta = Math.max(maxDelta, delta);
        activeCount++;

        // Track per-schema
        const schema = row.schema_name as string;
        const existing = schemaDeltas.get(schema) || { delta: 0, maxDelta: 0, count: 0 };
        existing.delta += delta;
        existing.maxDelta = Math.max(existing.maxDelta, delta);
        existing.count++;
        schemaDeltas.set(schema, existing);
      }
    }
  }

  lastSnapshot = newSnapshot;

  // Skip first snapshot (no previous data to compute deltas from)
  if (lastSnapshot.size > 0 && samples.length === 0 && totalDelta === 0 && activeCount === 0) {
    // This is the baseline snapshot — store a zero point so chart has a start
    samples.push({
      timestamp: new Date().toISOString(),
      totalDeltaRowsExamined: 0,
      maxDeltaRowsExamined: 0,
      activeDigests: 0,
      schemaDeltas: new Map(),
    });
    return;
  }

  samples.push({
    timestamp: new Date().toISOString(),
    totalDeltaRowsExamined: totalDelta,
    maxDeltaRowsExamined: maxDelta,
    activeDigests: activeCount,
    schemaDeltas,
  });

  // Trim to max
  if (samples.length > MAX_SAMPLES) {
    samples = samples.slice(samples.length - MAX_SAMPLES);
  }
}

/**
 * Get chart data from sampled deltas, bucketed into the requested number of buckets.
 */
export function getChartDataFromSamples(
  database?: string,
  since?: string,
  until?: string,
  buckets = 40,
): IopsChartPoint[] {
  const now = new Date();
  const sinceDate = since ? new Date(since) : new Date(now.getTime() - 60 * 60 * 1000);
  const untilDate = until ? new Date(until) : now;
  const rangeMs = untilDate.getTime() - sinceDate.getTime();
  const bucketMs = rangeMs / buckets;

  // Filter samples to time range
  const filtered = samples.filter(s => {
    const t = new Date(s.timestamp).getTime();
    return t >= sinceDate.getTime() && t <= untilDate.getTime();
  });

  // Initialize buckets
  const bucketData: { total: number; max: number; count: number }[] = [];
  for (let i = 0; i < buckets; i++) {
    bucketData.push({ total: 0, max: 0, count: 0 });
  }

  const filterDb = database && database !== '__ALL__';

  for (const sample of filtered) {
    const t = new Date(sample.timestamp).getTime();
    const idx = Math.floor((t - sinceDate.getTime()) / bucketMs);
    if (idx >= 0 && idx < buckets) {
      const bucket = bucketData[idx];

      if (filterDb) {
        const schemaData = sample.schemaDeltas.get(database!);
        if (schemaData) {
          bucket.total += schemaData.delta;
          bucket.max = Math.max(bucket.max, schemaData.maxDelta);
          bucket.count += schemaData.count;
        }
      } else {
        bucket.total += sample.totalDeltaRowsExamined;
        bucket.max = Math.max(bucket.max, sample.maxDeltaRowsExamined);
        bucket.count += sample.activeDigests;
      }
    }
  }

  // Build output
  const points: IopsChartPoint[] = [];
  for (let i = 0; i < buckets; i++) {
    const bucket = bucketData[i];
    const timestamp = new Date(sinceDate.getTime() + (i * bucketMs) + (bucketMs / 2));
    points.push({
      timestamp: timestamp.toISOString(),
      totalRowsExamined: bucket.total,
      maxRowsExamined: bucket.max,
      statementCount: bucket.count,
    });
  }

  return points;
}

/**
 * How many samples we currently have and the time range they cover.
 */
export function getSamplerStatus() {
  if (samples.length === 0) return { running: !!samplerInterval, sampleCount: 0 };
  return {
    running: !!samplerInterval,
    sampleCount: samples.length,
    oldest: samples[0].timestamp,
    newest: samples[samples.length - 1].timestamp,
  };
}
