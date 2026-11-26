import { bandPath, FLOWS_MOST, layoutFlows } from "@muster/ui-schema";
import { useEffect, useRef, useState } from "react";
import {
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { SERIES } from "@/components/charts";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import {
  fillOf,
  HUE,
  hueOf,
  onStrong,
  radiusOf,
  signOf,
  sparkPoints,
  ticks,
  toneOf,
  treemap,
  type Up,
  withUnit,
} from "./scale";
import { Frame } from "./visuals";

/** The ink of a rise or a fall where the words themselves are coloured (a table's cell, a figure's change). */
export const inkOf = (sign: number, up: Up): string | undefined => {
  const hue = hueOf(sign, up);
  return hue === "red" ? "var(--destructive)" : hue === "green" ? "var(--ok)" : undefined;
};

const signedNumber = (value: number, write: (n: number) => string, unit: string, up: Up) =>
  `${up && value > 0 ? "+" : ""}${withUnit(write(value), unit)}`;

/** How wide an element is, as it changes. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    setWidth(node.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => setWidth(node.clientWidth));
    watch.observe(node);
    return () => watch.disconnect();
  }, []);
  return [ref, width] as const;
}

export interface Tile {
  label: string;
  value: number;
  weight?: number;
  note?: string;
}

/**
 * Many named numbers at a glance: a tile each, filled by its number. With a weight on
 * every one the tiles share one box by weight (a market map); without, they are a grid.
 */
export function TilesView({
  title,
  items,
  unit = "",
  up,
}: {
  title: string;
  items: Tile[];
  unit?: string;
  up?: Up;
}) {
  const { number } = useI18n();
  const [ref, width] = useWidth<HTMLDivElement>();
  if (items.length === 0) return null;
  const all = items.map((item) => item.value);
  const say = (value: number) => signedNumber(value, number, unit, up);
  const face = (item: Tile, small = false, tiny = false) => {
    const tone = toneOf(item.value, all, up);
    return {
      style: { background: fillOf(tone) },
      className: cn(
        "flex min-w-0 flex-col items-center justify-center overflow-hidden px-1 text-center leading-tight",
        onStrong(tone.strength) ? "text-white" : "text-foreground",
      ),
      title: `${item.label} ${say(item.value)}${item.note ? ` · ${item.note}` : ""}`,
      children: tiny ? null : (
        <>
          <span
            className={cn("max-w-full truncate font-medium", small ? "text-[10px]" : "text-xs")}
          >
            {item.label}
          </span>
          <span className={cn("num max-w-full truncate", small ? "text-[10px]" : "text-[13px]")}>
            {say(item.value)}
          </span>
          {item.note && !small && (
            <span className="max-w-full truncate text-[10px] opacity-80">{item.note}</span>
          )}
        </>
      ),
    };
  };
  const weighted = items.every((item) => (item.weight ?? 0) > 0);
  if (weighted) {
    const height = Math.round(Math.min(360, Math.max(180, width * 0.5)));
    const rects = width
      ? treemap(
          items.map((item) => item.weight ?? 0),
          width,
          height,
        )
      : [];
    return (
      <Frame title={title}>
        <div className="p-3">
          <div ref={ref} className="relative w-full" style={{ height }}>
            {rects.map((rect, index) => {
              const item = items[index];
              if (!item || rect.w < 1 || rect.h < 1) return null;
              const { style, ...rest } = face(
                item,
                rect.w < 64 || rect.h < 40,
                rect.w < 30 || rect.h < 22,
              );
              return (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: tiles follow the items
                  key={index}
                  {...rest}
                  // A gap of the surface between fills, so neighbours of one colour are two tiles.
                  style={{
                    ...style,
                    position: "absolute",
                    left: rect.x + 1,
                    top: rect.y + 1,
                    width: Math.max(0, rect.w - 2),
                    height: Math.max(0, rect.h - 2),
                    borderRadius: 4,
                  }}
                />
              );
            })}
          </div>
        </div>
      </Frame>
    );
  }
  return (
    <Frame title={title}>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-0.5 p-3">
        {items.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: tiles follow the items
          <div key={index} {...face(item)} className={cn(face(item).className, "h-14 rounded")} />
        ))}
      </div>
    </Frame>
  );
}

