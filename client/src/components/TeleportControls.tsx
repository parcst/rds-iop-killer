import { useCallback, useEffect, useRef } from 'react';
import { useAppStore } from '../store/app-store';
import { useTeleport } from '../hooks/useTeleport';
import { awsSsoStatus, awsSsoLogin } from '../api/client';

const selectClasses = 'w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-200 focus:border-red-500 focus:ring-1 focus:ring-red-500 focus:outline-none';
const labelClasses = 'block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1';

function useAwsSso() {
  const store = useAppStore();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startLogin = useCallback(async () => {
    store.setAwsSsoLoggingIn(true);
    try {
      await awsSsoLogin();
      // Poll for successful login (aws sso login opens browser via stdio inherit on server)
      pollRef.current = setInterval(async () => {
        try {
          const { loggedIn } = await awsSsoStatus();
          if (loggedIn) {
            useAppStore.getState().setAwsSsoLoggedIn(true);
            useAppStore.getState().setAwsSsoLoggingIn(false);
            stopPolling();
          }
        } catch { /* ignore */ }
      }, 2000);
    } catch {
      store.setAwsSsoLoggingIn(false);
    }
  }, [store, stopPolling]);

  // Check SSO status on mount
  useEffect(() => {
    awsSsoStatus()
      .then(({ loggedIn }) => store.setAwsSsoLoggedIn(loggedIn))
      .catch(() => {});
  }, []);

  // Cleanup on unmount
  useEffect(() => () => stopPolling(), [stopPolling]);

  return { startLogin };
}

export function TeleportControls() {
  const store = useAppStore();
  const { selectCluster, login, selectInstance } = useTeleport();
  const { startLogin: startAwsSsoLogin } = useAwsSso();

  const isLoggedIn = store.loginStatus?.loggedIn ?? false;
  const isConnected = !!store.connectionResult;

  return (
    <div className="space-y-3">
      {/* tsh status */}
      {!store.tshAvailable && (
        <div className="rounded bg-red-900/30 border border-red-700 px-3 py-2 text-xs text-red-300">
          tsh binary not found. Install Teleport or Teleport Connect.
        </div>
      )}

      {/* Cluster selector */}
      <div>
        <label className={labelClasses}>Cluster</label>
        <select
          className={selectClasses}
          value={store.selectedCluster}
          onChange={(e) => selectCluster(e.target.value)}
          disabled={!store.tshAvailable}
        >
          <option value="">Select a cluster...</option>
          {store.clusters.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>

      {/* Login */}
      {store.selectedCluster && !isLoggedIn && (
        <div className="flex items-center gap-3">
          <button
            onClick={login}
            className="w-full py-2.5 text-sm font-medium rounded bg-red-600 hover:bg-red-500 text-white transition-colors"
          >
            Login via SSO
          </button>
        </div>
      )}

      {/* Login status */}
      {isLoggedIn && (
        <div className="flex items-center gap-2 px-3 py-2 rounded bg-gray-800 border border-gray-700">
          <span className="w-2 h-2 rounded-full bg-green-500" />
          <span className="text-xs text-gray-300">
            Logged in as <span className="text-gray-100">{store.loginStatus!.username}</span>
          </span>
        </div>
      )}

      {/* Instance selector */}
      {isLoggedIn && store.instances.length > 0 && (
        <div>
          <label className={labelClasses}>RDS Instance</label>
          <select
            className={selectClasses}
            value={store.selectedInstance}
            onChange={(e) => selectInstance(e.target.value)}
          >
            <option value="">Select an instance...</option>
            {store.instances.map((inst) => (
              <option key={inst.name} value={inst.name}>
                {inst.name} ({inst.region} / {inst.instanceId})
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Connecting indicator */}
      {store.connecting && (
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Connecting...
        </div>
      )}

      {/* Connected indicator */}
      {isConnected && (
        <div className="rounded bg-gray-800 border border-gray-700 px-3 py-3 space-y-2">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            <span className="text-xs font-medium text-green-400">Connected</span>
          </div>
          <div className="text-xs text-gray-400 space-y-1">
            <div>Cluster: <span className="text-gray-200">{store.selectedCluster}</span></div>
            <div>Instance: <span className="text-gray-200">{store.selectedInstance}</span></div>
            <div>Version: <span className="text-gray-200">{store.connectionResult!.version}</span></div>
          </div>
        </div>
      )}


      {/* AWS SSO */}
      {isConnected && store.awsSsoNeeded && !store.awsSsoLoggedIn && (
        <div className="rounded bg-amber-900/30 border border-amber-700 px-3 py-3 space-y-2">
          <div className="text-xs text-amber-300">
            AWS SSO session required for CloudWatch data and RDS config.
          </div>
          {store.awsSsoLoggingIn ? (
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Complete SSO login in your browser...
            </div>
          ) : (
            <button
              onClick={startAwsSsoLogin}
              className="w-full py-2 text-sm font-medium rounded bg-amber-600 hover:bg-amber-500 text-white transition-colors"
            >
              Login to AWS SSO
            </button>
          )}
        </div>
      )}

      {isConnected && store.awsSsoLoggedIn && (
        <div className="flex items-center gap-2 px-3 py-2 rounded bg-gray-800 border border-gray-700">
          <span className="w-2 h-2 rounded-full bg-green-500" />
          <span className="text-xs text-gray-300">AWS SSO active</span>
        </div>
      )}

      {/* Error */}
      {store.error && (
        <div className="rounded bg-red-900/30 border border-red-700 px-3 py-2 text-xs text-red-300">
          {store.error}
        </div>
      )}
    </div>
  );
}
