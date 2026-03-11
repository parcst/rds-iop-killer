// ===== Teleport Types =====

export interface TeleportInstance {
  name: string;
  uri: string;
  accountId: string;
  region: string;
  instanceId: string;
}

export interface TeleportStatus {
  loggedIn: boolean;
  username: string;
  cluster?: string;
}

export interface ConnectionResult {
  connected: boolean;
  database: string;
  databases?: string[];
  version: string;
}

// ===== IOPS Types =====

export interface TopStatement {
  db: string;
  queryText: string;
  querySampleText: string;
  digest: string;
  totalExecutions: number;
  totalRowsExamined: number;
  totalRowsSent: number;
  totalRowsAffected: number;
  avgRowsExamined: number;
  totalTimeSec: number;
  avgTimeSec: number;
  p99Sec: number;
  totalLockTimeSec: number;
  totalCpuTimeSec: number;
  noIndexUsed: number;
  noGoodIndexUsed: number;
  fullJoinCount: number;
  tmpDiskTables: number;
  sortMergePasses: number;
  lastSeen: string;
  firstSeen: string;
}

export interface TopConsumer {
  db: string;
  queryText: string;
  querySampleText: string;
  digest: string;
  totalExecutions: number;
  totalRowsExamined: number;
  avgRowsExamined: number;
  totalTimeSec: number;
  avgTimeSec: number;
  p99Sec: number;
  totalLockTimeSec: number;
  totalCpuTimeSec: number;
  fullJoinCount: number;
  concurrentCount: number;
  effectiveIops: number;
  lastSeen: string;
  firstSeen: string;
}

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
  burstBalance: number; // -1 = not available (io1/io2)
}

export type IopsTab = 'statements' | 'consumers';

export interface TimeRange {
  since: string; // ISO string
  until: string; // ISO string
  label: string;
}
