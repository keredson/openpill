import { Segmented, Spin } from "antd";
import type { ReactNode } from "react";
import { useState } from "react";
import type { HistoricalReading } from "./history";
import { gravityValue, temperatureValue, UnitPreferences } from "./units";

export type HistoryPeriod = "day" | "week" | "month" | "all";

type Metric = "temperatureC" | "gravity" | "batteryPercent";

function dateLabel(at: number) {
  return new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default function PillHistory({ readings, period, onPeriodChange, loading, error, summary, units }: {
  readings: HistoricalReading[];
  period: HistoryPeriod;
  onPeriodChange: (period: HistoryPeriod) => void;
  loading: boolean;
  error: string;
  summary: ReactNode;
  units: UnitPreferences;
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const series: { key: Metric; label: string; unit: string; decimals: number; color: string; minimumSpan: number; fixedRange?: [number, number]; convert: (value: number) => number }[] = [
    { key: "temperatureC", label: "Temperature", unit: units.temperature === "fahrenheit" ? "°F" : "°C", decimals: 1, color: "#d48635", minimumSpan: units.temperature === "fahrenheit" ? 0.7 : 0.4, convert: (value) => temperatureValue(value, units.temperature) },
    { key: "gravity", label: "Gravity", unit: units.gravity === "plato" ? "°P" : "SG", decimals: units.gravity === "plato" ? 1 : 3, color: "#39866b", minimumSpan: units.gravity === "plato" ? 0.5 : 0.002, convert: (value) => gravityValue(value, units.gravity) },
    { key: "batteryPercent", label: "Battery", unit: "%", decimals: 0, color: "#6176c4", minimumSpan: 100, fixedRange: [0, 100], convert: (value) => value }
  ];
  const duration = period === "day" ? 86_400_000 : period === "week" ? 7 * 86_400_000 : period === "month" ? 30 * 86_400_000 : 0;
  const cutoff = Date.now() - duration;
  const visible = duration ? readings.filter((reading) => reading.at >= cutoff) : readings;
  const first = visible[0]?.at;
  const last = visible[visible.length - 1]?.at;
  const left = 44, right = 556, top = 20, bottom = 270;
  const x = (at: number) => left + ((at - first!) / Math.max(last! - first!, 1)) * (right - left);
  const hovered = hoverIndex == null ? null : visible[hoverIndex] ?? null;

  function pointAt(clientX: number, width: number, start: number): void {
    const graphX = (clientX - start) * 600 / width;
    const at = first! + Math.max(0, Math.min(1, (graphX - left) / (right - left))) * (last! - first!);
    let low = 0, high = visible.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (visible[middle].at < at) low = middle + 1;
      else high = middle;
    }
    setHoverIndex(low === 0 ? 0 : low === visible.length ||
      at - visible[low - 1].at <= visible[low].at - at ? low - 1 : low);
  }

  return <div className="pill-history">
    <div className="pill-history-heading">
      {summary}
      <Segmented size="small" aria-label="History period" value={period} onChange={(value) => onPeriodChange(value as HistoryPeriod)} options={[
        { label: "24h", value: "day" }, { label: "7d", value: "week" },
        { label: "30d", value: "month" }, { label: "All", value: "all" }
      ]} />
    </div>
    {error ? <div className="pill-history-empty" role="status">{error}</div> : loading ?
      <div className="pill-history-empty"><Spin size="small" /></div> : first === undefined ?
      <div className="pill-history-empty">No readings yet for this period.</div> :
      <div className="pill-history-graph-wrap">
      <svg className="pill-history-graph" viewBox="0 0 600 340" role="img" aria-label={`Temperature (${series[0].unit}) on the left, gravity (${series[1].unit}) on the right, and battery percentage history from ${dateLabel(first)} to ${dateLabel(last!)}. Battery uses a fixed 0 to 100 percent scale without axis labels.`}
        onMouseMove={(event) => { const rect = event.currentTarget.getBoundingClientRect();
          const graphY = (event.clientY - rect.top) * 340 / rect.height;
          if (graphY < top || graphY > bottom) { setHoverIndex(null); return; }
          pointAt(event.clientX, rect.width, rect.left);
        }}
        onMouseLeave={() => setHoverIndex(null)}>
        <rect x={left} y={top} width={right - left} height={bottom - top} rx="6" className="pill-history-band" />
        {[0, 0.5, 1].map((fraction) => <line key={fraction} x1={left} x2={right} y1={top + fraction * (bottom - top)} y2={top + fraction * (bottom - top)} className="pill-history-grid-line" />)}
        {hovered && <line x1={x(hovered.at)} x2={x(hovered.at)} y1={top} y2={bottom} className="pill-history-hover-line" />}
        {series.map((metric, index) => {
          const points = visible.flatMap((reading) => {
            const value = reading[metric.key];
            return typeof value === "number" && Number.isFinite(value) ? [{ at: reading.at,
              value: metric.fixedRange ? Math.max(metric.fixedRange[0], Math.min(metric.fixedRange[1], metric.convert(value))) : metric.convert(value) }] : [];
          });
          const values = points.map((point) => point.value);
          const minimum = values.length ? values.reduce((value, next) => Math.min(value, next), Infinity) : 0;
          const maximum = values.length ? values.reduce((value, next) => Math.max(value, next), -Infinity) : 0;
          const padding = Math.max((maximum - minimum) * 0.1, metric.minimumSpan / 2);
          const floor = metric.fixedRange?.[0] ?? minimum - padding;
          const ceiling = metric.fixedRange?.[1] ?? maximum + padding;
          const y = (value: number) => bottom - ((value - floor) / (ceiling - floor)) * (bottom - top);
          const path = points.map((point, pointIndex) => `${pointIndex ? "L" : "M"}${x(point.at).toFixed(2)},${y(point.value).toFixed(2)}`).join(" ");
          const legendX = left + index * 160;
          return <g key={metric.key}>
            {index < 2 && [0, 0.5, 1].map((fraction) => <text key={fraction} x={index === 0 ? left - 9 : right + 9} y={top + fraction * (bottom - top) + 3}
              textAnchor={index === 0 ? "end" : "start"} className="pill-history-axis" style={{ fill: metric.color }}>
              {points.length ? (ceiling - fraction * (ceiling - floor)).toFixed(metric.decimals) : "—"}
            </text>)}
            {points.length > 1 && <path d={path} fill="none" stroke={metric.color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />}
            {hovered && typeof hovered[metric.key] === "number" && Number.isFinite(hovered[metric.key]) &&
              <circle cx={x(hovered.at)} cy={y(metric.fixedRange
                ? Math.max(metric.fixedRange[0], Math.min(metric.fixedRange[1], metric.convert(hovered[metric.key]!)))
                : metric.convert(hovered[metric.key]!))} r="5" fill={metric.color} stroke="white" strokeWidth="1.5" />}
            <line x1={legendX} x2={legendX + 16} y1="322" y2="322" stroke={metric.color} strokeWidth="3" />
            <text x={legendX + 22} y="325" className="pill-history-label" fill={metric.color}>{metric.label} ({metric.unit})</text>
          </g>;
        })}
        <text x={left} y="296" className="pill-history-axis">{dateLabel(first)}</text>
        <text x={right} y="296" textAnchor="end" className="pill-history-axis">{dateLabel(last!)}</text>
      </svg>
      {hovered && <div className="pill-history-tooltip" role="tooltip" style={{ left: `${Math.max(18, Math.min(82, x(hovered.at) / 600 * 100))}%` }}>
        <strong>{dateLabel(hovered.at)}</strong>
        {series.map((metric) => {
          const raw = hovered[metric.key];
          return typeof raw === "number" && Number.isFinite(raw) ? <span key={metric.key} style={{ color: metric.color }}>
            {metric.label}: {metric.convert(raw).toFixed(metric.decimals)} {metric.unit}
          </span> : null;
        })}
      </div>}
      </div>}
  </div>;
}
