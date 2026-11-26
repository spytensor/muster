import { Panel, panelAction } from "./panel";
import {
  FolderIcon,
  HandIcon,
  LoaderIcon,
  PencilIcon,
  PlusIcon,
  Settings2Icon,
  SquarePenIcon,
  UsersIcon,
} from "lucide-react";
import { useCallback, useState } from "react";
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
import { Textarea } from "@/components/ui/input";
import { useI18n } from "@/i18n";
import { ApiError, api } from "@/lib/api";
import { desktop } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import { type Approval, type ConversationSummary, ITEM_KINDS, type Project, worksIn } from "./api";
import { type Bar, PaneBar } from "./Chat";
import { ProjectFiles } from "./ProjectFiles";
import { type Adding, ProjectLives, type Standing } from "./ProjectLives";
import { ProjectPeople } from "./ProjectPeople";
import { ProjectSteps } from "./ProjectSteps";
import { preferProject } from "./Projects";
import { HealthMark, ProjectUpdates } from "./ProjectUpdates";

/** A line of a project's notes that is a step to take: "- [ ] …" or "- [x] …". */
const STEP = /^(\s*[-*]\s*)\[( |x|X)\](\s+)(.*)$/;

/**
 * A project's own page, in two columns (MUS-59). On the left, what is happening: what
 * waits for the person, the steps in hand and the next, the latest update, where it
 * stands, what was made and what was said. On the right, what the project is made of:
 * its repositories, guides, environments, links, people to reach and facts, which is
 * also what Muster is told at the start of every conversation in it. On a narrow page
 * the right column comes first: what a project is comes before how it is going.
 *
 * It has no kinds of project to choose from. A project manager's and an engineer's are
 * the same page with different things kept in it, and a kind with nothing in it is not
 * shown (the owner, 2026-11-24: "不同的人他们常驻在这里的都是啥").
 *
 * Added 2026-11-22. The owner, of a project that was a name over three conversations in
 * the sidebar: "既然是一个项目，是否有一个这个项目的概览". It is not a board: a board is how
 * several people share out work, and here one person works with agents. What moves a
 * project on is its notes, kept by the agents working in it and by the person, which
 * every new conversation in it reads first; the steps still to take are lines in them.
 */
