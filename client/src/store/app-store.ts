import { create } from 'zustand';
import type { TeleportInstance, TeleportStatus, ConnectionResult, TopStatement, TopConsumer, CloudWatchIopsPoint, IopsTab, TimeRange } from '../api/types';

function makeTimeRange(label: string, minutes: number): TimeRange {
  const now = new Date();
  return {
    since: new Date(now.getTime() - minutes * 60 * 1000).toISOString(),
    until: now.toISOString(),
    label,
  };
}

export const TIME_PRESETS: { label: string; minutes: number }[] = [
  { label: 'Last 5 min', minutes: 5 },
  { label: 'Last 30 min', minutes: 30 },
  { label: 'Last 1 hour', minutes: 60 },
  { label: 'Last 6 hours', minutes: 360 },
  { label: 'Last 12 hours', minutes: 720 },
  { label: 'Last 24 hours', minutes: 1440 },
];

interface AppState {
  // Teleport
  tshAvailable: boolean;
  clusters: string[];
  selectedCluster: string;
  loginStatus: TeleportStatus | null;
  instances: TeleportInstance[];
  selectedInstance: string;

  // Database
  availableDatabases: string[];
  selectedDatabase: string;

  // Connection
  connectionResult: ConnectionResult | null;
  connecting: boolean;

  // IOPS
  iopsTab: IopsTab;
  topStatements: TopStatement[];
  topConsumers: TopConsumer[];
  cloudwatchData: CloudWatchIopsPoint[];
  iopsLoading: boolean;
  iopsError: string;
  autoRefresh: boolean;
  refreshInterval: number;
  lastRefreshed: Date | null;

  // Time range
  timeRange: TimeRange;
  showUtc: boolean;

  // IOPS threshold + RDS config
  iopsThreshold: number; // 0 = disabled
  rdsConfig: {
    provisionedIops: number;
    storageType: string;
    allocatedStorageGb: number;
    instanceClass: string;
    engine: string;
    engineVersion: string;
  } | null;

  // RCA
  highlightedStmt: number | null;

  // General
  error: string;
  loading: boolean;

  // Actions
  setTshAvailable: (available: boolean) => void;
  setClusters: (clusters: string[]) => void;
  setSelectedCluster: (cluster: string) => void;
  setLoginStatus: (status: TeleportStatus | null) => void;
  setInstances: (instances: TeleportInstance[]) => void;
  setSelectedInstance: (instance: string) => void;
  setAvailableDatabases: (databases: string[]) => void;
  setSelectedDatabase: (database: string) => void;
  setConnectionResult: (result: ConnectionResult | null) => void;
  setConnecting: (connecting: boolean) => void;
  setIopsTab: (tab: IopsTab) => void;
  setTopStatements: (statements: TopStatement[]) => void;
  setTopConsumers: (consumers: TopConsumer[]) => void;
  setCloudwatchData: (data: CloudWatchIopsPoint[]) => void;
  setIopsLoading: (loading: boolean) => void;
  setIopsError: (error: string) => void;
  setAutoRefresh: (enabled: boolean) => void;
  setRefreshInterval: (seconds: number) => void;
  setLastRefreshed: (date: Date | null) => void;
  setTimeRange: (range: TimeRange) => void;
  setShowUtc: (utc: boolean) => void;
  setIopsThreshold: (threshold: number) => void;
  setRdsConfig: (config: AppState['rdsConfig']) => void;
  setHighlightedStmt: (stmt: number | null) => void;
  setError: (error: string) => void;
  setLoading: (loading: boolean) => void;
  reset: () => void;
}

const defaultTimeRange = makeTimeRange('Last 1 hour', 60);

const initialState = {
  tshAvailable: false,
  clusters: [],
  selectedCluster: '',
  loginStatus: null,
  instances: [],
  selectedInstance: '',
  availableDatabases: [],
  selectedDatabase: '',
  connectionResult: null,
  connecting: false,
  iopsTab: 'statements' as IopsTab,
  topStatements: [],
  topConsumers: [],
  cloudwatchData: [],
  iopsLoading: false,
  iopsError: '',
  autoRefresh: false,
  refreshInterval: 5,
  lastRefreshed: null,
  timeRange: defaultTimeRange,
  showUtc: false,
  iopsThreshold: 0,
  rdsConfig: null,
  highlightedStmt: null,
  error: '',
  loading: false,
};

export const useAppStore = create<AppState>((set) => ({
  ...initialState,

  setTshAvailable: (available) => set({ tshAvailable: available }),
  setClusters: (clusters) => set({ clusters }),
  setSelectedCluster: (cluster) => set({
    selectedCluster: cluster,
    loginStatus: null,
    instances: [],
    selectedInstance: '',
    availableDatabases: [],
    selectedDatabase: '',
    connectionResult: null,
    topStatements: [],
    topConsumers: [],
    cloudwatchData: [],
    iopsError: '',
    error: '',
  }),
  setLoginStatus: (status) => set({ loginStatus: status }),
  setInstances: (instances) => set({ instances }),
  setSelectedInstance: (instance) => set({
    selectedInstance: instance,
    availableDatabases: [],
    selectedDatabase: '',
    connectionResult: null,
    topStatements: [],
    topConsumers: [],
    cloudwatchData: [],
    iopsError: '',
    error: '',
    iopsThreshold: 0,
    rdsConfig: null,
  }),
  setAvailableDatabases: (databases) => set({ availableDatabases: databases }),
  setSelectedDatabase: (database) => set({ selectedDatabase: database, connectionResult: null }),
  setConnectionResult: (result) => set({ connectionResult: result }),
  setConnecting: (connecting) => set({ connecting }),
  setIopsTab: (tab) => set({ iopsTab: tab }),
  setTopStatements: (statements) => set({ topStatements: statements }),
  setTopConsumers: (consumers) => set({ topConsumers: consumers }),
  setCloudwatchData: (data) => set({ cloudwatchData: data }),
  setIopsLoading: (loading) => set({ iopsLoading: loading }),
  setIopsError: (error) => set({ iopsError: error }),
  setAutoRefresh: (enabled) => set({ autoRefresh: enabled }),
  setRefreshInterval: (seconds) => set({ refreshInterval: seconds }),
  setLastRefreshed: (date) => set({ lastRefreshed: date }),
  setTimeRange: (range) => set({ timeRange: range }),
  setShowUtc: (utc) => set({ showUtc: utc }),
  setIopsThreshold: (threshold) => set({ iopsThreshold: threshold }),
  setRdsConfig: (config) => set({ rdsConfig: config }),
  setHighlightedStmt: (stmt) => set({ highlightedStmt: stmt }),
  setError: (error) => set({ error }),
  setLoading: (loading) => set({ loading }),
  reset: () => set(initialState),
}));
