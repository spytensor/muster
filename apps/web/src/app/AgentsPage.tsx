import {
  AtSignIcon,
  BookOpenIcon,
  CopyIcon,
  FilePlus2Icon,
  FileTextIcon,
  FolderIcon,
  GlobeIcon,
  type LucideIcon,
  MailIcon,
  PencilIcon,
  PlugIcon,
  PlusIcon,
  ScrollTextIcon,
  SearchIcon,
  SendIcon,
  UsersIcon,
} from "lucide-react";
import { useState } from "react";
import { goApp } from "@/App";
import { useConfirm } from "@/components/confirm";
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
import { Input, Label, Textarea } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useI18n } from "@/i18n";
import { shownAgent } from "@/lib/agentName";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "./AgentAvatar";
import { ABILITY_TOOLS, type Ability } from "./abilities";
import type { AppAgent, Tool } from "./api";
import { callAgent } from "./Chat";
import type { Base } from "./Knowledge";
import { ShareDialog } from "./Share";
import type { Skill } from "./Skills";

/** What an agent can do, as the few things a person thinks in: not one line for each tool. */
const ABILITY: Record<Ability, { icon: LucideIcon; tools: string[] }> = {
  documents: { icon: FileTextIcon, tools: ABILITY_TOOLS.documents },
  files: { icon: FolderIcon, tools: ABILITY_TOOLS.files },
  makes: { icon: FilePlus2Icon, tools: ABILITY_TOOLS.makes },
  knowledge: { icon: BookOpenIcon, tools: ABILITY_TOOLS.knowledge },
  web: { icon: GlobeIcon, tools: ABILITY_TOOLS.web },
  microsoft: { icon: MailIcon, tools: ABILITY_TOOLS.microsoft },
  sends: { icon: SendIcon, tools: ABILITY_TOOLS.sends },
};
/** An agent's tools and what its carried parts bring. */
const toolsOf = (agent: AppAgent) => [
  ...agent.tools,
  ...(agent.carries?.some((part) => part.kind === "knowledge") ? ["knowledge.search"] : []),
];
const abilitiesOf = (tools: string[]) =>
  (Object.keys(ABILITY) as Ability[]).filter((ability) =>
    ABILITY[ability].tools.some((tool) => tools.includes(tool)),
  );

