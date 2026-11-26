import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  BookmarkIcon,
  BotIcon,
  CheckIcon,
  Columns3Icon,
  DownloadIcon,
  ListFilterIcon,
  MessageSquareTextIcon,
  SearchIcon,
  ShieldCheckIcon,
  SparklesIcon,
  StampIcon,
  Trash2Icon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { go } from "@/App";
import { useConfirm } from "@/components/confirm";
import { MoreMenu } from "@/components/more";
import {
  Dot,
  Empty,
  LevelBadge,
  Loading,
  Notice,
  RiskBadge,
  useAction,
  useLoad,
} from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Lead } from "@/components/ui/hint";
import { Input, Label, NativeSelect, Textarea } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useI18n } from "@/i18n";
import { shownAgent } from "@/lib/agentName";
import {
  type Agent,
  type Annotation,
  api,
  type Conversation,
  type Level,
  type Me,
  type RunStatus,
  type SavedView,
  type Span,
  type SpanKind,
  type SpanRow,
  type Trace,
  type TraceSummary,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const PAGE = 50;
const RANGES = ["15m", "1h", "12h", "24h", "7d", "30d", "90d"] as const;
const STATUSES: RunStatus[] = ["ok", "error", "blocked", "stopped", "awaiting_approval", "running"];
const LEVELS: Level[] = ["A0", "A1", "A2", "A3", "A4"];
const KINDS: SpanKind[] = ["agent", "llm", "tool", "retriever", "policy", "approval"];
type Tab = "traces" | "spans" | "conversations";
type Filters = Record<string, string>;
const DEFAULTS: Filters = { range: "7d" };
const FILTER_KEYS = ["range", "status", "level", "venue", "agent", "user", "q", "minMs"];

const kindIcon: Record<SpanKind, typeof BotIcon> = {
  agent: BotIcon,
  llm: SparklesIcon,
  tool: WrenchIcon,
  retriever: SearchIcon,
  policy: ShieldCheckIcon,
  approval: StampIcon,
};
const statusVariant = {
  ok: "ok",
  error: "destructive",
  blocked: "warn",
  stopped: "muted",
  awaiting_approval: "outline",
  running: "secondary",
} as const;

/** Filters live in the address, so a view can be linked, reloaded and gone back to. */
function readFilters(): Filters {
  const query = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const filters: Filters = { ...DEFAULTS };
  for (const key of FILTER_KEYS) {
    const value = query.get(key);
    if (value) filters[key] = value;
  }
  return filters;
}
const toQuery = (filters: Filters, extra: Record<string, string | number> = {}) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
  for (const [key, value] of Object.entries(extra)) query.set(key, String(value));
  return query.toString();
};
const toggle = (list: string, value: string) => {
  const items = list ? list.split(",") : [];
  return (items.includes(value) ? items.filter((item) => item !== value) : [...items, value]).join(
    ",",
  );
};

export function TracesPage({ me, path }: { me: Me; path: string[] }) {
  if (path[0] === "t" && path[1])
    return <TraceDetail key={path[1]} me={me} id={path[1]} spanId={path[2]} />;
  if (path[0] === "c" && path[1]) return <ConversationDetail key={path[1]} id={path[1]} />;
  const tab: Tab =
    path[0] === "spans" ? "spans" : path[0] === "conversations" ? "conversations" : "traces";
  return <TraceLists tab={tab} />;
}

// ---------------------------------------------------------------------------
// Level 1: the lists
// ---------------------------------------------------------------------------

