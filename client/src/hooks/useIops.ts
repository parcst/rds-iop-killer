import { useCallback, useEffect, useRef } from 'react';
import { useAppStore } from '../store/app-store';
import { fetchTopStatements, fetchTopConsumers, fetchCloudWatchIops, fetchRdsConfig, fetchInnodbMetrics } from '../api/client';

export function useIops() {
  const store = useAppStore();
  const rdsFetchingRef = useRef(false);
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
        const [cwRes, statementsRes, consumersRes, innodbRes] = await Promise.all([
          cwPromise,
          fetchTopStatements(db, 25, timeRange.since, timeRange.until),
          fetchTopConsumers(db, 25, timeRange.since, timeRange.until),
          fetchInnodbMetrics(timeRange.since, timeRange.until).catch(() => null),
        ]);

        if (thisRequest !== requestId.current) return;

        if (cwRes) useAppStore.getState().setCloudwatchData(cwRes.cloudwatch);
        useAppStore.getState().setTopStatements(statementsRes.statements);
        useAppStore.getState().setTopConsumers(consumersRes.consumers);
        useAppStore.getState().setInnodbMetrics(innodbRes);
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
      const msg = err.message || 'Failed to fetch IOPS data';
      if (msg.includes('SSO') || msg.includes('sso')) {
        useAppStore.getState().setAwsSsoNeeded(true);
      }
      useAppStore.getState().setIopsError(msg);
    } finally {
      if (thisRequest === requestId.current) {
        useAppStore.getState().setIopsLoading(false);
      }
    }
  }, []);

  // Auto-fetch provisioned IOPS from AWS RDS API on connect (retries if rdsConfig is still null)
  useEffect(() => {
    if (store.connectionResult && !store.rdsConfig && !rdsFetchingRef.current) {
      const { selectedInstance, instances } = useAppStore.getState();
      const instance = instances.find(i => i.name === selectedInstance);
      if (instance?.accountId && instance?.region && instance?.instanceId) {
        rdsFetchingRef.current = true;
        fetchRdsConfig(instance.accountId, instance.region, instance.instanceId)
          .then((config) => {
            useAppStore.getState().setRdsConfig(config);
            if (config.provisionedIops > 0) {
              useAppStore.getState().setIopsThreshold(config.provisionedIops);
            }
          })
          .catch((err) => {
            const msg = err.message || '';
            if (msg.includes('SSO') || msg.includes('sso')) {
              useAppStore.getState().setAwsSsoNeeded(true);
            }
            console.warn('Failed to fetch RDS config from AWS:', msg);
          })
          .finally(() => { rdsFetchingRef.current = false; });
      }
    }
  }, [store.connectionResult, store.rdsConfig, store.awsSsoLoggedIn]);

  // Refresh when connected or time range changes
  useEffect(() => {
    if (store.connectionResult) {
      refresh();
    }
  }, [store.connectionResult, store.timeRange, refresh]);

  // Re-fetch CloudWatch data when SSO login succeeds
  useEffect(() => {
    if (store.awsSsoLoggedIn && store.connectionResult) {
      refresh();
    }
  }, [store.awsSsoLoggedIn]);

  return { refresh };
}
