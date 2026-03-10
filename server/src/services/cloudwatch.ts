import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface CloudWatchIopsPoint {
  timestamp: string;
  readIops: number;
  writeIops: number;
  totalIops: number;
}

/**
 * Fetch ReadIOPS + WriteIOPS from CloudWatch for an RDS instance.
 * Uses AWS CLI with SSO credentials.
 */
export async function getCloudWatchIops(
  instanceId: string,
  region: string,
  profileName: string,
  since: string,
  until: string,
): Promise<CloudWatchIopsPoint[]> {
  // Determine period based on range (aim for ~288 points max)
  const rangeMs = new Date(until).getTime() - new Date(since).getTime();
  const rangeMins = rangeMs / 60000;
  // CloudWatch minimum period: 60s. Use 60s for <=6h, 300s for <=24h, 900s for longer
  let period = 300;
  if (rangeMins <= 360) period = 60;
  else if (rangeMins > 1440) period = 900;

  // Fetch both metrics in parallel
  const [readResult, writeResult] = await Promise.all([
    execFileAsync('aws', [
      'cloudwatch', 'get-metric-statistics',
      '--namespace', 'AWS/RDS',
      '--metric-name', 'ReadIOPS',
      '--dimensions', `Name=DBInstanceIdentifier,Value=${instanceId}`,
      '--start-time', since,
      '--end-time', until,
      '--period', String(period),
      '--statistics', 'Average',
      '--region', region,
      '--profile', profileName,
      '--output', 'json',
    ], { timeout: 30_000 }),
    execFileAsync('aws', [
      'cloudwatch', 'get-metric-statistics',
      '--namespace', 'AWS/RDS',
      '--metric-name', 'WriteIOPS',
      '--dimensions', `Name=DBInstanceIdentifier,Value=${instanceId}`,
      '--start-time', since,
      '--end-time', until,
      '--period', String(period),
      '--statistics', 'Average',
      '--region', region,
      '--profile', profileName,
      '--output', 'json',
    ], { timeout: 30_000 }),
  ]);

  const readData = JSON.parse(readResult.stdout);
  const writeData = JSON.parse(writeResult.stdout);

  // Index write data by timestamp
  const writeMap = new Map<string, number>();
  for (const p of writeData.Datapoints || []) {
    const ts = new Date(p.Timestamp).toISOString();
    writeMap.set(ts, p.Average || 0);
  }

  // Merge into combined points
  const points: CloudWatchIopsPoint[] = [];
  for (const p of readData.Datapoints || []) {
    const ts = new Date(p.Timestamp).toISOString();
    const readIops = Math.round(p.Average || 0);
    const writeIops = Math.round(writeMap.get(ts) || 0);
    writeMap.delete(ts);
    points.push({
      timestamp: ts,
      readIops,
      writeIops,
      totalIops: readIops + writeIops,
    });
  }

  // Add any write-only points (shouldn't happen but be safe)
  for (const [ts, writeIops] of writeMap) {
    points.push({
      timestamp: ts,
      readIops: 0,
      writeIops: Math.round(writeIops),
      totalIops: Math.round(writeIops),
    });
  }

  // Sort by timestamp
  points.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return points;
}
