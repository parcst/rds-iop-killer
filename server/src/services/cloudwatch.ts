import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface CloudWatchIopsPoint {
  timestamp: string;
  readIops: number;
  writeIops: number;
  totalIops: number;
  diskQueueDepth: number;
  readLatencyMs: number;
  writeLatencyMs: number;
  cpuUtilization: number;
  freeableMemoryMb: number;
  databaseConnections: number;
  burstBalance: number; // -1 = not available (io1/io2 don't have burst)
}

/**
 * Fetch ReadIOPS, WriteIOPS, DiskQueueDepth, and ReadLatency from CloudWatch.
 * Uses AWS CLI with SSO credentials.
 */
export async function getCloudWatchIops(
  instanceId: string,
  region: string,
  profileName: string,
  since: string,
  until: string,
): Promise<CloudWatchIopsPoint[]> {
  const rangeMs = new Date(until).getTime() - new Date(since).getTime();
  const rangeMins = rangeMs / 60000;
  let period = 300;
  if (rangeMins <= 360) period = 60;
  else if (rangeMins > 1440) period = 900;

  const commonArgs = [
    'cloudwatch', 'get-metric-statistics',
    '--namespace', 'AWS/RDS',
    '--dimensions', `Name=DBInstanceIdentifier,Value=${instanceId}`,
    '--start-time', since,
    '--end-time', until,
    '--period', String(period),
    '--statistics', 'Average',
    '--region', region,
    '--profile', profileName,
    '--output', 'json',
  ];

  const fetchMetric = (metricName: string) =>
    execFileAsync('aws', [...commonArgs, '--metric-name', metricName], { timeout: 30_000 })
      .then(r => JSON.parse(r.stdout))
      .catch(() => ({ Datapoints: [] })); // BurstBalance may not exist for io1/io2

  // Fetch all 9 metrics in parallel
  const [readData, writeData, queueData, readLatData, writeLatData, cpuData, memData, connData, burstData] = await Promise.all([
    fetchMetric('ReadIOPS'),
    fetchMetric('WriteIOPS'),
    fetchMetric('DiskQueueDepth'),
    fetchMetric('ReadLatency'),
    fetchMetric('WriteLatency'),
    fetchMetric('CPUUtilization'),
    fetchMetric('FreeableMemory'),
    fetchMetric('DatabaseConnections'),
    fetchMetric('BurstBalance'),
  ]);

  // Helper: build a timestamp → value map from CloudWatch datapoints
  function buildMap(data: any, transform?: (v: number) => number): Map<string, number> {
    const map = new Map<string, number>();
    for (const p of data.Datapoints || []) {
      const val = p.Average || 0;
      map.set(new Date(p.Timestamp).toISOString(), transform ? transform(val) : val);
    }
    return map;
  }

  const readMap = buildMap(readData);
  const writeMap = buildMap(writeData);
  const queueMap = buildMap(queueData);
  const readLatMap = buildMap(readLatData, v => v * 1000); // seconds → ms
  const writeLatMap = buildMap(writeLatData, v => v * 1000);
  const cpuMap = buildMap(cpuData);
  const memMap = buildMap(memData, v => v / (1024 * 1024)); // bytes → MB
  const connMap = buildMap(connData);
  const burstMap = buildMap(burstData);

  // Collect all unique timestamps
  const allTimestamps = new Set<string>();
  for (const m of [readMap, writeMap, queueMap, readLatMap, writeLatMap, cpuMap, memMap, connMap, burstMap]) {
    for (const ts of m.keys()) allTimestamps.add(ts);
  }

  // Merge into combined points
  const hasBurst = burstMap.size > 0;
  const points: CloudWatchIopsPoint[] = [];
  for (const ts of allTimestamps) {
    const readIops = Math.round(readMap.get(ts) || 0);
    const writeIops = Math.round(writeMap.get(ts) || 0);
    points.push({
      timestamp: ts,
      readIops,
      writeIops,
      totalIops: readIops + writeIops,
      diskQueueDepth: Math.round((queueMap.get(ts) || 0) * 100) / 100,
      readLatencyMs: Math.round((readLatMap.get(ts) || 0) * 100) / 100,
      writeLatencyMs: Math.round((writeLatMap.get(ts) || 0) * 100) / 100,
      cpuUtilization: Math.round((cpuMap.get(ts) || 0) * 10) / 10,
      freeableMemoryMb: Math.round(memMap.get(ts) || 0),
      databaseConnections: Math.round(connMap.get(ts) || 0),
      burstBalance: hasBurst ? Math.round((burstMap.get(ts) ?? -1) * 10) / 10 : -1,
    });
  }

  points.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return points;
}
