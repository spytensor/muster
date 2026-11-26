import { CodeIcon, DownloadIcon } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  Radar,
  RadarChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { SERIES } from "@/components/charts";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import { useTheme } from "@/lib/theme";
import { repairDiagram } from "./diagram";
import { fold, HUE, hueOf, type Up, waterfall, withUnit } from "./scale";

export function Frame({
  title,
  tools,
  children,
}: {
  title: string;
  tools?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <figure className="rounded-xl border">
      <figcaption className="flex min-h-8 items-center gap-2 border-b px-3 text-[13px] font-medium">
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {tools}
      </figcaption>
      {children}
    </figure>
  );
}

/**
 * A diagram drawn from Mermaid source an agent wrote. The source is checked before it
 * is drawn and drawn in Mermaid's strict mode, where labels are text and nothing in
 * the diagram can run or link out. Source that does not parse is shown as source.
 */
export function DiagramView({
  title,
  code,
  writing = false,
}: {
  title: string;
  code: string;
  /** The reply it is part of is still being written: its source may not be whole yet. */
  writing?: boolean;
}) {
  const { t } = useI18n();
  const { dark } = useTheme();
  const id = `d${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [source, setSource] = useState(false);
  // It could not be drawn: said in a line, with the source behind its button, not laid
  // out in the reply as if it were the answer.
  const [failed, setFailed] = useState(false);
  // The drawing is shown as a picture, not placed into the page: a picture can load
  // nothing from anywhere and its styles cannot touch the app.
  const picture = useMemo(
    () => (svg ? URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })) : null),
    [svg],
  );
  useEffect(() => () => void (picture && URL.revokeObjectURL(picture)), [picture]);
  useEffect(() => {
    let live = true;
    // A reply arrives piece by piece; wait for the source to settle before drawing.
    const timer = setTimeout(async () => {
      try {
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: dark ? "dark" : "neutral",
          // Labels are drawn as the picture's own text, which every browser shows inside a picture.
          htmlLabels: false,
          flowchart: { htmlLabels: false },
          // The diagram's own text may not change how it is drawn: that is where a
          // diagram could ask the browser to fetch something.
          secure: [
            "secure",
            "securityLevel",
            "startOnLoad",
            "maxTextSize",
            "suppressErrorRendering",
            "maxEdges",
            "themeCSS",
            "themeVariables",
            "fontFamily",
            "altFontFamily",
          ],
        });
        // As written; failing that, with the slips models most often make put right.
        const fixed = repairDiagram(code);
        const good = (await mermaid.parse(code, { suppressErrors: true }))
          ? code
          : fixed !== code && (await mermaid.parse(fixed, { suppressErrors: true }))
            ? fixed
            : null;
        if (!good) throw new Error("not a diagram");
        const drawn = await mermaid.render(id, good);
        if (live) {
          setSvg(drawn.svg);
          setFailed(false);
        }
      } catch {
        // Source still arriving is not a diagram yet, and not one that failed: what was
        // drawn so far stays, and nothing is said until the reply is finished.
        if (live && !writing) {
          setSvg(null);
          setFailed(true);
        }
      }
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [code, dark, id, writing]);
  const save = () => {
    if (!svg) return;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    link.download = `${title.replace(/[\\/:*?"<>|]/g, " ").trim() || "diagram"}.svg`;
    link.click();
    URL.revokeObjectURL(link.href);
  };
  return (
    <Frame
      title={title}
      tools={
        <>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-pressed={source}
            title={t.app.visual.source}
            onClick={() => setSource(!source)}
          >
            <CodeIcon className="size-3.5" />
            <span className="sr-only">{t.app.visual.source}</span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            disabled={!svg}
            title={t.app.visual.save}
            onClick={save}
          >
            <DownloadIcon className="size-3.5" />
            <span className="sr-only">{t.app.visual.save}</span>
          </Button>
        </>
      }
    >
      {picture && !source ? (
        <div className="flex justify-center overflow-x-auto p-3">
          {/* A small diagram stays small: it is never stretched to the width of the reply. */}
          <img src={picture} alt={title} className="h-auto max-h-[30rem] w-auto max-w-full" />
        </div>
      ) : failed && !source ? (
        <p className="p-3 text-[13px] text-muted-foreground">{t.app.visual.notDrawn}</p>
      ) : svg === null && !failed && !source ? (
        // Being drawn: nothing yet, and not the source for a moment.
        <div className="h-24" />
      ) : (
        <pre className="overflow-x-auto p-3 font-mono text-xs whitespace-pre">{code}</pre>
      )}
    </Frame>
  );
}

interface Series {
  name: string;
  /** One for each label; `null` where there is none, which keeps its place empty. */
  values: (number | null)[];
}

export type ChartKind =
  | "bar"
  | "hbar"
  | "stacked"
  | "line"
  | "area"
  | "pie"
  | "radar"
  | "combo"
  | "waterfall";

/** The colours of a pie's slices, in fixed order: the four of a chart and two more. */
const SLICES = [...SERIES, "var(--series-5)", "var(--series-6)"] as const;

const TIP = {
  background: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  fontSize: 12,
  color: "var(--popover-foreground)",
};
const TICK = { fontSize: 11, fill: "var(--chart-axis)" };

/**
 * Numbers an agent charted: one scale to a plot, at most four series in fixed colours,
 * values on hover, and the numbers themselves one click away. Two measures of different
 * scale ("combo") are two plots over the same labels, never two scales on one.
 */
export function ChartView({
  title,
  kind,
  labels,
  series,
  unit = "",
  up,
  target,
  targetName,
  unit2 = "",
}: {
  title: string;
  kind: ChartKind;
  labels: string[];
  series: Series[];
  unit?: string;
  up?: Up;
  target?: number;
  targetName?: string;
  unit2?: string;
}) {
  const { t, number, compact } = useI18n();
  const [table, setTable] = useState(false);
  // The two plots of a combo follow one pointer; no other chart on the page does.
  const pair = useId();
  // A pie is the shares of one whole and a waterfall one amount's way: one series.
  const shown = series.slice(0, kind === "pie" || kind === "waterfall" ? 1 : SERIES.length);
  const lying = kind === "hbar";
  // One series of changes: each bar wears the colour of a rise or a fall.
  const signed = Boolean(up) && shown.length === 1 && (kind === "bar" || kind === "hbar");
  const slices =
    kind === "pie"
      ? fold(
          labels,
          (shown[0]?.values ?? []).map((one) => one ?? 0),
          t.app.visual.other,
        )
      : [];
  const whole = slices.reduce((sum, slice) => sum + slice.value, 0);
  const data = labels.map((label, index) => ({
    label,
    ...Object.fromEntries(shown.map((item, i) => [`s${i}`, item.values[index] ?? null])),
  }));
  // Which unit a series is in: in a combo all but the first are in the second.
  const unitOf = (i: number) => (kind === "combo" && i > 0 ? unit2 : unit);
  const value = (n: number, i = 0) => withUnit(number(n), unitOf(i));
  if (labels.length === 0 || shown.length === 0) return null;
  // The longest name decides how much room names get beside lying bars, within reason.
  const names = Math.min(140, Math.max(48, ...labels.map((label) => [...label].length * 7 + 12)));
  // Along an axis a number is short (1.2M, 3400万); where it is read, it is whole.
  const short = (n: number) => (Math.abs(n) >= 10_000 ? compact(n) : number(n));
  // One step for each label, and the total after them: a series shorter than its labels
  // (a reply still arriving) is filled with places that move nothing.
  const steps =
    kind === "waterfall"
      ? waterfall(labels.map((_, index) => shown[0]?.values[index] ?? null))
      : [];
  const falls = steps.map((step, index) => ({
    label: step?.kind === "total" ? t.app.visual.total : (labels[index] ?? ""),
    range: step ? [Math.min(step.from, step.to), Math.max(step.from, step.to)] : null,
    step,
  }));
  const fallFill = (index: number) => {
    const step = steps[index];
    if (!step || step.kind !== "move") return "var(--chart-axis)";
    const hue = up ? hueOf(step.change, up) : step.change < 0 ? "orange" : "blue";
    return hue ? HUE[hue] : "var(--chart-axis)";
  };
  const goal =
    target !== undefined && Number.isFinite(target) && kind !== "pie" && kind !== "radar" ? (
      <ReferenceLine
        {...(lying ? { x: target } : { y: target })}
        stroke="var(--foreground)"
        strokeOpacity={0.55}
        strokeDasharray="4 3"
        ifOverflow="extendDomain"
        label={{
          value: targetName ? `${targetName} ${value(target)}` : value(target),
          position: "insideTopRight",
          fontSize: 10,
          fill: "var(--chart-axis)",
        }}
      />
    ) : null;
  const tooltip = (
    <Tooltip
      cursor={{ fill: "var(--accent)", opacity: 0.5 }}
      contentStyle={TIP}
      formatter={(n, key) => {
        const i = Number(String(key).slice(1));
        return [value(Number(n), i), shown[i]?.name ?? ""];
      }}
    />
  );
  const axes = (names_: boolean, i = 0) => (
    <>
      <CartesianGrid stroke="var(--chart-grid)" vertical={lying} horizontal={!lying} />
      {lying ? (
        <>
          <XAxis
            type="number"
            tick={TICK}
            tickLine={false}
            axisLine={false}
            tickFormatter={(n: number) => short(n)}
          />
          <YAxis
            type="category"
            dataKey="label"
            width={names}
            tick={TICK}
            tickLine={false}
            axisLine={{ stroke: "var(--chart-grid)" }}
            interval={0}
          />
        </>
      ) : (
        <>
          <XAxis
            dataKey="label"
            tick={names_ ? TICK : false}
            height={names_ ? 30 : 4}
            tickLine={false}
            axisLine={{ stroke: "var(--chart-grid)" }}
          />
          <YAxis
            width={48}
            tick={TICK}
            tickLine={false}
            axisLine={false}
            // The lines of a combo are read for how they move: their scale need not start at nothing.
            domain={kind === "combo" && i > 0 ? ["auto", "auto"] : undefined}
            tickFormatter={(n: number) =>
              withUnit(short(n), unitOf(i).length <= 1 ? unitOf(i) : "")
            }
          />
        </>
      )}
    </>
  );
  const line = (item: Series, i: number) => (
    <Line
      key={`s${i}`}
      dataKey={`s${i}`}
      stroke={SERIES[i]}
      strokeWidth={2}
      // Dots where there is room for them; a long line is the line alone.
      dot={labels.length <= 40 ? { r: 3 } : false}
      activeDot={{ r: 5 }}
      // Drawn at once: a line that is still being drawn reads as no line.
      isAnimationActive={false}
    />
  );
  const bars = (item: Series, i: number) => (
    <Bar
      key={`s${i}`}
      dataKey={`s${i}`}
      fill={SERIES[i]}
      {...(kind === "stacked"
        ? { stackId: "all", stroke: "var(--card)", strokeWidth: 1 }
        : { radius: lying ? ([0, 4, 4, 0] as const) : ([4, 4, 0, 0] as const) })}
      isAnimationActive={false}
    >
      {signed &&
        item.values.map((one, at) => {
          const hue = one === null ? null : hueOf(one, up);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: bars follow the labels
            <Cell key={at} fill={hue ? HUE[hue] : "var(--chart-axis)"} />
          );
        })}
      {/* A ranking is read off its bars: each says its number at its end. */}
      {lying && shown.length === 1 && (
        <LabelList
          dataKey={`s${i}`}
          position="right"
          fontSize={11}
          fill="var(--chart-axis)"
          formatter={(n: unknown) => (typeof n === "number" ? value(n) : "")}
        />
      )}
    </Bar>
  );
  return (
    <Frame
      title={title}
      tools={
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-xs"
          aria-pressed={table}
          onClick={() => setTable(!table)}
        >
          {table ? t.app.visual.chart : t.app.visual.numbers}
        </Button>
      }
    >
      {table ? (
        <div className="overflow-x-auto p-3">
          <table className="num w-full text-xs">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-1 pr-3 font-normal" />
                {kind === "waterfall" ? (
                  <>
                    <th className="py-1 pl-3 text-right font-normal">{shown[0]?.name}</th>
                    <th className="py-1 pl-3 text-right font-normal">{t.app.visual.total}</th>
                  </>
                ) : (
                  shown.map((item, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: series keep their order, and two may share a name
                    <th key={i} className="py-1 pl-3 text-right font-normal">
                      {item.name}
                    </th>
                  ))
                )}
              </tr>
            </thead>
            <tbody>
              {kind === "waterfall"
                ? falls.map((row, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: rows follow the labels
                    <tr key={index} className="border-b last:border-b-0">
                      <td className="py-1 pr-3">{row.label}</td>
                      <td className="py-1 pl-3 text-right">
                        {row.step && row.step.kind === "move"
                          ? `${row.step.change > 0 ? "+" : ""}${value(row.step.change)}`
                          : ""}
                      </td>
                      <td className="py-1 pl-3 text-right">{row.step ? value(row.step.to) : ""}</td>
                    </tr>
                  ))
                : labels.map((label, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: rows follow the labels, and two may share a name
                    <tr key={index} className="border-b last:border-b-0">
                      <td className="py-1 pr-3">{label}</td>
                      {shown.map((item, i) => {
                        const one = item.values[index];
                        return (
                          // biome-ignore lint/suspicious/noArrayIndexKey: series keep their order, and two may share a name
                          <td key={i} className="py-1 pl-3 text-right">
                            {one === undefined || one === null ? "" : value(one, i)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="p-3">
          {/* With one series the title names it; with more, each has its colour named here. */}
          {shown.length > 1 && kind !== "pie" && (
            <ul className="flex flex-wrap gap-x-4 gap-y-1 pb-2 text-xs text-muted-foreground">
              {shown.map((item, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: series keep their order, and two may share a name
                <li key={i} className="flex items-center gap-1.5">
                  <span className="size-2 rounded-sm" style={{ background: SERIES[i] }} />
                  {item.name}
                </li>
              ))}
            </ul>
          )}
          {kind === "pie" && (
            <ul className="num flex flex-wrap gap-x-4 gap-y-1 pb-2 text-xs text-muted-foreground">
              {slices.map((slice, i) => {
                const share = whole
                  ? `${number(Math.round((slice.value / whole) * 1000) / 10)}%`
                  : "";
                const amount = value(slice.value);
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: slices follow the labels, and two may share a name
                  <li key={i} className="flex items-center gap-1.5">
                    <span className="size-2 rounded-sm" style={{ background: SLICES[i] }} />
                    {slice.name}
                    {/* Shares that were given as shares are said once. */}
                    <span className="text-foreground">
                      {amount === share || !share ? amount : `${amount} · ${share}`}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {kind === "combo" ? (
            <>
              <div className="h-40">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data} barCategoryGap="24%" syncId={pair}>
                    {axes(shown.length < 2)}
                    {tooltip}
                    {shown[0] && bars(shown[0], 0)}
                    {goal}
                  </BarChart>
                </ResponsiveContainer>
              </div>
              {shown.length > 1 && (
                <div className="h-28">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={data} syncId={pair}>
                      {axes(true, 1)}
                      {tooltip}
                      {shown.slice(1).map((item, i) => line(item, i + 1))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </>
          ) : (
            <div
              className={lying ? undefined : "h-56"}
              // Lying bars get a row each, however many there are.
              style={
                lying
                  ? { height: Math.max(120, labels.length * (shown.length * 14 + 12) + 32) }
                  : undefined
              }
            >
              <ResponsiveContainer width="100%" height="100%">
                {kind === "waterfall" ? (
                  <BarChart data={falls} barCategoryGap="24%">
                    {axes(true)}
                    <Tooltip
                      cursor={{ fill: "var(--accent)", opacity: 0.5 }}
                      contentStyle={TIP}
                      formatter={(_n, _key, entry) => {
                        const step = (entry?.payload as (typeof falls)[number] | undefined)?.step;
                        if (!step) return ["", ""];
                        return step.kind === "move"
                          ? [
                              `${step.change > 0 ? "+" : ""}${value(step.change)} → ${value(step.to)}`,
                              shown[0]?.name ?? "",
                            ]
                          : [value(step.to), shown[0]?.name ?? ""];
                      }}
                    />
                    <Bar dataKey="range" radius={2} isAnimationActive={false}>
                      {falls.map((_, index) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: bars follow the labels
                        <Cell key={index} fill={fallFill(index)} />
                      ))}
                    </Bar>
                    {goal}
                  </BarChart>
                ) : kind === "bar" || kind === "hbar" || kind === "stacked" ? (
                  <BarChart
                    data={data}
                    layout={lying ? "vertical" : "horizontal"}
                    barCategoryGap="24%"
                    barGap={2}
                    // Parts below nothing hang below it, apart from those above.
                    stackOffset="sign"
                    margin={lying && shown.length === 1 ? { right: 56 } : undefined}
                  >
                    {axes(true)}
                    {tooltip}
                    {shown.map(bars)}
                    {goal}
                  </BarChart>
                ) : kind === "pie" ? (
                  <PieChart>
                    <Tooltip
                      contentStyle={TIP}
                      formatter={(n, name) => [value(Number(n)), String(name)]}
                    />
                    <Pie
                      data={slices}
                      dataKey="value"
                      nameKey="name"
                      innerRadius="52%"
                      outerRadius="88%"
                      paddingAngle={1}
                      stroke="var(--card)"
                      strokeWidth={2}
                      isAnimationActive={false}
                    >
                      {slices.map((_, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: slices follow the labels
                        <Cell key={i} fill={SLICES[i]} />
                      ))}
                    </Pie>
                  </PieChart>
                ) : kind === "radar" ? (
                  <RadarChart data={data} outerRadius="76%">
                    <PolarGrid stroke="var(--chart-grid)" />
                    <PolarAngleAxis dataKey="label" tick={TICK} />
                    <Tooltip
                      contentStyle={TIP}
                      formatter={(n, key) => [
                        value(Number(n)),
                        shown[Number(String(key).slice(1))]?.name ?? "",
                      ]}
                    />
                    {shown.map((item, i) => (
                      <Radar
                        // biome-ignore lint/suspicious/noArrayIndexKey: series keep their order, and two may share a name
                        key={`s${i}`}
                        dataKey={`s${i}`}
                        stroke={SERIES[i]}
                        strokeWidth={2}
                        fill={SERIES[i]}
                        fillOpacity={0.12}
                        isAnimationActive={false}
                      />
                    ))}
                  </RadarChart>
                ) : kind === "line" ? (
                  <LineChart data={data}>
                    {axes(true)}
                    {tooltip}
                    {shown.map(line)}
                    {goal}
                  </LineChart>
                ) : (
                  <AreaChart data={data}>
                    {axes(true)}
                    {tooltip}
                    {shown.map((item, i) => (
                      <Area
                        // biome-ignore lint/suspicious/noArrayIndexKey: series keep their order, and two may share a name
                        key={`s${i}`}
                        dataKey={`s${i}`}
                        stroke={SERIES[i]}
                        strokeWidth={2}
                        fill={SERIES[i]}
                        fillOpacity={0.15}
                        isAnimationActive={false}
                      />
                    ))}
                    {goal}
                  </AreaChart>
                )}
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}
    </Frame>
  );
}
