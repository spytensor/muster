import type { ReactNode } from "react";
import { axis, type Chart, formatNumber } from "./chart";

const FONT = `"Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif`;
const SIZE = 15;

/** A chart from a presentation, drawn at the size of its frame on the slide. */
export function ChartView({ chart, w, h }: { chart: Chart; w: number; h: number }) {
  const round = chart.kind === "pie" || chart.kind === "doughnut";
  const first = chart.series[0];
  const entries = round
    ? chart.categories.map((name, index) => ({
        name,
        color: first?.colors[index] ?? PIE[index % PIE.length] ?? "gray",
      }))
    : chart.series.map((one) => ({ name: one.name, color: one.color }));
  const legend = chart.legend && (round || chart.series.length > 1) ? chart.legend : null;
  const side = legend === "l" || legend === "r";
  const titleH = chart.title ? 34 : 0;
  const legendH = legend && !side ? 34 : 0;
  const legendW = legend && side ? Math.min(w * 0.3, 170) : 0;
  const area = {
    x: legend === "l" ? legendW : 0,
    y: titleH + (legend === "t" ? legendH : 0),
    w: w - legendW,
    h: h - titleH - legendH,
  };
  return (
    <svg
      role="img"
      aria-label={chart.title || entries.map((entry) => entry.name).join(", ")}
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      style={{
        position: "absolute",
        inset: 0,
        fontFamily: FONT,
        fontSize: SIZE,
        overflow: "visible",
      }}
    >
      {chart.title && (
        <text
          x={w / 2}
          y={22}
          textAnchor="middle"
          // A long title is set smaller so that all of it is inside the chart.
          fontSize={Math.max(10, Math.min(18, (18 * (w - 16)) / wide(chart.title, 18)))}
          fontWeight={700}
          fill="rgb(20,24,31)"
        >
          {chart.title}
        </text>
      )}
      {round ? <Round chart={chart} area={area} /> : <Plot chart={chart} area={area} />}
      {legend && (
        <Legend
          entries={entries}
          color={chart.axisColor}
          side={side}
          x={legend === "r" ? w - legendW + 12 : side ? 0 : 0}
          y={side ? titleH : legend === "t" ? titleH : h - legendH}
          w={side ? legendW : w}
          h={side ? h - titleH : legendH}
        />
      )}
    </svg>
  );
}

const PIE = ["#2F6BFF", "#0B1F3A", "#12B5A5", "#F59E0B", "#8B5CF6", "#EF4444", "#64748B"];
interface Area {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** Roughly how wide a label is drawn, to keep labels off each other. */
const wide = (text: string, size = SIZE) =>
  [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2e7f ? size : size * 0.56), 0);

