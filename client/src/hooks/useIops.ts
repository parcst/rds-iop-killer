import { useCallback, useEffect, useRef } from 'react';
import { useAppStore } from '../store/app-store';
import { fetchTopStatements, fetchTopConsumers, fetchCloudWatchIops, fetchRdsConfig } from '../api/client';

export function useIops() {
  const store = useAppStore();
  const rdsFetched = useRef(false);
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    const { connectionResult, selectedDatabase, timeRange } = useAppStore.getState();
    if (!connectionResult) return;

    const thisRequest = ++requestId.current;
    const isInvestigating = timeRange.label === 'Custom';
    const db = selectedDatabase === '__ALL__' ? undefined : selectedDatabase;

    useAppStore.getState().setIopsLoading(true);
    useAppStore.getState().setIopsError('');

    // Check if we have AWS instance info for CloudWatch
    const { selectedInstance, instances } = useAppStore.getState();
    const instance = instances.find(i => i.name === selectedInstance);
    const hasAws = !!(instance?.accountId && instance?.region && instance?.instanceId);

    try {
      // Always fetch CloudWatch IOPS for the chart
      const cwPromise = hasAws
        ? fetchCloudWatchIops(instance!.accountId, instance!.region, instance!.instanceId, timeRange.since, timeRange.until)
        : Promise.resolve(null);

      if (isInvestigating) {
        // Investigating a specific range — fetch DBA data for root cause analysis
        const [cwRes, statementsRes, consumersRes] = await Promise.all([
          cwPromise,
          fetchTopStatements(db, 25, timeRange.since, timeRange.until),
          fetchTopConsumers(db, 25, timeRange.since, timeRange.until),
        ]);

        if (thisRequest !== requestId.current) return;

        if (cwRes) useAppStore.getState().setCloudwatchData(cwRes.cloudwatch);
        useAppStore.getState().setTopStatements(statementsRes.statements);
        useAppStore.getState().setTopConsumers(consumersRes.consumers);
      } else {
        // Overview mode — just CloudWatch chart, no DBA queries
        const cwRes = await cwPromise;

        if (thisRequest !== requestId.current) return;

        if (cwRes) useAppStore.getState().setCloudwatchData(cwRes.cloudwatch);
        useAppStore.getState().setTopStatements([]);
        useAppStore.getState().setTopConsumers([]);
      }

      useAppStore.getState().setLastRefreshed(new Date());
    } catch (err: any) {
      if (thisRequest !== requestId.current) return;
      useAppStore.getState().setIopsError(err.message || 'Failed to fetch IOPS data');
    } finally {
      if (thisRequest === requestId.current) {
        useAppStore.getState().setIopsLoading(false);
      }
    }
  }, []);

  // Auto-fetch provisioned IOPS from AWS RDS API on connect
  useEffect(() => {
    if (store.connectionResult && !rdsFetched.current) {
      rdsFetched.current = true;
      const { selectedInstance, instances } = useAppStore.getState();
      const instance = instances.find(i => i.name === selectedInstance);
      if (instance?.accountId && instance?.region && instance?.instanceId) {
        fetchRdsConfig(instance.accountId, instance.region, instance.instanceId)
          .then((config) => {
            useAppStore.getState().setRdsConfig(config);
            if (config.provisionedIops > 0) {
              useAppStore.getState().setIopsThreshold(config.provisionedIops);
            }
          })
          .catch((err) => {
            console.warn('Failed to fetch RDS config from AWS:', err.message);
          });
      }
    }
    if (!store.connectionResult) {
      rdsFetched.current = false;
    }
  }, [store.connectionResult]);

  // Refresh when connected or time range changes
  useEffect(() => {
    if (store.connectionResult) {
      refresh();
    }
  }, [store.connectionResult, store.timeRange, refresh]);

  return { refresh };
}
