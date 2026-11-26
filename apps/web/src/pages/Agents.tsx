import { ChevronRightIcon, CopyIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { go } from "@/App";
import { useConfirm } from "@/components/confirm";
import {
  Dot,
  Empty,
  Kpi,
  LevelBadge,
  Loading,
  Notice,
  RiskBadge,
  useAction,
  useLoad,
} from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Lead } from "@/components/ui/hint";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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
import { type Agent, api, type Level, type Me } from "@/lib/api";
import { address } from "@/lib/utils";

const stateVariant = {
  published: "ok",
  pending: "warn",
  suspended: "destructive",
  draft: "muted",
} as const;
type Decision = "approve" | "suspend" | "restore";
/** What an administrator can do with an agent in the state it is in; nothing for a draft or a deleted one. */
const decisionFor = (agent: Agent): Decision | null =>
  agent.deletedAt || agent.state === "draft"
    ? null
    : agent.state === "pending"
      ? "approve"
      : agent.state === "published"
        ? "suspend"
        : "restore";

function StateBadge({ agent }: { agent: Agent }) {
  const { t } = useI18n();
  return agent.deletedAt ? (
    <Badge variant="muted">{t.app.roster.deleted}</Badge>
  ) : (
    <Badge variant={stateVariant[agent.state]}>
      <Dot />
      {t.agents.state[agent.state]}
    </Badge>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] items-baseline gap-3 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/** Everything about one agent, and the decision an administrator can take on it, with what the decision does. */
/** The rest of what the organization knows about one agent. See GET /api/agents/:id/record. */
interface AgentRecord {
  createdAt: string;
  usage: { runs: number; tokens: number; costMicros: number; medianMs: number };
  people: { name: string; email: string; runs: number; lastRunAt: string }[] | null;
  approvals: { tool: string; status: string; count: number }[];
  conversations: number;
  runs:
    | {
        traceId: string;
        person: string | null;
        email: string | null;
        status: string;
        startedAt: string;
      }[]
    | null;
  events: { time: string; actorEmail: string; action: string }[] | null;
}

function AgentDetail({
  agent,
  levels,
  manages,
  busy,
  failure,
  onDecide,
  onClose,
}: {
  /** Why the last decision did not go through, shown where the decision was made. */
  failure: string | null;
  agent: Agent;
  levels: Record<string, Level>;
  manages: boolean;
  busy: boolean;
  onDecide(agent: Agent, decision: Decision): void;
  onClose(): void;
}) {
  const { t, number, ago, money, date, dateTime, duration } = useI18n();
  const a = t.agents;
  const d = a.detail;
  const [copied, setCopied] = useState(false);
  // The rest of what is known about it: who uses it, what it cost, what was decided.
  const record = useLoad(() => api<AgentRecord>(`/api/agents/${agent.id}/record`), [agent.id]);
  const more = record.data;
  const asked = new Map<string, number>();
  for (const row of more?.approvals ?? [])
    asked.set(row.status, (asked.get(row.status) ?? 0) + row.count);
  const mostRuns = Math.max(1, ...(more?.people?.map((row) => row.runs) ?? []));
  const decision = decisionFor(agent);
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="gap-0 sm:max-w-2xl">
        <SheetHeader className="border-b">
          <div className="flex flex-wrap items-center gap-2">
            <SheetTitle>{shownAgent(agent)}</SheetTitle>
            <StateBadge agent={agent} />
            <RiskBadge risk={agent.risk} />
          </div>
          <SheetDescription>
            {(t.app.described[agent.description] ?? agent.description) || d.noDescription}
          </SheetDescription>
        </SheetHeader>
        <div className="grid gap-3 p-3.5">
          {failure && <Notice tone="bad">{failure}</Notice>}
          {manages && decision && (
            <section className="glass grid gap-2 rounded-lg p-2.5">
              <p className="text-sm">{d.effect[decision]}</p>
              <div>
                <Button
                  size="sm"
                  variant={decision === "suspend" ? "destructive" : "default"}
                  disabled={busy}
                  onClick={() => onDecide(agent, decision)}
                >
                  {t.app.roster[decision]}
                </Button>
              </div>
            </section>
          )}
          <section>
            <h3 className="section-title pb-2">{d.can}</h3>
            {agent.tools.length === 0 ? (
              <p className="text-sm text-muted-foreground">{d.noTools}</p>
            ) : (
              <ul className="grid gap-1.5">
                {agent.tools.map((tool) => (
                  <li key={tool} className="flex items-center justify-between gap-3 text-sm">
                    <span>{t.app.toolSummary[tool] ?? tool}</span>
                    {levels[tool] && <LevelBadge level={levels[tool] as Level} named />}
                  </li>
                ))}
              </ul>
            )}
            <Lead className="pt-2 text-xs text-muted-foreground">{d.riskFrom}</Lead>
          </section>
          <section>
            <h3 className="section-title pb-2">{d.instructions}</h3>
            <p className="max-h-72 overflow-y-auto rounded-md bg-foreground/5 p-2.5 text-sm whitespace-pre-wrap">
              {agent.instructions || d.noInstructions}
            </p>
          </section>
          <section>
            <h3 className="section-title pb-2">{d.use}</h3>
            <div className="grid grid-cols-4 gap-2">
              {(
                [
                  [d.runs, agent.runs, false],
                  [d.people, agent.users, false],
                  [d.failed, agent.errors, agent.errors > 0],
                  [d.blocked, agent.blocked, false],
                ] as const
              ).map(([label, value, bad]) => (
                <div key={label} className="rounded-md bg-foreground/5 px-3 py-2">
                  <div className="text-xs text-muted-foreground">{label}</div>
                  <div className={`num text-lg font-semibold ${bad ? "text-destructive" : ""}`}>
                    {number(value)}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between pt-2 text-sm">
              <span className="text-muted-foreground">
                {agent.lastRunAt ? d.lastRun(ago(agent.lastRunAt)) : d.neverRun}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => go(`traces?agent=${agent.id}&range=30d`)}
              >
                {d.seeRuns}
              </Button>
            </div>
          </section>
          {more && (
            <>
              <section className="grid gap-2">
                <h3 className="section-title">{d.month}</h3>
                <div className="grid grid-cols-4 gap-2">
                  {(
                    [
                      [d.runs, number(more.usage.runs)],
                      [d.cost, money(more.usage.costMicros)],
                      [d.tokens, number(more.usage.tokens)],
                      [d.median, more.usage.runs ? duration(more.usage.medianMs) : "–"],
                    ] as const
                  ).map(([label, value]) => (
                    <div key={label} className="rounded-md bg-foreground/5 px-3 py-2">
                      <div className="text-xs text-muted-foreground">{label}</div>
                      <div className="num text-lg font-semibold">{value}</div>
                    </div>
                  ))}
                </div>
                <p className="text-sm text-muted-foreground">
                  {d.conversations(number(more.conversations))} ·{" "}
                  {d.asked(
                    asked.get("approved") ?? 0,
                    asked.get("rejected") ?? 0,
                    (asked.get("expired") ?? 0) + (asked.get("pending") ?? 0),
                  )}
                </p>
              </section>
              {more.people && (
                <section className="grid gap-2">
                  <h3 className="section-title">{d.who}</h3>
                  {more.people.length === 0 ? (
                    <Lead className="text-sm text-muted-foreground">{d.nobody}</Lead>
                  ) : (
                    <ul className="grid gap-1.5">
                      {more.people.map((person) => (
                        <li
                          key={person.email}
                          className="grid grid-cols-[11rem_1fr_auto] items-center gap-3 text-sm"
                          title={address(person.email) || undefined}
                        >
                          <span className="truncate">{person.name || person.email}</span>
                          <span
                            className="h-1.5 overflow-hidden rounded-full bg-muted"
                            aria-hidden="true"
                          >
                            <span
                              className="block h-full rounded-full bg-brand"
                              style={{ width: `${(person.runs / mostRuns) * 100}%` }}
                            />
                          </span>
                          <span className="num text-muted-foreground">
                            {d.runsCount(number(person.runs))} · {ago(person.lastRunAt)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}
              {more.runs && more.runs.length > 0 && (
                <section className="grid gap-2">
                  <h3 className="section-title">{d.latest}</h3>
                  <ul className="divide-y rounded-lg border">
                    {more.runs.map((run) => (
                      <li key={run.traceId}>
                        <button
                          type="button"
                          className="flex w-full items-center gap-3 px-3 py-1.5 text-left text-sm hover:bg-accent"
                          onClick={() => go(`traces/t/${run.traceId}`)}
                        >
                          <span className="w-32 shrink-0 text-muted-foreground">
                            {dateTime(run.startedAt)}
                          </span>
                          <span className="min-w-0 flex-1 truncate">
                            {run.person || run.email || t.common.unknown}
                          </span>
                          <Badge
                            variant={
                              run.status === "ok"
                                ? "ok"
                                : run.status === "error"
                                  ? "destructive"
                                  : run.status === "stopped"
                                    ? "muted"
                                    : "warn"
                            }
                          >
                            {t.runStatus[run.status] ?? run.status}
                          </Badge>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {more.events && more.events.length > 0 && (
                <section className="grid gap-2">
                  <h3 className="section-title">{d.history}</h3>
                  <ul className="grid gap-1 text-sm">
                    {more.events.map((event, index) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list read once
                      <li key={index} className="flex gap-3">
                        <span className="w-32 shrink-0 text-muted-foreground">
                          {dateTime(event.time)}
                        </span>
                        <span className="min-w-0 flex-1">
                          {t.events[event.action] ?? event.action}
                          <span className="text-muted-foreground"> · {event.actorEmail}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
          <section>
            <h3 className="section-title pb-1">{d.record}</h3>
            <dl>
              <Field label={a.columns.owner}>
                {agent.ownerName || agent.ownerEmail || a.platformOwner}
                {agent.ownerName && agent.ownerEmail && (
                  <span className="text-muted-foreground"> · {agent.ownerEmail}</span>
                )}
              </Field>
              <Field label={a.columns.source}>{d.sourceMeans[agent.source]}</Field>
              {more && <Field label={d.created}>{date(more.createdAt)}</Field>}
              <Field label={a.columns.model}>
                <span className="font-mono text-xs">{agent.model}</span>
              </Field>
              <Field label="ID">
                <span className="font-mono text-xs">{agent.id}</span>
                <button
                  type="button"
                  className="ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    void navigator.clipboard.writeText(agent.id).then(() => setCopied(true));
                  }}
                >
                  <CopyIcon className="size-3" />
                  {copied ? t.common.copied : t.common.copy}
                </button>
              </Field>
              <Field label={a.columns.version}>
                <span className="font-mono text-xs" title={agent.version}>
                  {agent.version.slice(0, 12)}
                </span>
                <Lead as="span" className="block text-xs text-muted-foreground">
                  {d.versionMeans}
                </Lead>
              </Field>
            </dl>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function AgentsPage({ me }: { me: Me }) {
  const { t, number, ago } = useI18n();
  const { data, error, reload } = useLoad(() => api<Agent[]>("/api/agents"));
  const { data: tools } = useLoad(() => api<{ name: string; level: Level }[]>("/api/app/tools"));
  const { busy, error: failure, run } = useAction();
  const { confirm, dialog } = useConfirm();
  const manages = me.permissions.includes("agents.manage");
  const [query, setQuery] = useState("");
  const [show, setShow] = useState("all");
  const [open, setOpen] = useState<string | null>(null);
  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <Loading />;
  const a = t.agents;
  const levels = Object.fromEntries((tools ?? []).map((tool) => [tool.name, tool.level]));
  /** Approves a waiting agent, suspends a running one, or restores a suspended one, after the administrator confirms. */
  const decide = async (agent: Agent, decision: Decision) => {
    if (
      !(await confirm(`${t.app.roster[decision]}: ${shownAgent(agent)}`, a.detail.effect[decision]))
    )
      return;
    await run(async () => {
      // The decision is about the version on screen; the server refuses it if the agent has changed since.
      await api(`/api/agents/${agent.id}`, {
        method: "PATCH",
        body: { state: decision === "suspend" ? "suspended" : "published", version: agent.version },
      }).finally(reload);
    });
  };
  const needle = query.trim().toLowerCase();
  const filters: Record<string, (agent: Agent) => boolean> = {
    all: () => true,
    pending: (x) => x.state === "pending" && !x.deletedAt,
    high: (x) => x.risk === "R3" || x.risk === "R4",
    suspended: (x) => x.state === "suspended" && !x.deletedAt,
    failing: (x) => x.errors > 0,
  };
  const rows = data.filter(
    (agent) =>
      (!needle ||
        `${agent.name} ${shownAgent(agent)} ${agent.description} ${agent.ownerName ?? ""} ${agent.ownerEmail ?? ""}`
          .toLowerCase()
          .includes(needle)) &&
      (filters[show] ?? filters.all)?.(agent),
  );
  const count = (test: (agent: Agent) => boolean) => data.filter(test).length;
  const sum = (pick: (agent: Agent) => number) =>
    data.reduce((total, agent) => total + pick(agent), 0);
  const opened = data.find((agent) => agent.id === open);

  return (
    <>
      {dialog}
      {opened && (
        <AgentDetail
          agent={opened}
          levels={levels}
          manages={manages}
          busy={busy}
          failure={failure}
          onDecide={(agent, decision) => void decide(agent, decision)}
          onClose={() => setOpen(null)}
        />
      )}
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label={a.kpi.total}
          value={number(data.length)}
          hint={a.bySource(
            count((x) => x.source === "platform"),
            count((x) => x.source === "org"),
            count((x) => x.source === "user"),
          )}
        />
        <Kpi
          label={a.kpi.pending}
          value={number(count(filters.pending as (agent: Agent) => boolean))}
          tone={count(filters.pending as (agent: Agent) => boolean) > 0 ? "warn" : undefined}
          hint={a.kpiHint.pending}
        />
        <Kpi
          label={a.kpi.high}
          value={number(count(filters.high as (agent: Agent) => boolean))}
          hint={a.kpiHint.high}
        />
        <Kpi
          label={a.kpi.runs}
          value={number(sum((x) => x.runs))}
          hint={a.kpiHint.runs(
            sum((x) => x.errors),
            sum((x) => x.blocked),
          )}
        />
      </section>
      <Card className="overflow-hidden pb-0 dense:pb-0">
        <CardHeader>
          <CardTitle>{a.title}</CardTitle>
          <CardDescription>{a.lead}</CardDescription>
        </CardHeader>
        <div className="flex flex-wrap items-center gap-3 px-3.5">
          <Input
            className="sm:w-72"
            placeholder={a.search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Tabs value={show} onValueChange={setShow}>
            <TabsList>
              {Object.keys(filters).map((key) => (
                <TabsTrigger key={key} value={key}>
                  {a.show[key as keyof typeof a.show]}
                  <span className="num pl-1.5 text-muted-foreground">
                    {count(filters[key] as (agent: Agent) => boolean)}
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
        {failure && (
          <div className="px-3.5 pb-3">
            <Notice tone="bad">{failure}</Notice>
          </div>
        )}
        {rows.length === 0 ? (
          <Empty>{data.length === 0 ? a.none : a.noMatch}</Empty>
        ) : (
          <Table pinLast>
            <TableHeader>
              <TableRow>
                <TableHead>{a.columns.agent}</TableHead>
                <TableHead>{a.columns.owner}</TableHead>
                <TableHead>{a.columns.risk}</TableHead>
                <TableHead>{a.columns.state}</TableHead>
                <TableHead>{a.columns.week}</TableHead>
                <TableHead>{a.columns.last}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((agent) => {
                const decision = decisionFor(agent);
                return (
                  <TableRow
                    key={agent.id}
                    className="cursor-pointer"
                    onClick={() => setOpen(agent.id)}
                  >
                    <TableCell>
                      <button
                        type="button"
                        className="grid max-w-[34rem] text-left"
                        aria-label={a.detail.open(shownAgent(agent))}
                      >
                        <span className="font-medium">{shownAgent(agent)}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {t.app.described[agent.description] ?? agent.description}
                        </span>
                      </button>
                    </TableCell>
                    <TableCell>
                      <div className="grid">
                        <span>{agent.ownerName || agent.ownerEmail || a.platformOwner}</span>
                        <span className="text-xs text-muted-foreground">
                          {a.source[agent.source]}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <RiskBadge risk={agent.risk} />
                    </TableCell>
                    <TableCell>
                      <StateBadge agent={agent} />
                    </TableCell>
                    <TableCell className="num">
                      {a.weekCell(agent.runs, agent.users)}
                      {agent.errors > 0 && (
                        <span className="block text-xs text-destructive">
                          {a.failedCell(agent.errors)}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{ago(agent.lastRunAt)}</TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-2">
                        {manages && decision && (
                          <Button
                            variant={decision === "approve" ? "default" : "outline"}
                            size="sm"
                            disabled={busy}
                            aria-label={`${t.app.roster[decision]}: ${shownAgent(agent)}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              void decide(agent, decision);
                            }}
                          >
                            {t.app.roster[decision]}
                          </Button>
                        )}
                        <ChevronRightIcon className="size-4 text-muted-foreground" />
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>
    </>
  );
}