function Legend({
  entries,
  color,
  side,
  x,
  y,
  w,
  h,
}: {
  entries: { name: string; color: string }[];
  color: string;
  side: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}) {
  if (side)
    return (
      <g>
        {entries.map((entry, index) => {
          const top = y + h / 2 - (entries.length * 26) / 2 + index * 26;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: the series of a chart never reorder
            <g key={index}>
              <rect x={x} y={top + 4} width={12} height={12} rx={2} fill={entry.color} />
              <text x={x + 20} y={top + 15} fill={color}>
                {entry.name}
              </text>
            </g>
          );
        })}
      </g>
    );
  const widths = entries.map((entry) => 12 + 8 + wide(entry.name) + 24);
  const total = widths.reduce((sum, one) => sum + one, 0) - 24;
  let at = x + Math.max(0, (w - total) / 2);
  return (
    <g>
      {entries.map((entry, index) => {
        const left = at;
        at += widths[index] ?? 0;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: the series of a chart never reorder
          <g key={index}>
            <rect x={left} y={y + h / 2 - 6} width={12} height={12} rx={2} fill={entry.color} />
            <text x={left + 20} y={y + h / 2 + 5} fill={color}>
              {entry.name}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function Round({ chart, area }: { chart: Chart; area: Area }) {
  const series = chart.series[0];
  const values = (series?.values ?? []).map((value) => Math.max(0, value ?? 0));
  const total = values.reduce((sum, one) => sum + one, 0);
  if (!series || total <= 0) return null;
  const cx = area.x + area.w / 2;
  const cy = area.y + area.h / 2;
  const r = Math.max(10, Math.min(area.w, area.h) / 2 - 12);
  const inner = chart.kind === "doughnut" ? r * chart.hole : 0;
  const point = (angle: number, radius: number) =>
    `${cx + radius * Math.sin(angle)} ${cy - radius * Math.cos(angle)}`;
  let from = 0;
  return (
    <g>
      {values.map((value, index) => {
        if (value <= 0) return null;
        const share = value / total;
        // A whole circle cannot be drawn as one arc, so it stops a hair short.
        const to = from + Math.min(share, 0.9999) * Math.PI * 2;
        const large = to - from > Math.PI ? 1 : 0;
        const d = inner
          ? `M ${point(from, r)} A ${r} ${r} 0 ${large} 1 ${point(to, r)} L ${point(to, inner)} A ${inner} ${inner} 0 ${large} 0 ${point(from, inner)} Z`
          : `M ${cx} ${cy} L ${point(from, r)} A ${r} ${r} 0 ${large} 1 ${point(to, r)} Z`;
        const middle = (from + to) / 2;
        const at = inner ? (r + inner) / 2 : r * 0.64;
        from = to;
        const label =
          chart.labels === "percent"
            ? `${Math.round(share * 100)}%`
            : chart.labels === "value"
              ? formatNumber(value, chart.format)
              : "";
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: the slices of a chart never reorder
          <g key={index}>
            <path
              d={d}
              fill={series.colors[index] ?? PIE[index % PIE.length]}
              stroke="#fff"
              strokeWidth={2}
            />
            {label && share >= 0.04 && (
              <text
                x={cx + at * Math.sin(middle)}
                y={cy - at * Math.cos(middle) + 5}
                textAnchor="middle"
                fontWeight={600}
                fill={chart.labelColor}
              >
                {label}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}

function Plot({ chart, area }: { chart: Chart; area: Area }) {
  const { series, categories, stacked } = chart;
  const count = categories.length;
  const sums = categories.map((_, index) => ({
    up: series.reduce((sum, one) => sum + Math.max(0, one.values[index] ?? 0), 0),
    down: series.reduce((sum, one) => sum + Math.min(0, one.values[index] ?? 0), 0),
  }));
  const every = series.flatMap((one) =>
    one.values.filter((value): value is number => value !== null),
  );
  const scale = stacked
    ? axis(Math.min(...sums.map((sum) => sum.down)), Math.max(...sums.map((sum) => sum.up)))
    : axis(Math.min(...every, 0), Math.max(...every, 0));
  const tickText = scale.ticks.map((tick) => formatNumber(tick, chart.format));
  const sideways = chart.sideways;
  const names = Math.min(area.w * 0.3, Math.max(...categories.map((name) => wide(name))) + 12);
  const pad = {
    l: sideways ? names : Math.max(...tickText.map((text) => wide(text, 14))) + 12,
    r: sideways ? 30 : 12,
    t: 24,
    b: 30,
  };
  const plot = {
    x: area.x + pad.l,
    y: area.y + pad.t,
    w: Math.max(10, area.w - pad.l - pad.r),
    h: Math.max(10, area.h - pad.t - pad.b),
  };
  /** Along the value axis: left to right when sideways, bottom to top otherwise. */
  const along = (value: number) => {
    const share = (value - scale.min) / (scale.max - scale.min || 1);
    return sideways ? plot.x + share * plot.w : plot.y + plot.h - share * plot.h;
  };
  const band = (sideways ? plot.h : plot.w) / Math.max(1, count);
  const start = (index: number) => (sideways ? plot.y : plot.x) + index * band;
  const show = chart.labels === "value";
  const marks: ReactNode[] = [];

  if (chart.kind === "bar") {
    const group = band * 0.62;
    const each = stacked ? group : group / series.length;
    categories.forEach((_, c) => {
      let up = 0;
      let down = 0;
      series.forEach((one, s) => {
        const value = one.values[c];
        if (value == null) return;
        const base = stacked ? (value >= 0 ? up : down) : 0;
        if (stacked) {
          if (value >= 0) up += value;
          else down += value;
        }
        const a = along(base);
        const b = along(base + value);
        const across = start(c) + (band - group) / 2 + (stacked ? 0 : s * each);
        const thick = Math.max(1, each - (stacked ? 0 : 2));
        const length = Math.abs(b - a);
        marks.push(
          <rect
            // biome-ignore lint/suspicious/noArrayIndexKey: the points of a chart never reorder
            key={`b${c}-${s}`}
            x={sideways ? Math.min(a, b) : across}
            y={sideways ? across : Math.min(a, b)}
            width={sideways ? length : thick}
            height={sideways ? thick : length}
            rx={Math.min(3, thick / 4)}
            fill={one.colors[c] ?? one.color}
          />,
        );
        if (show)
          marks.push(
            <text
              // biome-ignore lint/suspicious/noArrayIndexKey: the points of a chart never reorder
              key={`l${c}-${s}`}
              x={sideways ? Math.max(a, b) + 6 : across + thick / 2}
              y={sideways ? across + thick / 2 + 5 : Math.min(a, b) - 6}
              textAnchor={sideways ? "start" : "middle"}
              fontSize={14}
              fill={chart.labelColor}
            >
              {formatNumber(value, chart.format)}
            </text>,
          );
      });
    });
  } else {
    const floor = along(Math.max(scale.min, 0));
    series.forEach((one, s) => {
      const spots = one.values
        .map((value, c) =>
          value == null ? null : { x: start(c) + band / 2, y: along(value), value },
        )
        .filter((spot): spot is { x: number; y: number; value: number } => spot !== null);
      if (!spots.length) return;
      const line = spots.map((spot) => `${spot.x},${spot.y}`).join(" ");
      if (chart.kind === "area")
        marks.push(
          <polygon
            // biome-ignore lint/suspicious/noArrayIndexKey: the series of a chart never reorder
            key={`a${s}`}
            points={`${spots[0]?.x},${floor} ${line} ${spots[spots.length - 1]?.x},${floor}`}
            fill={one.color}
            opacity={0.22}
          />,
        );
      marks.push(
        <polyline
          // biome-ignore lint/suspicious/noArrayIndexKey: the series of a chart never reorder
          key={`p${s}`}
          points={line}
          fill="none"
          stroke={one.color}
          strokeWidth={3}
          strokeLinejoin="round"
          strokeLinecap="round"
        />,
      );
      spots.forEach((spot, c) => {
        marks.push(
          <circle
            // biome-ignore lint/suspicious/noArrayIndexKey: the points of a chart never reorder
            key={`c${s}-${c}`}
            cx={spot.x}
            cy={spot.y}
            r={4.5}
            fill="#fff"
            stroke={one.color}
            strokeWidth={2.5}
          />,
        );
        if (show)
          marks.push(
            <text
              // biome-ignore lint/suspicious/noArrayIndexKey: the points of a chart never reorder
              key={`t${s}-${c}`}
              x={spot.x}
              y={spot.y - 11}
              textAnchor="middle"
              fontSize={14}
              fill={chart.labelColor}
            >
              {formatNumber(spot.value, chart.format)}
            </text>,
          );
      });
    });
  }

  // Category names are thinned out when they would run into each other.
  const widest = Math.max(...categories.map((name) => wide(name, 14)));
  const every2 = sideways ? Math.ceil(18 / band) : Math.max(1, Math.ceil((widest + 8) / band));
  return (
    <g>
      {scale.ticks.map((tick, index) => {
        const at = along(tick);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: the ticks of an axis never reorder
          <g key={index}>
            <line
              x1={sideways ? at : plot.x}
              x2={sideways ? at : plot.x + plot.w}
              y1={sideways ? plot.y : at}
              y2={sideways ? plot.y + plot.h : at}
              stroke={chart.gridColor}
              strokeWidth={1}
            />
            <text
              x={sideways ? at : plot.x - 8}
              y={sideways ? plot.y + plot.h + 20 : at + 5}
              textAnchor={sideways ? "middle" : "end"}
              fontSize={14}
              fill={chart.axisColor}
              opacity={0.8}
            >
              {tickText[index]}
            </text>
          </g>
        );
      })}
      {marks}
      <line
        x1={sideways ? along(0) : plot.x}
        x2={sideways ? along(0) : plot.x + plot.w}
        y1={sideways ? plot.y : along(0)}
        y2={sideways ? plot.y + plot.h : along(0)}
        stroke={chart.axisColor}
        strokeWidth={1}
        opacity={0.6}
      />
      {categories.map((name, index) =>
        index % every2 ? null : (
          <text
            // biome-ignore lint/suspicious/noArrayIndexKey: the categories of a chart never reorder
            key={index}
            x={sideways ? plot.x - 8 : start(index) + band / 2}
            y={sideways ? start(index) + band / 2 + 5 : plot.y + plot.h + 20}
            textAnchor={sideways ? "end" : "middle"}
            fontSize={14}
            fill={chart.axisColor}
          >
            {name}
          </text>
        ),
      )}
    </g>
  );
}