export function ProjectPage({
  project,
  conversations,
  waiting,
  bar,
  onChange,
  onSettings,
}: {
  project: Project;
  /** The project's conversations, newest first. */
  conversations: ConversationSummary[];
  /** What waits for the person's word, anywhere: this page shows what is the project's. */
  waiting: Approval[];
  bar: Bar;
  onChange(): void;
  onSettings(): void;
}) {
  const { t, ago } = useI18n();
  const p = t.app.project;
  const { error, run, busy } = useAction();
  const [writing, setWriting] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  // The notes were changed while the page had them open.
  const [stale, setStale] = useState(false);
  const [people, setPeople] = useState(false);
  // What "Add" asked for, written in the right column; and how the repositories stand,
  // counted there and said at the top.
  const [adding, setAdding] = useState<Adding | null>(null);
  const [standing, setStanding] = useState<Standing>({ repos: 0, failing: 0, pulls: 0 });
  const stood = useCallback((now: Standing) => setStanding(now), []);
  const added = useCallback((kind: Adding | null) => setAdding(kind), []);
  const [pinned, setPinned] = useState(0);
  // The notes are shown by their first lines: a page of them hides everything under it.
  const [allNotes, setAllNotes] = useState(false);
  // A colleague's project: what the person may do in it is said under its name, and what
  // they may not is not offered.
  const owns = project.role === "owner";
  const canWork = worksIn(project);
  const ids = new Set(conversations.map((one) => one.id));
  const asks = waiting.filter((one) => one.conversationId && ids.has(one.conversationId));
  const working = conversations.filter(
    (one) => one.running && !asks.some((ask) => ask.conversationId === one.id),
  );
  const keep = (notes: string) =>
    run(async () => {
      try {
        await api(`/api/app/projects/${project.id}/notes`, {
          method: "PUT",
          // What the page started from: notes an agent changed meanwhile are not written over.
          body: { notes, seen: project.notesRev },
        });
        setWriting(null);
        setStale(false);
      } catch (problem) {
        if (!(problem instanceof ApiError) || problem.code !== "notes_changed") throw problem;
        // The page shows them as they are now; what was being written stays in its box.
        setStale(true);
      }
      onChange();
    });
  const lines = project.notes.split("\n");
  const NOTES_SHOWN = 6;
  const goal = project.instructions.trim().split("\n")[0]?.trim() ?? "";
  const l = p.lives;
  const chip = "num rounded-md bg-foreground/6 px-2 py-0.5 text-xs text-muted-foreground";
  /** A step ticked or unticked: the notes kept with that one line changed. */
  const tick = (at: number) =>
    keep(
      lines
        .map((line, index) =>
          index === at
            ? line.replace(STEP, (_all, lead, mark, gap, words) => {
                return `${lead}[${mark === " " ? "x" : " "}]${gap}${words}`;
              })
            : line,
        )
        .join("\n"),
    );
  const start = () => {
    preferProject(project.id);
    goApp("");
  };
  const shown = more ? conversations : conversations.slice(0, 6);
  const row =
    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-accent/40";

  return (
    <div className="glass-strong flex min-w-0 flex-1 flex-col rounded-xl">
      <PaneBar bar={bar}>
        <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium">{project.name}</span>
      </PaneBar>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid w-full gap-4 px-5 py-5">
          <div className="grid gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-48 flex-1">
                <h2 className="truncate text-2xl font-semibold tracking-tight">{project.name}</h2>
                {goal && <p className="truncate text-[13px] text-muted-foreground">{goal}</p>}
              </div>
              {project.health && <HealthMark health={project.health} />}
              {canWork && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="outline">
                      <PlusIcon />
                      {l.add}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    {ITEM_KINDS.map((kind) => (
                      <DropdownMenuItem key={kind} onSelect={() => setAdding(kind)}>
                        {l.one[kind]}
                      </DropdownMenuItem>
                    ))}
                    {desktop && owns && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => setAdding("folder")}>
                          {l.addFolder}
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              {/* Who is in it: for the owner the way to bring someone in, for the others to see who else is. */}
              <Button size="sm" variant="outline" onClick={() => setPeople(true)}>
                <UsersIcon />
                {p.people.open(project.people === 0 ? 0 : project.people + 1)}
              </Button>
              {canWork && (
                <Button size="sm" onClick={start}>
                  <SquarePenIcon />
                  {p.start}
                </Button>
              )}
              {owns && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  title={t.app.projects.edit}
                  onClick={onSettings}
                >
                  <Settings2Icon className="size-4" />
                  <span className="sr-only">{t.app.projects.edit}</span>
                </Button>
              )}
            </div>
            {project.owner && (
              <p className="text-[13px] text-muted-foreground">
                {p.theirs(project.owner.name, canWork)}
              </p>
            )}
            {/* How it stands at a glance. Each is said only when there is something to say. */}
            <ul className="flex flex-wrap gap-1.5" aria-label={p.stands}>
              {project.steps > 0 && (
                <li className={chip}>{l.steps(project.stepsDone, project.steps)}</li>
              )}
              {standing.repos > 0 && <li className={chip}>{l.repos(standing.repos)}</li>}
              {standing.failing > 0 && (
                <li className={cn(chip, "bg-warn/15 text-warn")}>{l.failing(standing.failing)}</li>
              )}
              {standing.pulls > 0 && <li className={chip}>{l.open(standing.pulls)}</li>}
              {project.updateAt && <li className={chip}>{l.updated(ago(project.updateAt))}</li>}
            </ul>
          </div>
          {people && (
            <ProjectPeople
              project={project}
              onClose={(result) => {
                setPeople(false);
                if (result === "left") goApp("");
                if (result) onChange();
              }}
            />
          )}
          {error && <Notice tone="bad">{error}</Notice>}
          {stale && <Notice>{p.changed}</Notice>}

          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
            <div className="grid min-w-0 grid-cols-1 content-start gap-4">
              {/* What waits for the person comes before everything: it is what they came for. */}
              {(asks.length > 0 || working.length > 0) && (
                <Panel title={p.now}>
                  {asks.map((ask) => (
                    <button
                      type="button"
                      key={ask.id}
                      className={row}
                      onClick={() => goApp(`c/${ask.conversationId}`)}
                    >
                      <HandIcon className="size-3.5 shrink-0 text-warn" />
                      <span className="min-w-0 flex-1 truncate">
                        {conversations.find((one) => one.id === ask.conversationId)?.title ||
                          t.app.untitled}
                      </span>
                      <span className="shrink-0 text-xs text-warn">{p.needsYou}</span>
                    </button>
                  ))}
                  {working.map((one) => (
                    <button
                      type="button"
                      key={one.id}
                      className={row}
                      onClick={() => goApp(`c/${one.id}`)}
                    >
                      <LoaderIcon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{one.title || t.app.untitled}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{p.working}</span>
                    </button>
                  ))}
                </Panel>
              )}

              <ProjectSteps
                project={project}
                conversations={conversations}
                onChange={onChange}
                compact
              />
              <ProjectUpdates project={project} conversations={conversations} onChange={onChange} />

              <Panel
                flush
                title={p.stands}
                action={
                  writing === null &&
                  canWork && (
                    <button
                      type="button"
                      className={panelAction}
                      onClick={() => setWriting(project.notes)}
                    >
                      <PencilIcon className="size-3" />
                      {project.notes ? p.edit : p.write}
                    </button>
                  )
                }
              >
                {writing !== null ? (
                  <div className="grid gap-2 p-3">
                    <Textarea
                      autoFocus
                      rows={14}
                      maxLength={6000}
                      value={writing}
                      placeholder={p.hint}
                      onChange={(event) => setWriting(event.target.value)}
                    />
                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setWriting(null)}
                      >
                        {t.common.cancel}
                      </Button>
                      <Button size="sm" disabled={busy} onClick={() => void keep(writing)}>
                        {t.common.save}
                      </Button>
                    </div>
                  </div>
                ) : project.notes ? (
                  <div className="grid gap-1 px-3.5 py-3 text-[13px] leading-relaxed">
                    {(allNotes ? lines : lines.slice(0, NOTES_SHOWN)).map((line, at) => {
                      const step = line.match(STEP);
                      if (step)
                        return (
                          // biome-ignore lint/suspicious/noArrayIndexKey: the lines of one text never reorder
                          <label key={at} className="flex items-start gap-2">
                            <input
                              type="checkbox"
                              className="mt-1 size-3.5 shrink-0 accent-[var(--brand)]"
                              checked={step[2] !== " "}
                              disabled={busy || !canWork}
                              onChange={() => void tick(at)}
                            />
                            <span
                              className={cn(
                                step[2] !== " " && "text-muted-foreground line-through",
                              )}
                            >
                              {step[4]}
                            </span>
                          </label>
                        );
                      const item = line.match(/^\s*[-*]\s+(.*)$/);
                      if (item)
                        return (
                          // biome-ignore lint/suspicious/noArrayIndexKey: the lines of one text never reorder
                          <p key={at} className="flex gap-2">
                            <span className="text-muted-foreground">•</span>
                            <span>{item[1]}</span>
                          </p>
                        );
                      if (!line.trim())
                        // biome-ignore lint/suspicious/noArrayIndexKey: the lines of one text never reorder
                        return <span key={at} className="h-1" />;
                      // A short line with a list under it names that list.
                      const named = line.replace(/^#+\s*/, "").replace(/[:：]\s*$/, "");
                      const under = lines.slice(at + 1).find((one) => one.trim());
                      return /^#+\s/.test(line) ||
                        (line.trim().length <= 30 &&
                          under !== undefined &&
                          /^\s*[-*]\s/.test(under)) ? (
                        // biome-ignore lint/suspicious/noArrayIndexKey: the lines of one text never reorder
                        <p key={at} className="pt-1 font-medium">
                          {named}
                        </p>
                      ) : (
                        // biome-ignore lint/suspicious/noArrayIndexKey: the lines of one text never reorder
                        <p key={at}>{line}</p>
                      );
                    })}
                    <p className="flex items-center gap-2 pt-2 text-xs text-muted-foreground">
                      {lines.length > NOTES_SHOWN && (
                        <button
                          type="button"
                          aria-expanded={allNotes}
                          className="underline-offset-2 hover:text-foreground hover:underline"
                          onClick={() => setAllNotes(!allNotes)}
                        >
                          {allNotes ? l.fewer : l.showAll}
                        </button>
                      )}
                      {project.notesAt && (
                        <span>{p.updated(ago(project.notesAt), project.notesBy ?? p.you)}</span>
                      )}
                      {project.notesEarlier && canWork && (
                        <button
                          type="button"
                          className="underline-offset-2 hover:text-foreground hover:underline"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              await api(`/api/app/projects/${project.id}/notes/restore`, {
                                method: "POST",
                              });
                              onChange();
                            })
                          }
                        >
                          {p.earlier}
                        </button>
                      )}
                    </p>
                  </div>
                ) : (
                  <p className="px-3.5 py-2.5 text-[13px] text-muted-foreground">
                    {canWork ? p.standsEmpty : p.standsEmptySeen}
                  </p>
                )}
              </Panel>

              <Panel title={p.conversations}>
                {conversations.length > 0 ? (
                  <div className="grid">
                    {shown.map((one) => (
                      <button
                        type="button"
                        key={one.id}
                        className={row}
                        onClick={() => goApp(`c/${one.id}`)}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {one.title || t.app.untitled}
                        </span>
                        <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">
                          {one.agentName}
                        </span>
                        <span className="w-24 shrink-0 text-right text-xs text-muted-foreground">
                          {ago(one.updatedAt)}
                        </span>
                      </button>
                    ))}
                    {conversations.length > shown.length && (
                      <button
                        type="button"
                        className={cn(row, "justify-center text-muted-foreground")}
                        onClick={() => setMore(true)}
                      >
                        {p.all(conversations.length)}
                      </button>
                    )}
                  </div>
                ) : (
                  <p className="px-2.5 py-1.5 text-[13px] text-muted-foreground">
                    {p.noConversations}
                  </p>
                )}
              </Panel>
            </div>
            <div className="grid min-w-0 grid-cols-1 content-start gap-4">
              <ProjectLives
                project={project}
                conversations={conversations}
                adding={adding}
                onAdding={added}
                onStanding={stood}
                onChange={onChange}
                pinned={pinned}
                onPeople={() => setPeople(true)}
              />
              <ProjectFiles
                project={project}
                conversations={conversations}
                pinnedElsewhere
                onPinned={() => setPinned((n) => n + 1)}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
