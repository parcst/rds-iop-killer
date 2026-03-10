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
  digest: string;
  totalExecutions: number;
  totalRowsExamined: number;
  totalRowsSent: number;
  totalRowsAffected: number;
  avgRowsExamined: number;
  totalTimeSec: number;
  avgTimeSec: number;
  noIndexUsed: number;
  noGoodIndexUsed: number;
  tmpDiskTables: number;
  sortMergePasses: number;
  lastSeen: string;
  firstSeen: string;
}

export interface TopConsumer {
  db: string;
  queryText: string;
  digest: string;
  totalExecutions: number;
  totalRowsExamined: number;
  avgRowsExamined: number;
  totalTimeSec: number;
  avgTimeSec: number;
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
}

export type IopsTab = 'statements' | 'consumers';

export interface TimeRange {
  since: string; // ISO string
  until: string; // ISO string
  label: string;
}