/** A grid of numbers as colour, each written in its cell. */
export function HeatmapView({
  title,
  columns,
  rows,
  unit = "",
  up,
}: {
  title: string;
  columns: string[];
  rows: { label: string; values: number[] }[];
  unit?: string;
  up?: Up;
}) {
  const { number } = useI18n();
  if (rows.length === 0 || columns.length === 0) return null;
  const all = rows
    .flatMap((row) => row.values.slice(0, columns.length))
    .filter((value) => Number.isFinite(value));
  return (
    <Frame title={title}>
      <div className="overflow-x-auto p-3">
        <table className="num w-full border-separate border-spacing-0.5 text-xs">
          <thead>
            <tr>
              <th />
              {columns.map((column, index) => (
                <th
                  // biome-ignore lint/suspicious/noArrayIndexKey: columns never reorder
                  key={index}
                  className="px-1 pb-1 text-center font-normal text-muted-foreground"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, at) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows never reorder
              <tr key={at}>
                <th className="max-w-40 truncate pr-2 text-left font-normal whitespace-nowrap text-muted-foreground">
                  {row.label}
                </th>
                {columns.map((column, index) => {
                  const value = row.values[index];
                  if (value === undefined || !Number.isFinite(value))
                    // biome-ignore lint/suspicious/noArrayIndexKey: cells follow the columns
                    return <td key={index} />;
                  const tone = toneOf(value, all, up);
                  return (
                    <td
                      // biome-ignore lint/suspicious/noArrayIndexKey: cells follow the columns
                      key={index}
                      title={`${row.label} · ${column}`}
                      className={cn(
                        "h-8 min-w-11 rounded px-1 text-center",
                        onStrong(tone.strength) ? "text-white" : "text-foreground",
                      )}
                      style={{ background: fillOf(tone) }}
                    >
                      {signedNumber(value, number, unit, up)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Frame>
  );
}

export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
}

/** A price over time: for each label a wick from low to high and a body from open to close. */
export function CandlesView({
  title,
  labels,
  candles,
  unit = "",
  up,
}: {
  title: string;
  labels: string[];
  candles: Candle[];
  unit?: string;
  up?: Up;
}) {
  const { t, number } = useI18n();
  const [ref, width] = useWidth<HTMLDivElement>();
  const [at, setAt] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  if (candles.length === 0) return null;
  const height = 224;
  const left = 52;
  const bottom = 22;
  const top = 8;
  const low = Math.min(...candles.map((one) => one.low));
  const high = Math.max(...candles.map((one) => one.high));
  const pad = (high - low) * 0.06 || 1;
  const from = low - pad;
  const to = high + pad;
  const plot = Math.max(0, width - left - 4);
  const step = plot / candles.length;
  const body = Math.max(1, Math.min(14, step * 0.62));
  const y = (value: number) => top + ((to - value) / (to - from)) * (height - top - bottom);
  // Rises and falls by the custom asked for; green for a rise when none was.
  const colour = (one: Candle) => {
    const hue = hueOf(one.close - one.open, up ?? "green");
    return hue ? HUE[hue] : "var(--chart-axis)";
  };
  // As many names along the bottom as fit without touching.
  const every = Math.max(1, Math.ceil(candles.length / Math.max(1, Math.floor(plot / 64))));
  const seen = at === null ? null : candles[at];
  const say = (value: number) => withUnit(number(value), unit);
  return (
    <Frame title={title} tools={<NumbersSwitch on={table} set={setTable} />}>
      {table && (
        <div className="max-h-72 overflow-auto p-3">
          <table className="num w-full text-xs">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-1 pr-3 font-normal" />
                {(["open", "high", "low", "close"] as const).map((part) => (
                  <th key={part} className="py-1 pl-3 text-right font-normal">
                    {t.app.visual[part]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {candles.map((one, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows follow the labels
                <tr key={index} className="border-b last:border-b-0">
                  <td className="py-1 pr-3">{labels[index] ?? ""}</td>
                  <td className="py-1 pl-3 text-right">{say(one.open)}</td>
                  <td className="py-1 pl-3 text-right">{say(one.high)}</td>
                  <td className="py-1 pl-3 text-right">{say(one.low)}</td>
                  <td className="py-1 pl-3 text-right">{say(one.close)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {/* Kept while the numbers are shown, so its width is still known when it comes back. */}
      <div className={table ? "hidden" : "p-3"}>
        <p className="num h-4 text-xs text-muted-foreground">
          {seen &&
            `${labels[at ?? 0] ?? ""}  ${t.app.visual.open} ${say(seen.open)}  ${t.app.visual.high} ${say(seen.high)}  ${t.app.visual.low} ${say(seen.low)}  ${t.app.visual.close} ${say(seen.close)}`}
        </p>
        <div ref={ref} style={{ height }}>
          {width > 0 && (
            <svg
              width={width}
              height={height}
              role="img"
              aria-label={title}
              onMouseLeave={() => setAt(null)}
              onMouseMove={(event) => {
                const x = event.nativeEvent.offsetX - left;
                const index = Math.floor(x / step);
                setAt(index >= 0 && index < candles.length ? index : null);
              }}
            >
              {ticks(from, to).map((value) => (
                <g key={value}>
                  <line
                    x1={left}
                    x2={width}
                    y1={y(value)}
                    y2={y(value)}
                    stroke="var(--chart-grid)"
                  />
                  <text
                    x={left - 6}
                    y={y(value) + 4}
                    textAnchor="end"
                    fontSize={11}
                    fill="var(--chart-axis)"
                  >
                    {number(value)}
                  </text>
                </g>
              ))}
              {at !== null && (
                <rect
                  x={left + at * step}
                  y={top}
                  width={step}
                  height={height - top - bottom}
                  fill="var(--accent)"
                  opacity={0.5}
                />
              )}
              {candles.map((one, index) => {
                const x = left + index * step + step / 2;
                const a = y(Math.max(one.open, one.close));
                const b = y(Math.min(one.open, one.close));
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: candles follow the labels
                  <g key={index}>
                    <line x1={x} x2={x} y1={y(one.high)} y2={y(one.low)} stroke={colour(one)} />
                    <rect
                      x={x - body / 2}
                      y={a}
                      width={body}
                      height={Math.max(1, b - a)}
                      rx={1}
                      fill={colour(one)}
                    />
                    {index % every === 0 && (
                      <text
                        x={x}
                        y={height - 6}
                        textAnchor="middle"
                        fontSize={11}
                        fill="var(--chart-axis)"
                      >
                        {labels[index] ?? ""}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          )}
        </div>
      </div>
    </Frame>
  );
}

export interface Dot {
  label: string;
  x: number;
  y: number;
  group?: string;
  size?: number;
}

/** The switch between a drawing and its numbers, as the chart has it. */
function NumbersSwitch({ on, set }: { on: boolean; set: (on: boolean) => void }) {
  const { t } = useI18n();
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-6 px-1.5 text-xs"
      aria-pressed={on}
      onClick={() => set(!on)}
    >
      {on ? t.app.visual.chart : t.app.visual.numbers}
    </Button>
  );
}

/**
 * How two measures go together: a dot for each thing, coloured by its kind when it has
 * one and sized by a third measure when it has one.
 */
export function ScatterView({
  title,
  x,
  y,
  points,
}: {
  title: string;
  x: string;
  y: string;
  points: Dot[];
}) {
  const { t, number, compact } = useI18n();
  const [table, setTable] = useState(false);
  if (points.length === 0) return null;
  const tick = { fontSize: 11, fill: "var(--chart-axis)" };
  const short = (n: number) => (Math.abs(n) >= 10_000 ? compact(n) : number(n));
  // Kinds in the order they first appear; past the fourth they are one, in grey.
  const kinds = [...new Set(points.flatMap((point) => (point.group ? [point.group] : [])))];
  const named = kinds.slice(0, SERIES.length);
  const colour = (point: Dot) => {
    if (!kinds.length) return SERIES[0];
    const at = point.group ? named.indexOf(point.group) : -1;
    return at < 0 ? "var(--chart-axis)" : SERIES[at];
  };
  const sizes = points.flatMap((point) => (point.size !== undefined ? [point.size] : []));
  const sized = sizes.length > 0;
  return (
    <Frame title={title} tools={<NumbersSwitch on={table} set={setTable} />}>
      {table ? (
        <div className="overflow-x-auto p-3">
          <table className="num w-full text-xs">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-1 pr-3 font-normal" />
                <th className="py-1 pl-3 text-right font-normal">{x}</th>
                <th className="py-1 pl-3 text-right font-normal">{y}</th>
                {sized && <th className="py-1 pl-3 text-right font-normal">{t.app.visual.size}</th>}
              </tr>
            </thead>
            <tbody>
              {points.map((point, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows follow the points
                <tr key={index} className="border-b last:border-b-0">
                  <td className="py-1 pr-3">
                    {point.label}
                    {point.group && <span className="text-muted-foreground"> · {point.group}</span>}
                  </td>
                  <td className="py-1 pl-3 text-right">{number(point.x)}</td>
                  <td className="py-1 pl-3 text-right">{number(point.y)}</td>
                  {sized && (
                    <td className="py-1 pl-3 text-right">
                      {point.size === undefined ? "" : number(point.size)}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="p-3">
          {kinds.length > 0 && (
            <ul className="flex flex-wrap gap-x-4 gap-y-1 pb-2 text-xs text-muted-foreground">
              {named.map((kind, i) => (
                <li key={kind} className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full" style={{ background: SERIES[i] }} />
                  {kind}
                </li>
              ))}
              {kinds.length > named.length && (
                <li className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-[var(--chart-axis)]" />
                  {t.app.visual.other}
                </li>
              )}
            </ul>
          )}
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 16, right: 16, bottom: 18, left: 4 }}>
                <CartesianGrid stroke="var(--chart-grid)" />
                <XAxis
                  type="number"
                  dataKey="x"
                  name={x}
                  tick={tick}
                  tickLine={false}
                  axisLine={{ stroke: "var(--chart-grid)" }}
                  domain={["auto", "auto"]}
                  tickFormatter={(n: number) => short(n)}
                  label={{ value: x, position: "insideBottom", offset: -10, ...tick }}
                />
                <YAxis
                  type="number"
                  dataKey="y"
                  name={y}
                  width={52}
                  tick={tick}
                  tickLine={false}
                  axisLine={false}
                  domain={["auto", "auto"]}
                  tickFormatter={(n: number) => short(n)}
                  label={{ value: y, angle: -90, position: "insideLeft", ...tick }}
                />
                <Tooltip
                  cursor={{ stroke: "var(--chart-grid)" }}
                  content={({ payload }) => {
                    const point = payload?.[0]?.payload as Dot | undefined;
                    return point ? (
                      <div className="num rounded-lg border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground">
                        <div className="font-medium">
                          {point.label}
                          {point.group && (
                            <span className="font-normal text-muted-foreground">
                              {" "}
                              · {point.group}
                            </span>
                          )}
                        </div>
                        <div className="text-muted-foreground">
                          {x} {number(point.x)} · {y} {number(point.y)}
                          {point.size !== undefined &&
                            ` · ${t.app.visual.size} ${number(point.size)}`}
                        </div>
                      </div>
                    ) : null;
                  }}
                />
                <Scatter
                  data={points}
                  isAnimationActive={false}
                  // A ring of the surface around each dot, so two that overlap are two.
                  shape={(dot: { cx?: number; cy?: number; payload?: Dot }) => (
                    <circle
                      cx={dot.cx}
                      cy={dot.cy}
                      r={sized ? radiusOf(dot.payload?.size, sizes) : 5}
                      fill={dot.payload ? colour(dot.payload) : SERIES[0]}
                      fillOpacity={sized ? 0.75 : 1}
                      stroke="var(--card)"
                      strokeWidth={2}
                    />
                  )}
                >
                  {/* Named where there is room for names: a few dots, not a cloud. */}
                  {points.length <= 12 && (
                    <LabelList
                      dataKey="label"
                      position="top"
                      offset={sized ? 14 : 8}
                      fontSize={10}
                      fill="var(--chart-axis)"
                    />
                  )}
                </Scatter>
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </Frame>
  );
}

/** A few headline numbers side by side. */
export function MetricsView({
  items,
  up,
}: {
  items: { label: string; value: string; change?: string; note?: string; trend?: number[] }[];
  up?: Up;
}) {
  if (items.length === 0) return null;
  return (
    <dl className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-px overflow-hidden rounded-xl border bg-border">
      {items.map((item, index) => {
        const sign = item.change ? signOf(item.change) : 0;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: figures of one reply never reorder
          <div key={index} className="min-w-0 bg-background px-4 py-3">
            <dt className="truncate text-xs text-muted-foreground">{item.label}</dt>
            <dd className="flex items-center gap-2">
              <span className="num min-w-0 flex-1 truncate text-xl font-semibold tracking-tight">
                {item.value}
              </span>
              {item.trend && item.trend.length >= 2 && (
                <svg width={64} height={20} aria-hidden="true" className="shrink-0">
                  <polyline
                    points={sparkPoints(item.trend, 64, 20)}
                    fill="none"
                    stroke="var(--chart-axis)"
                    strokeWidth={1.5}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                </svg>
              )}
            </dd>
            {(item.change || item.note) && (
              <dd className="num flex min-w-0 items-baseline gap-1.5 text-xs">
                {item.change && (
                  <span className="shrink-0 font-medium" style={{ color: inkOf(sign, up) }}>
                    {sign > 0 ? "▲ " : sign < 0 ? "▼ " : ""}
                    {item.change}
                  </span>
                )}
                {item.note && <span className="truncate text-muted-foreground">{item.note}</span>}
              </dd>
            )}
          </div>
        );
      })}
    </dl>
  );
}

/** How far each of a few things is toward its target. */
export function ProgressView({
  title,
  items,
  unit = "",
}: {
  title: string;
  items: { label: string; value: number; of: number }[];
  unit?: string;
}) {
  const { number } = useI18n();
  if (items.length === 0) return null;
  return (
    <Frame title={title}>
      <ul className="grid gap-2.5 p-3">
        {items.map((item, index) => {
          const share = item.of > 0 ? item.value / item.of : 0;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows of one reply never reorder
            <li key={index} className="grid gap-1 text-[13px]">
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                <span className="num text-xs text-muted-foreground">
                  {number(item.value)}
                  {unit} / {number(item.of)}
                  {unit}
                </span>
                <span className="num w-10 text-right text-xs font-medium">
                  {Math.round(share * 100)}%
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.max(0, Math.min(1, share)) * 100}%`,
                    // Past its target it is said in the figure; the bar is full, in another colour.
                    background: share > 1 ? "var(--series-2)" : "var(--series-1)",
                  }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </Frame>
  );
}

/** What happened, or is to happen, in order. */
export function TimelineView({
  title,
  items,
}: {
  title: string;
  items: { when: string; title: string; text?: string }[];
}) {
  if (items.length === 0) return null;
  return (
    <Frame title={title}>
      <ol className="p-3">
        {items.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: events of one reply never reorder
          <li key={index} className="relative grid grid-cols-[6.5rem_1fr] gap-x-4 pb-3 last:pb-0">
            <span className="num pt-px text-right text-xs text-muted-foreground">{item.when}</span>
            <div className="relative min-w-0 border-l pl-4 text-[13px]">
              <span className="absolute top-1.5 -left-[4.5px] size-2 rounded-full bg-foreground/60 ring-2 ring-background" />
              <p className="font-medium">{item.title}</p>
              {item.text && <p className="text-muted-foreground">{item.text}</p>}
            </div>
          </li>
        ))}
      </ol>
    </Frame>
  );
}

/**
 * Amounts going from sources to uses: a box for each name, as tall as what passes through
 * it, and a band for each flow, as thick as its amount. Where things lie is the shared
 * arithmetic of `layoutFlows`, so the phone draws the same.
 */
export function FlowsView({
  title,
  flows,
  unit = "",
}: {
  title: string;
  flows: { from: string; to: string; value: number }[];
  unit?: string;
}) {
  const { number } = useI18n();
  const [ref, width] = useWidth<HTMLDivElement>();
  const [table, setTable] = useState(false);
  const [lit, setLit] = useState<number | null>(null);
  // Names stand beside their boxes: room for them at both edges.
  // In a frame too narrow for names and bands both, the bands keep a little and the names less.
  const side = Math.max(0, Math.min(140, Math.max(64, width * 0.2), (width - 60) / 2));
  const rows = Math.min(
    FLOWS_MOST.nodes,
    Math.max(1, new Set(flows.flatMap((flow) => [flow.from, flow.to])).size),
  );
  const height = Math.round(Math.min(420, Math.max(200, rows * 26)));
  // Before its width is known it is laid out all the same: which flows are flows does not wait.
  const laid = layoutFlows(flows, Math.max(1, width - side * 2), height);
  const say = (value: number) => withUnit(number(value), unit);
  if (laid.nodes.length === 0) return null;
  const colourOf = new Map(
    laid.nodes
      .filter((node) => node.column === 0)
      .map((node, index) => [node.name, SERIES[index % SERIES.length]] as const),
  );
  // A band that leaves a source wears the source's colour; one that leaves a name further
  // along is grey, since what it carries came from several.
  const origin = new Map<string, string>();
  for (const node of [...laid.nodes].sort((a, b) => a.column - b.column)) {
    if (node.column === 0) origin.set(node.name, colourOf.get(node.name) ?? SERIES[0]);
  }
  const bandColour = (from: string) => origin.get(from) ?? "var(--chart-axis)";
  return (
    <Frame title={title} tools={<NumbersSwitch on={table} set={setTable} />}>
      {table && (
        <div className="max-h-72 overflow-auto p-3">
          <table className="num w-full text-xs">
            <tbody>
              {laid.bands.map((band, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows follow the flows
                <tr key={index} className="border-b last:border-b-0">
                  <td className="py-1 pr-3">{band.from}</td>
                  <td className="py-1 pr-3 text-muted-foreground">→ {band.to}</td>
                  <td className="py-1 pl-3 text-right">{say(band.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className={table ? "hidden" : "p-3"}>
        <p className="num h-4 text-xs text-muted-foreground">
          {lit !== null && laid.bands[lit]
            ? `${laid.bands[lit].from} → ${laid.bands[lit].to}  ${say(laid.bands[lit].value)}`
            : ""}
        </p>
        <div ref={ref} style={{ height }}>
          {width > 0 && (
            <svg width={width} height={height} role="img" aria-label={title}>
              <g transform={`translate(${side},0)`}>
                {laid.bands.map((band, index) => (
                  // biome-ignore lint/a11y/noStaticElementInteractions: pointing at a band reads it out above; the same is in the numbers
                  <path
                    // biome-ignore lint/suspicious/noArrayIndexKey: bands follow the flows
                    key={index}
                    d={bandPath(band)}
                    fill="none"
                    stroke={bandColour(band.from)}
                    strokeWidth={band.thickness}
                    strokeOpacity={lit === null ? 0.35 : lit === index ? 0.7 : 0.15}
                    onMouseEnter={() => setLit(index)}
                    onMouseLeave={() => setLit(null)}
                  />
                ))}
                {laid.nodes.map((node) => {
                  const left = node.column === 0;
                  return (
                    <g key={node.name}>
                      <rect
                        x={node.x}
                        y={node.y}
                        width={node.width}
                        height={node.height}
                        rx={2}
                        fill={colourOf.get(node.name) ?? "var(--chart-axis)"}
                      />
                      <text
                        x={left ? node.x - 6 : node.x + node.width + 6}
                        y={node.y + node.height / 2}
                        textAnchor={left ? "end" : "start"}
                        dominantBaseline="middle"
                        fontSize={11}
                        fill="var(--foreground)"
                      >
                        {[...node.name].length > 12
                          ? `${[...node.name].slice(0, 11).join("")}…`
                          : node.name}
                        <tspan fill="var(--chart-axis)"> {say(node.value)}</tspan>
                      </text>
                    </g>
                  );
                })}
              </g>
            </svg>
          )}
        </div>
      </div>
    </Frame>
  );
}