/** What an agent can do, as a few plain abilities: chips, or with `full` one line each. */
export function Abilities({ tools, full }: { tools: string[]; full?: boolean }) {
  const { t } = useI18n();
  const b = t.app.builder;
  const list = abilitiesOf(tools);
  if (list.length === 0) return <p className="text-xs text-muted-foreground">{b.ability.none}</p>;
  return (
    <ul className={cn("flex flex-wrap gap-1.5", full && "grid gap-2")}>
      {list.map((ability) => {
        const Icon = ABILITY[ability].icon;
        return (
          <li
            key={ability}
            className={cn(
              "flex items-center gap-1.5 text-xs",
              !full && "rounded-full bg-foreground/6 px-2 py-0.5",
              ability === "sends" && !full && "bg-warn/15 text-warn",
            )}
          >
            <Icon className={cn("size-3.5 shrink-0", full && "size-4 text-muted-foreground")} />
            <span className={cn(full && "text-sm")}>
              {full ? b.abilityFull[ability] : b.ability[ability]}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Whose it is, in a few words: the person's own, a colleague's, or the organization's. */
function useFrom() {
  const { t } = useI18n();
  const b = t.app.builder;
  return (agent: AppAgent) =>
    agent.mine
      ? b.byYou
      : agent.sharedBy
        ? b.sharedBy(agent.sharedBy.name || agent.sharedBy.email)
        : b.byOrganization;
}

/** What an agent carries beside its tools: the skills it follows and where it looks things up. */
function Carries({ agent }: { agent: AppAgent }) {
  if (!agent.carries?.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {agent.carries.map((part) => (
        <span
          key={`${part.kind}:${part.id}`}
          className="flex items-center gap-1 rounded-full bg-brand/10 px-2 py-0.5 text-[11px] text-brand-text"
        >
          {part.kind === "connector" ? (
            <PlugIcon className="size-3" />
          ) : part.kind === "knowledge" ? (
            <BookOpenIcon className="size-3" />
          ) : (
            <ScrollTextIcon className="size-3" />
          )}
          {part.name}
        </span>
      ))}
    </div>
  );
}

function StateNote({ agent }: { agent: AppAgent }) {
  const { t } = useI18n();
  const b = t.app.builder;
  if (agent.state === "pending") return <Badge variant="warn">{b.pendingNote}</Badge>;
  if (agent.state === "suspended") return <Badge variant="destructive">{b.suspendedNote}</Badge>;
  return null;
}

const talkTo = (agent: AppAgent) => {
  // For the conversation about to start, not from now on.
  callAgent(agent.id);
  goApp("");
};

function AgentTile({ agent, onOpen }: { agent: AppAgent; onOpen(): void }) {
  const { t } = useI18n();
  const b = t.app.builder;
  const from = useFrom();
  return (
    <article className="glass-thick group relative flex flex-col gap-3 rounded-2xl p-4 transition-colors hover:bg-accent/40">
      {/* The whole tile opens the agent. */}
      <button
        type="button"
        className="flex items-start gap-3 text-left outline-none after:absolute after:inset-0 after:rounded-2xl focus-visible:after:ring-2 focus-visible:after:ring-ring"
        onClick={onOpen}
      >
        <AgentAvatar name={shownAgent(agent)} description={agent.description} />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">{shownAgent(agent)}</span>
            <span className="min-w-0 shrink truncate text-[11px] text-muted-foreground">
              {from(agent)}
            </span>
            {agent.mine && (agent.shares ?? 0) > 0 && (
              <span
                // Above the tile's own button, so what it says on hover can be read.
                className="relative z-10 flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground"
                title={b.sharedWith(agent.shares ?? 0)}
              >
                <UsersIcon className="size-3" />
                {agent.shares}
              </span>
            )}
          </span>
          <span className="line-clamp-2 text-[13px] text-muted-foreground">
            {(t.app.described[agent.description] ?? agent.description) || b.noDescription}
          </span>
        </span>
      </button>
      <Abilities tools={toolsOf(agent)} />
      <Carries agent={agent} />
      {/* No button to "start a conversation": an agent is called with "@" where the person
          is already writing. The tile opens its details; a note says when it cannot be used. */}
      {agent.state !== "published" && (
        <div className="mt-auto pt-1">
          <StateNote agent={agent} />
        </div>
      )}
    </article>
  );
}

function AgentSheet({
  agent,
  onClose,
  onEdit,
  onRemove,
  onShare,
  onCopy,
  onHide,
}: {
  agent: AppAgent;
  onClose(): void;
  onEdit?(): void;
  onRemove?(): void;
  onShare?(): void;
  /** For an agent a colleague shared: make one's own copy, or put it away. */
  onCopy?(): void;
  onHide?(): void;
}) {
  const { t } = useI18n();
  const b = t.app.builder;
  const from = useFrom();
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="gap-0 sm:max-w-xl">
        <SheetHeader className="border-b">
          <div className="flex items-center gap-3">
            <AgentAvatar name={shownAgent(agent)} description={agent.description} size="lg" />
            <div className="grid gap-0.5">
              <SheetTitle>{shownAgent(agent)}</SheetTitle>
              <SheetDescription>{from(agent)}</SheetDescription>
            </div>
          </div>
        </SheetHeader>
        <div className="grid gap-6 p-5">
          <p className="text-sm">
            {(t.app.described[agent.description] ?? agent.description) || b.noDescription}
          </p>
          <StateNote agent={agent} />
          <section className="grid gap-2">
            <h3 className="section-title px-0">{b.canDo}</h3>
            <Abilities tools={toolsOf(agent)} full />
            <Carries agent={agent} />
            {agent.tools.includes("web.send") && (
              <p className="text-xs text-muted-foreground">{t.app.asksFirst}</p>
            )}
          </section>
          <section className="grid gap-2">
            <h3 className="section-title px-0">{b.howItWorks}</h3>
            <p className="max-h-64 overflow-y-auto rounded-lg bg-foreground/5 p-3 text-sm whitespace-pre-wrap">
              {agent.instructions}
            </p>
          </section>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              disabled={agent.state !== "published"}
              onClick={() => talkTo(agent)}
            >
              <AtSignIcon />
              {b.talk}
            </Button>
            {onEdit && (
              <Button variant="outline" onClick={onEdit}>
                <PencilIcon />
                {b.edit}
              </Button>
            )}
            {onShare && (
              <Button variant="outline" onClick={onShare}>
                <UsersIcon />
                {agent.shares ? b.sharedWith(agent.shares) : b.share}
              </Button>
            )}
            {onCopy && (
              <Button variant="outline" onClick={onCopy}>
                <CopyIcon />
                {b.copy}
              </Button>
            )}
            <MoreMenu
              className="ml-auto"
              label={t.common.more}
              items={[
                ...(onHide ? [{ label: b.hide, destructive: true, onSelect: onHide }] : []),
                ...(onRemove
                  ? [{ label: t.common.delete, destructive: true, onSelect: onRemove }]
                  : []),
              ]}
            />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function AgentEditor({
  agent,
  tools,
  onClose,
}: {
  agent: AppAgent | null;
  tools: Tool[];
  onClose(changed: boolean): void;
}) {
  const { t } = useI18n();
  const b = t.app.builder;
  const [name, setName] = useState(agent?.name ?? "");
  const [description, setDescription] = useState(agent?.description ?? "");
  const [instructions, setInstructions] = useState(agent?.instructions ?? "");
  const [chosen, setChosen] = useState<string[]>(agent?.tools ?? []);
  // The skills it carries, from those the builder may use.
  const skills = useLoad(() => api<Skill[]>("/api/app/skills"));
  const [carried, setCarried] = useState<string[]>(
    agent?.carries?.filter((part) => part.kind === "skill").map((part) => part.id) ?? [],
  );
  const bases = useLoad(() => api<Base[]>("/api/app/knowledge"));
  const [looksIn, setLooksIn] = useState<string[]>(
    agent?.carries?.filter((part) => part.kind === "knowledge").map((part) => part.id) ?? [],
  );
  const systems = useLoad(() =>
    api<
      {
        id: string;
        name: string;
        description: string;
        mine?: boolean;
        actions: { reads: boolean }[];
      }[]
    >("/api/app/company-connectors"),
  );
  const [reaches, setReaches] = useState<string[]>(
    agent?.carries?.filter((part) => part.kind === "connector").map((part) => part.id) ?? [],
  );
  const { busy, error, run } = useAction();
  // Sending outside, or a company system it can change: an administrator looks first.
  const outside =
    chosen.includes("web.send") ||
    (systems.data ?? []).some(
      (system) => reaches.includes(system.id) && system.actions.some((action) => !action.reads),
    );
  const save = () =>
    run(async () => {
      await api(agent ? `/api/app/agents/${agent.id}` : "/api/app/agents", {
        method: agent ? "PATCH" : "POST",
        body: {
          name: name.trim(),
          description: description.trim(),
          instructions: instructions.trim(),
          tools: chosen,
          skills: carried,
          knowledge: looksIn,
          connectors: reaches,
        },
      });
      onClose(true);
    });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose(false)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{agent ? b.edit : b.new}</DialogTitle>
          <DialogDescription>{b.lead}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-[1fr_1.4fr]">
          <Label>
            {b.name}
            <Input value={name} maxLength={60} onChange={(event) => setName(event.target.value)} />
          </Label>
          <Label>
            {b.description}
            <Input
              value={description}
              maxLength={200}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Label>
        </div>
        <Label>
          {b.instructions}
          <Textarea
            value={instructions}
            rows={7}
            placeholder={b.instructionsHint}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </Label>
        <fieldset className="grid gap-1.5">
          <legend className="pb-2 text-sm font-medium">{b.toolsLabel}</legend>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {tools.map((tool) => (
              <label
                key={tool.name}
                className="flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2 text-[13px] has-checked:border-brand has-checked:bg-brand/5"
              >
                <input
                  type="checkbox"
                  className="size-4 accent-(--brand)"
                  checked={chosen.includes(tool.name)}
                  onChange={(event) =>
                    setChosen((now) =>
                      event.target.checked
                        ? [...now, tool.name]
                        : now.filter((item) => item !== tool.name),
                    )
                  }
                />
                <span className="flex-1" title={tool.name}>
                  {t.app.toolSummary[tool.name] ?? tool.summary}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {skills.data && skills.data.length > 0 && (
          <fieldset className="grid gap-1.5">
            <legend className="pb-2 text-sm font-medium">{b.carriesSkills}</legend>
            <div className="flex flex-wrap gap-1.5">
              {skills.data
                // One that did not pass its scan is its author's alone, and an agent is for more than one.
                .filter((skill) => skill.scanStatus === "passed" || carried.includes(skill.id))
                .map((skill) => (
                  <label
                    key={skill.id}
                    title={skill.description}
                    className="flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1 text-[13px] has-checked:border-brand has-checked:bg-brand/5"
                  >
                    <input
                      type="checkbox"
                      className="size-3.5 accent-(--brand)"
                      checked={carried.includes(skill.id)}
                      onChange={(event) =>
                        setCarried((now) =>
                          event.target.checked
                            ? [...now, skill.id].slice(0, 8)
                            : now.filter((item) => item !== skill.id),
                        )
                      }
                    />
                    {skill.name}
                  </label>
                ))}
            </div>
          </fieldset>
        )}
        {bases.data && bases.data.length > 0 && (
          <fieldset className="grid gap-1.5">
            <legend className="pb-2 text-sm font-medium">{b.carriesKnowledge}</legend>
            <div className="flex flex-wrap gap-1.5">
              {bases.data.map((base) => (
                <label
                  key={base.id}
                  title={base.description}
                  className="flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1 text-[13px] has-checked:border-brand has-checked:bg-brand/5"
                >
                  <input
                    type="checkbox"
                    className="size-3.5 accent-(--brand)"
                    checked={looksIn.includes(base.id)}
                    onChange={(event) =>
                      setLooksIn((now) =>
                        event.target.checked
                          ? [...now, base.id].slice(0, 8)
                          : now.filter((item) => item !== base.id),
                      )
                    }
                  />
                  {base.name}
                </label>
              ))}
            </div>
            <Lead className="text-xs text-muted-foreground">{b.carriesKnowledgeHint}</Lead>
          </fieldset>
        )}
        {systems.data && systems.data.length > 0 && (
          <fieldset className="grid gap-1.5">
            <legend className="pb-2 text-sm font-medium">{b.carriesConnectors}</legend>
            <div className="flex flex-wrap gap-1.5">
              {systems.data.map((system) => (
                <label
                  key={system.id}
                  title={system.description}
                  className="flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1 text-[13px] has-checked:border-brand has-checked:bg-brand/5"
                >
                  <input
                    type="checkbox"
                    className="size-3.5 accent-(--brand)"
                    checked={reaches.includes(system.id)}
                    onChange={(event) =>
                      setReaches((now) =>
                        event.target.checked
                          ? [...now, system.id].slice(0, 8)
                          : now.filter((item) => item !== system.id),
                      )
                    }
                  />
                  {system.name}
                  {system.mine && <span className="text-muted-foreground">· {b.yours}</span>}
                </label>
              ))}
            </div>
            <Lead className="text-xs text-muted-foreground">{b.carriesConnectorsHint}</Lead>
          </fieldset>
        )}
        <Notice tone={outside ? "info" : "ok"}>{outside ? b.needsApproval : b.readyAtOnce}</Notice>
        {error && <Notice tone="bad">{error}</Notice>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(false)}>
            {t.common.cancel}
          </Button>
          <Button
            disabled={busy || !name.trim() || !instructions.trim()}
            onClick={() => void save()}
          >
            {agent ? t.common.save : b.create}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type Show = "all" | "mine" | "shared" | "provided";

/** The agents a person can talk to and the ones they built: found, understood and started from one page. */
export function MyAgents() {
  const { t } = useI18n();
  const b = t.app.builder;
  const { data, error, reload } = useLoad(async () => ({
    ...(await api<{ agents: AppAgent[] }>("/api/app/agents")),
    tools: await api<Tool[]>("/api/app/tools"),
  }));
  const [editing, setEditing] = useState<AppAgent | "new" | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [show, setShow] = useState<Show>("all");
  const [sharing, setSharing] = useState<AppAgent | null>(null);
  const { error: failure, run } = useAction();
  const { confirm, dialog } = useConfirm();
  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <Loading />;
  const needle = query.trim().toLowerCase();
  const groups: Record<Show, AppAgent[]> = {
    all: data.agents,
    mine: data.agents.filter((agent) => agent.mine),
    shared: data.agents.filter((agent) => agent.sharedBy),
    provided: data.agents.filter((agent) => agent.source !== "user"),
  };
  const shown = groups[show].filter(
    (agent) =>
      !needle ||
      `${agent.name} ${shownAgent(agent)} ${agent.description}`.toLowerCase().includes(needle),
  );
  const opened = data.agents.find((agent) => agent.id === open);
  const remove = async (agent: AppAgent) => {
    if (!(await confirm(t.common.delete, b.deleteConfirm(agent.name)))) return;
    await run(async () => {
      await api(`/api/app/agents/${agent.id}`, { method: "DELETE" });
      setOpen(null);
      await reload();
    });
  };
  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto">
      <div className="grid gap-4 px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-72">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder={b.search}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="flex rounded-lg bg-foreground/6 p-0.5">
            {(Object.keys(groups) as Show[])
              // "Shared with you" is there once something is.
              .filter((key) => key !== "shared" || groups.shared.length > 0)
              .map((key) => (
                <button
                  type="button"
                  key={key}
                  aria-pressed={show === key}
                  onClick={() => setShow(key)}
                  className={cn(
                    "h-7 rounded-md px-3 text-[13px]",
                    show === key ? "bg-background font-medium shadow-xs" : "text-muted-foreground",
                  )}
                >
                  {b.show[key]}
                  <span className="num pl-1.5 text-muted-foreground">{groups[key].length}</span>
                </button>
              ))}
          </div>
          <Button size="sm" className="ml-auto" onClick={() => setEditing("new")}>
            <PlusIcon />
            {b.new}
          </Button>
        </div>
        {failure && <Notice tone="bad">{failure}</Notice>}
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
          {shown.map((agent) => (
            <AgentTile key={agent.id} agent={agent} onOpen={() => setOpen(agent.id)} />
          ))}
          {/* Building one is a tile among the agents, where a person looking for one that fits will see it. */}
          {show !== "provided" && !needle && (
            <button
              type="button"
              onClick={() => setEditing("new")}
              className="grid min-h-40 content-center justify-items-center gap-1.5 rounded-2xl border border-dashed p-4 text-center text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
            >
              <PlusIcon className="size-5" />
              <span className="text-sm font-medium">
                {groups.mine.length === 0 ? b.first : b.new}
              </span>
              <span className="max-w-64 text-xs">{b.firstHint}</span>
            </button>
          )}
        </div>
        {shown.length === 0 && needle && <Notice>{b.noMatch}</Notice>}
      </div>
      {opened && (
        <AgentSheet
          agent={opened}
          onClose={() => setOpen(null)}
          onEdit={
            opened.mine
              ? () => {
                  setOpen(null);
                  setEditing(opened);
                }
              : undefined
          }
          onRemove={opened.mine ? () => void remove(opened) : undefined}
          onShare={
            opened.mine && opened.state === "published"
              ? () => {
                  setOpen(null);
                  setSharing(opened);
                }
              : undefined
          }
          onCopy={
            opened.sharedBy
              ? () =>
                  void run(async () => {
                    await api(`/api/app/agents/${opened.id}/copy`, { method: "POST" });
                    setOpen(null);
                    setShow("mine");
                    await reload();
                  })
              : undefined
          }
          onHide={
            opened.sharedBy
              ? async () => {
                  if (!(await confirm(b.hide, b.hideConfirm(opened.name)))) return;
                  await run(async () => {
                    await api(`/api/app/items/agent/${opened.id}/hide`, { method: "POST" });
                    setOpen(null);
                    await reload();
                  });
                }
              : undefined
          }
        />
      )}
      {editing && (
        <AgentEditor
          agent={editing === "new" ? null : editing}
          tools={data.tools}
          onClose={(changed) => {
            setEditing(null);
            if (changed) void reload();
          }}
        />
      )}
      {sharing && (
        <ShareDialog
          kind="agent"
          id={sharing.id}
          name={sharing.name}
          onClose={(changed) => {
            setSharing(null);
            if (changed) void reload();
          }}
        />
      )}
      {dialog}
    </div>
  );
}
