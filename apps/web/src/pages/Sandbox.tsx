import { PlusIcon, XIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import {
  Empty,
  Loading,
  Notice,
  Person,
  SettingRow,
  useAction,
  useLoad,
} from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Hint, Lead } from "@/components/ui/hint";
import { Input, Label } from "@/components/ui/input";
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
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  capOf,
  capText,
  cpuTime,
  idleOnes,
  keptFor,
  releasedIn,
  runningFor,
  sorted,
  type Workspace,
  whole,
} from "./sandboxLogic";

const RANGES = ["24h", "7d", "30d", "90d"] as const;
type Range = (typeof RANGES)[number];
/** How often what is running is asked again while the page is in sight. */
const LIVE_MS = 4000;
/** "Release all idle" releases what nobody has used for this many days. */
const IDLE_DAYS = 1;

interface Allowance {
  runs: number;
  cpuSeconds: number;
}
interface Overview {
  canManage: boolean;
  configured: boolean;
  state: null | {
    ready: boolean;
    isolation: "gvisor" | "container" | null;
    reason: string;
    running: number;
    runtime: string | null;
    image: string | null;
    waiting: number;
    slots: number | null;
    built: string | null;
    disk: { free: number; total: number } | null;
    limits: null | {
      seconds: number;
      maxSeconds: number;
      cpus: number;
      memory: string;
      spaceBytes: number;
      diskBytes: number;
    };
  };
  workspaces: { count: number; bytes: number };
  settings: { idleDays: number; totalBytes: number | null };
  reclaim: {
    on: boolean;
    hold: boolean;
    lastAt: string | null;
    nextAt: string | null;
    last: { released: number; bytes: number } | null;
  };
  limits: {
    server: Allowance;
    everyone: Allowance | null;
    rows: (Allowance & { kind: "department" | "person"; id: string; name: string })[];
  };
  departments: { id: string; name: string }[];
  people: { id: string; name: string; email: string }[];
}
interface Flight {
  conversation: string;
  title: string;
  person: { name: string; email: string };
  agent: string | null;
  language: string;
  state: "waiting" | "running";
  askedAt: string;
  startedAt: string | null;
  seconds: number;
  printed: number | null;
  connections: number | null;
  traceId: string | null;
}
interface RunRow {
  id: string;
  startedAt: string;
  ending: string;
  seconds: number;
  cpuSeconds: number;
  peakKb: number | null;
  printed: number;
  netUp: number;
  netDown: number;
  refused: number;
  traceId: string | null;
  title: string;
  agent: string | null;
  person: { name: string; email: string };
}
interface Runs {
  page: number;
  size: number;
  total: number;
  people: { id: string; name: string; email: string }[];
  rows: RunRow[];
}
interface Network {
  reached: { host: string; allowed: number; refused: number; up: number; down: number }[];
}
interface Hosts {
  hosts: string[];
  own: boolean;
  defaults: string[];
  most: number;
  canManage: boolean;
}

const select = "h-7 max-w-44 shrink-0 rounded-md border bg-transparent px-1.5 text-xs";
const traceOf = (id: string) => `#/admin/traces/t/${id}`;

/** A card's name with what more there is to know behind a mark. */
function Title({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <CardTitle className="flex items-center gap-1.5">
      {children}
      {hint && <Hint>{hint}</Hint>}
    </CardTitle>
  );
}

