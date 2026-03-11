import { useAppStore } from './store/app-store';
import { TeleportControls } from './components/TeleportControls';
import { IopsView } from './components/IopsView';
import { RootCauseAnalysis } from './components/RootCauseAnalysis';
import { ParameterGroupPanel } from './components/ParameterGroupPanel';

export default function App() {
  const connectionResult = useAppStore((s) => s.connectionResult);

  return (
    <div className="h-screen flex flex-col bg-gray-950 text-gray-100">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-950 flex items-center gap-3 px-6 py-4">
        <div className="w-8 h-8 rounded-lg bg-red-600 flex items-center justify-center">
          <span className="text-white text-sm font-bold">IOP</span>
        </div>
        <div>
          <h1 className="text-lg font-semibold text-white">RDS IOP Killer</h1>
          <p className="text-xs text-gray-500">Connect to RDS MySQL instances via Teleport</p>
        </div>
      </header>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-80 shrink-0 border-r border-gray-800 bg-gray-900 flex flex-col overflow-y-auto">
          <div className="p-4 space-y-4">
            <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider">
              Connection
            </h2>
            <TeleportControls />
            <ParameterGroupPanel />
            <RootCauseAnalysis />
          </div>
        </aside>

        {/* Main area */}
        <section className="flex-1 overflow-hidden flex flex-col">
          {connectionResult ? (
            <IopsView />
          ) : (
            <div className="flex items-center justify-center h-full text-gray-600">
              <div className="text-center">
                <div className="text-4xl mb-3 opacity-30">&#9881;</div>
                <p className="text-sm">Connect to a database to get started</p>
                <p className="text-xs text-gray-700 mt-1">Select a cluster and instance from the sidebar</p>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
