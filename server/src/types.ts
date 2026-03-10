import type { ChildProcess } from 'child_process';

// ===== Teleport Types =====

export interface TeleportTunnel {
  process: ChildProcess;
  host: string;
  port: number;
  dbName: string;
  dbUser: string;
}

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

export interface IopsChartPoint {
  timestamp: string; // ISO string
  totalRowsExamined: number;
  maxRowsExamined: number;
  statementCount: number;
}
