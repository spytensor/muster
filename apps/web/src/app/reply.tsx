import * as schema from "@muster/ui-schema";
import { isPart, toRenderable, webUrl } from "@muster/ui-schema";
import { createLibrary, defineComponent, Renderer } from "@openuidev/react-lang";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  CornerDownRightIcon,
  InfoIcon,
  XIcon,
} from "lucide-react";
import { createContext, Fragment, type ReactNode, useContext, useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { AgentDraftCard, SkillDraftCard } from "./builders";
import { MailDraftCard, TeamsDraftCard } from "./drafts";
import { FormCard, FormScope } from "./forms";
import { FileMention } from "./lang";
import { CODE, inline, Markdown } from "./markdown";
import {
  CandlesView,
  FlowsView,
  HeatmapView,
  inkOf,
  MetricsView,
  ProgressView,
  ScatterView,
  TilesView,
  TimelineView,
} from "./numbers";
import { MOST, numberOr, numbers, signOf, type Up } from "./scale";
import { type ChartKind, ChartView, DiagramView } from "./visuals";

/** How a part of a reply sends the person's next message. Disabled while a reply is being written. */
export const ReplyActions = createContext<{ send(text: string): void; disabled: boolean }>({
  send: () => undefined,
  disabled: true,
});

/**
 * A line of an agent's words with its **bold**, `code` (a file named as the file) and links
 * drawn as such. Used wherever an agent's words are shown: a paragraph, the words along the
 * way, and a cell of a table, where the marks were once shown as written (the owner,
 * 2026-11-22, of a table whose cells read "**部分真实，但被高估**").
 */
export function runsOf(paragraph: string): ReactNode {
  return inline(paragraph);
}

/**
 * What a reply says in words, set as a document is (Markdown: headings, lists set in one
 * under another, `code`, files named with their language's mark, **bold**, rules). Nothing
 * is taken as HTML. A reply that talks about code reads as Antigravity's do: the owner's
 * reference, 2026-11-22.
 */
function Prose({ text }: { text: string }) {
  return <Markdown text={text} className="gap-3 text-[length:inherit] leading-[inherit]" />;
}

const Text = defineComponent({
  ...schema.Text,
  component: ({ props }) => (
    <div className={cn(props.tone === "muted" && "text-[0.93em] text-muted-foreground")}>
      <Prose text={String(props.text ?? "")} />
    </div>
  ),
});

const Heading = defineComponent({
  ...schema.Heading,
  component: ({ props }) => (
    <h3 className="pt-2 text-[1.08em] leading-snug font-semibold tracking-tight">
      {inline(String(props.text ?? ""))}
    </h3>
  ),
});

// A note set apart by a thin line in its tone, not a filled box: it is part of what is read.
const calloutTone = {
  info: { Icon: InfoIcon, className: "border-foreground/20", icon: "text-muted-foreground" },
  warning: { Icon: AlertTriangleIcon, className: "border-warn", icon: "text-warn" },
  success: { Icon: CheckCircle2Icon, className: "border-ok", icon: "text-ok" },
} as const;
const Callout = defineComponent({
  ...schema.Callout,
  component: ({ props }) => {
    // A model sometimes writes the tone where the title goes (`Callout("info", "…")`),
    // and the note then had the word "info" for its title. A title that is only a tone's
    // name is taken as the tone, and the note has no title.
    const written = String(props.title ?? "").trim();
    const misplaced = Object.hasOwn(calloutTone, written.toLowerCase())
      ? (written.toLowerCase() as keyof typeof calloutTone)
      : null;
    const title = misplaced ? "" : written;
    const { Icon, className, icon } =
      calloutTone[props.tone ?? misplaced ?? "info"] ?? calloutTone.info;
    return (
      <div className={cn("flex gap-2.5 border-l-2 py-0.5 pl-3.5", className)}>
        <Icon className={cn("mt-[0.35em] size-[1em] shrink-0", icon)} />
        <div className="grid gap-0.5">
          {title && <p className="font-semibold">{title}</p>}
          <div className="text-foreground/85">
            <Prose text={String(props.text ?? "")} />
          </div>
        </div>
      </div>
    );
  },
});

const List = defineComponent({
  ...schema.List,
  component: ({ props }) => {
    const items = (props.items ?? []).filter((item): item is string => typeof item === "string");
    const Tag = props.ordered ? "ol" : "ul";
    return (
      <Tag className="grid gap-1.5">
        {items.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: items of one list never reorder
          <li key={index} className="grid grid-cols-[1.25em_minmax(0,1fr)]">
            <span aria-hidden className="text-muted-foreground select-none">
              {props.ordered ? `${index + 1}.` : "•"}
            </span>
            <span className="min-w-0">
              <Prose text={item} />
            </span>
          </li>
        ))}
      </Tag>
    );
  },
});

