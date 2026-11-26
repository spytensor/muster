import { Panel, panelAction } from "./panel";
import { UI_VERSION } from "@muster/ui-schema";
import { ChevronRightIcon, PencilIcon, SparklesIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { goApp } from "@/App";
import { Notice, useAction } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { useI18n } from "@/i18n";
import { generalOf } from "@/lib/agentName";
import { ApiError, api } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  type AppAgent,
  type ConversationSummary,
  type Health,
  type Project,
  type ProjectUpdate,
  worksIn,
} from "./api";
import { deviceFor, preferredAgent } from "./Chat";

const HEALTHS: Health[] = ["on_track", "at_risk", "off_track"];
/** The colour a state of health is said in: the same everywhere it is shown. */
export const healthTone: Record<Health, { dot: string; text: string }> = {
  on_track: { dot: "bg-ok", text: "text-ok" },
  at_risk: { dot: "bg-warn", text: "text-warn" },
  off_track: { dot: "bg-destructive", text: "text-destructive" },
};

/** How a project is going, in a word and its colour. */
export function HealthMark({ health, className }: { health: Health; className?: string }) {
  const { t } = useI18n();
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1.5 text-xs",
        healthTone[health].text,
        className,
      )}
    >
      <span className={cn("size-2 rounded-full", healthTone[health].dot)} />
      {t.app.project.updates.health[health]}
    </span>
  );
}

/**
 * A project's updates: how it is going, said at a moment and kept.
 *
 * The newest stands open: its health, what it says, when and by whom. The person writes
 * one here (a health and a few lines), or asks an agent to draft one, which starts a
 * conversation in the project that writes it from the steps, the notes and what was done.
 * Earlier ones fold away under a count; an update is never changed, only added after.
 */
