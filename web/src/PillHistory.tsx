import { Segmented, Spin } from "antd";
import type { ReactNode } from "react";
import type { HistoricalReading } from "./history";
import { gravityValue, temperatureValue, UnitPreferences } from "./units";

export type HistoryPeriod = "day" | "week" | "month" | "all";

type Metric = "temperatureC" | "gravity";

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
  const series: { key: Metric; label: string; unit: string; decimals: number; color: string; minimumSpan: number; convert: (value: number) => number }[] = [
    { key: "temperatureC", label: "Temperature", unit: units.temperature === "fahrenheit" ? "°F" : "°C", decimals: 1, color: "#d48635", minimumSpan: units.temperature === "fahrenheit" ? 0.7 : 0.4, convert: (value) => temperatureValue(value, units.temperature) },
    { key: "gravity", label: "Gravity", unit: units.gravity === "plato" ? "°P" : "SG", decimals: units.gravity === "plato" ? 1 : 3, color: "#39866b", minimumSpan: units.gravity === "plato" ? 0.5 : 0.002, convert: (value) => gravityValue(value, units.gravity) }
  ];
  const duration = period === "day" ? 86_400_000 : period === "week" ? 7 * 86_400_000 : period === "month" ? 30 * 86_400_000 : 0;
  const cutoff = Date.now() - duration;
  const visible = duration ? readings.filter((reading) => reading.at >= cutoff) : readings;
  const first = visible[0]?.at;
  const last = visible[visible.length - 1]?.at;
  const left = 44, right = 556, top = 20, bottom = 270;
  const x = (at: number) => left + ((at - first!) / Math.max(last! - first!, 1)) * (right - left);

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
      <svg className="pill-history-graph" viewBox="0 0 600 340" role="img" aria-label={`Temperature (${series[0].unit}) and gravity (${series[1].unit}) history from ${dateLabel(first)} to ${dateLabel(last!)}. Temperature scale on the left; gravity scale on the right.`}>
        <title>Temperature and gravity history</title>
        <rect x={left} y={top} width={right - left} height={bottom - top} rx="6" className="pill-history-band" />
        {[0, 0.5, 1].map((fraction) => <line key={fraction} x1={left} x2={right} y1={top + fraction * (bottom - top)} y2={top + fraction * (bottom - top)} className="pill-history-grid-line" />)}
        {series.map((metric, index) => {
          const points = visible.flatMap((reading) => {
            const value = reading[metric.key];
            return typeof value === "number" && Number.isFinite(value) ? [{ at: reading.at, value: metric.convert(value) }] : [];
          });
          const values = points.map((point) => point.value);
          const minimum = values.length ? values.reduce((value, next) => Math.min(value, next), Infinity) : 0;
          const maximum = values.length ? values.reduce((value, next) => Math.max(value, next), -Infinity) : 0;
          const padding = Math.max((maximum - minimum) * 0.1, metric.minimumSpan / 2);
          const floor = minimum - padding;
          const ceiling = maximum + padding;
          const y = (value: number) => bottom - ((value - floor) / (ceiling - floor)) * (bottom - top);
          const path = points.map((point, pointIndex) => `${pointIndex ? "L" : "M"}${x(point.at).toFixed(2)},${y(point.value).toFixed(2)}`).join(" ");
          const latest = points[points.length - 1];
          const axisX = index === 0 ? left - 9 : right + 9;
          const anchor = index === 0 ? "end" : "start";
          return <g key={metric.key}>
            {[0, 0.5, 1].map((fraction) => <text key={fraction} x={axisX} y={top + fraction * (bottom - top) + 3} textAnchor={anchor} className="pill-history-axis" style={{ fill: metric.color }}>{points.length ? (ceiling - fraction * (ceiling - floor)).toFixed(metric.decimals) : "—"}</text>)}
            {points.length > 1 && <path d={path} fill="none" stroke={metric.color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />}
            {latest && <circle cx={x(latest.at)} cy={y(latest.value)} r="4" fill={metric.color}><title>{metric.label}: {latest.value.toFixed(metric.decimals)} {metric.unit} · {dateLabel(latest.at)}</title></circle>}
            <line x1={index === 0 ? left : right - 115} x2={index === 0 ? left + 16 : right - 99} y1="322" y2="322" stroke={metric.color} strokeWidth="3" />
            <text x={index === 0 ? left + 22 : right - 93} y="325" className="pill-history-label" fill={metric.color}>{metric.label} ({metric.unit})</text>
          </g>;
        })}
        <text x={left} y="296" className="pill-history-axis">{dateLabel(first)}</text>
        <text x={right} y="296" textAnchor="end" className="pill-history-axis">{dateLabel(last!)}</text>
      </svg>}
  </div>;
}
