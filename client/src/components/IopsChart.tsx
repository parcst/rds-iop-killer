import { useRef, useState, useCallback } from 'react';
import { useAppStore } from '../store/app-store';

const PADDING = { top: 20, right: 75, bottom: 32, left: 70 };

type SeriesKey = 'read' | 'write' | 'total' | 'threshold' | 'queue' | 'latency';

const SERIES_CONFIG: Record<SeriesKey, { label: string; color: string; dashed?: boolean; secondary?: boolean }> = {
  read: { label: 'ReadIOPS', color: '#3b82f6' },
  write: { label: 'WriteIOPS', color: '#f59e0b' },
  total: { label: 'Total', color: 'rgba(255,255,255,0.7)' },
  threshold: { label: 'Provisioned IOPS Limit', color: '#ef4444', dashed: true },
  queue: { label: 'Queue Depth', color: '#22c55e', dashed: true, secondary: true },
  latency: { label: 'Read Latency (ms)', color: '#a855f7', dashed: true, secondary: true },
};

function formatNumber(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(Math.round(n));
}

function formatTimeLabel(iso: string, rangeMins: number, utc: boolean): string {
  const d = new Date(iso);
  const opts: Intl.DateTimeFormatOptions = { hour12: false, ...(utc ? { timeZone: 'UTC' } : {}) };
  if (rangeMins <= 60) return d.toLocaleTimeString([], { ...opts, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  if (rangeMins <= 1440) return d.toLocaleTimeString([], { ...opts, hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { ...opts, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function IopsChart({ chartHeight = 200 }: { chartHeight?: number }) {
  const cloudwatchData = useAppStore((s) => s.cloudwatchData);
  const timeRange = useAppStore((s) => s.timeRange);
  const setTimeRange = useAppStore((s) => s.setTimeRange);
  const iopsLoading = useAppStore((s) => s.iopsLoading);
  const showUtc = useAppStore((s) => s.showUtc);
  const iopsThreshold = useAppStore((s) => s.iopsThreshold);

  const svgRef = useRef<SVGSVGElement>(null);
  const [dragStart, setDragStart] = useState<number | null>(null);
  const [dragEnd, setDragEnd] = useState<number | null>(null);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [hiddenSeries, setHiddenSeries] = useState<Set<SeriesKey>>(new Set());

  const toggleSeries = useCallback((key: SeriesKey) => {
    setHiddenSeries(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const isVisible = (key: SeriesKey) => !hiddenSeries.has(key);

  const width = 900;
  const height = chartHeight;
  const chartW = width - PADDING.left - PADDING.right;
  const chartH = height - PADDING.top - PADDING.bottom;

  const rangeMins = (new Date(timeRange.until).getTime() - new Date(timeRange.since).getTime()) / 60000;

  const data = cloudwatchData;

  // Y axis — scale based on visible primary series only
  const primaryMaxes: number[] = [];
  if (isVisible('total')) primaryMaxes.push(...data.map(p => p.totalIops));
  if (isVisible('read')) primaryMaxes.push(...data.map(p => p.readIops));
  if (isVisible('write')) primaryMaxes.push(...data.map(p => p.writeIops));
  const dataMax = primaryMaxes.length > 0 ? Math.max(...primaryMaxes, 1) : 1;
  const yMax = Math.max(dataMax, isVisible('threshold') && iopsThreshold > 0 ? iopsThreshold * 1.2 : 0) * 1.1;

  const xScale = (i: number) => PADDING.left + (i / Math.max(data.length - 1, 1)) * chartW;
  const yScale = (v: number) => PADDING.top + chartH - (v / yMax) * chartH;

  // Secondary Y axis — scale based on visible secondary series only
  const hasSecondaryData = data.some(p => p.diskQueueDepth > 0 || p.readLatencyMs > 0);
  const showSecondary = hasSecondaryData && (isVisible('queue') || isVisible('latency'));
  const secondaryMaxes: number[] = [];
  if (isVisible('queue')) secondaryMaxes.push(...data.map(p => p.diskQueueDepth));
  if (isVisible('latency')) secondaryMaxes.push(...data.map(p => p.readLatencyMs));
  const y2Max = secondaryMaxes.length > 0 ? Math.max(...secondaryMaxes, 0.1) * 1.2 : 1;
  const y2Scale = (v: number) => PADDING.top + chartH - (v / y2Max) * chartH;

  // Build SVG paths
  const totalPath = data.map((p, i) => `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)},${yScale(p.totalIops).toFixed(1)}`).join(' ');
  const totalArea = totalPath + ` L${xScale(data.length - 1).toFixed(1)},${yScale(0).toFixed(1)} L${xScale(0).toFixed(1)},${yScale(0).toFixed(1)} Z`;
  const readPath = data.map((p, i) => `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)},${yScale(p.readIops).toFixed(1)}`).join(' ');
  const writePath = data.map((p, i) => `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)},${yScale(p.writeIops).toFixed(1)}`).join(' ');
  const queuePath = hasSecondaryData ? data.map((p, i) => `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)},${y2Scale(p.diskQueueDepth).toFixed(1)}`).join(' ') : '';
  const latencyPath = hasSecondaryData ? data.map((p, i) => `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)},${y2Scale(p.readLatencyMs).toFixed(1)}`).join(' ') : '';

  // Ticks — adapt count to chart height for readability
  const yTickCount = Math.max(2, Math.min(10, Math.floor(chartH / 30)));
  const yTicks = Array.from({ length: yTickCount + 1 }, (_, i) => (i / yTickCount) * yMax);
  const y2TickCount = Math.max(2, Math.min(6, Math.floor(chartH / 50)));
  const y2Ticks = Array.from({ length: y2TickCount + 1 }, (_, i) => (i / y2TickCount) * y2Max);
  const tickCount = 13;
  const xTicks = Array.from({ length: tickCount }, (_, i) =>
    Math.round((i / (tickCount - 1)) * (data.length - 1))
  ).filter((v, i, arr) => v >= 0 && v < data.length && arr.indexOf(v) === i);

  // Drag-to-zoom
  const getXIndex = useCallback((clientX: number) => {
    if (!svgRef.current) return 0;
    const rect = svgRef.current.getBoundingClientRect();
    const scale = width / rect.width;
    const viewBoxX = (clientX - rect.left) * scale;
    const x = viewBoxX - PADDING.left;
    const pct = Math.max(0, Math.min(1, x / chartW));
    return Math.round(pct * (data.length - 1));
  }, [data.length, chartW]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const idx = getXIndex(e.clientX);
    setDragStart(idx);
    setDragEnd(idx);
  }, [getXIndex]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const idx = getXIndex(e.clientX);
    setHoveredIdx(idx);
    if (dragStart !== null) setDragEnd(idx);
  }, [dragStart, getXIndex]);

  const handleMouseUp = useCallback(() => {
    if (dragStart !== null && dragEnd !== null && Math.abs(dragEnd - dragStart) >= 2) {
      const minIdx = Math.min(dragStart, dragEnd);
      const maxIdx = Math.max(dragStart, dragEnd);
      if (data[minIdx] && data[maxIdx]) {
        setTimeRange({
          since: data[minIdx].timestamp,
          until: data[maxIdx].timestamp,
          label: 'Custom',
        });
      }
    }
    setDragStart(null);
    setDragEnd(null);
  }, [dragStart, dragEnd, data, setTimeRange]);

  const handleMouseLeave = useCallback(() => {
    setHoveredIdx(null);
    if (dragStart !== null) {
      setDragStart(null);
      setDragEnd(null);
    }
  }, [dragStart]);

  // Empty state (no data and not loading)
  if (data.length === 0 && !iopsLoading) {
    return (
      <div className="flex items-center justify-center text-gray-600 text-xs">
        No CloudWatch data — ensure AWS SSO is active
      </div>
    );
  }

  // Pure loading state (no data yet)
  if (data.length === 0 && iopsLoading) {
    return (
      <div className="flex items-center justify-center text-gray-400 text-xs gap-2">
        <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <span>Loading CloudWatch IOPS...</span>
      </div>
    );
  }

  const selX1 = dragStart !== null && dragEnd !== null ? xScale(Math.min(dragStart, dragEnd)) : null;
  const selX2 = dragStart !== null && dragEnd !== null ? xScale(Math.max(dragStart, dragEnd)) : null;
  const hoveredPoint = hoveredIdx !== null && data[hoveredIdx] ? data[hoveredIdx] : null;
  const breachCount = iopsThreshold > 0 ? data.filter(p => p.totalIops > iopsThreshold).length : 0;
  const peak = Math.max(...data.map(p => p.totalIops));

  // Which legend items to show
  const availableSeries: SeriesKey[] = ['read', 'write', 'total'];
  if (iopsThreshold > 0) availableSeries.push('threshold');
  if (hasSecondaryData) availableSeries.push('queue', 'latency');

  return (
    <div className="relative">
      {/* Loading overlay — shows on top of stale chart */}
      {iopsLoading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-900/60 rounded">
          <div className="flex items-center gap-2 bg-gray-800 border border-gray-700 rounded px-3 py-1.5">
            <svg className="animate-spin h-4 w-4 text-blue-400" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span className="text-xs text-gray-300">Fetching CloudWatch IOPS...</span>
          </div>
        </div>
      )}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        className="w-full select-none cursor-crosshair"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
      >
        {/* Y-axis label */}
        <text x={14} y={PADDING.top + chartH / 2} textAnchor="middle" fill="#9ca3af" fontSize={10} fontWeight="500" transform={`rotate(-90, 14, ${PADDING.top + chartH / 2})`}>
          IOPS
        </text>

        {/* Grid lines */}
        {yTicks.map((v, i) => (
          <g key={i}>
            <line x1={PADDING.left} y1={yScale(v)} x2={width - PADDING.right} y2={yScale(v)} stroke="#1f2937" strokeWidth={1} />
            <text x={PADDING.left - 8} y={yScale(v) + 3} textAnchor="end" fill="#6b7280" fontSize={9}>
              {formatNumber(v)}
            </text>
          </g>
        ))}

        {/* X axis labels */}
        {xTicks.map((i) => (
          data[i] && (
            <text key={i} x={xScale(i)} y={height - 4} textAnchor="middle" fill="#6b7280" fontSize={7}>
              {formatTimeLabel(data[i].timestamp, rangeMins, showUtc)}
            </text>
          )
        ))}

        {/* Breach zone — red fill above threshold */}
        {isVisible('threshold') && iopsThreshold > 0 && (
          <>
            <defs>
              <clipPath id="breach-clip">
                <rect x={PADDING.left} y={PADDING.top} width={chartW} height={Math.max(yScale(iopsThreshold) - PADDING.top, 0)} />
              </clipPath>
            </defs>
            <path d={totalArea} fill="rgba(239, 68, 68, 0.35)" clipPath="url(#breach-clip)" />
          </>
        )}

        {/* Total IOPS area fill */}
        {isVisible('total') && <path d={totalArea} fill="rgba(255, 255, 255, 0.04)" />}

        {/* Total IOPS line (white) */}
        {isVisible('total') && <path d={totalPath} fill="none" stroke="rgba(255, 255, 255, 0.7)" strokeWidth={1} />}

        {/* Provisioned IOPS threshold line */}
        {isVisible('threshold') && iopsThreshold > 0 && (
          <>
            <line
              x1={PADDING.left} y1={yScale(iopsThreshold)}
              x2={width - PADDING.right} y2={yScale(iopsThreshold)}
              stroke="#ef4444" strokeWidth={1.5} strokeDasharray="6 3" opacity={0.8}
            />
            <text
              x={width - PADDING.right - 2} y={yScale(iopsThreshold) - 4}
              textAnchor="end" fill="#ef4444" fontSize={8} fontWeight="bold" opacity={0.9}
            >
              PROVISIONED IOPS ({formatNumber(iopsThreshold)})
            </text>
          </>
        )}

        {/* ReadIOPS line (blue) */}
        {isVisible('read') && <path d={readPath} fill="none" stroke="#3b82f6" strokeWidth={1.5} />}

        {/* WriteIOPS line (orange) */}
        {isVisible('write') && <path d={writePath} fill="none" stroke="#f59e0b" strokeWidth={1.5} />}

        {/* DiskQueueDepth line (green) */}
        {isVisible('queue') && hasSecondaryData && queuePath && (
          <path d={queuePath} fill="none" stroke="#22c55e" strokeWidth={1} strokeDasharray="4 2" opacity={0.7} />
        )}

        {/* ReadLatency line (purple) */}
        {isVisible('latency') && hasSecondaryData && latencyPath && (
          <path d={latencyPath} fill="none" stroke="#a855f7" strokeWidth={1} strokeDasharray="4 2" opacity={0.7} />
        )}

        {/* Secondary Y-axis labels (right side) */}
        {showSecondary && y2Ticks.map((v, i) => (
          <text key={`y2-${i}`} x={width - PADDING.right + 8} y={y2Scale(v) + 3} textAnchor="start" fill="#6b7280" fontSize={9}>
            {v.toFixed(v >= 10 ? 0 : 1)}
          </text>
        ))}
        {showSecondary && (
          <text x={width - 14} y={PADDING.top + chartH / 2} textAnchor="middle" fill="#9ca3af" fontSize={10} fontWeight="500" transform={`rotate(90, ${width - 14}, ${PADDING.top + chartH / 2})`}>
            Depth / Latency
          </text>
        )}

        {/* Drag selection overlay */}
        {selX1 !== null && selX2 !== null && (
          <rect
            x={selX1} y={PADDING.top} width={selX2 - selX1} height={chartH}
            fill="rgba(59, 130, 246, 0.15)" stroke="#3b82f6" strokeWidth={1} strokeDasharray="3 2"
          />
        )}

        {/* Hover crosshair */}
        {hoveredIdx !== null && dragStart === null && (
          <line
            x1={xScale(hoveredIdx)} y1={PADDING.top}
            x2={xScale(hoveredIdx)} y2={PADDING.top + chartH}
            stroke="#4b5563" strokeWidth={1} strokeDasharray="2 2"
          />
        )}
      </svg>

      {/* Clickable legend */}
      <div className="flex items-center gap-4 px-4 mt-1">
        {availableSeries.map(key => {
          const cfg = SERIES_CONFIG[key];
          const visible = isVisible(key);
          return (
            <button
              key={key}
              onClick={() => toggleSeries(key)}
              className={`flex items-center gap-1.5 transition-opacity ${visible ? 'opacity-100' : 'opacity-35'}`}
              title={visible ? `Hide ${cfg.label}` : `Show ${cfg.label}`}
            >
              <div
                className="w-3 h-0.5 rounded"
                style={cfg.dashed
                  ? { borderTop: `1.5px dashed ${cfg.color}`, opacity: visible ? 1 : 0.4 }
                  : { backgroundColor: cfg.color, opacity: visible ? 1 : 0.4 }
                }
              />
              <span className={`text-[10px] select-none ${visible ? 'text-gray-400' : 'text-gray-600 line-through'}`}>
                {cfg.label}
              </span>
            </button>
          );
        })}

        <span className="text-[10px] text-gray-600 ml-auto">Drag to zoom</span>
      </div>

      {/* Breach summary */}
      {isVisible('threshold') && iopsThreshold > 0 && breachCount > 0 && (
        <div className="flex items-center gap-2 px-4 mt-0.5 mb-1">
          <span className="text-[10px] font-medium text-red-400">
            BREACH — {breachCount} of {data.length} intervals exceed provisioned IOPS
          </span>
          <span className="text-[10px] text-gray-600">
            Peak: {formatNumber(peak)}/s ({((peak / iopsThreshold) * 100).toFixed(0)}% of {formatNumber(iopsThreshold)} limit)
          </span>
        </div>
      )}

      {/* Hover tooltip */}
      {hoveredPoint && dragStart === null && (
        <div className={`absolute top-2 right-6 border rounded px-2 py-1.5 text-[10px] text-gray-300 space-y-0.5 pointer-events-none ${
          iopsThreshold > 0 && hoveredPoint.totalIops > iopsThreshold
            ? 'bg-red-950 border-red-700'
            : 'bg-gray-800 border-gray-700'
        }`}>
          <div className="text-gray-500">{formatTimeLabel(hoveredPoint.timestamp, rangeMins, showUtc)}</div>
          {isVisible('read') && <div>Read: <span className="text-blue-400 font-medium">{formatNumber(hoveredPoint.readIops)}</span></div>}
          {isVisible('write') && <div>Write: <span className="text-amber-400 font-medium">{formatNumber(hoveredPoint.writeIops)}</span></div>}
          {isVisible('total') && <div>Total: <span className="text-white font-medium">{formatNumber(hoveredPoint.totalIops)}</span></div>}
          {hasSecondaryData && isVisible('queue') && (
            <div>Queue: <span className="text-green-400 font-medium">{hoveredPoint.diskQueueDepth.toFixed(1)}</span></div>
          )}
          {hasSecondaryData && isVisible('latency') && (
            <div>Latency: <span className="text-purple-400 font-medium">{hoveredPoint.readLatencyMs.toFixed(2)}ms</span></div>
          )}
          {isVisible('threshold') && iopsThreshold > 0 && hoveredPoint.totalIops > iopsThreshold && (
            <div className="text-red-400 font-bold">BREACH ({((hoveredPoint.totalIops / iopsThreshold) * 100).toFixed(0)}% of limit)</div>
          )}
        </div>
      )}
    </div>
  );
}
