import { useCallback, useEffect, useRef } from 'react';
import { useAppStore } from '../store/app-store';
import {
  teleportStatus,
  teleportClusters,
  teleportLoginStatus,
  teleportLogin,
  teleportInstances,
  teleportConnect,
  teleportDisconnect,
} from '../api/client';

export function useTeleport() {
  const store = useAppStore();
  const loginPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Check tsh availability on mount
  useEffect(() => {
    teleportStatus()
      .then(({ available }) => store.setTshAvailable(available))
      .catch(() => store.setTshAvailable(false));
  }, []);

  // Load clusters on mount
  useEffect(() => {
    teleportClusters()
      .then(({ clusters }) => store.setClusters(clusters))
      .catch(() => {});
  }, []);

  // Cleanup on unmount and page close
  useEffect(() => {
    const handleBeforeUnload = () => {
      navigator.sendBeacon('/api/teleport/shutdown');
      stopLoginPolling();
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      stopLoginPolling();
    };
  }, []);

  const stopLoginPolling = useCallback(() => {
    if (loginPollRef.current) {
      clearInterval(loginPollRef.current);
      loginPollRef.current = null;
    }
  }, []);

  const startLoginPolling = useCallback(() => {
    if (loginPollRef.current) return;
    loginPollRef.current = setInterval(async () => {
      const cluster = useAppStore.getState().selectedCluster;
      if (!cluster) return;
      try {
        const status = await teleportLoginStatus(cluster);
        useAppStore.getState().setLoginStatus(status);
        if (status.loggedIn && loginPollRef.current) {
          clearInterval(loginPollRef.current);
          loginPollRef.current = null;
        }
      } catch { /* ignore */ }
    }, 2000);
  }, []);

  // Silently disconnect if currently connected
  const silentDisconnect = useCallback(async () => {
    if (useAppStore.getState().connectionResult) {
      try { await teleportDisconnect(); } catch { /* ignore */ }
      store.setConnectionResult(null);
    }
  }, [store]);

  // Check login status when cluster changes
  const selectCluster = useCallback(async (cluster: string) => {
    stopLoginPolling();
    await silentDisconnect();
    store.setSelectedCluster(cluster);
    if (!cluster) return;

    try {
      const status = await teleportLoginStatus(cluster);
      store.setLoginStatus(status);

      if (status.loggedIn) {
        const { instances } = await teleportInstances(cluster);
        store.setInstances(instances);
      }
    } catch { /* ignore */ }
  }, [store, stopLoginPolling, silentDisconnect]);

  // Login to cluster
  const login = useCallback(async () => {
    if (!store.selectedCluster) return;
    try {
      await teleportLogin(store.selectedCluster);
      startLoginPolling();
    } catch { /* ignore */ }
  }, [store.selectedCluster, startLoginPolling]);

  // Load instances after successful login
  useEffect(() => {
    if (store.loginStatus?.loggedIn && store.selectedCluster && store.instances.length === 0) {
      teleportInstances(store.selectedCluster)
        .then(({ instances }) => store.setInstances(instances))
        .catch(() => {});
    }
  }, [store.loginStatus?.loggedIn, store.selectedCluster]);

  // Select instance and auto-connect with __ALL__ (IOPS are instance-level)
  const selectInstance = useCallback(async (instanceName: string) => {
    await silentDisconnect();
    store.setSelectedInstance(instanceName);
    if (!instanceName || !store.selectedCluster) return;

    store.setSelectedDatabase('__ALL__');
    store.setConnecting(true);
    store.setError('');
    try {
      const result = await teleportConnect(store.selectedCluster, instanceName, '__ALL__');
      store.setConnectionResult(result);
    } catch (err: any) {
      store.setError(err.message || 'Failed to connect');
    } finally {
      store.setConnecting(false);
    }
  }, [store, silentDisconnect]);

  return {
    selectCluster,
    login,
    selectInstance,
  };
}