function TraceLists({ tab }: { tab: Tab }) {
  const { t } = useI18n();
  const [filters, setFilters] = useState<Filters>(readFilters);
  const [showFilters, setShowFilters] = useState(false);
  const [search, setSearch] = useState(filters.q ?? "");
  const agents = useLoad(() => api<Agent[]>("/api/agents").catch(() => [] as Agent[]));
  const views = useLoad(() => api<SavedView[]>("/api/views"));
  const asking = useConfirm();
  const [saving, setSaving] = useState(false);

  // Keep the address in step with the filters, without adding a history entry per keystroke.
  useEffect(() => {
    const base = tab === "traces" ? "traces" : `traces/${tab}`;
    history.replaceState(null, "", `#/admin/${base}?${toQuery(filters)}`);
  }, [filters, tab]);
  // Typing in the search box applies after a short pause.
  useEffect(() => {
    const timer = setTimeout(
      () =>
        setFilters((current) =>
          current.q === search || (!current.q && !search) ? current : { ...current, q: search },
        ),
      300,
    );
    return () => clearTimeout(timer);
  }, [search]);

  const set = (key: string, value: string) =>
    setFilters((current) => ({ ...current, [key]: value }));
  const active = FILTER_KEYS.filter((key) => key !== "range" && key !== "q" && filters[key]).length;
  const apply = (next: Filters) => {
    setFilters({ ...DEFAULTS, ...next });
    setSearch(next.q ?? "");
  };
  const tr = t.traces;

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <Tabs
          value={tab}
          onValueChange={(value) =>
            go(`${value === "traces" ? "traces" : `traces/${value}`}?${toQuery(filters)}`)
          }
        >
          <TabsList>
            {(["traces", "spans", "conversations"] as Tab[]).map((id) => (
              <TabsTrigger key={id} value={id}>
                {tr.tabs[id]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="relative min-w-56 flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder={tr.search}
            aria-label={tr.search}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <NativeSelect
          className="w-44"
          aria-label={t.dashboard.periodLabel}
          value={filters.range}
          onChange={(event) => set("range", event.target.value)}
        >
          {RANGES.map((range) => (
            <option key={range} value={range}>
              {t.ranges[range]}
            </option>
          ))}
        </NativeSelect>
        <Button
          variant={showFilters || active ? "secondary" : "outline"}
          size="sm"
          aria-expanded={showFilters}
          onClick={() => setShowFilters((open) => !open)}
        >
          <ListFilterIcon />
          {tr.filters}
          {active > 0 && (
            <span className="num rounded-full bg-primary px-1.5 text-xs text-primary-foreground">
              {active}
            </span>
          )}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <BookmarkIcon />
              {tr.views}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-64">
            <DropdownMenuItem onSelect={() => apply({})}>{tr.defaultView}</DropdownMenuItem>
            {views.data?.map((view) => (
              <DropdownMenuItem
                key={view.id}
                onSelect={() => apply(view.filters)}
                className="justify-between"
              >
                <span className="truncate">{view.name}</span>
                <button
                  type="button"
                  className="rounded p-1 text-muted-foreground hover:bg-background hover:text-destructive"
                  aria-label={tr.deleteView(view.name)}
                  onClick={(event) => {
                    event.stopPropagation();
                    void asking
                      .confirm(t.common.delete, tr.deleteViewConfirm(view.name))
                      .then((yes) =>
                        yes
                          ? api(`/api/views/${view.id}`, { method: "DELETE" }).then(() =>
                              views.reload(),
                            )
                          : undefined,
                      );
                  }}
                >
                  <Trash2Icon className="size-3.5" />
                </button>
              </DropdownMenuItem>
            ))}
            {views.data?.length === 0 && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">{tr.noViews}</p>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setSaving(true)}>{tr.saveView}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {showFilters && (
        <Card>
          <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <Field label={tr.status}>
              <Chips
                options={STATUSES.map((status) => ({
                  value: status,
                  label: t.runStatus[status] as string,
                }))}
                value={filters.status ?? ""}
                onToggle={(value) => set("status", toggle(filters.status ?? "", value))}
              />
            </Field>
            <Field label={tr.level}>
              <Chips
                options={LEVELS.map((level) => ({
                  value: level,
                  label: level,
                  title: t.level[level],
                }))}
                value={filters.level ?? ""}
                onToggle={(value) => set("level", toggle(filters.level ?? "", value))}
              />
            </Field>
            <Field label={tr.venue} htmlFor="f-venue">
              <NativeSelect
                id="f-venue"
                value={filters.venue ?? ""}
                onChange={(event) => set("venue", event.target.value)}
              >
                <option value="">{tr.anyVenue}</option>
                <option value="cloud">{t.venue.cloud}</option>
                <option value="device">{t.venue.device}</option>
              </NativeSelect>
            </Field>
            <Field label={tr.agent} htmlFor="f-agent">
              <NativeSelect
                id="f-agent"
                value={filters.agent ?? ""}
                onChange={(event) => set("agent", event.target.value)}
              >
                <option value="">{tr.anyAgent}</option>
                {agents.data?.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {shownAgent(agent)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label={tr.user} htmlFor="f-user">
              <Input
                id="f-user"
                value={filters.user ?? ""}
                onChange={(event) => set("user", event.target.value)}
              />
            </Field>
            <Field label={tr.minDuration} htmlFor="f-min">
              <Input
                id="f-min"
                type="number"
                min={0}
                step={1}
                value={filters.minMs ? String(Number(filters.minMs) / 1000) : ""}
                onChange={(event) =>
                  set(
                    "minMs",
                    event.target.value && Number(event.target.value) > 0
                      ? String(Math.round(Number(event.target.value) * 1000))
                      : "",
                  )
                }
              />
            </Field>
            {active > 0 && (
              <div className="md:col-span-2 xl:col-span-3">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => apply({ range: filters.range ?? "7d", q: filters.q ?? "" })}
                >
                  <XIcon />
                  {tr.clear}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {tab === "traces" ? (
        <TraceTable filters={filters} />
      ) : tab === "spans" ? (
        <SpanTable filters={filters} />
      ) : (
        <ConversationTable filters={filters} />
      )}

      {saving && (
        <SaveViewDialog
          filters={filters}
          onClose={() => setSaving(false)}
          onDone={async () => {
            setSaving(false);
            await views.reload();
          }}
        />
      )}
      {asking.dialog}
    </>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid content-start gap-1.5">
      {htmlFor ? (
        <Label htmlFor={htmlFor}>{label}</Label>
      ) : (
        <span className="text-[13px] font-medium">{label}</span>
      )}
      {children}
    </div>
  );
}

function Chips({
  options,
  value,
  onToggle,
}: {
  options: { value: string; label: string; title?: string }[];
  value: string;
  onToggle: (value: string) => void;
}) {
  const chosen = new Set(value ? value.split(",") : []);
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          title={option.title}
          aria-pressed={chosen.has(option.value)}
          onClick={() => onToggle(option.value)}
          className={cn(
            "rounded-full border px-2.5 py-1 text-xs transition-colors hover:bg-accent",
            chosen.has(option.value) &&
              "border-primary bg-primary text-primary-foreground hover:bg-primary/85",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function SaveViewDialog({
  filters,
  onClose,
  onDone,
}: {
  filters: Filters;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const action = useAction();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.traces.saveView}</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void action.run(async () => {
              await api("/api/views", {
                method: "POST",
                body: {
                  name,
                  filters: Object.fromEntries(Object.entries(filters).filter(([, value]) => value)),
                },
              });
              await onDone();
            });
          }}
        >
          <Input
            autoFocus
            aria-label={t.traces.viewName}
            placeholder={t.traces.viewName}
            maxLength={40}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          {action.error && <p className="text-sm text-destructive">{action.error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t.common.cancel}
            </Button>
            <Button type="submit" disabled={!name.trim() || action.busy}>
              {t.common.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RunStatusBadge({ status }: { status: RunStatus }) {
  const { t } = useI18n();
  return (
    <Badge variant={statusVariant[status]}>
      <Dot />
      {t.runStatus[status]}
    </Badge>
  );
}

function Pager({
  offset,
  shown,
  total,
  onChange,
}: {
  offset: number;
  shown: number;
  total: number;
  onChange: (offset: number) => void;
}) {
  const { t } = useI18n();
  if (total <= PAGE) return null;
  return (
    <div className="flex items-center justify-end gap-3 border-t px-3.5 py-1.5 text-sm text-muted-foreground">
      <span className="num">{t.common.showing(offset + 1, offset + shown, total)}</span>
      <Button
        variant="outline"
        size="sm"
        disabled={offset === 0}
        onClick={() => onChange(Math.max(0, offset - PAGE))}
      >
        {t.common.previous}
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={offset + shown >= total}
        onClick={() => onChange(offset + PAGE)}
      >
        {t.common.next}
      </Button>
    </div>
  );
}

const COLUMNS = [
  "status",
  "started",
  "id",
  "agent",
  "user",
  "input",
  "output",
  "duration",
  "tokens",
  "cost",
  "steps",
  "venue",
  "level",
  "annotations",
] as const;
type Column = (typeof COLUMNS)[number];
const SORTABLE: Partial<Record<Column, string>> = {
  started: "started",
  duration: "duration",
  tokens: "tokens",
  cost: "cost",
};
const HIDDEN_KEY = "muster.traces.hidden";
const hiddenByDefault: Column[] = ["output", "venue"];

function TraceTable({ filters }: { filters: Filters }) {
  const { t, number, compact, money, duration, dateTime, percent } = useI18n();
  const tr = t.traces;
  const [sort, setSort] = useState<{ by: string; dir: "asc" | "desc" }>({
    by: "started",
    dir: "desc",
  });
  const [offset, setOffset] = useState(0);
  const [hidden, setHidden] = useState<Set<Column>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "null");
      return new Set(Array.isArray(saved) ? saved : hiddenByDefault);
    } catch {
      return new Set(hiddenByDefault);
    }
  });
  const key = toQuery(filters);
  // A new filter starts again from the first page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the filters change
  useEffect(() => setOffset(0), [key]);
  const { data, error, loading } = useLoad(
    () =>
      api<{ rows: Trace[]; summary: TraceSummary }>(
        `/api/traces?${toQuery(filters, { sort: sort.by, dir: sort.dir, limit: PAGE, offset })}`,
      ),
    [key, sort.by, sort.dir, offset],
  );
  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <Loading />;
  const { rows, summary } = data;
  const show = (column: Column) => !hidden.has(column);
  const flip = (column: Column) => {
    const next = new Set(hidden);
    if (next.has(column)) next.delete(column);
    else next.add(column);
    setHidden(next);
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next]));
  };
  const head = (column: Column, className?: string) => {
    if (!show(column)) return null;
    const by = SORTABLE[column];
    return (
      <TableHead
        className={className}
        aria-sort={
          by && sort.by === by ? (sort.dir === "asc" ? "ascending" : "descending") : undefined
        }
      >
        {by ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 hover:text-foreground"
            onClick={() =>
              setSort({ by, dir: sort.by === by && sort.dir === "desc" ? "asc" : "desc" })
            }
          >
            {tr.columns[column]}
            {sort.by === by &&
              (sort.dir === "desc" ? (
                <ArrowDownIcon className="size-3" />
              ) : (
                <ArrowUpIcon className="size-3" />
              ))}
          </button>
        ) : (
          tr.columns[column]
        )}
      </TableHead>
    );
  };
  const stat = (label: string, value: string, tone?: string) => (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("num text-lg font-semibold tracking-tight", tone)}>{value}</dd>
    </div>
  );

  return (
    <Card
      className={cn("overflow-hidden pb-0 dense:pb-0 transition-opacity", loading && "opacity-70")}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 px-3.5">
        <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-4 xl:grid-cols-8">
          {stat(tr.summary.total, number(summary.total))}
          {stat(
            tr.summary.errorRate,
            summary.total ? percent(summary.errors / summary.total) : "–",
            summary.errors ? "text-destructive" : undefined,
          )}
          {stat(tr.summary.blocked, number(summary.blocked))}
          {stat(tr.summary.awaiting, number(summary.awaiting))}
          {stat(tr.summary.p50, duration(summary.p50))}
          {stat(tr.summary.p95, duration(summary.p95))}
          {stat(tr.summary.tokens, compact(summary.tokens))}
          {stat(tr.summary.cost, money(summary.costMicros))}
        </dl>
        <div className="flex gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Columns3Icon />
                {tr.columnsButton}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {COLUMNS.map((column) => (
                <DropdownMenuItem
                  key={column}
                  onSelect={(event) => {
                    event.preventDefault();
                    flip(column);
                  }}
                >
                  <CheckIcon className={cn(!show(column) && "invisible")} />
                  {tr.columns[column]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="outline" size="sm" asChild title={tr.exportHint}>
            <a href={`/api/traces/export.csv?${toQuery(filters)}`} download>
              <DownloadIcon />
              {tr.export}
            </a>
          </Button>
        </div>
      </div>
      {rows.length === 0 ? (
        <Empty>
          {summary.total === 0 && !Object.keys(filters).some((k) => k !== "range" && filters[k])
            ? tr.empty
            : tr.none}
        </Empty>
      ) : (
        <Table pinLast>
          <TableHeader>
            <TableRow>
              {head("status")}
              {head("started")}
              {head("id")}
              {head("agent")}
              {head("user")}
              {head("input")}
              {head("output")}
              {head("duration", "text-right")}
              {head("tokens", "text-right")}
              {head("cost", "text-right")}
              {head("steps", "text-right")}
              {head("venue")}
              {head("level")}
              {head("annotations", "text-right")}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((trace) => (
              <TableRow
                key={trace.id}
                className="cursor-pointer"
                tabIndex={0}
                aria-label={`${tr.open} ${trace.id.slice(0, 13)}`}
                onClick={() => go(`traces/t/${trace.id}`)}
                onKeyDown={(event) => event.key === "Enter" && go(`traces/t/${trace.id}`)}
              >
                {show("status") && (
                  <TableCell>
                    <RunStatusBadge status={trace.status} />
                  </TableCell>
                )}
                {show("started") && (
                  <TableCell className="num text-muted-foreground">
                    {dateTime(trace.startedAt)}
                  </TableCell>
                )}
                {show("id") && (
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {trace.id.slice(0, 13)}
                  </TableCell>
                )}
                {show("agent") && <TableCell className="font-medium">{trace.agentName}</TableCell>}
                {show("user") && (
                  <TableCell className="text-muted-foreground">
                    {trace.userName || trace.userEmail || "–"}
                  </TableCell>
                )}
                {show("input") && (
                  <TableCell className="max-w-72 truncate" title={trace.input}>
                    {trace.input}
                  </TableCell>
                )}
                {show("output") && (
                  <TableCell
                    className="max-w-72 truncate text-muted-foreground"
                    title={trace.output}
                  >
                    {trace.output}
                  </TableCell>
                )}
                {show("duration") && (
                  <TableCell className="num text-right">{duration(trace.durationMs)}</TableCell>
                )}
                {show("tokens") && (
                  <TableCell
                    className="num text-right"
                    title={tr.tokenSplit(
                      number(trace.promptTokens),
                      number(trace.completionTokens),
                    )}
                  >
                    {compact(trace.promptTokens + trace.completionTokens)}
                  </TableCell>
                )}
                {show("cost") && (
                  <TableCell className="num text-right">{money(trace.costMicros, 4)}</TableCell>
                )}
                {show("steps") && (
                  <TableCell className="num text-right">{trace.spanCount}</TableCell>
                )}
                {show("venue") && (
                  <TableCell className="text-muted-foreground">{t.venue[trace.venue]}</TableCell>
                )}
                {show("level") && (
                  <TableCell>
                    <LevelBadge level={trace.maxAction} />
                  </TableCell>
                )}
                {show("annotations") && (
                  <TableCell className="num text-right text-muted-foreground">
                    {trace.annotations > 0 && (
                      <span className="inline-flex items-center gap-1">
                        <MessageSquareTextIcon className="size-3.5" />
                        {trace.annotations}
                      </span>
                    )}
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Pager offset={offset} shown={rows.length} total={summary.total} onChange={setOffset} />
    </Card>
  );
}

function KindBadge({ kind }: { kind: SpanKind }) {
  const { t } = useI18n();
  const Icon = kindIcon[kind];
  return (
    <Badge variant="outline">
      <Icon />
      {t.spanKind[kind]}
    </Badge>
  );
}

function SpanStatus({ status }: { status: Span["status"] }) {
  const { t } = useI18n();
  return (
    <Badge
      variant={
        status === "ok"
          ? "ok"
          : status === "error"
            ? "destructive"
            : status === "stopped"
              ? "muted"
              : "warn"
      }
    >
      <Dot />
      {t.spanStatus[status]}
    </Badge>
  );
}

function SpanTable({ filters }: { filters: Filters }) {
  const { t, compact, money, duration, dateTime } = useI18n();
  const tr = t.traces;
  const [kinds, setKinds] = useState("");
  const [offset, setOffset] = useState(0);
  const key = `${toQuery(filters)}|${kinds}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the filters change
  useEffect(() => setOffset(0), [key]);
  const { data, error, loading } = useLoad(
    () =>
      api<{ rows: SpanRow[]; total: number }>(
        `/api/spans?${toQuery(filters, { limit: PAGE, offset, ...(kinds ? { kind: kinds } : {}) })}`,
      ),
    [key, offset],
  );
  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <Loading />;
  const c = tr.spanColumns;
  return (
    <Card
      className={cn("overflow-hidden pb-0 dense:pb-0 transition-opacity", loading && "opacity-70")}
    >
      <div className="flex flex-wrap items-center gap-3 px-3.5">
        <span className="text-[13px] font-medium">{tr.kindFilter}</span>
        <Chips
          options={KINDS.map((kind) => ({ value: kind, label: t.spanKind[kind] as string }))}
          value={kinds}
          onToggle={(value) => setKinds(toggle(kinds, value))}
        />
      </div>
      {data.rows.length === 0 ? (
        <Empty>{tr.spansNone}</Empty>
      ) : (
        <Table pinLast>
          <TableHeader>
            <TableRow>
              <TableHead>{c.kind}</TableHead>
              <TableHead>{c.name}</TableHead>
              <TableHead>{c.status}</TableHead>
              <TableHead>{c.agent}</TableHead>
              <TableHead>{c.started}</TableHead>
              <TableHead className="text-right">{c.duration}</TableHead>
              <TableHead className="text-right">{c.tokens}</TableHead>
              <TableHead className="text-right">{c.cost}</TableHead>
              <TableHead>{c.io}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.map((span) => (
              <TableRow
                key={span.id}
                className="cursor-pointer"
                tabIndex={0}
                onClick={() => go(`traces/t/${span.traceId}/${span.id}`)}
                onKeyDown={(event) =>
                  event.key === "Enter" && go(`traces/t/${span.traceId}/${span.id}`)
                }
              >
                <TableCell>
                  <KindBadge kind={span.kind} />
                </TableCell>
                <TableCell className="font-mono text-xs">{span.name}</TableCell>
                <TableCell>
                  <SpanStatus status={span.status} />
                </TableCell>
                <TableCell>{span.agentName}</TableCell>
                <TableCell className="num text-muted-foreground">
                  {dateTime(span.startedAt)}
                </TableCell>
                <TableCell className="num text-right">{duration(span.durationMs)}</TableCell>
                <TableCell className="num text-right">
                  {span.promptTokens + span.completionTokens
                    ? compact(span.promptTokens + span.completionTokens)
                    : ""}
                </TableCell>
                <TableCell className="num text-right">
                  {span.costMicros ? money(span.costMicros, 4) : ""}
                </TableCell>
                <TableCell
                  className="max-w-96 truncate text-muted-foreground"
                  title={`${span.input}\n→ ${span.output}`}
                >
                  {span.input} → {span.output}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Pager offset={offset} shown={data.rows.length} total={data.total} onChange={setOffset} />
    </Card>
  );
}

function ConversationTable({ filters }: { filters: Filters }) {
  const { t, compact, money, duration, dateTime } = useI18n();
  const tr = t.traces;
  const key = toQuery(filters);
  const { data, error, loading } = useLoad(
    () => api<Conversation[]>(`/api/conversations?${key}`),
    [key],
  );
  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <Loading />;
  const c = tr.conversationColumns;
  return (
    <Card className={cn("overflow-hidden py-0 transition-opacity", loading && "opacity-70")}>
      {data.length === 0 ? (
        <Empty>{tr.conversationsNone}</Empty>
      ) : (
        <Table pinLast>
          <TableHeader className="border-t-0">
            <TableRow>
              <TableHead>{c.started}</TableHead>
              <TableHead>{c.agent}</TableHead>
              <TableHead>{c.user}</TableHead>
              <TableHead>{c.first}</TableHead>
              <TableHead className="text-right">{c.turns}</TableHead>
              <TableHead className="text-right">{c.duration}</TableHead>
              <TableHead className="text-right">{c.tokens}</TableHead>
              <TableHead className="text-right">{c.cost}</TableHead>
              <TableHead className="text-right">{c.problems}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((conversation) => (
              <TableRow
                key={conversation.id}
                className="cursor-pointer"
                tabIndex={0}
                onClick={() => go(`traces/c/${conversation.id}`)}
                onKeyDown={(event) => event.key === "Enter" && go(`traces/c/${conversation.id}`)}
              >
                <TableCell className="num text-muted-foreground">
                  {dateTime(conversation.startedAt)}
                </TableCell>
                <TableCell className="font-medium">{conversation.agentName}</TableCell>
                <TableCell className="text-muted-foreground">
                  {conversation.userEmail ?? "–"}
                </TableCell>
                <TableCell className="max-w-96 truncate" title={conversation.firstInput}>
                  {conversation.firstInput}
                </TableCell>
                <TableCell className="num text-right">{conversation.traces}</TableCell>
                <TableCell className="num text-right">
                  {duration(conversation.durationMs)}
                </TableCell>
                <TableCell className="num text-right">{compact(conversation.tokens)}</TableCell>
                <TableCell className="num text-right">
                  {money(conversation.costMicros, 4)}
                </TableCell>
                <TableCell className="num text-right">
                  {conversation.problems > 0 && (
                    <Badge variant="destructive">{conversation.problems}</Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// A conversation: its turns in order
// ---------------------------------------------------------------------------

function ConversationDetail({ id }: { id: string }) {
  const { t, dateTime, duration } = useI18n();
  const { data, error } = useLoad(() =>
    api<Trace[]>(`/api/conversations/${encodeURIComponent(id)}`),
  );
  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <Loading />;
  const d = t.traces.detail;
  return (
    <>
      <BackBar
        to="traces/conversations"
        title={`${t.traces.conversationTitle} · ${data[0]?.agentName}`}
        id={id}
      />
      <div className="grid gap-3">
        {data.map((trace, index) => (
          <Card key={trace.id}>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2 leading-normal">
                {t.traces.turn(index + 1, data.length)}
                <RunStatusBadge status={trace.status} />
              </CardTitle>
              <CardDescription>
                {dateTime(trace.startedAt)} · {duration(trace.durationMs)} ·{" "}
                {trace.userName || trace.userEmail || "–"}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <Block label={d.input} text={trace.input} />
              <Block label={d.output} text={trace.output} />
              <div>
                <Button variant="outline" size="sm" onClick={() => go(`traces/t/${trace.id}`)}>
                  {t.traces.open}
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}

function BackBar({ to, title, id }: { to: string; title: string; id: string }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        variant="outline"
        size="sm"
        onClick={() => (history.length > 1 ? history.back() : go(to))}
      >
        <ArrowLeftIcon />
        {t.common.back}
      </Button>
      <h2 className="text-base font-medium">{title}</h2>
      <span className="font-mono text-xs text-muted-foreground">{id}</span>
    </div>
  );
}

function Block({ label, text }: { label: string; text: string }) {
  const { t } = useI18n();
  return (
    <div className="grid gap-1.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <pre className="max-h-72 overflow-auto rounded-lg border bg-muted px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
        {text || t.traces.detail.empty}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Level 2 and 3: one trace — its steps as a tree, and one step in detail
// ---------------------------------------------------------------------------

interface Node {
  span: Span;
  depth: number;
}

/** Orders spans as a tree: each parent followed by its children, earliest first. */
function flatten(spans: Span[]): Node[] {
  const children = new Map<string | null, Span[]>();
  for (const span of spans) {
    const list = children.get(span.parentId) ?? [];
    list.push(span);
    children.set(span.parentId, list);
  }
  const out: Node[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const span of (children.get(parent) ?? []).sort(
      (a, b) => a.startOffsetMs - b.startOffsetMs || a.seq - b.seq,
    )) {
      out.push({ span, depth });
      walk(span.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

function TraceDetail({ me, id, spanId }: { me: Me; id: string; spanId?: string }) {
  const { t, number, money, duration, dateTime } = useI18n();
  const { data, error, reload } = useLoad(() =>
    api<{ trace: Trace; spans: Span[]; annotations: Annotation[] }>(
      `/api/traces/${encodeURIComponent(id)}`,
    ),
  );
  const [selected, setSelected] = useState<string | undefined>(spanId);
  const nodes = useMemo(() => (data ? flatten(data.spans) : []), [data]);
  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <Loading />;
  const { trace, annotations } = data;
  const d = t.traces.detail;
  const current = nodes.find((node) => node.span.id === selected)?.span ?? nodes[0]?.span;
  const total = Math.max(1, trace.durationMs);
  const notesOn = (span: Span) =>
    annotations.filter((note) =>
      span.parentId === null
        ? note.spanId === null || note.spanId === span.id
        : note.spanId === span.id,
    ).length;
  const fact = (label: string, value: ReactNode) => (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-[13px] font-medium">{value}</dd>
    </div>
  );

  return (
    <>
      <BackBar to="traces" title={`${d.title} · ${trace.agentName}`} id={trace.id} />
      <Card>
        <CardContent className="grid gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <RunStatusBadge status={trace.status} />
            <LevelBadge level={trace.maxAction} named />
            <RiskBadge risk={trace.agentRisk} />
            <Badge variant="muted">{t.venue[trace.venue]}</Badge>
            <span className="text-sm text-muted-foreground">
              {trace.userName || trace.userEmail || "–"}
            </span>
          </div>
          <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-3 xl:grid-cols-6">
            {fact(d.started, <span className="num">{dateTime(trace.startedAt)}</span>)}
            {fact(d.duration, <span className="num">{duration(trace.durationMs)}</span>)}
            {fact(
              d.tokens,
              <span
                className="num"
                title={t.traces.tokenSplit(
                  number(trace.promptTokens),
                  number(trace.completionTokens),
                )}
              >
                {number(trace.promptTokens + trace.completionTokens)}
              </span>,
            )}
            {fact(d.cost, <span className="num">{money(trace.costMicros, 4)}</span>)}
            {fact(
              d.version,
              <span className="font-mono text-xs" title={trace.agentVersion}>
                {trace.agentVersion.slice(0, 12)}
              </span>,
            )}
            {fact(
              d.conversation,
              <button
                type="button"
                className="font-mono text-xs underline underline-offset-2"
                title={d.openConversation}
                onClick={() => go(`traces/c/${trace.conversationId}`)}
              >
                {trace.conversationId.slice(0, 13)}
              </button>,
            )}
          </dl>
        </CardContent>
      </Card>

      <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,6fr)_minmax(0,5fr)]">
        <Card className="overflow-hidden pb-2 dense:pb-2">
          <CardHeader>
            <CardTitle>
              {d.tree}{" "}
              <span className="num font-normal text-muted-foreground">· {nodes.length}</span>
            </CardTitle>
            <CardDescription>{d.treeLead}</CardDescription>
          </CardHeader>
          <ul>
            {nodes.map(({ span, depth }) => {
              const Icon = kindIcon[span.kind];
              const notes = notesOn(span);
              return (
                <li key={span.id}>
                  <button
                    type="button"
                    aria-current={current?.id === span.id ? "true" : undefined}
                    onClick={() => setSelected(span.id)}
                    className={cn(
                      "grid w-full grid-cols-[minmax(0,1fr)_auto_7rem] items-center gap-3 border-t px-3.5 py-2 text-left text-sm transition-colors hover:bg-muted/60 sm:grid-cols-[minmax(0,1fr)_auto_12rem]",
                      current?.id === span.id && "bg-accent hover:bg-accent",
                    )}
                  >
                    <span
                      className="flex min-w-0 items-center gap-2"
                      ref={(node) => {
                        if (node) node.style.paddingLeft = `${depth * 18}px`;
                      }}
                    >
                      <Icon className="size-4 shrink-0 text-muted-foreground" />
                      <span
                        className={cn(
                          "truncate",
                          span.kind === "agent" ? "font-medium" : "font-mono text-xs",
                        )}
                      >
                        {span.name}
                      </span>
                      {span.status !== "ok" && <SpanStatus status={span.status} />}
                      {notes > 0 && (
                        <span className="num inline-flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground">
                          <MessageSquareTextIcon className="size-3" />
                          {notes}
                        </span>
                      )}
                    </span>
                    <span className="num text-xs text-muted-foreground">
                      {duration(span.durationMs)}
                    </span>
                    <span
                      className="relative h-2 rounded-full bg-secondary"
                      title={`${d.offset} ${duration(span.startOffsetMs)}`}
                    >
                      <span
                        className={cn(
                          "absolute inset-y-0 min-w-0.5 rounded-full",
                          span.status === "error"
                            ? "bg-destructive"
                            : span.status === "blocked"
                              ? "bg-warn"
                              : "bg-[var(--series-1)]",
                        )}
                        ref={(node) => {
                          if (node) {
                            node.style.left = `${(span.startOffsetMs / total) * 100}%`;
                            node.style.width = `${Math.max(0.5, (span.durationMs / total) * 100)}%`;
                          }
                        }}
                      />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>

        {current && (
          <SpanPanel
            key={current.id}
            me={me}
            traceId={trace.id}
            span={current}
            notes={annotations.filter((note) =>
              current.parentId === null
                ? note.spanId === null || note.spanId === current.id
                : note.spanId === current.id,
            )}
            reload={reload}
          />
        )}
      </div>
    </>
  );
}

function SpanPanel({
  me,
  traceId,
  span,
  notes,
  reload,
}: {
  me: Me;
  traceId: string;
  span: Span;
  notes: Annotation[];
  reload: () => Promise<void>;
}) {
  const { t, number, money, duration } = useI18n();
  const d = t.traces.detail;
  const [tab, setTab] = useState("overview");
  const attributes = Object.entries(span.attributes).filter(
    ([, value]) => value !== null && value !== "",
  );
  const stat = (label: string, value: string) => (
    <div className="rounded-lg border px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="num text-[13px] font-medium">{value}</p>
    </div>
  );
  return (
    <Card className="xl:sticky xl:top-20">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 leading-normal">
          <KindBadge kind={span.kind} />
          <span className={span.kind === "agent" ? "" : "font-mono text-sm"}>{span.name}</span>
          <SpanStatus status={span.status} />
        </CardTitle>
        <CardDescription className="num">
          {duration(span.durationMs)} · {d.offset} {duration(span.startOffsetMs)}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="overview">{d.tabs.overview}</TabsTrigger>
            <TabsTrigger value="attributes">
              {d.tabs.attributes}
              <span className="num text-xs opacity-70">{attributes.length}</span>
            </TabsTrigger>
            <TabsTrigger value="annotations">
              {d.tabs.annotations}
              <span className="num text-xs opacity-70">{notes.length}</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {tab === "overview" && (
          <>
            {span.kind === "llm" && (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {stat(t.usage.columns.model, String(span.attributes.model ?? "–"))}
                {stat(d.promptTokens, number(span.promptTokens))}
                {stat(d.completionTokens, number(span.completionTokens))}
                {stat(d.cost, money(span.costMicros, 4))}
              </div>
            )}
            <Block label={d.input} text={span.input} />
            <Block label={d.output} text={span.output} />
            {span.events.length > 0 && (
              <div className="grid gap-1.5">
                <p className="text-xs font-medium text-muted-foreground">{d.events}</p>
                <ul className="grid gap-1.5">
                  {span.events.map((event) => (
                    <li
                      key={`${event.name}${event.atMs}`}
                      className="rounded-lg border border-destructive/30 bg-destructive/6 px-3 py-2 text-sm"
                    >
                      <span className="font-mono text-xs font-medium">{event.name}</span>
                      <span className="num text-xs text-muted-foreground">
                        {" "}
                        · {d.at(duration(event.atMs))}
                      </span>
                      <p className="text-destructive">{event.message}</p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}

        {tab === "attributes" &&
          (attributes.length === 0 ? (
            <Empty>{d.noAttributes}</Empty>
          ) : (
            <div className="-mx-5">
              <Table pinLast>
                <TableHeader>
                  <TableRow>
                    <TableHead>{d.attribute}</TableHead>
                    <TableHead>{d.value}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {attributes.map(([name, value]) => (
                    <TableRow key={name}>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {name}
                      </TableCell>
                      <TableCell className="max-w-72 font-mono text-xs break-all whitespace-normal">
                        {typeof value === "string" ? value : JSON.stringify(value)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ))}

        {tab === "annotations" && (
          <Notes me={me} traceId={traceId} span={span} notes={notes} reload={reload} />
        )}
      </CardContent>
    </Card>
  );
}

function Notes({
  me,
  traceId,
  span,
  notes,
  reload,
}: {
  me: Me;
  traceId: string;
  span: Span;
  notes: Annotation[];
  reload: () => Promise<void>;
}) {
  const { t, ago } = useI18n();
  const d = t.traces.detail;
  const [label, setLabel] = useState("");
  const [score, setScore] = useState("");
  const [note, setNote] = useState("");
  const action = useAction();
  const asking = useConfirm();
  const whole = span.parentId === null;
  const canWrite = me.permissions.includes("traces.annotate");
  return (
    <div className="grid gap-3">
      {notes.length === 0 ? (
        <p className="text-sm text-muted-foreground">{whole ? d.noNotesRun : d.noNotes}</p>
      ) : (
        <ul className="grid gap-2">
          {notes.map((item) => (
            <li key={item.id} className="grid gap-1 rounded-lg border px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">{item.label}</Badge>
                {item.score !== null && (
                  <span className="num text-xs text-muted-foreground">{item.score}</span>
                )}
                <span className="text-xs text-muted-foreground">
                  {item.authorName || item.authorEmail} · {ago(item.createdAt)}
                </span>
                {canWrite && (item.authorId === me.user.id || me.role === "owner") && (
                  <MoreMenu
                    className="ml-auto"
                    label={t.common.more}
                    items={[
                      {
                        label: d.removeNote,
                        destructive: true,
                        onSelect: () =>
                          void asking.confirm(d.removeNote, d.removeNoteConfirm).then((yes) =>
                            yes
                              ? action.run(async () => {
                                  await api(`/api/annotations/${item.id}`, { method: "DELETE" });
                                  await reload();
                                })
                              : undefined,
                          ),
                      },
                    ]}
                  />
                )}
              </div>
              {item.note && <p className="text-foreground/80">{item.note}</p>}
            </li>
          ))}
        </ul>
      )}
      {!canWrite ? (
        <Lead className="text-xs text-muted-foreground">{d.readOnly}</Lead>
      ) : (
        <form
          className="grid gap-3 border-t pt-2"
          onSubmit={(event) => {
            event.preventDefault();
            void action.run(async () => {
              await api(`/api/traces/${traceId}/annotations`, {
                method: "POST",
                body: {
                  spanId: whole ? null : span.id,
                  label,
                  score: score === "" ? null : Number(score),
                  note,
                },
              });
              setLabel("");
              setScore("");
              setNote("");
              await reload();
            });
          }}
        >
          <p className="text-[13px] font-medium">
            {d.addNote}{" "}
            <span className="font-normal text-muted-foreground">
              · {whole ? d.wholeRun : d.thisStep}
            </span>
          </p>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
            <div className="grid gap-1.5">
              <Label htmlFor="note-label">{d.label}</Label>
              <Input
                id="note-label"
                required
                maxLength={40}
                placeholder={d.labelPlaceholder}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="note-score">{d.score}</Label>
              <Input
                id="note-score"
                type="number"
                min={0}
                max={1}
                step={0.1}
                value={score}
                onChange={(event) => setScore(event.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="note-text">{d.note}</Label>
            <Textarea
              id="note-text"
              maxLength={2000}
              rows={2}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          {action.error && <p className="text-sm text-destructive">{action.error}</p>}
          <div>
            <Button type="submit" size="sm" disabled={!label.trim() || action.busy}>
              {d.add}
            </Button>
          </div>
        </form>
      )}
      {asking.dialog}
    </div>
  );
}