/** Asked once more before something that cannot be taken back. */
function Confirm({
  title,
  lead,
  action,
  onClose,
  run,
}: {
  title: string;
  lead: string;
  action: string;
  onClose(): void;
  run(): Promise<void>;
}) {
  const { t } = useI18n();
  const doing = useAction();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{lead}</DialogDescription>
        </DialogHeader>
        {doing.error && <Notice tone="bad">{doing.error}</Notice>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button
            variant="destructive"
            disabled={doing.busy}
            onClick={() =>
              void doing.run(async () => {
                await run();
                onClose();
              })
            }
          >
            {action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Admin console → Sandbox: where agents' code runs, and everything an administrator does about it. */
export function SandboxPage() {
  const { t } = useI18n();
  const s = t.sandbox;
  const [range, setRange] = useState<Range>("7d");
  const { data, error, reload } = useLoad(() => api<Overview>("/api/sandbox/overview"));
  // What runs changed (one began, ended or was stopped): the counts, the workspaces and
  // the record are read again, so the page does not go on saying "running" of a run that
  // is over (seen trying the page, 2026-11-24).
  const [beat, setBeat] = useState(0);
  const moved = () => {
    setBeat((now) => now + 1);
    void reload();
  };
  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <Loading />;
  if (!data.configured) return <Notice>{s.off}</Notice>;
  return (
    <>
      <div className="grid items-start gap-3 lg:grid-cols-2 2xl:grid-cols-3">
        <StateCard data={data} />
        <ReclaimCard data={data} onChanged={reload} />
        <LimitsCard data={data} onChanged={reload} />
      </div>
      <LiveCard canManage={data.canManage} onMoved={moved} />
      <WorkspacesCard key={`w${beat}`} data={data} onChanged={reload} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Lead className="text-sm text-muted-foreground">{s.lead}</Lead>
        <Tabs value={range} onValueChange={(value) => setRange(value as Range)}>
          <TabsList>
            {RANGES.map((one) => (
              <TabsTrigger key={one} value={one}>
                {t.ranges[one]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      <RunsCard key={`r${beat}`} range={range} />
      <NetworkCard key={`n${beat}`} range={range} />
    </>
  );
}

function StateCard({ data }: { data: Overview }) {
  const { t, number, ago } = useI18n();
  const s = t.sandbox.state;
  const state = data.state;
  const size = t.files.size;
  return (
    <Card>
      <CardHeader>
        <Title hint={s.hint}>{s.title}</Title>
      </CardHeader>
      <CardContent>
        <SettingRow label={s.status} lead={state?.ready ? null : (state?.reason ?? s.unreachable)}>
          {state?.ready ? (
            <Badge variant={state.isolation === "gvisor" ? "ok" : "warn"}>
              {s.ready} · {state.isolation === "gvisor" ? s.gvisor : s.container}
            </Badge>
          ) : (
            <Badge variant="muted">{s.notReady}</Badge>
          )}
        </SettingRow>
        <SettingRow label={s.image}>
          {state?.image ? (
            <span>
              <span className="font-mono text-xs">{state.image.split(":").pop()}</span>
              {state.built && (
                <span className="text-muted-foreground"> · {s.built(ago(state.built))}</span>
              )}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </SettingRow>
        <SettingRow label={s.running}>
          <span className="num">
            {state ? s.runningOf(number(state.running), state.slots, number(state.waiting)) : "—"}
          </span>
        </SettingRow>
        <SettingRow label={s.workspaces}>
          <span className="num">
            {s.workspacesOf(
              number(data.workspaces.count),
              size(data.workspaces.bytes),
              data.settings.totalBytes === null ? null : size(data.settings.totalBytes),
            )}
          </span>
        </SettingRow>
        <SettingRow label={s.disk}>
          <span className="num">
            {state?.disk ? s.diskOf(size(state.disk.free), size(state.disk.total)) : "—"}
          </span>
        </SettingRow>
      </CardContent>
    </Card>
  );
}

function ReclaimCard({ data, onChanged }: { data: Overview; onChanged(): Promise<void> }) {
  const { t, ago, dateTime, number } = useI18n();
  const s = t.sandbox.reclaim;
  const [days, setDays] = useState(String(data.settings.idleDays));
  const [cap, setCap] = useState(capText(data.settings.totalBytes));
  const action = useAction();
  const idleDays = whole(days, 90);
  const totalBytes = capOf(cap);
  const valid = idleDays !== null && idleDays >= 1 && totalBytes !== undefined;
  const changed =
    days.trim() !== String(data.settings.idleDays) ||
    cap.trim() !== capText(data.settings.totalBytes);
  const save = () =>
    action.run(async () => {
      await api("/api/sandbox/settings", { method: "PUT", body: { idleDays, totalBytes } });
      await onChanged();
    });
  const fixed = data.state?.limits;
  return (
    <Card>
      <CardHeader>
        <Title hint={s.hint}>{s.title}</Title>
        {data.canManage && changed && (
          <CardAction>
            <Button size="sm" disabled={!valid || action.busy} onClick={() => void save()}>
              {t.common.save}
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        <SettingRow
          label={s.after}
          below={
            (changed && !valid && <p className="pb-1.5 text-xs text-destructive">{s.invalid}</p>) ||
            (action.error && <Notice tone="bad">{action.error}</Notice>)
          }
        >
          <Input
            aria-label={s.after}
            inputMode="numeric"
            className="num h-7 w-14 text-right"
            value={days}
            disabled={!data.canManage}
            onChange={(event) => setDays(event.target.value)}
          />
          <span className="text-muted-foreground">{s.afterUnit}</span>
        </SettingRow>
        <SettingRow label={s.cap}>
          <Input
            aria-label={s.cap}
            inputMode="decimal"
            className="num h-7 w-16 text-right"
            value={cap}
            placeholder={s.capNone}
            disabled={!data.canManage}
            onChange={(event) => setCap(event.target.value)}
          />
          <span className="text-muted-foreground">GB</span>
        </SettingRow>
        {fixed && (
          <SettingRow label={s.one}>
            <span className="num text-muted-foreground">
              {t.files.size(fixed.spaceBytes)} · {s.fixed}
            </span>
          </SettingRow>
        )}
        <SettingRow label={s.last} lead={data.reclaim.hold ? s.hold : !data.reclaim.on && s.off}>
          <span className="num">
            {data.reclaim.lastAt
              ? data.reclaim.last
                ? s.lastOf(
                    ago(data.reclaim.lastAt),
                    number(data.reclaim.last.released),
                    t.files.size(data.reclaim.last.bytes),
                  )
                : ago(data.reclaim.lastAt)
              : s.never}
          </span>
        </SettingRow>
        <SettingRow label={s.next}>
          <span className="num">
            {data.reclaim.nextAt ? dateTime(data.reclaim.nextAt) : s.never}
          </span>
        </SettingRow>
      </CardContent>
    </Card>
  );
}

/** Whose allowance is being set: one there is, or a new one for a department or a person. */
type Editing =
  | { kind: "everyone"; id?: undefined; label: string; own: Allowance | null }
  | { kind: "department" | "person"; id: string; label: string; own: Allowance }
  | { kind: "new" };

function LimitEditor({
  editing,
  data,
  onClose,
}: {
  editing: Editing;
  data: Overview;
  onClose(changed: boolean): void;
}) {
  const { t } = useI18n();
  const s = t.sandbox.limits;
  const own = editing.kind === "new" ? null : editing.own;
  const [kind, setKind] = useState<"department" | "person">(
    data.departments.length ? "department" : "person",
  );
  const [subject, setSubject] = useState("");
  const [runs, setRuns] = useState(own ? String(own.runs) : "");
  const [minutes, setMinutes] = useState(own ? String(Math.round(own.cpuSeconds / 60)) : "");
  const action = useAction();
  const runsN = whole(runs, 100_000);
  const minutesN = whole(minutes, 16_000);
  const target = editing.kind === "new" ? { kind, id: subject } : editing;
  const ready = runsN !== null && minutesN !== null && (target.kind === "everyone" || !!target.id);
  const put = () =>
    action.run(async () => {
      await api("/api/sandbox/limits", {
        method: "PUT",
        body: {
          kind: target.kind,
          ...(target.kind === "everyone" ? {} : { id: target.id }),
          runs: runsN,
          cpuSeconds: (minutesN as number) * 60,
        },
      });
      onClose(true);
    });
  const remove = () =>
    action.run(async () => {
      await api(
        `/api/sandbox/limits/${target.kind}${target.kind === "everyone" ? "" : `/${target.id}`}`,
        { method: "DELETE" },
      );
      onClose(true);
    });
  const options = kind === "department" ? data.departments : data.people;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose(false)}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{editing.kind === "new" ? s.add : s.editTitle(editing.label)}</DialogTitle>
          <DialogDescription>{s.editLead}</DialogDescription>
        </DialogHeader>
        {editing.kind === "new" && (
          <div className="flex gap-2">
            <select
              aria-label={s.who}
              className={cn(select, "h-9 max-w-none")}
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as "department" | "person");
                setSubject("");
              }}
            >
              <option value="department">{s.department}</option>
              <option value="person">{s.person}</option>
            </select>
            <select
              aria-label={kind === "department" ? s.department : s.person}
              className={cn(select, "h-9 max-w-none min-w-0 flex-1")}
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
            >
              <option value="">—</option>
              {options.map((one) => (
                <option key={one.id} value={one.id}>
                  {"email" in one ? one.name || (one.email as string) : one.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1.5">
            <Label>{s.runs}</Label>
            <Input
              autoFocus
              inputMode="numeric"
              className="num"
              value={runs}
              onChange={(event) => setRuns(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>{s.cpu}</Label>
            <Input
              inputMode="numeric"
              className="num"
              value={minutes}
              onChange={(event) => setMinutes(event.target.value)}
            />
          </div>
        </div>
        {action.error && <Notice tone="bad">{action.error}</Notice>}
        <DialogFooter className="sm:justify-between">
          {own ? (
            <Button variant="ghost" disabled={action.busy} onClick={() => void remove()}>
              {s.remove}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onClose(false)}>
              {t.common.cancel}
            </Button>
            <Button disabled={!ready || action.busy} onClick={() => void put()}>
              {t.common.save}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LimitsCard({ data, onChanged }: { data: Overview; onChanged(): Promise<void> }) {
  const { t, number } = useI18n();
  const s = t.sandbox.limits;
  const [editing, setEditing] = useState<Editing | null>(null);
  const said = (one: Allowance) =>
    s.value(
      one.runs > 0 ? number(one.runs) : "∞",
      one.cpuSeconds > 0 ? number(Math.round(one.cpuSeconds / 60)) : "∞",
    );
  const everyone = data.limits.everyone;
  const fixed = data.state?.limits;
  const edit = (to: Editing, own: boolean) =>
    data.canManage && (
      <Button size="sm" variant="ghost" onClick={() => setEditing(to)}>
        {own ? s.change : s.set}
      </Button>
    );
  return (
    <Card>
      <CardHeader>
        <Title hint={s.hint}>{s.title}</Title>
        {data.canManage && (
          <CardAction>
            <Button size="sm" variant="outline" onClick={() => setEditing({ kind: "new" })}>
              <PlusIcon />
              {s.add}
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        <SettingRow label={s.everyone} lead={everyone ? null : s.fromServer}>
          <span className="num">{said(everyone ?? data.limits.server)}</span>
          {edit({ kind: "everyone", label: s.everyone, own: everyone }, everyone !== null)}
        </SettingRow>
        {data.limits.rows.map((row) => (
          <SettingRow
            key={`${row.kind}:${row.id}`}
            label={row.name}
            lead={row.kind === "department" ? s.department : s.person}
          >
            <span className="num">{said(row)}</span>
            {edit({ kind: row.kind, id: row.id, label: row.name, own: row }, true)}
          </SettingRow>
        ))}
        {fixed && (
          <>
            <SettingRow label={s.perRun}>
              <span className="num text-muted-foreground">
                {s.perRunOf(fixed.seconds, fixed.maxSeconds)} · {s.fixed}
              </span>
            </SettingRow>
            {data.state?.slots != null && (
              <SettingRow label={s.atOnce}>
                <span className="num text-muted-foreground">
                  {data.state.slots} · {s.fixed}
                </span>
              </SettingRow>
            )}
          </>
        )}
      </CardContent>
      {editing && (
        <LimitEditor
          editing={editing}
          data={data}
          onClose={(changed) => {
            setEditing(null);
            if (changed) void onChanged();
          }}
        />
      )}
    </Card>
  );
}

function LiveCard({ canManage, onMoved }: { canManage: boolean; onMoved(): void }) {
  const { t, number, ago, duration } = useI18n();
  const s = t.sandbox.live;
  const { data, error, reload } = useLoad(() =>
    api<{ live: boolean; runs: Flight[] }>("/api/sandbox/running"),
  );
  const [stopping, setStopping] = useState<Flight | null>(null);
  // Asked again every few seconds, and only while someone can see the answer.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) void reload();
    }, LIVE_MS);
    return () => clearInterval(timer);
  }, [reload]);
  const runs = data?.runs ?? [];
  // Which runs these are, not how far each has got: it changes when one begins or ends.
  const which = data
    ? runs.map((run) => `${run.conversation}:${run.askedAt}:${run.state}`).join("|")
    : null;
  const [seen, setSeen] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: told once per change of the list
  useEffect(() => {
    if (which === null) return;
    if (seen !== null && seen !== which) onMoved();
    setSeen(which);
  }, [which]);
  return (
    <Card className="overflow-hidden pb-0 dense:pb-0">
      <CardHeader>
        <Title hint={data && !data.live ? s.notLive : undefined}>
          {s.title}
          <span className="num pl-1 text-[13px] font-normal text-muted-foreground">
            {number(runs.length)}
          </span>
        </Title>
      </CardHeader>
      {error ? (
        <Empty>{error}</Empty>
      ) : runs.length === 0 ? (
        <Empty>{s.none}</Empty>
      ) : (
        <Table pinLast>
          <TableHeader>
            <TableRow>
              <TableHead>{s.person}</TableHead>
              <TableHead>{s.agent}</TableHead>
              <TableHead>{s.conversation}</TableHead>
              <TableHead>{s.language}</TableHead>
              <TableHead>{s.started}</TableHead>
              <TableHead className="text-right">{s.runningFor}</TableHead>
              <TableHead className="text-right">{s.limit}</TableHead>
              <TableHead className="text-right">{s.printed}</TableHead>
              <TableHead className="text-right">{s.connections}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => (
              <TableRow key={`${run.conversation}:${run.askedAt}`}>
                <TableCell>
                  <Person name={run.person.name} email={run.person.email} />
                </TableCell>
                <TableCell>{run.agent ? run.agent : "—"}</TableCell>
                <TableCell className="max-w-64 truncate">
                  {run.traceId ? (
                    <a className="underline-offset-2 hover:underline" href={traceOf(run.traceId)}>
                      {run.title || s.untitled}
                    </a>
                  ) : (
                    run.title || s.untitled
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs">{run.language}</TableCell>
                <TableCell className="text-muted-foreground">
                  {run.startedAt ? ago(run.startedAt) : s.waiting}
                </TableCell>
                <TableCell className="num text-right">
                  {run.startedAt ? duration(runningFor(run.startedAt) * 1000) : "—"}
                </TableCell>
                <TableCell className="num text-right">{duration(run.seconds * 1000)}</TableCell>
                <TableCell className="num text-right">
                  {run.printed === null ? "—" : t.files.size(run.printed)}
                </TableCell>
                <TableCell className="num text-right">
                  {run.connections === null ? "—" : number(run.connections)}
                </TableCell>
                <TableCell className="text-right">
                  {canManage && (
                    <Button size="sm" variant="ghost" onClick={() => setStopping(run)}>
                      {s.stop}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {stopping && (
        <Confirm
          title={s.stopTitle}
          lead={s.stopLead(stopping.person.name || stopping.person.email)}
          action={s.stop}
          onClose={() => {
            setStopping(null);
            void reload();
          }}
          run={() =>
            api(`/api/sandbox/running/${stopping.conversation}/stop`, { method: "POST" }).then(
              () => undefined,
            )
          }
        />
      )}
    </Card>
  );
}

function WorkspacesCard({ data, onChanged }: { data: Overview; onChanged(): Promise<void> }) {
  const { t, number, ago } = useI18n();
  const s = t.sandbox.spaces;
  const size = t.files.size;
  const list = useLoad(() =>
    api<{ available: boolean; workspaces: Workspace[] }>("/api/sandbox/workspaces"),
  );
  const [by, setBy] = useState<"used" | "size">("used");
  const [releasing, setReleasing] = useState<Workspace | "idle" | null>(null);
  const all = list.data?.workspaces ?? [];
  const idle = idleOnes(all, IDLE_DAYS);
  const done = () => {
    setReleasing(null);
    void list.reload();
    void onChanged();
  };
  const head = (key: "used" | "size", label: string) => (
    <TableHead className="text-right">
      <button
        type="button"
        aria-pressed={by === key}
        onClick={() => setBy(key)}
        className={cn("hover:text-foreground", by === key && "text-foreground underline")}
      >
        {label}
      </button>
    </TableHead>
  );
  return (
    <Card className="overflow-hidden pb-0 dense:pb-0">
      <CardHeader>
        <Title hint={s.hint}>
          {s.title}
          <span className="num pl-1 text-[13px] font-normal text-muted-foreground">
            {s.total(number(all.length), size(all.reduce((sum, one) => sum + one.bytes, 0)))}
          </span>
        </Title>
        {data.canManage && idle.ones.length > 0 && (
          <CardAction>
            <Button size="sm" variant="outline" onClick={() => setReleasing("idle")}>
              {s.releaseAll}
            </Button>
          </CardAction>
        )}
      </CardHeader>
      {list.error ? (
        <Empty>{list.error}</Empty>
      ) : list.data && !list.data.available ? (
        <Empty>{s.unavailable}</Empty>
      ) : all.length === 0 ? (
        <Empty>{s.none}</Empty>
      ) : (
        <Table pinLast>
          <TableHeader>
            <TableRow>
              <TableHead>{s.person}</TableHead>
              <TableHead>{s.conversation}</TableHead>
              <TableHead>{s.repository}</TableHead>
              <TableHead className="text-right">{s.files}</TableHead>
              {head("size", s.size)}
              {head("used", s.used)}
              <TableHead>{s.releasedIn}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted(all, by).map((one) => {
              const kept = keptFor(one);
              const left = releasedIn(one.usedAt, data.settings.idleDays);
              return (
                <TableRow key={one.conversation}>
                  <TableCell>
                    <Person name={one.person.name} email={one.person.email} />
                  </TableCell>
                  <TableCell className="max-w-64 truncate">{one.title || s.untitled}</TableCell>
                  <TableCell className="font-mono text-xs">{one.repository ?? "—"}</TableCell>
                  <TableCell className="num text-right">{number(one.files)}</TableCell>
                  <TableCell className="num text-right">{size(one.bytes)}</TableCell>
                  <TableCell className="num text-right text-muted-foreground">
                    {ago(one.usedAt)}
                  </TableCell>
                  <TableCell>
                    {kept ? (
                      <Badge variant={kept === "running" ? "ok" : "warn"}>{s.kept[kept]}</Badge>
                    ) : data.reclaim.hold ? (
                      <Badge variant="muted">{s.hold}</Badge>
                    ) : (
                      <span className="num">{left === 0 ? s.due : s.days(left)}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {data.canManage && !kept && (
                      <Button size="sm" variant="ghost" onClick={() => setReleasing(one)}>
                        {s.release}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      {releasing === "idle" ? (
        <Confirm
          title={s.releaseAllTitle(number(idle.ones.length), size(idle.bytes))}
          lead={s.releaseAllLead}
          action={s.release}
          onClose={done}
          run={() =>
            api("/api/sandbox/workspaces/release-idle", {
              method: "POST",
              body: { days: IDLE_DAYS },
            }).then(() => undefined)
          }
        />
      ) : (
        releasing && (
          <Confirm
            title={s.releaseTitle}
            lead={s.releaseLead(size(releasing.bytes))}
            action={s.release}
            onClose={done}
            run={() =>
              api(`/api/sandbox/workspaces/${releasing.conversation}`, { method: "DELETE" }).then(
                () => undefined,
              )
            }
          />
        )
      )}
    </Card>
  );
}

const ENDINGS = ["ok", "failed", "timeout", "stopped", "lost", "refused"] as const;
const endingTone: Record<string, "ok" | "destructive" | "warn" | "muted"> = {
  ok: "ok",
  failed: "destructive",
  broke: "destructive",
  timeout: "warn",
  stopped: "muted",
  lost: "warn",
  refused: "muted",
  running: "muted",
};

function RunsCard({ range }: { range: Range }) {
  const { t, number, dateTime, duration } = useI18n();
  const s = t.sandbox.runs;
  const size = t.files.size;
  const [person, setPerson] = useState("");
  const [ending, setEnding] = useState("");
  const [page, setPage] = useState(1);
  const query = new URLSearchParams({
    range,
    page: String(page),
    ...(person ? { person } : {}),
    ...(ending ? { ending } : {}),
  }).toString();
  const { data, error } = useLoad(() => api<Runs>(`/api/sandbox/runs?${query}`), [query]);
  const rows = data?.rows ?? [];
  const memory = rows.some((row) => row.peakKb !== null);
  const filter = (set: (value: string) => void) => (value: string) => {
    set(value);
    setPage(1);
  };
  // Another period is another list: it starts at its first page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the range is what it follows
  useEffect(() => setPage(1), [range]);
  return (
    <Card className="overflow-hidden pb-0 dense:pb-0">
      <CardHeader>
        <Title>
          {s.title}
          <span className="num pl-1 text-[13px] font-normal text-muted-foreground">
            {number(data?.total ?? 0)}
          </span>
        </Title>
        <CardAction className="flex items-center gap-2">
          <select
            aria-label={s.person}
            className={select}
            value={person}
            onChange={(event) => filter(setPerson)(event.target.value)}
          >
            <option value="">{s.everyone}</option>
            {data?.people.map((one) => (
              <option key={one.id} value={one.id}>
                {one.name || one.email}
              </option>
            ))}
          </select>
          <select
            aria-label={s.ending}
            className={select}
            value={ending}
            onChange={(event) => filter(setEnding)(event.target.value)}
          >
            <option value="">{s.any}</option>
            {ENDINGS.map((one) => (
              <option key={one} value={one}>
                {s.endings[one]}
              </option>
            ))}
          </select>
        </CardAction>
      </CardHeader>
      {error ? (
        <Empty>{error}</Empty>
      ) : rows.length === 0 ? (
        <Empty>{s.none}</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{s.person}</TableHead>
              <TableHead>{s.when}</TableHead>
              <TableHead>{s.conversation}</TableHead>
              <TableHead className="text-right">{s.took}</TableHead>
              <TableHead className="text-right">{s.cpu}</TableHead>
              {memory && <TableHead className="text-right">{s.memory}</TableHead>}
              <TableHead className="text-right">{s.printed}</TableHead>
              <TableHead className="text-right">{s.net}</TableHead>
              <TableHead className="text-right">{s.refused}</TableHead>
              <TableHead>{s.ending}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <Person name={row.person.name} email={row.person.email} />
                </TableCell>
                <TableCell className="num text-muted-foreground">
                  {dateTime(row.startedAt)}
                </TableCell>
                <TableCell className="max-w-56 truncate">
                  {row.traceId ? (
                    <a className="underline-offset-2 hover:underline" href={traceOf(row.traceId)}>
                      {row.title || row.agent || s.trace}
                    </a>
                  ) : (
                    row.title || row.agent || "—"
                  )}
                </TableCell>
                <TableCell className="num text-right">{duration(row.seconds * 1000)}</TableCell>
                <TableCell className="num text-right">
                  {cpuTime(row.cpuSeconds, t.sandbox.units)}
                </TableCell>
                {memory && (
                  <TableCell className="num text-right">
                    {row.peakKb === null ? "—" : size(row.peakKb * 1024)}
                  </TableCell>
                )}
                <TableCell className="num text-right">{size(row.printed)}</TableCell>
                <TableCell className="num text-right">
                  {row.netUp + row.netDown > 0 ? s.netOf(size(row.netUp), size(row.netDown)) : "—"}
                </TableCell>
                <TableCell className="num text-right">
                  {row.refused > 0 ? number(row.refused) : "—"}
                </TableCell>
                <TableCell>
                  <Badge variant={endingTone[row.ending] ?? "muted"}>
                    {s.endings[row.ending] ?? row.ending}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {data && data.total > data.size && (
        <div className="flex items-center justify-end gap-2 border-t px-3.5 py-1.5 text-xs text-muted-foreground">
          <span className="num">
            {t.common.showing(
              (data.page - 1) * data.size + 1,
              Math.min(data.total, data.page * data.size),
              data.total,
            )}
          </span>
          <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            {t.common.previous}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={data.page * data.size >= data.total}
            onClick={() => setPage(page + 1)}
          >
            {t.common.next}
          </Button>
        </div>
      )}
    </Card>
  );
}

/**
 * The hosts code may reach: one list, the administrator's. Each host is a chip; one is
 * added by typing its name, taken away by its cross. Saved as it is changed.
 */
function HostList() {
  const { t } = useI18n();
  const s = t.sandbox.network;
  const { data, error, reload } = useLoad(() => api<Hosts>("/api/sandbox/hosts"));
  const [adding, setAdding] = useState("");
  const action = useAction();
  if (error || !data) return error ? <Notice tone="bad">{error}</Notice> : null;
  const save = (hosts: string[]) =>
    action.run(async () => {
      await api("/api/sandbox/hosts", { method: "PUT", body: { hosts } });
      setAdding("");
      await reload();
    });
  const add = () => {
    const host = adding.trim();
    if (host) void save([...data.hosts, host]);
  };
  const changed = data.own && data.hosts.join(" ") !== data.defaults.join(" ");
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="pr-1 text-[13px] font-medium">{s.hosts}</span>
        {data.hosts.length === 0 && (
          <span className="text-xs text-muted-foreground">{s.hostsNone}</span>
        )}
        {data.hosts.map((host) => (
          <span
            key={host}
            className="inline-flex h-6 items-center gap-1 rounded-md bg-foreground/6 pr-1 pl-2 font-mono text-xs"
          >
            {host}
            {data.canManage && (
              <button
                type="button"
                aria-label={s.hostsRemove(host)}
                disabled={action.busy}
                onClick={() => void save(data.hosts.filter((one) => one !== host))}
                className="grid size-4 place-items-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
              >
                <XIcon className="size-3" />
              </button>
            )}
          </span>
        ))}
        {data.canManage && data.hosts.length < data.most && (
          <form
            className="flex items-center gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              add();
            }}
          >
            <Input
              value={adding}
              onChange={(event) => setAdding(event.target.value)}
              placeholder={s.hostsAdd}
              aria-label={s.hostsAdd}
              className="h-6 w-44 font-mono text-xs"
              spellCheck={false}
              autoCapitalize="off"
            />
            <Button
              type="submit"
              size="sm"
              variant="ghost"
              className="h-6 px-1.5"
              disabled={action.busy || !adding.trim()}
              aria-label={s.hostsAdd}
            >
              <PlusIcon />
            </Button>
          </form>
        )}
        {data.canManage && changed && (
          <button
            type="button"
            disabled={action.busy}
            onClick={() => void save(data.defaults)}
            className="pl-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            {s.hostsReset}
          </button>
        )}
      </div>
      {action.error && <Notice tone="bad">{action.error}</Notice>}
    </div>
  );
}

function NetworkCard({ range }: { range: Range }) {
  const { t, number } = useI18n();
  const s = t.sandbox.network;
  const size = t.files.size;
  const { data } = useLoad(() => api<Network>(`/api/sandbox/network?range=${range}`), [range]);
  const reached = data?.reached ?? [];
  return (
    <Card className="overflow-hidden pb-0 dense:pb-0">
      <CardHeader>
        <Title hint={s.hint}>{s.title}</Title>
      </CardHeader>
      <CardContent className="pb-2">
        <HostList />
      </CardContent>
      {reached.length === 0 ? (
        <Empty>{s.none}</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{s.host}</TableHead>
              <TableHead className="text-right">{s.allowed}</TableHead>
              <TableHead className="text-right">{s.refused}</TableHead>
              <TableHead className="text-right">{s.up}</TableHead>
              <TableHead className="text-right">{s.down}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {reached.map((row) => (
              <TableRow key={row.host}>
                <TableCell className="font-mono text-xs">{row.host}</TableCell>
                <TableCell className="num text-right">{number(row.allowed)}</TableCell>
                <TableCell className={cn("num text-right", row.refused > 0 && "text-destructive")}>
                  {number(row.refused)}
                </TableCell>
                <TableCell className="num text-right">{size(row.up)}</TableCell>
                <TableCell className="num text-right">{size(row.down)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}