export function ProjectUpdates({
  project,
  conversations,
  onChange,
}: {
  project: Project;
  conversations: ConversationSummary[];
  onChange(): void;
}) {
  const { t, ago } = useI18n();
  const p = t.app.project.updates;
  const { error, run, busy } = useAction();
  const canWork = worksIn(project);
  const [updates, setUpdates] = useState<ProjectUpdate[]>();
  const [writing, setWriting] = useState<{ health: Health; text: string }>();
  const [earlier, setEarlier] = useState(false);
  const at = `/api/app/projects/${project.id}/updates`;
  // Asked again when a conversation of the project has moved on: an agent may have written one.
  const moved = conversations.map((one) => `${one.id}${one.updatedAt}${one.running}`).join();
  const asked = useRef(0);
  const load = useCallback(() => {
    const mine = ++asked.current;
    return api<ProjectUpdate[]>(at).then(
      (found) => {
        if (mine === asked.current) setUpdates(found);
      },
      () => setUpdates((had) => had ?? []),
    );
  }, [at]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `moved` is why it is asked again
  useEffect(() => {
    void load();
  }, [load, moved, project.health]);
  // With other people in the project, one of them may post at any time: asked again
  // every so often while the page is looked at.
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
  const keep = () => {
    if (!writing?.text.trim()) return;
    void act(async () => {
      await api(at, {
        method: "POST",
        body: { health: writing.health, text: writing.text.trim() },
      });
      setWriting(undefined);
    });
  };
  /** Asks an agent for a draft: a conversation in the project that writes the update. */
  const draft = () =>
    run(async () => {
      const { agents } = await api<{ agents: AppAgent[] }>("/api/app/agents");
      const usable = agents.filter((agent) => agent.state === "published");
      const agent =
        usable.find((one) => one.id === preferredAgent()) ?? generalOf(usable) ?? usable[0];
      if (!agent) throw new Error(p.noAgent);
      const { id } = await api<{ id: string }>("/api/app/conversations", {
        method: "POST",
        body: { agentId: agent.id, projectId: project.id },
      });
      try {
        await api(`/api/app/conversations/${id}/messages`, {
          method: "POST",
          body: { content: p.brief, ...(await deviceFor(project.id)), ui: UI_VERSION },
        });
      } catch (refused) {
        if (refused instanceof ApiError)
          await api(`/api/app/conversations/${id}`, { method: "DELETE" }).catch(() => undefined);
        throw refused;
      }
      onChange();
      goApp(`c/${id}`);
    });

  const [latest, ...older] = updates ?? [];
  const card = (update: ProjectUpdate, first: boolean) => (
    <li key={update.id} className={cn("group grid gap-1.5 px-3.5 py-3", !first && "border-t")}>
      <div className="flex items-center gap-2">
        <HealthMark health={update.health} />
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {p.when(
            ago(update.createdAt),
            // An agent's is named for the agent, and for whose conversation when not the person's own.
            update.by
              ? update.mine || !update.author
                ? update.by
                : p.byFor(update.by, update.author.name)
              : update.mine
                ? t.app.project.you
                : (update.author?.name ?? p.someone),
          )}
        </span>
        <button
          type="button"
          hidden={!update.canRemove}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-foreground/8 hover:text-destructive focus-visible:!opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
          title={p.remove}
          disabled={busy}
          onClick={() => {
            if (window.confirm(p.removeConfirm))
              void act(() => api(`${at}/${update.id}`, { method: "DELETE" }));
          }}
        >
          <Trash2Icon className="size-3.5" />
          <span className="sr-only">{p.remove}</span>
        </button>
      </div>
      <p className="text-[13px] leading-relaxed whitespace-pre-wrap">{update.text}</p>
    </li>
  );

  return (
    <Panel
      flush
      title={p.heading}
      action={
        !writing &&
        canWork && (
          <>
            <button
              type="button"
              className={panelAction}
              disabled={busy}
              onClick={() => void draft()}
            >
              <SparklesIcon className="size-3" />
              {p.draft}
            </button>
            <button
              type="button"
              className={panelAction}
              onClick={() => setWriting({ health: latest?.health ?? "on_track", text: "" })}
            >
              <PencilIcon className="size-3" />
              {p.write}
            </button>
          </>
        )
      }
    >
      {error && <Notice tone="bad">{error}</Notice>}
      {writing && (
        <div className="grid gap-2 p-3">
          <div className="flex gap-1.5" role="radiogroup" aria-label={p.how}>
            {HEALTHS.map((health) => (
              // biome-ignore lint/a11y/useSemanticElements: three chips in a row read as one choice
              <button
                type="button"
                key={health}
                role="radio"
                aria-checked={writing.health === health}
                className={cn(
                  "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
                  writing.health === health
                    ? cn("border-current", healthTone[health].text)
                    : "text-muted-foreground hover:bg-foreground/5",
                )}
                onClick={() => setWriting({ ...writing, health })}
              >
                <span className={cn("size-2 rounded-full", healthTone[health].dot)} />
                {p.health[health]}
              </button>
            ))}
          </div>
          <Textarea
            autoFocus
            rows={6}
            maxLength={2000}
            value={writing.text}
            placeholder={p.hint}
            onChange={(event) => setWriting({ ...writing, text: event.target.value })}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setWriting(undefined)}>
              {t.common.cancel}
            </Button>
            <Button size="sm" disabled={busy || !writing.text.trim()} onClick={keep}>
              {p.keep}
            </Button>
          </div>
        </div>
      )}
      {updates === undefined ? (
        <p className="px-3.5 py-2 text-[13px] text-muted-foreground">…</p>
      ) : latest ? (
        <div className="grid">
          <ul className="grid">{card(latest, true)}</ul>
          {older.length > 0 && (
            <>
              <button
                type="button"
                aria-expanded={earlier}
                className="flex items-center gap-1.5 border-t px-3.5 py-2 text-left text-xs text-muted-foreground hover:bg-accent/40"
                onClick={() => setEarlier(!earlier)}
              >
                <ChevronRightIcon
                  className={cn("size-3 transition-transform", earlier && "rotate-90")}
                />
                {p.earlier(older.length)}
              </button>
              {earlier && <ul className="grid">{older.map((one) => card(one, false))}</ul>}
            </>
          )}
        </div>
      ) : (
        !writing && (
          <p className="px-3.5 py-2.5 text-[13px] text-muted-foreground">
            {canWork ? p.empty : p.emptySeen}
          </p>
        )
      )}
    </Panel>
  );
}
