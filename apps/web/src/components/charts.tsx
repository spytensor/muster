import { type ReactNode, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

export interface Series {
  key: string;
  label: string;
  color: string;
}

/** Series colours, in fixed order. A series keeps its colour whatever else is on the chart. */
export const SERIES = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
] as const;

export function ChartCard({
  title,
  lead,
  action,
  legend,
  children,
  className,
}: {
  title: string;
  lead?: ReactNode;
  action?: ReactNode;
  legend?: Series[];
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {lead && <CardDescription>{lead}</CardDescription>}
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent className="grid gap-3">
        {legend && <Legend items={legend} />}
        {children}
      </CardContent>
    </Card>
  );
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5">
          <Swatch color={item.color} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

function Swatch({ color }: { color: string }) {
  return (
    <span
      className="size-2.5 shrink-0 rounded-[3px]"
      ref={(node) => {
        if (node) node.style.background = color;
      }}
    />
  );
}

function TooltipBox({
  title,
  rows,
}: {
  title: string;
  rows: { label: string; value: string; color?: string }[];
}) {
  return (
    <div className="grid gap-1 rounded-lg border bg-popover px-3 py-2 text-xs shadow-md">
      <p className="font-medium">{title}</p>
      {rows.map((row) => (
        <p key={row.label} className="flex items-center gap-1.5 text-muted-foreground">
          {row.color && <Swatch color={row.color} />}
          <span>{row.label}</span>
          <span className="num ml-auto pl-4 text-foreground">{row.value}</span>
        </p>
      ))}
    </div>
  );
}

const axis = {
  tickLine: false,
  axisLine: false,
  fontSize: 12,
  stroke: "var(--chart-axis)",
} as const;

/** Formats a bucket's start for the x axis and the tooltip. */
export function useBucketLabel(bucket: "hour" | "day") {
  const { locale } = useI18n();
  const tag = locale === "zh" ? "zh-CN" : "en-US";
  const short = new Intl.DateTimeFormat(
    tag,
    bucket === "hour"
      ? { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }
      : { month: "numeric", day: "numeric", timeZone: "UTC" },
  );
  const long = new Intl.DateTimeFormat(
    tag,
    bucket === "hour"
      ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }
      : { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" },
  );
  return {
    short: (iso: string) => short.format(new Date(iso)),
    long: (iso: string) => long.format(new Date(iso)),
  };
}

interface TimeProps<T> {
  data: T[];
  series: Series[];
  bucket: "hour" | "day";
  format: (value: number) => string;
  height?: number;
}

/** Stacked columns over time. Segments are separated by a gap in the surface colour, not by an outline. */
export function TimeBars<T extends { at: string }>({
  data,
  series,
  bucket,
  format,
  height = 240,
}: TimeProps<T>) {
  const label = useBucketLabel(bucket);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ left: 0, right: 8, top: 8 }} barCategoryGap="28%">
        <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
        <XAxis dataKey="at" tickFormatter={label.short} tickMargin={8} minTickGap={24} {...axis} />
        <YAxis tickFormatter={format} width={44} allowDecimals={false} {...axis} />
        <Tooltip
          cursor={{ fill: "var(--muted)" }}
          content={({ active, payload }) =>
            active && payload?.length ? (
              <TooltipBox
                title={label.long(String(payload[0]?.payload.at))}
                rows={[...series].reverse().map((s) => ({
                  label: s.label,
                  color: s.color,
                  value: format(Number(payload[0]?.payload[s.key] ?? 0)),
                }))}
              />
            ) : null
          }
        />
        {series.map((s, index) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            stackId="all"
            fill={s.color}
            maxBarSize={24}
            stroke="var(--card)"
            strokeWidth={2}
            radius={index === series.length - 1 ? [4, 4, 0, 0] : 0}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

/** One or two lines over time on a single axis. */
export function TimeLines<T extends { at: string }>({
  data,
  series,
  bucket,
  format,
  height = 240,
}: TimeProps<T>) {
  const label = useBucketLabel(bucket);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
        <XAxis dataKey="at" tickFormatter={label.short} tickMargin={8} minTickGap={24} {...axis} />
        <YAxis tickFormatter={format} width={44} {...axis} />
        <Tooltip
          cursor={{ stroke: "var(--chart-grid)" }}
          content={({ active, payload }) =>
            active && payload?.length ? (
              <TooltipBox
                title={label.long(String(payload[0]?.payload.at))}
                rows={series.map((s) => ({
                  label: s.label,
                  color: s.color,
                  value: format(Number(payload[0]?.payload[s.key] ?? 0)),
                }))}
              />
            ) : null
          }
        />
        {series.map((s) => (
          <Line
            key={s.key}
            dataKey={s.key}
            type="monotone"
            stroke={s.color}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, stroke: "var(--card)", strokeWidth: 2 }}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

/** A single series over time, as a line with a light wash beneath it. */
export function TimeArea<T extends { at: string }>({
  data,
  series,
  bucket,
  format,
  height = 240,
}: TimeProps<T>) {
  const label = useBucketLabel(bucket);
  const only = series[0];
  if (!only) return null;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
        <XAxis dataKey="at" tickFormatter={label.short} tickMargin={8} minTickGap={24} {...axis} />
        <YAxis tickFormatter={format} width={52} {...axis} />
        <Tooltip
          cursor={{ stroke: "var(--chart-grid)" }}
          content={({ active, payload }) =>
            active && payload?.length ? (
              <TooltipBox
                title={label.long(String(payload[0]?.payload.at))}
                rows={[
                  { label: only.label, value: format(Number(payload[0]?.payload[only.key] ?? 0)) },
                ]}
              />
            ) : null
          }
        />
        <Area
          dataKey={only.key}
          type="monotone"
          stroke={only.color}
          strokeWidth={2}
          fill={only.color}
          fillOpacity={0.1}
          activeDot={{ r: 4, stroke: "var(--card)", strokeWidth: 2 }}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

const width = (ratio: number) => (node: HTMLElement | null) => {
  if (node) node.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
};

/** Ranked horizontal bars: one hue, a name, a bar and a figure per row. */
export function BarList({
  rows,
  format,
  max,
}: {
  rows: { label: ReactNode; key: string; value: number; detail?: ReactNode }[];
  format: (value: number) => string;
  max?: number;
}) {
  const top = max ?? Math.max(1, ...rows.map((row) => row.value));
  return (
    <ul className="grid gap-3">
      {rows.map((row) => (
        <li key={row.key} className="grid gap-1.5">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate">{row.label}</span>
            <span className="flex shrink-0 items-baseline gap-2">
              {row.detail && <span className="text-xs text-muted-foreground">{row.detail}</span>}
              <span className="num font-medium">{format(row.value)}</span>
            </span>
          </div>
          <div className="h-2 rounded-full bg-secondary">
            <div
              className="h-full rounded-full bg-[var(--series-1)]"
              ref={width(row.value / top)}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** One whole split into a few parts, read at a glance. Parts are separated by gaps; the legend names them. */
export function SegmentedBar({
  parts,
  format,
}: {
  parts: { label: string; value: number; color: string }[];
  format: (value: number) => string;
}) {
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  if (total === 0) return null;
  return (
    <div className="grid gap-3">
      <div className="flex h-9 gap-0.5 overflow-hidden rounded-md">
        {parts
          .filter((part) => part.value > 0)
          .map((part) => (
            <div
              key={part.label}
              title={`${part.label}: ${format(part.value)}`}
              className="h-full min-w-1"
              ref={(node) => {
                if (node) {
                  node.style.width = `${(part.value / total) * 100}%`;
                  node.style.background = part.color;
                }
              }}
            />
          ))}
      </div>
      <ul className="grid gap-1.5 text-sm">
        {parts.map((part) => (
          <li key={part.label} className="flex items-center gap-2">
            <Swatch color={part.color} />
            <span className="text-muted-foreground">{part.label}</span>
            <span className="num ml-auto font-medium">{format(part.value)}</span>
            <span className="num w-12 text-right text-xs text-muted-foreground">
              {Math.round((part.value / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/** A weekday-by-hour grid: one hue, more is darker. */
/** Half the width a heatmap's hint may take: "Sat 23:00 · 1,234 runs" and its padding. */
const HINT_HALF = 84;

export function Heatmap({
  cells,
  rowLabels,
  title,
}: {
  cells: { row: number; col: number; value: number }[];
  rowLabels: string[];
  title: (row: number, col: number, value: number) => string;
}) {
  const { t } = useI18n();
  // The cell under the pointer says what it is at once, as the other charts do: a colour
  // alone is not a number, and the browser's own hint comes late or not at all.
  const [over, setOver] = useState<{ text: string; left: number; top: number } | null>(null);
  const max = Math.max(1, ...cells.map((cell) => cell.value));
  const at = new Map(cells.map((cell) => [`${cell.row}:${cell.col}`, cell.value]));
  const shade = (value: number) => (node: HTMLElement | null) => {
    if (node)
      node.style.background =
        value === 0
          ? "var(--secondary)"
          : `color-mix(in oklab, var(--series-1) ${Math.round(18 + (value / max) * 82)}%, var(--card))`;
  };
  return (
    <div className="relative grid gap-2">
      {over && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-10 max-w-[168px] -translate-x-1/2 -translate-y-full truncate whitespace-nowrap rounded-lg border bg-popover px-3 py-2 text-xs font-medium text-popover-foreground shadow-md"
          style={{ left: over.left, top: over.top - 6 }}
        >
          {over.text}
        </div>
      )}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: leaving the grid only puts the hint away */}
      <div
        className="grid grid-cols-[auto_repeat(24,minmax(0,1fr))] items-center gap-0.5 text-xs text-muted-foreground"
        onMouseLeave={() => setOver(null)}
      >
        {rowLabels.map((label, row) => (
          <div key={label} className="contents">
            <span className="pr-2">{label}</span>
            {HOURS.map((col) => {
              const value = at.get(`${row}:${col}`) ?? 0;
              return (
                <span
                  key={`${label}-${col}`}
                  role="img"
                  aria-label={title(row, col, value)}
                  className="aspect-square min-h-3 rounded-[3px] hover:ring-2 hover:ring-foreground/60"
                  onMouseEnter={(event) => {
                    const cell = event.currentTarget;
                    // Kept inside the chart: at the first and last hours a hint centred on
                    // its cell would hang over the edge and widen the page.
                    const width = (cell.offsetParent as HTMLElement | null)?.offsetWidth ?? 0;
                    const middle = cell.offsetLeft + cell.offsetWidth / 2;
                    setOver({
                      text: title(row, col, value),
                      left: width
                        ? Math.min(Math.max(middle, HINT_HALF), width - HINT_HALF)
                        : middle,
                      top: cell.offsetTop,
                    });
                  }}
                  ref={shade(value)}
                />
              );
            })}
          </div>
        ))}
        <span />
        {HOURS.map((col) => (
          <span
            key={`h${col}`}
            className={cn("num pt-1 text-center text-[10px]", col % 3 !== 0 && "invisible")}
          >
            {col}
          </span>
        ))}
      </div>
      <div className="flex items-center justify-end gap-1.5 text-xs text-muted-foreground">
        {t.dashboard.less}
        {[0, 0.25, 0.5, 0.75, 1].map((step) => (
          <span key={step} className="size-3 rounded-[3px]" ref={shade(step * max)} />
        ))}
        {t.dashboard.more}
      </div>
    </div>
  );
}
