import {
  CalendarClockIcon,
  HourglassIcon,
  MailIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { goApp } from "@/App";
import { useConfirm } from "@/components/confirm";
import { Guide } from "@/components/guide";
import { MoreMenu } from "@/components/more";
import { Loading, Notice, useAction, useLoad } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Lead } from "@/components/ui/hint";
import { Input, Label, NativeSelect, Textarea } from "@/components/ui/input";
import { useI18n } from "@/i18n";
import { generalOf, shownAgent } from "@/lib/agentName";
import { api } from "@/lib/api";
import type { AppAgent } from "./api";
import { preferredAgent } from "./Chat";
import { type ScheduleSeed, takeScheduleSeed } from "./discovery";

export type Cadence =
  | { kind: "once"; date: string; time: string }
  | { kind: "daily"; time: string }
  | { kind: "weekly"; day: number; time: string }
  | { kind: "monthly"; day: number; time: string };
export interface Schedule {
  id: string;
  title: string;
  prompt: string;
  cadence: Cadence;
  timezone: string;
  paused: boolean;
  failures: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: "ok" | "failed" | "running" | null;
  lastDetail: string;
  conversationId: string;
  agentId: string;
  agentName: string;
}

/** Setting when something is done: what, by which agent, and at what times. */
function Editor({
  schedule,
  seed,
  onClose,
}: {
  schedule: Schedule | null;
  /** What a new schedule is to do, from a suggestion on the start page. */
  seed?: ScheduleSeed;
  onClose(changed: boolean): void;
}) {
  const { t } = useI18n();
  const s = t.app.schedules;
  const agents = useLoad(() => api<{ agents: AppAgent[] }>("/api/app/agents"));
  const usable = (agents.data?.agents ?? []).filter((agent) => agent.state === "published");
  const [prompt, setPrompt] = useState(schedule?.prompt ?? seed?.text ?? "");
  const [title, setTitle] = useState(schedule?.title ?? "");
  const [agentId, setAgentId] = useState(schedule?.agentId ?? "");
  const [kind, setKind] = useState<Cadence["kind"]>(
    schedule?.cadence.kind ?? seed?.kind ?? "daily",
  );
  const [time, setTime] = useState(schedule?.cadence.time ?? "09:00");
  const [date, setDate] = useState(
    schedule?.cadence.kind === "once" ? schedule.cadence.date : new Date().toLocaleDateString("sv"),
  );
  const [day, setDay] = useState(
    schedule?.cadence.kind === "weekly" || schedule?.cadence.kind === "monthly"
      ? schedule.cadence.day
      : 1,
  );
  // The times are those of the place the person is in when they set them.
  const timezone = schedule?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { error, busy, run } = useAction();
  // The person's usual agent answers, as on the start page; choosing another is not a step
  // of making a schedule (Q-7).
  const usual = usable.find((one) => one.id === preferredAgent()) ?? generalOf(usable) ?? usable[0];
  const agent = agentId || usual?.id || "";
  const [choosing, setChoosing] = useState(Boolean(schedule && schedule.agentId !== usual?.id));
  const cadence: Cadence =
    kind === "once"
      ? { kind, date, time }
      : kind === "daily"
        ? { kind, time }
        : { kind, day: kind === "weekly" ? Math.min(day, 6) : Math.max(day, 1), time };
  const save = () =>
    run(async () => {
      await api(schedule ? `/api/app/schedules/${schedule.id}` : "/api/app/schedules", {
        method: schedule ? "PATCH" : "POST",
        body: { title, prompt, agentId: agent, cadence, timezone },
      });
      onClose(true);
    });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose(false)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{schedule ? s.edit : s.new}</DialogTitle>
          <DialogDescription>{s.lead}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Label className="grid gap-1.5">
            {s.what}
            <Textarea
              className="min-h-24"
              value={prompt}
              maxLength={4000}
              placeholder={s.whatHint}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </Label>
          <div className="grid gap-3 sm:grid-cols-2">
            {choosing || !usual ? (
              <Label className="grid gap-1.5">
                {s.agent}
                <NativeSelect value={agent} onChange={(event) => setAgentId(event.target.value)}>
                  {usable.map((one) => (
                    <option key={one.id} value={one.id}>
                      {shownAgent(one)}
                    </option>
                  ))}
                </NativeSelect>
              </Label>
            ) : (
              <div className="grid content-start gap-1.5 text-sm">
                <span className="font-medium">{s.agent}</span>
                <p className="flex h-9 items-center gap-2 text-muted-foreground">
                  {/* The agent nobody called is named Muster, as in a conversation (CHA-271). */}
                  {s.answeredBy(shownAgent(usual))}
                  <button
                    type="button"
                    className="text-foreground underline-offset-2 hover:underline"
                    onClick={() => setChoosing(true)}
                  >
                    {s.chooseAgent}
                  </button>
                </p>
              </div>
            )}
            <Label className="grid gap-1.5">
              {s.name}
              <Input
                value={title}
                maxLength={80}
                placeholder={s.nameHint}
                onChange={(event) => setTitle(event.target.value)}
              />
            </Label>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Label className="grid gap-1.5">
              {s.when}
              <NativeSelect
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value as Cadence["kind"]);
                  setDay(1);
                }}
              >
                {(["once", "daily", "weekly", "monthly"] as const).map((one) => (
                  <option key={one} value={one}>
                    {s.kind[one]}
                  </option>
                ))}
              </NativeSelect>
            </Label>
            {kind === "once" && (
              <Label className="grid gap-1.5">
                {s.date}
                <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
              </Label>
            )}
            {kind === "weekly" && (
              <Label className="grid gap-1.5">
                {s.day}
                <NativeSelect value={day} onChange={(event) => setDay(Number(event.target.value))}>
                  {s.weekdays.map((name, index) => (
                    <option key={name} value={index}>
                      {name}
                    </option>
                  ))}
                </NativeSelect>
              </Label>
            )}
            {kind === "monthly" && (
              <Label className="grid gap-1.5">
                {s.dayOfMonth}
                <NativeSelect value={day} onChange={(event) => setDay(Number(event.target.value))}>
                  {Array.from({ length: 31 }, (_, index) => index + 1).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </NativeSelect>
              </Label>
            )}
            <Label className="grid gap-1.5">
              {s.time}
              <Input type="time" value={time} onChange={(event) => setTime(event.target.value)} />
            </Label>
          </div>
          <Lead className="text-xs text-muted-foreground">{s.rules(timezone)}</Lead>
          {error && <Notice tone="bad">{error}</Notice>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(false)}>
            {t.common.cancel}
          </Button>
          <Button disabled={!prompt.trim() || !agent || !time || busy} onClick={() => void save()}>
            {t.common.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** How a schedule's times read: "Every Monday at 09:00". */
export function useCadence() {
  const { t } = useI18n();
  const s = t.app.schedules;
  return (cadence: Cadence) =>
    cadence.kind === "once"
      ? s.says.once(cadence.date, cadence.time)
      : cadence.kind === "daily"
        ? s.says.daily(cadence.time)
        : cadence.kind === "weekly"
          ? s.says.weekly(s.weekdays[cadence.day] ?? "", cadence.time)
          : s.says.monthly(cadence.day, cadence.time);
}

export interface FollowUp {
  id: string;
  waitingFor: string;
  thenDo: string;
  from: string | null;
  lookAt: string;
  status: "waiting" | "waking" | "woken" | "ended" | "failed";
  wokenBy: "time" | "mail" | null;
  detail: string;
  createdAt: string;
  endedAt: string | null;
  conversationId: string;
  conversationTitle: string;
  agentName: string;
}

/**
 * What agents are waiting for on the person's behalf: each comes back to its conversation
 * when its time comes or the mail it waits for arrives. Set by an agent in a
 * conversation; ended or looked at now from here.
 */
function WaitingOn() {
  const { t, ago, dateTime } = useI18n();
  const f = t.app.followups;
  const { data, error, reload } = useLoad(() => api<FollowUp[]>("/api/app/followups"));
  const action = useAction();
  const { confirm, dialog } = useConfirm();
  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data || data.length === 0) return null;
  const act = (fn: () => Promise<unknown>) =>
    action.run(async () => {
      await fn();
      await reload();
    });
  const open = data.filter((one) => one.status === "waiting" || one.status === "waking");
  const over = data.filter((one) => !open.includes(one)).slice(0, 6);
  return (
    <section className="grid gap-2">
      <div className="flex items-baseline gap-2">
        <h3 className="text-sm font-semibold">{f.title}</h3>
        <Lead as="span" className="text-xs text-muted-foreground">
          {f.how}
        </Lead>
      </div>
      {action.error && <Notice tone="bad">{action.error}</Notice>}
      <div className="glass-thick divide-y rounded-2xl">
        {open.length === 0 && (
          <p className="px-4 py-3 text-[13px] text-muted-foreground">{f.none}</p>
        )}
        {open.map((one) => (
          <div key={one.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand/12 text-brand-text">
              {one.from ? <MailIcon className="size-4" /> : <HourglassIcon className="size-4" />}
            </span>
            <span className="grid min-w-0 flex-1 gap-0.5">
              <span className="truncate text-[13px] font-medium">{one.waitingFor}</span>
              <span className="truncate text-xs text-muted-foreground">
                {f.andThen(one.thenDo)} · {one.agentName}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {one.from
                  ? f.whenMail(one.from, dateTime(one.lookAt))
                  : f.when(dateTime(one.lookAt))}
              </span>
            </span>
            <span className="flex shrink-0 flex-wrap gap-1.5">
              <Button size="sm" variant="outline" onClick={() => goApp(`c/${one.conversationId}`)}>
                {f.open}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={action.busy || one.status === "waking"}
                onClick={() =>
                  void act(() => api(`/api/app/followups/${one.id}/now`, { method: "POST" }))
                }
              >
                <PlayIcon />
                {f.now}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={action.busy || one.status === "waking"}
                onClick={async () => {
                  if (await confirm(f.end, f.endConfirm(one.waitingFor)))
                    await act(() => api(`/api/app/followups/${one.id}`, { method: "DELETE" }));
                }}
              >
                {f.end}
              </Button>
            </span>
          </div>
        ))}
        {over.map((one) => (
          <button
            type="button"
            key={one.id}
            onClick={() => goApp(`c/${one.conversationId}`)}
            className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-accent/40"
          >
            <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
              {one.waitingFor}
              {one.status !== "woken" && f.why[one.detail] ? ` · ${f.why[one.detail]}` : ""}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {one.endedAt ? ago(one.endedAt) : ""}
            </span>
            <Badge variant={one.status === "failed" ? "warn" : "muted"}>
              {one.status === "woken"
                ? one.wokenBy === "mail"
                  ? f.cameBackMail
                  : f.cameBack
                : one.status === "failed"
                  ? f.failed
                  : f.ended}
            </Badge>
          </button>
        ))}
      </div>
      {dialog}
    </section>
  );
}

/** A person's scheduled work: what runs when, how the last run went, and the controls. */
export function MySchedules() {
  const { t, ago, dateTime } = useI18n();
  const s = t.app.schedules;
  const { data, error, reload } = useLoad(() => api<Schedule[]>("/api/app/schedules"));
  // A suggestion on the start page opens the form with its words in it (Q-1).
  // Taken in an effect, not while drawing: what is drawn may be drawn twice, and the words
  // are given only once.
  const [seed, setSeed] = useState<ScheduleSeed | null>(null);
  const [editing, setEditing] = useState<Schedule | "new" | null>(null);
  useEffect(() => {
    const words = takeScheduleSeed();
    if (!words) return;
    setSeed(words);
    setEditing("new");
  }, []);
  const action = useAction();
  const { confirm, dialog } = useConfirm();
  const says = useCadence();
  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <Loading />;
  const act = (fn: () => Promise<unknown>) =>
    action.run(async () => {
      await fn();
      await reload();
    });
  const remove = async (schedule: Schedule) => {
    if (await confirm(t.common.delete, s.deleteConfirm(schedule.title)))
      await act(() => api(`/api/app/schedules/${schedule.id}`, { method: "DELETE" }));
  };
  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto">
      <div className="grid gap-4 px-5 py-4">
        <WaitingOn />
        {/* With nothing scheduled the page says so once, in the middle, with the one button. */}
        {data.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <Lead as="span" className="text-xs text-muted-foreground">
              {s.how}
            </Lead>
            <Button size="sm" className="ml-auto" onClick={() => setEditing("new")}>
              <PlusIcon />
              {s.new}
            </Button>
          </div>
        )}
        {action.error && <Notice tone="bad">{action.error}</Notice>}
        <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          {data.map((schedule) => (
            <div key={schedule.id} className="glass-thick grid gap-2 rounded-2xl p-4">
              <div className="flex items-start gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand/12 text-brand-text">
                  <CalendarClockIcon className="size-4" />
                </span>
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="truncate text-sm font-semibold">{schedule.title}</span>
                  <span className="truncate text-[11px] text-muted-foreground">
                    {says(schedule.cadence)} · {schedule.agentName}
                  </span>
                </span>
                {schedule.paused ? (
                  <Badge variant="muted">{s.paused}</Badge>
                ) : schedule.lastStatus === "failed" ? (
                  <Badge variant="warn">{s.failed}</Badge>
                ) : schedule.lastStatus === "running" ? (
                  <Badge variant="muted">{s.running}</Badge>
                ) : (
                  <Badge variant="ok">{s.on}</Badge>
                )}
                <MoreMenu
                  label={t.common.more}
                  items={[
                    { label: s.edit, onSelect: () => setEditing(schedule) },
                    {
                      label: t.common.delete,
                      destructive: true,
                      onSelect: () => void remove(schedule),
                    },
                  ]}
                />
              </div>
              <p className="line-clamp-2 text-[13px] text-muted-foreground">{schedule.prompt}</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                <dt className="text-muted-foreground">{s.next}</dt>
                <dd title={schedule.timezone}>
                  {schedule.paused || !schedule.nextRunAt ? "—" : dateTime(schedule.nextRunAt)}
                </dd>
                <dt className="text-muted-foreground">{s.last}</dt>
                <dd>
                  {schedule.lastRunAt
                    ? `${ago(schedule.lastRunAt)} · ${s.status[schedule.lastStatus ?? "ok"]}`
                    : s.never}
                </dd>
              </dl>
              {schedule.lastStatus === "failed" && schedule.lastDetail && (
                <p className="text-xs text-warn">{schedule.lastDetail}</p>
              )}
              <div className="flex flex-wrap gap-1.5 pt-1">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => goApp(`c/${schedule.conversationId}`)}
                >
                  {s.open}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={action.busy || schedule.lastStatus === "running"}
                  onClick={() =>
                    void act(() => api(`/api/app/schedules/${schedule.id}/run`, { method: "POST" }))
                  }
                >
                  <PlayIcon />
                  {s.runNow}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={action.busy}
                  onClick={() =>
                    void act(() =>
                      api(`/api/app/schedules/${schedule.id}`, {
                        method: "PATCH",
                        body: { paused: !schedule.paused },
                      }),
                    )
                  }
                >
                  {schedule.paused ? <PlayIcon /> : <PauseIcon />}
                  {schedule.paused ? s.resume : s.pause}
                </Button>
              </div>
            </div>
          ))}
          {data.length > 0 && (
            <button
              type="button"
              onClick={() => setEditing("new")}
              className="flex min-h-36 flex-col items-center justify-center gap-1 rounded-2xl border border-dashed p-4 text-center text-muted-foreground hover:bg-accent/40"
            >
              <PlusIcon className="size-5" />
              <span className="text-sm font-medium text-foreground">{s.first}</span>
              <span className="max-w-64 text-xs">{s.firstHint}</span>
            </button>
          )}
        </div>
        {data.length === 0 && (
          <Guide icon={CalendarClockIcon} text={t.app.guides.schedules}>
            <Button onClick={() => setEditing("new")}>
              <PlusIcon />
              {s.new}
            </Button>
          </Guide>
        )}
      </div>
      {editing && (
        <Editor
          schedule={editing === "new" ? null : editing}
          seed={editing === "new" ? (seed ?? undefined) : undefined}
          onClose={(changed) => {
            setEditing(null);
            setSeed(null);
            if (changed) void reload();
          }}
        />
      )}
      {dialog}
    </div>
  );
}
