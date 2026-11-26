import { Panel } from "./panel";
import { UI_VERSION } from "@muster/ui-schema";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BotIcon,
  CalendarIcon,
  ChevronRightIcon,
  HandIcon,
  LoaderIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PlusIcon,
  Trash2Icon,
  UndoIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { goApp } from "@/App";
import { Notice, useAction } from "@/components/shared";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useI18n } from "@/i18n";
import { shownAgent } from "@/lib/agentName";
import { ApiError, api } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  type AppAgent,
  type ConversationSummary,
  type Project,
  type ProjectStep,
  worksIn,
} from "./api";
import { deviceFor } from "./Chat";
import { ProjectTracker } from "./ProjectTracker";
import { stepLinesIn } from "./stepLines";

/** Today, as a step's due day is written. */
const today = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};

/**
 * A project's steps: what is still to do in it, and how far it has come.
 *
 * Each step is a row: ticked when it is done, given to an agent (which starts a
 * conversation on it in the project), marked as waiting for the person, given a day it is
 * due, put above or below another. Agents working in the project keep the same list
 * (project.step), so a step an agent took up says so here, with the conversation to open.
 * Done steps fold away under a count. It is a list one person keeps with their agents,
 * not a board for a team.
 */
export function ProjectSteps({
  project,
  conversations,
  onChange,
  compact = false,
}: {
  project: Project;
  conversations: ConversationSummary[];
  onChange(): void;
  /**
   * On the project's page: what is being done and what comes next, with the whole list
   * one press away. A page that opens on forty steps says nothing about now.
   */
  compact?: boolean;
}) {
  const { t, locale } = useI18n();
  const p = t.app.project.steps;
  const [whole, setWhole] = useState(false);
  const brief = compact && !whole;
  const { error, run, busy } = useAction();
  // Brought into a colleague's project only to see it: the steps are shown, and nothing here changes them.
  const canWork = worksIn(project);
  const [steps, setSteps] = useState<ProjectStep[]>();
  const [agents, setAgents] = useState<AppAgent[]>();
  const [adding, setAdding] = useState("");
  const [editing, setEditing] = useState<{ id: string; title: string }>();
  const [dating, setDating] = useState<string>();
  /** Escape was pressed in the title box: what was written there is dropped. */
  const left = useRef(false);
  const [showDone, setShowDone] = useState(false);
  const at = `/api/app/projects/${project.id}/steps`;
  // Asked again when a conversation of the project has moved on: an agent may have changed a step.
  const moved = conversations.map((one) => `${one.id}${one.updatedAt}${one.running}`).join();
  // Only the answer to the latest question is shown: an older one that comes late is dropped.
  const asked = useRef(0);
  const load = useCallback(() => {
    const mine = ++asked.current;
    return api<ProjectStep[]>(at).then(
      (found) => {
        if (mine === asked.current) setSteps(found);
      },
      () => setSteps((had) => had ?? []),
    );
  }, [at]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `moved` is why it is asked again
  useEffect(() => {
    void load();
  }, [load, moved, project.steps, project.stepsDone]);
  // In a project with other people in it, a colleague may change a step at any time, and
  // nothing here would say so: asked again every so often while the page is looked at.
  const shared = project.role !== "owner" || project.people > 0;
  useEffect(() => {
    if (!shared) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 20_000);
    return () => clearInterval(timer);
  }, [shared, load]);

  const act = (job: () => Promise<unknown>) =>
    run(async () => {
      await job();
      await load();
      onChange();
    });
  const change = (step: ProjectStep, body: Record<string, unknown>) =>
    act(() => api(`${at}/${step.id}`, { method: "PATCH", body }));
  const add = () => {
    const title = adding.trim();
    if (!title) return;
    void act(async () => {
      await api(at, { method: "POST", body: { title } });
      setAdding("");
    });
  };
  /**
   * Hands a step to an agent: a conversation in the project, begun with the step. The
   * step is marked before the agent begins, so that what the agent then says of it
   * (taken up, done) is the last word and not written over.
   */
  const hand = (step: ProjectStep, agent: AppAgent) =>
    act(async () => {
      const { id } = await api<{ id: string }>("/api/app/conversations", {
        method: "POST",
        body: { agentId: agent.id, projectId: project.id },
      });
      const undo = () =>
        api(`/api/app/conversations/${id}`, { method: "DELETE" }).catch(() => undefined);
      try {
        await api(`${at}/${step.id}`, {
          method: "PATCH",
          body: { agentId: agent.id, conversationId: id, state: "doing" },
        });
      } catch (refused) {
        await undo();
        throw refused;
      }
      try {
        await api(`/api/app/conversations/${id}/messages`, {
          method: "POST",
          body: {
            content: p.brief(step.n, step.title),
            ...(await deviceFor(project.id)),
            ui: UI_VERSION,
          },
        });
      } catch (refused) {
        // The server said no: the step is as it was, and no empty conversation is left.
        // A lost connection is different: the message may have arrived, so both stay.
        if (refused instanceof ApiError) {
          await api(`${at}/${step.id}`, {
            method: "PATCH",
            body: { agentId: step.agentId, conversationId: null, state: step.state },
          }).catch(() => undefined);
          await undo();
        }
        throw refused;
      }
      goApp(`c/${id}`);
    });
  // Steps the notes still hold as lines of text: the server makes them steps of their
  // own and takes them out of the notes, both or neither.
  const inNotes = stepLinesIn(project.notes);
  const adopt = () =>
    act(() => api(`${at}/adopt`, { method: "POST", body: { seen: project.notesRev } }));

  const open = steps?.filter((one) => one.state !== "done") ?? [];
  const done = steps?.filter((one) => one.state === "done") ?? [];
  const total = steps?.length ?? 0;
  // In brief: what is in hand or waits for the person, and the first of what is still to do.
  const next = open.find((one) => one.state === "todo");
  const shownOpen = brief
    ? [...open.filter((one) => one.state !== "todo"), ...(next ? [next] : [])]
    : open;
  const day = (due: string) =>
    new Date(`${due}T00:00:00`).toLocaleDateString(locale, { month: "short", day: "numeric" });
  const menuOpened = () => {
    if (!agents)
      void api<{ agents: AppAgent[] }>("/api/app/agents").then(
        (found) => setAgents(found.agents.filter((agent) => agent.state === "published")),
        () => setAgents([]),
      );
  };
  const live = (id: string | null) => conversations.find((one) => one.id === id);

  const row = (step: ProjectStep, index: number, list: ProjectStep[]) => {
    const isDone = step.state === "done";
    const talk = live(step.conversationId);
    const late = !isDone && step.due !== null && step.due < today();
    return (
      <li key={step.id} className="group grid gap-0.5 rounded-lg px-2.5 py-1.5 hover:bg-accent/40">
        <div className="flex min-w-0 items-center gap-2.5">
          <input
            type="checkbox"
            aria-label={isDone ? p.undo(step.title) : p.finish(step.title)}
            className="size-3.5 shrink-0 accent-[var(--brand)]"
            checked={isDone}
            disabled={busy || !canWork}
            onChange={() => void change(step, { state: isDone ? "todo" : "done" })}
          />
          {editing?.id === step.id ? (
            <input
              // biome-ignore lint/a11y/noAutofocus: the person just asked to write here
              autoFocus
              aria-label={p.title}
              className="min-w-0 flex-1 rounded-md border bg-transparent px-1.5 py-0.5 text-[13px] outline-none focus-visible:border-ring"
              maxLength={200}
              value={editing.title}
              onChange={(event) => setEditing({ id: step.id, title: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  left.current = true;
                  setEditing(undefined);
                }
                if (event.key === "Enter" && !event.nativeEvent.isComposing)
                  event.currentTarget.blur();
              }}
              // Leaving the box keeps what was written; Escape is the way to drop it.
              onBlur={() => {
                const title = editing.title.trim();
                const dropped = left.current;
                left.current = false;
                setEditing(undefined);
                if (!dropped && title && title !== step.title) void change(step, { title });
              }}
            />
          ) : (
            <button
              type="button"
              className={cn(
                "min-w-0 flex-1 truncate text-left text-[13px]",
                isDone && "text-muted-foreground line-through",
              )}
              title={step.title}
              disabled={!canWork}
              onClick={() => setEditing({ id: step.id, title: step.title })}
            >
              {step.title}
            </button>
          )}
          {step.state === "waiting" && (
            <span className="flex shrink-0 items-center gap-1 text-xs text-warn">
              <HandIcon className="size-3" />
              {p.waiting}
            </span>
          )}
          {step.state === "doing" && (
            <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
              {talk?.running ? (
                <LoaderIcon className="size-3 animate-spin" />
              ) : (
                <BotIcon className="size-3" />
              )}
              {step.agentName ? p.doingBy(step.agentName) : p.doing}
            </span>
          )}
          {step.ticket && (
            <a
              className="num shrink-0 text-xs text-muted-foreground hover:underline"
              href={step.ticket.url}
              target="_blank"
              rel="noreferrer"
            >
              {step.ticket.key}
            </a>
          )}
          {step.state === "todo" && step.agentName && (
            <span className="shrink-0 text-xs text-muted-foreground">{step.agentName}</span>
          )}
          {dating === step.id ? (
            <input
              type="date"
              // biome-ignore lint/a11y/noAutofocus: the person just asked to set it
              autoFocus
              aria-label={p.due}
              className="h-6 shrink-0 rounded-md border bg-transparent px-1 text-xs"
              defaultValue={step.due ?? ""}
              // Kept on leaving the box or on Enter, not at the first key: a year is typed
              // digit by digit, and each digit makes a day of some year.
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  event.currentTarget.value = step.due ?? "";
                  event.currentTarget.blur();
                }
              }}
              onBlur={(event) => {
                const due = event.currentTarget.value || null;
                setDating(undefined);
                if (due !== step.due) void change(step, { due });
              }}
            />
          ) : (
            step.due && (
              <button
                type="button"
                className={cn(
                  "num shrink-0 text-xs",
                  late ? "text-destructive" : "text-muted-foreground",
                )}
                title={late ? p.overdue : p.due}
                disabled={!canWork}
                onClick={() => setDating(step.id)}
              >
                {day(step.due)}
              </button>
            )
          )}
          {step.conversationId && talk && (
            <button
              type="button"
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-foreground/8 hover:text-foreground"
              title={p.openConversation(talk.title || t.app.untitled)}
              onClick={() => goApp(`c/${step.conversationId}`)}
            >
              <MessageSquareIcon className="size-3.5" />
              <span className="sr-only">{p.openConversation(talk.title || t.app.untitled)}</span>
            </button>
          )}
          <DropdownMenu onOpenChange={(opened) => opened && menuOpened()}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                hidden={!canWork}
                // Shown on hover where there is a pointer to hover with; always where there is not.
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-foreground/8 hover:text-foreground focus-visible:!opacity-100 data-[state=open]:!opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
              >
                <MoreHorizontalIcon className="size-3.5" />
                <span className="sr-only">{p.more(step.title)}</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {!isDone && (
                <>
                  <p className="px-2 pt-1 pb-0.5 text-xs text-muted-foreground">{p.handTo}</p>
                  {(agents ?? []).slice(0, 8).map((agent) => (
                    <DropdownMenuItem
                      key={agent.id}
                      disabled={busy}
                      onSelect={() => void hand(step, agent)}
                    >
                      <BotIcon />
                      <span className="truncate">{shownAgent(agent)}</span>
                    </DropdownMenuItem>
                  ))}
                  {agents === undefined && (
                    <p className="px-2 py-1 text-xs text-muted-foreground">…</p>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() =>
                      void change(step, { state: step.state === "waiting" ? "todo" : "waiting" })
                    }
                  >
                    {step.state === "waiting" ? <UndoIcon /> : <HandIcon />}
                    {step.state === "waiting" ? p.notWaiting : p.markWaiting}
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuItem onSelect={() => setDating(step.id)}>
                <CalendarIcon />
                {step.due ? p.changeDue : p.setDue}
              </DropdownMenuItem>
              {step.due && (
                <DropdownMenuItem onSelect={() => void change(step, { due: null })}>
                  <UndoIcon />
                  {p.noDue}
                </DropdownMenuItem>
              )}
              {!isDone && index > 0 && (
                <DropdownMenuItem
                  onSelect={() => void change(step, { before: list[index - 1]?.id })}
                >
                  <ArrowUpIcon />
                  {p.up}
                </DropdownMenuItem>
              )}
              {!isDone && index < list.length - 1 && (
                <DropdownMenuItem
                  onSelect={() => void change(step, { before: list[index + 2]?.id ?? null })}
                >
                  <ArrowDownIcon />
                  {p.down}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => void act(() => api(`${at}/${step.id}`, { method: "DELETE" }))}
              >
                <Trash2Icon />
                {p.remove}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {step.result && (
          <p className="pl-6 text-xs text-muted-foreground">
            {step.by ? `${step.by}: ` : ""}
            {step.result}
          </p>
        )}
      </li>
    );
  };

  return (
    <Panel
      title={p.heading}
      action={
        <>
          {total > 0 && (
            <>
              <div
                className="hidden h-1 w-24 overflow-hidden rounded-full bg-foreground/10 sm:block"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={total}
                aria-valuenow={done.length}
                aria-label={p.progress(done.length, total)}
              >
                <div
                  className="h-full rounded-full bg-[var(--brand)] transition-[width]"
                  style={{ width: `${(done.length / total) * 100}%` }}
                />
              </div>
              <span className="num px-1 text-xs text-muted-foreground">
                {done.length} / {total}
              </span>
            </>
          )}
          <ProjectTracker
            projectId={project.id}
            steps={total}
            moved={(steps ?? []).map((one) => `${one.id}${one.updatedAt}`).join()}
            onSent={() => void load()}
          />
        </>
      }
    >
      {error && <Notice tone="bad">{error}</Notice>}
      {inNotes > 0 && canWork && (
        <div className="flex items-center gap-3 rounded-lg px-2.5 py-1.5 text-[13px] text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">{p.inNotes(inNotes)}</span>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void adopt()}>
            {p.adopt}
          </Button>
        </div>
      )}
      <div className="grid">
        {steps === undefined ? (
          <p className="px-2.5 py-1.5 text-[13px] text-muted-foreground">…</p>
        ) : (
          <>
            {shownOpen.length > 0 && <ul className="grid">{shownOpen.map(row)}</ul>}
            {total === 0 && (
              <p className="px-2.5 py-1.5 text-[13px] text-muted-foreground">
                {canWork ? p.empty : p.emptySeen}
              </p>
            )}
            <form
              // Not offered to someone who only sees the project. Said with a class: the row's own `flex` would outweigh the attribute.
              className={cn("flex items-center gap-2.5 px-2.5 py-1.5", !canWork && "hidden")}
              onSubmit={(event) => {
                event.preventDefault();
                add();
              }}
            >
              <PlusIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                aria-label={p.add}
                className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
                placeholder={p.add}
                maxLength={200}
                // An Enter that only chooses a word while writing Chinese is not "add".
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    (event.nativeEvent.isComposing || event.keyCode === 229)
                  )
                    event.preventDefault();
                }}
                value={adding}
                disabled={busy}
                onChange={(event) => setAdding(event.target.value)}
              />
            </form>
            {compact && (whole || total > shownOpen.length) && (
              <button
                type="button"
                aria-expanded={whole}
                className="rounded-lg px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent/40"
                onClick={() => setWhole(!whole)}
              >
                {whole ? t.app.project.lives.fewer : t.app.project.lives.allSteps(total)}
              </button>
            )}
            {done.length > 0 && !brief && (
              <>
                <button
                  type="button"
                  aria-expanded={showDone}
                  className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent/40"
                  onClick={() => setShowDone(!showDone)}
                >
                  <ChevronRightIcon
                    className={cn("size-3 transition-transform", showDone && "rotate-90")}
                  />
                  {p.done(done.length)}
                </button>
                {showDone && <ul className="grid">{done.map(row)}</ul>}
              </>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}