const DataTable = defineComponent({
  ...schema.Table,
  component: ({ props }) => {
    const columns = (props.columns ?? []).map(String);
    const rows = (props.rows ?? []).filter(Array.isArray);
    // The columns whose cells are changes: coloured as rises and falls, once the reply says which is which.
    const up = upOf(props.up);
    const signed = new Set(up ? numbers(props.signed) : []);
    return (
      <div className="overflow-hidden rounded-xl border">
        <Table>
          {/* The frame's own line is right above it. The words are the agent's: left as written. */}
          <TableHeader className="border-t-0">
            <TableRow>
              {columns.map((column, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: columns of one table never reorder
                <TableHead key={index} className="text-xs tracking-normal normal-case">
                  {/* A heading is already set apart: its marks are taken off, not drawn. */}
                  {column.replace(/\*\*|`/g, "")}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, at) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows of one table never reorder
              <TableRow key={at}>
                {columns.map((_, index) => (
                  <TableCell
                    // biome-ignore lint/suspicious/noArrayIndexKey: cells follow the columns
                    key={index}
                    className={cn("whitespace-normal", signed.has(index) && "num")}
                    style={
                      signed.has(index)
                        ? { color: inkOf(signOf(String(row[index] ?? "")), up) }
                        : undefined
                    }
                  >
                    {inline(String(row[index] ?? ""))}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  },
});

const Facts = defineComponent({
  ...schema.Facts,
  component: ({ props }) => (
    <dl className="grid gap-x-6 gap-y-2 rounded-xl border px-4 py-3 text-sm sm:grid-cols-[auto_1fr]">
      {(props.items ?? []).map(
        (item, index) =>
          item && (
            // biome-ignore lint/suspicious/noArrayIndexKey: facts of one reply never reorder
            <Fragment key={index}>
              <dt className="text-muted-foreground">{String(item.label ?? "")}</dt>
              <dd className="font-medium">{String(item.value ?? "")}</dd>
            </Fragment>
          ),
      )}
    </dl>
  ),
});

/**
 * Whether a block holds words to be read, not code: a letter, a note, a list. Those wrap,
 * so nothing is off the edge. Code keeps its lines, where indentation and alignment are
 * part of what it says, and scrolls sideways inside its own frame. A block that names no
 * language is taken for code: a command or a table with its lines broken reads worse
 * than words that must be scrolled, and the model is asked to name the language.
 */
export const prose = (language?: string) =>
  Boolean(language) && /^(text|plain|plaintext|txt|markdown|md)$/i.test((language ?? "").trim());

export function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="overflow-hidden rounded-xl border bg-muted">
      <div className="flex items-center justify-between border-b px-3 py-1.5 text-xs text-muted-foreground">
        <span className="font-mono">{language ?? ""}</span>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-background"
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
          <span className="sr-only">Copy</span>
        </button>
      </div>
      <pre
        className={
          prose(language)
            ? "px-3 py-2 font-mono text-xs leading-relaxed wrap-break-word whitespace-pre-wrap"
            : "overflow-x-auto px-3 py-2 font-mono text-xs leading-relaxed"
        }
      >
        {code}
      </pre>
    </div>
  );
}
const Code = defineComponent({
  ...schema.Code,
  component: ({ props }) => (
    <CodeBlock
      code={String(props.code ?? "")}
      language={props.language ? String(props.language) : undefined}
    />
  ),
});

const Diagram = defineComponent({
  ...schema.Diagram,
  component: ({ props }) => {
    const { disabled } = useContext(ReplyActions);
    return (
      <DiagramView
        title={String(props.title ?? "")}
        code={String(props.code ?? "")}
        writing={disabled}
      />
    );
  },
});

/** The colour of a rise, when the reply names one of the two there are. */
const upOf = (value: unknown): Up => (value === "red" || value === "green" ? value : undefined);

const Chart = defineComponent({
  ...schema.Chart,
  component: ({ props }) => {
    const kind = (schema.CHART_KINDS as readonly string[]).includes(String(props.kind))
      ? (props.kind as ChartKind)
      : "bar";
    // Only what is really a label or a number is charted. A place without a number keeps
    // its place, so every number stays under its own label. Of more than a drawing holds,
    // a ranking and a radar keep the first and everything over time keeps the latest.
    const all = (props.labels ?? []).map((label) => String(label ?? ""));
    // A ranking, a radar, a pie and a waterfall (whose first bar is where it starts) keep
    // the first; everything over time keeps the latest.
    const first =
      kind === "radar"
        ? MOST.spokes
        : kind === "hbar"
          ? MOST.bars
          : kind === "pie" || kind === "waterfall"
            ? MOST.labels
            : 0;
    const most = kind === "line" || kind === "area" ? MOST.line : MOST.labels;
    const [from, to] = first ? [0, first] : [Math.max(0, all.length - most), all.length];
    const labels = all.slice(from, to);
    const series = (props.series ?? []).flatMap((item) =>
      item && Array.isArray(item.values)
        ? [
            {
              name: String(item.name ?? ""),
              values: item.values.slice(from, to).map((one) => (finite(one) ? one : null)),
            },
          ]
        : [],
    );
    return (
      <ChartView
        title={String(props.title ?? "")}
        kind={kind}
        labels={labels}
        series={series}
        unit={props.unit ? String(props.unit) : undefined}
        up={upOf(props.up)}
        target={finite(props.target) ? props.target : undefined}
        targetName={props.targetName ? String(props.targetName) : undefined}
        unit2={props.unit2 ? String(props.unit2) : undefined}
      />
    );
  },
});

// What follows shows numbers too. Like the chart, each takes only what is really a name
// or a number and no more of it than a reply can hold; a reply still being written may
// have any part of them missing.
const text = (value: unknown) => (value === undefined || value === null ? "" : String(value));
const finite = (value: unknown): value is number =>
  typeof value === "number" ? Number.isFinite(value) : false;
const list = <T,>(value: T[] | undefined | null, most: number): T[] =>
  (Array.isArray(value) ? value : []).filter(Boolean).slice(0, most);

const Scatter = defineComponent({
  ...schema.Scatter,
  component: ({ props }) => (
    <ScatterView
      title={text(props.title)}
      x={text(props.x)}
      y={text(props.y)}
      points={list(props.points, MOST.points)
        .map((point) => ({
          label: text(point.label),
          x: numberOr(point.x),
          y: numberOr(point.y),
          ...(point.group ? { group: text(point.group) } : {}),
          ...(finite(point.size) && point.size > 0 ? { size: point.size } : {}),
        }))
        .filter((point) => finite(point.x) && finite(point.y))}
    />
  ),
});

const Heatmap = defineComponent({
  ...schema.Heatmap,
  component: ({ props }) => (
    <HeatmapView
      title={text(props.title)}
      columns={list(props.columns, MOST.heat).map(text)}
      rows={list(props.rows, MOST.heat).map((row) => ({
        label: text(row.label),
        // Each keeps its column: a word where a number belongs leaves that cell empty.
        values: (Array.isArray(row.values) ? row.values : []).map(numberOr),
      }))}
      unit={props.unit ? text(props.unit) : undefined}
      up={upOf(props.up)}
    />
  ),
});

const Tiles = defineComponent({
  ...schema.Tiles,
  component: ({ props }) => (
    <TilesView
      title={text(props.title)}
      items={list(props.items, MOST.tiles)
        .map((item) => ({
          label: text(item.label),
          value: numberOr(item.value),
          ...(finite(item.weight) ? { weight: item.weight } : {}),
          ...(item.note ? { note: text(item.note) } : {}),
        }))
        .filter((item) => finite(item.value))}
      unit={props.unit ? text(props.unit) : undefined}
      up={upOf(props.up)}
    />
  ),
});

const Candles = defineComponent({
  ...schema.Candles,
  component: ({ props }) => {
    const labels = (Array.isArray(props.labels) ? props.labels : []).map(text);
    // A candle that is not four numbers is left out with its label, so the rest stay in
    // step. Of more than fit, the latest are the ones shown.
    const every = (Array.isArray(props.candles) ? props.candles : []).flatMap((one, index) => {
      if (!one) return [];
      const candle = {
        open: numberOr(one.open),
        high: numberOr(one.high),
        low: numberOr(one.low),
        close: numberOr(one.close),
      };
      return Object.values(candle).every(finite) ? [{ candle, label: labels[index] ?? "" }] : [];
    });
    const kept = every.slice(-MOST.candles);
    return (
      <CandlesView
        title={text(props.title)}
        labels={kept.map((one) => one.label)}
        candles={kept.map((one) => one.candle)}
        unit={props.unit ? text(props.unit) : undefined}
        up={upOf(props.up)}
      />
    );
  },
});

const Metrics = defineComponent({
  ...schema.Metrics,
  component: ({ props }) => (
    <MetricsView
      items={list(props.items, MOST.metrics).map((item) => ({
        label: text(item.label),
        value: text(item.value),
        ...(item.change ? { change: text(item.change) } : {}),
        ...(item.note ? { note: text(item.note) } : {}),
        ...(Array.isArray(item.trend) ? { trend: item.trend.filter(finite).slice(-60) } : {}),
      }))}
      up={upOf(props.up)}
    />
  ),
});

const Progress = defineComponent({
  ...schema.Progress,
  component: ({ props }) => (
    <ProgressView
      title={text(props.title)}
      items={list(props.items, MOST.progress)
        .map((item) => ({
          label: text(item.label),
          value: numberOr(item.value),
          of: numberOr(item.of),
        }))
        // Toward nothing there is no way to be part of the way.
        .filter((item) => finite(item.value) && finite(item.of) && item.of > 0)}
      unit={props.unit ? text(props.unit) : undefined}
    />
  ),
});

const Flows = defineComponent({
  ...schema.Flows,
  component: ({ props }) => (
    <FlowsView
      title={text(props.title)}
      // Which of them are flows, and how many a drawing holds, the layout decides.
      flows={list(props.flows, 200).map((flow) => ({
        from: text(flow.from),
        to: text(flow.to),
        value: numberOr(flow.value),
      }))}
      unit={props.unit ? text(props.unit) : undefined}
    />
  ),
});

const Timeline = defineComponent({
  ...schema.Timeline,
  component: ({ props }) => (
    <TimelineView
      title={text(props.title)}
      items={list(props.items, MOST.events).map((item) => ({
        when: text(item.when),
        title: text(item.title),
        ...(item.text ? { text: text(item.text) } : {}),
      }))}
    />
  ),
});

/** Where a page is, in a word: its site, without the `www`. */
const siteOf = (address: string) => {
  try {
    return new URL(address).host.replace(/^www\./, "");
  } catch {
    return address;
  }
};

/**
 * Where a reply got what it says. Under the reply and no part of it: one quiet line that
 * says how many and from where, opened to the list. As a row of bordered chips, seven of
 * them stood under the text like more of the text (the owner, 2026-11-21: "用户都不知道
 * 是不是正文了").
 */
function SourceList({ items }: { items: { title: string; url: string }[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const sites = [...new Set(items.map((item) => siteOf(item.url)))];
  return (
    <div className="mt-1 border-t pt-2 text-xs text-muted-foreground">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex max-w-full items-center gap-1.5 rounded-md py-0.5 hover:text-foreground"
      >
        <ChevronRightIcon
          className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
        />
        <span className="shrink-0 font-medium">{t.app.replyTail.sources(items.length)}</span>
        {!open && (
          <span className="min-w-0 truncate">
            {sites.slice(0, 3).join(" · ")}
            {sites.length > 3 && ` ${t.app.replyTail.more(sites.length - 3)}`}
          </span>
        )}
      </button>
      {open && (
        <ol className="mt-1 grid gap-0.5 pl-[18px]">
          {items.map((item, index) => (
            <li key={item.url} className="flex min-w-0 items-baseline gap-2">
              <span className="num w-4 shrink-0 text-right">{index + 1}</span>
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                title={item.url}
                className="min-w-0 truncate text-foreground/80 underline-offset-2 hover:text-foreground hover:underline"
              >
                {item.title || item.url}
              </a>
              {/* Without a title the address is the link, and says its site itself. */}
              {item.title && <span className="shrink-0">{siteOf(item.url)}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
const Sources = defineComponent({
  ...schema.Sources,
  component: ({ props }) => {
    // Checked again here: a link the schema would refuse is never rendered as a link.
    const seen = new Set<string>();
    const items = (props.items ?? []).flatMap((item) => {
      if (!item || !webUrl.safeParse(item.url).success) return [];
      // A page named twice is one source.
      const url = String(item.url);
      if (seen.has(url)) return [];
      seen.add(url);
      return [{ title: String(item.title ?? ""), url }];
    });
    if (items.length === 0) return null;
    return <SourceList items={items} />;
  },
});

/**
 * What the person could ask next. Not the reply: said to be a suggestion, set to the
 * left under a small heading, each a plain line with an arrow, not a bordered box as
 * wide as the text. Offered under the latest reply only: under an older one the
 * conversation has already gone on.
 */
function FollowUpButtons({ items }: { items: { label: string; text: string }[] }) {
  const { send, disabled } = useContext(ReplyActions);
  const { t } = useI18n();
  const place = useContext(FormScope);
  if (items.length === 0 || (place && !place.last)) return null;
  return (
    <div className="mt-2 grid justify-items-start gap-0.5">
      <p className="text-xs font-medium text-muted-foreground">{t.app.replyTail.next}</p>
      {items.slice(0, 4).map((item) => (
        <button
          type="button"
          key={item.label}
          disabled={disabled}
          onClick={() => send(item.text)}
          className="-mx-1.5 flex max-w-full items-start gap-1.5 rounded-md px-1.5 py-1 text-left text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <CornerDownRightIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{item.label}</span>
        </button>
      ))}
    </div>
  );
}
const FollowUps = defineComponent({
  ...schema.FollowUps,
  component: ({ props }) => (
    <FollowUpButtons
      items={(props.items ?? []).flatMap((item) =>
        item && typeof item.label === "string" && typeof item.text === "string"
          ? // The button shows exactly what it sends: a reply cannot hide a request behind a friendly label.
            [{ label: item.text, text: item.text }]
          : [],
      )}
    />
  ),
});

/** A decision put to the person: each way to go is a button that says what it sends. */
function ChoiceButtons({
  question,
  options,
}: {
  question: string;
  options: { title: string; detail: string }[];
}) {
  const { send, disabled } = useContext(ReplyActions);
  const { t } = useI18n();
  // A decision is for the moment it was asked: once anything is said after it, it is closed.
  const place = useContext(FormScope);
  const closed = Boolean(place && !place.last);
  return (
    <div className="glass-thick my-1 grid max-w-2xl overflow-hidden rounded-xl">
      {question && <p className="border-b px-3 py-2 text-[13px] font-medium">{question}</p>}
      {options.slice(0, 4).map((option, index) => (
        <button
          type="button"
          // biome-ignore lint/suspicious/noArrayIndexKey: the options of a question never reorder
          key={index}
          disabled={disabled || closed}
          onClick={() => send(option.title)}
          className="group flex items-start gap-2.5 border-b px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-accent/60 disabled:opacity-60"
        >
          <span className="num mt-px grid size-5 shrink-0 place-items-center rounded-md bg-foreground/8 text-[11px] font-medium group-hover:bg-primary group-hover:text-primary-foreground">
            {index + 1}
          </span>
          <span className="grid min-w-0 gap-0.5">
            <span className="text-[13px] font-medium">{option.title}</span>
            {option.detail && (
              <span className="text-xs text-muted-foreground">{option.detail}</span>
            )}
          </span>
        </button>
      ))}
      {closed && (
        <p className="border-t px-3 py-2 text-xs text-muted-foreground" role="status">
          {t.app.form.choiceClosed}
        </p>
      )}
    </div>
  );
}
const Choices = defineComponent({
  ...schema.Choices,
  component: ({ props }) => (
    <ChoiceButtons
      question={String(props.question ?? "").slice(0, 300)}
      options={(Array.isArray(props.options) ? props.options : []).flatMap((option) =>
        option && typeof option.title === "string" && option.title.trim()
          ? [
              {
                // The title is what is sent, so it is shown whole and kept short.
                title: option.title.trim().slice(0, 160),
                detail: String(option.detail ?? "").slice(0, 400),
              },
            ]
          : [],
      )}
    />
  ),
});

// A draft is a card the person sends from. Nothing in a reply sends anything.
const MailDraft = defineComponent({
  ...schema.MailDraft,
  component: ({ props }) => <MailDraftCard props={props as Record<string, unknown>} />,
});
const TeamsDraft = defineComponent({
  ...schema.TeamsDraft,
  component: ({ props }) => <TeamsDraftCard props={props as Record<string, unknown>} />,
});
// An agent or a skill proposed in a reply is made by the person, from its card.
const AgentDraft = defineComponent({
  ...schema.AgentDraft,
  component: ({ props }) => <AgentDraftCard props={props as Record<string, unknown>} />,
});
const SkillDraft = defineComponent({
  ...schema.SkillDraft,
  component: ({ props }) => <SkillDraftCard props={props as Record<string, unknown>} />,
});

// A form is drawn whole by its card, from what the reply gave it, checked. Its fields exist
// only inside it: met anywhere else they draw nothing.
const Form = defineComponent({
  ...schema.Form,
  component: ({ props }) => <FormCard props={props} />,
});
const nothing = () => null;
const TextField = defineComponent({ ...schema.TextField, component: nothing });
const SelectField = defineComponent({ ...schema.SelectField, component: nothing });
const DateField = defineComponent({ ...schema.DateField, component: nothing });
const NumberField = defineComponent({ ...schema.NumberField, component: nothing });

const Stack = defineComponent({
  ...schema.Stack,
  component: ({ props, renderNode }) => (
    // One column no wider than the conversation: a part with a long line (a code block, a
    // table) scrolls inside itself instead of widening everything around it.
    // A reply is read: a size and a line height for reading, not the 14 px of the interface.
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 text-[15px] leading-[1.75]">
      {/* A part that came out as a bare value, not a component, is not drawn as "false". */}
      {(props.children ?? []).filter(isPart).map((child, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: parts of one reply never reorder
        <div key={index} className="min-w-0">
          {renderNode(child)}
        </div>
      ))}
    </div>
  ),
});

/**
 * How a reply that changed the person's code ends (C1): what was done, each file with why,
 * each check with what came of it, and what is left. One card, so the person can tell at a
 * glance whether the change is right without reading the steps.
 */
/**
 * A check as written, the command apart from what the agent said of it in brackets at the
 * end ("npm test (after the change)"): only the command is set as code.
 */
const commandOf = (what: string) => {
  const note = /\s*([(（][^()（）]*[)）])\s*$/.exec(what);
  return note && note.index > 0
    ? { command: what.slice(0, note.index).trim(), note: note[1] ?? "" }
    : { command: what.trim(), note: "" };
};

function WalkthroughCard({ spec }: { spec: schema.WalkthroughSpec }) {
  const { t } = useI18n();
  const w = t.app.walkthrough;
  const head = "font-semibold";
  const row = "grid grid-cols-[1.25em_minmax(0,1fr)]";
  return (
    <section aria-label={w.title} className="grid gap-4 border-t pt-4">
      {spec.summary && <p className="font-medium">{inline(spec.summary)}</p>}
      {spec.changes.length > 0 && (
        <div className="grid gap-1.5">
          <h4 className={head}>{w.changes(spec.changes.length)}</h4>
          <ul className="grid gap-1.5">
            {spec.changes.map((change, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: files of one reply never reorder
              <li key={index} className={row}>
                <span aria-hidden className="text-muted-foreground select-none">
                  •
                </span>
                <span className="min-w-0">
                  <FileMention path={change.file} folder />
                  {change.why && (
                    <span className="text-foreground/80"> — {inline(change.why)}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {spec.checks.length > 0 && (
        <div className="grid gap-1.5">
          <h4 className={head}>{w.checks}</h4>
          <ul className="grid gap-1.5">
            {spec.checks.map((check, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: checks of one reply never reorder
              <li key={index} className={row}>
                {check.ok ? (
                  <CheckIcon className="mt-[0.4em] size-[0.95em] text-ok" aria-label={w.passed} />
                ) : (
                  <XIcon
                    className="mt-[0.4em] size-[0.95em] text-destructive"
                    aria-label={w.failed}
                  />
                )}
                <span className="min-w-0">
                  <code className={CODE}>{commandOf(check.what).command}</code>
                  {commandOf(check.what).note && (
                    <span className="text-muted-foreground"> {commandOf(check.what).note}</span>
                  )}
                  {check.result && (
                    <span className="text-muted-foreground"> — {inline(check.result)}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {spec.left.length > 0 && (
        <div className="grid gap-1.5">
          <h4 className={head}>{w.left}</h4>
          <ul className="grid gap-1.5">
            {spec.left.map((item, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: items of one reply never reorder
              <li key={index} className={row}>
                <span aria-hidden className="text-muted-foreground select-none">
                  •
                </span>
                <span className="min-w-0">{inline(item)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

const Walkthrough = defineComponent({
  ...schema.Walkthrough,
  component: ({ props }) => {
    const words = (value: unknown) => (typeof value === "string" ? value : "");
    const rows = (value: unknown) =>
      (Array.isArray(value) ? value : []).filter(
        (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
      );
    return (
      <WalkthroughCard
        spec={{
          summary: words(props.summary),
          changes: rows(props.changes).map((item) => ({
            file: words(item.file),
            why: words(item.why),
          })),
          checks: rows(props.checks).map((item) => ({
            what: words(item.what),
            result: words(item.result),
            ok: item.ok === true,
          })),
          left: (Array.isArray(props.left) ? props.left : []).map(words).filter(Boolean),
        }}
      />
    );
  },
});

const library = createLibrary({
  root: "Stack",
  components: [
    Stack,
    Text,
    Heading,
    Callout,
    List,
    DataTable,
    Facts,
    Code,
    Diagram,
    Chart,
    Scatter,
    Heatmap,
    Tiles,
    Candles,
    Metrics,
    Progress,
    Flows,
    Timeline,
    Sources,
    FollowUps,
    Choices,
    MailDraft,
    TeamsDraft,
    AgentDraft,
    SkillDraft,
    Walkthrough,
    Form,
    TextField,
    SelectField,
    DateField,
    NumberField,
  ],
});

/**
 * One reply from an agent, rendered from the OpenUI Lang it wrote. Safe to call on every new piece of text.
 *
 * The renderer is given no tool provider and no handler for actions: a reply that writes a
 * query, a mutation or a step that opens an address calls nothing and opens nothing. What a
 * reply can do is what its components do themselves.
 */
export function Reply({
  text,
  streaming,
  fallback,
}: {
  text: string;
  streaming: boolean;
  fallback?: ReactNode;
}) {
  const response = toRenderable(text, streaming);
  if (!response) return <>{fallback ?? null}</>;
  return (
    <Renderer
      response={response}
      library={library}
      isStreaming={streaming}
      publishObservability={false}
    />
  );
}
