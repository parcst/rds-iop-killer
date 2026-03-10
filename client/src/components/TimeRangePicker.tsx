import { useState } from 'react';
import { useAppStore, TIME_PRESETS } from '../store/app-store';

export function TimeRangePicker() {
  const timeRange = useAppStore((s) => s.timeRange);
  const setTimeRange = useAppStore((s) => s.setTimeRange);
  const showUtc = useAppStore((s) => s.showUtc);
  const setShowUtc = useAppStore((s) => s.setShowUtc);

  const [showCustom, setShowCustom] = useState(false);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  const handlePreset = (label: string, minutes: number) => {
    const now = new Date();
    setTimeRange({
      since: new Date(now.getTime() - minutes * 60 * 1000).toISOString(),
      until: now.toISOString(),
      label,
    });
    setShowCustom(false);
  };

  const handleCustomApply = () => {
    if (!customFrom || !customTo) return;
    // If in UTC mode, treat inputs as UTC; otherwise as local
    const sinceStr = showUtc ? customFrom + ':00Z' : customFrom;
    const untilStr = showUtc ? customTo + ':00Z' : customTo;
    const since = new Date(sinceStr);
    const until = new Date(untilStr);
    if (isNaN(since.getTime()) || isNaN(until.getTime()) || since >= until) return;
    setTimeRange({
      since: since.toISOString(),
      until: until.toISOString(),
      label: 'Custom',
    });
    setShowCustom(false);
  };

  const formatDisplay = (iso: string) => {
    const d = new Date(iso);
    const opts: Intl.DateTimeFormatOptions = {
      hour12: false,
      ...(showUtc ? { timeZone: 'UTC' } : {}),
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
    };
    return d.toLocaleString([], opts);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {TIME_PRESETS.map(({ label, minutes }) => (
        <button
          key={label}
          onClick={() => handlePreset(label, minutes)}
          className={`px-2 py-1 text-[11px] rounded border transition-colors ${
            timeRange.label === label
              ? 'bg-red-600 text-white border-red-600'
              : 'bg-gray-800 text-gray-400 border-gray-700 hover:border-gray-600 hover:text-gray-300'
          }`}
        >
          {label}
        </button>
      ))}

      {/* Custom range button */}
      <button
        onClick={() => setShowCustom(!showCustom)}
        className={`px-2 py-1 text-[11px] rounded border transition-colors ${
          showCustom || timeRange.label === 'Custom'
            ? 'bg-red-600 text-white border-red-600'
            : 'bg-gray-800 text-gray-400 border-gray-700 hover:border-gray-600 hover:text-gray-300'
        }`}
      >
        Custom
      </button>

      {/* UTC / Local toggle */}
      <div className="flex items-center gap-0 ml-1 border border-gray-700 rounded overflow-hidden">
        <button
          onClick={() => setShowUtc(false)}
          className={`px-2 py-0.5 text-[10px] transition-colors ${
            !showUtc ? 'bg-red-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-300'
          }`}
        >
          Local
        </button>
        <button
          onClick={() => setShowUtc(true)}
          className={`px-2 py-0.5 text-[10px] transition-colors ${
            showUtc ? 'bg-red-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-300'
          }`}
        >
          UTC
        </button>
      </div>

      <div className="text-[10px] text-gray-500 ml-1">
        {formatDisplay(timeRange.since)} — {formatDisplay(timeRange.until)}
        {showUtc && <span className="ml-1 text-gray-600">UTC</span>}
        {timeRange.label === 'Custom' && (
          <span className="ml-1 text-amber-500">(custom range)</span>
        )}
      </div>

      {/* Custom range inputs */}
      {showCustom && (
        <div className="flex items-center gap-2 w-full mt-1">
          <label className="text-[10px] text-gray-500">From{showUtc ? ' (UTC)' : ''}:</label>
          <input
            type="datetime-local"
            value={customFrom}
            onChange={(e) => setCustomFrom(e.target.value)}
            step="60"
            className="bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] text-gray-200 focus:border-red-500 focus:outline-none"
          />
          <label className="text-[10px] text-gray-500">To{showUtc ? ' (UTC)' : ''}:</label>
          <input
            type="datetime-local"
            value={customTo}
            onChange={(e) => setCustomTo(e.target.value)}
            step="60"
            className="bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] text-gray-200 focus:border-red-500 focus:outline-none"
          />
          <button
            onClick={handleCustomApply}
            disabled={!customFrom || !customTo}
            className="px-3 py-0.5 text-[11px] rounded bg-red-600 hover:bg-red-500 text-white disabled:bg-gray-700 disabled:text-gray-500 transition-colors"
          >
            Investigate
          </button>
        </div>
      )}
    </div>
  );
}
