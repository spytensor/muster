import { CheckIcon, ChevronDownIcon, SparklesIcon, TriangleAlertIcon } from "lucide-react";
import { useContext, useEffect, useMemo, useState } from "react";
import { goApp } from "@/App";
import { useAction } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import { ApiError, api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "./AgentAvatar";
import { ABILITY_NAMES, ABILITY_TOOLS, type Ability } from "./abilities";
import type { AppAgent } from "./api";
import { DraftScope } from "./drafts";

/**
 * An agent or a skill an agent proposed in its reply. Nothing exists until the person
 * presses Create here: the card makes it through the same routes the builder pages use,
 * as the person, so every rule that holds there holds here.
 */
interface Skill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  texts: { name: string; text: string }[];
  mine: boolean;
  scanStatus: "passed" | "failed";
}
/** What the person already has, asked once per page and again after something is made. */
let known: Promise<{ agents: AppAgent[]; skills: Skill[] }> | null = null;
let knownAt = 0;
const load = (fresh = false) => {
  // Not kept for long: an agent deleted on its own page is gone from the cards too.
  if (fresh || !known || Date.now() - knownAt > 5000) {
    knownAt = Date.now();
    known = Promise.all([
      api<{ agents: AppAgent[] }>("/api/app/agents"),
      api<Skill[]>("/api/app/skills"),
    ]).then(
      ([agents, skills]) => ({ agents: agents.agents, skills }),
      () => {
        known = null;
        return { agents: [], skills: [] };
      },
    );
  }
  return known;
};
/** Said to the page when an agent or a skill was made, so lists of them are asked for again. */
export const BUILT = "muster:built";
/** Names as the server compares them, near enough: case, width and spacing do not tell two apart. */
const plain = (name: string) => name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
const same = (a: string, b: string) => plain(a) === plain(b);
/** The most each field may hold; what the model wrote beyond it is cut before it is shown. */
const NAME = 60;
const DESCRIPTION = 300;
const AGENT_INSTRUCTIONS = 8000;
const SKILL_INSTRUCTIONS = 12_000;
/** Instructions longer than this are not all in view: they are to be opened before Create. */
const IN_VIEW = 5;
const longer = (text: string) => text.split("\n").length > IN_VIEW || text.length > 420;
/** The abilities a card offers. A knowledge base is attached on the agent's own page. */
const OFFERED: Ability[] = ABILITY_NAMES.filter((ability) => ability !== "knowledge");

const field =
  "min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground disabled:opacity-70";

function Shell({
  face,
  kind,
  note,
  warning,
  children,
}: {
  face: React.ReactNode;
  kind: string;
  note?: React.ReactNode;
  /** Said under the head when the draft may carry what was read from outside. */
  warning?: string | false;
  children: React.ReactNode;
}) {
  return (
    <div className="glass-thick my-1 grid max-w-2xl overflow-hidden rounded-xl text-sm">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        {face}
        <span className="text-xs font-medium text-muted-foreground">{kind}</span>
        <span className="ml-auto text-xs text-muted-foreground">{note}</span>
      </div>
      {warning && (
        <p className="flex items-start gap-1.5 border-b bg-warn/10 px-3 py-1.5 text-xs text-warn">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          {warning}
        </p>
      )}
      {children}
    </div>
  );
}
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 border-b px-3 py-1.5">
      <span className="w-20 shrink-0 text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
/** The long text of a draft: a few lines until the person opens it. */
function Long({
  label,
  value,
  onChange,
  disabled,
  max,
  onOpen,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  disabled: boolean;
  max: number;
  /** The person opened it to its whole length. */
  onOpen?: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const lines = value.split("\n").length;
  return (
    <div className="grid gap-1 border-b px-3 py-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>{label}</span>
        <button
          type="button"
          className="ml-auto flex items-center gap-0.5 hover:text-foreground"
          onClick={() => {
            if (!open) onOpen?.();
            setOpen(!open);
          }}
        >
          {open ? t.app.build.less : t.app.build.more}
          <ChevronDownIcon className={cn("size-3 transition-transform", open && "rotate-180")} />
        </button>
      </div>
      <textarea
        aria-label={label}
        value={value}
        disabled={disabled}
        maxLength={max}
        rows={open ? Math.min(28, Math.max(8, lines + 1)) : IN_VIEW}
        onChange={(event) => onChange(event.target.value)}
        className="w-full resize-none bg-transparent text-[13px] leading-relaxed outline-none disabled:opacity-70"
      />
    </div>
  );
}

export function AgentDraftCard({ props }: { props: Record<string, unknown> }) {
  const { t, errorText } = useI18n();
  const b = t.app.build;
  const { messageId, outside } = useContext(DraftScope);
  // Still being written: what is here is not yet what the agent means to propose.
  const live = !messageId;
  const original = useMemo(
    () => ({
      name: String(props.name ?? "")
        .trim()
        .slice(0, NAME),
      description: String(props.description ?? "")
        .trim()
        .slice(0, DESCRIPTION),
      instructions: String(props.instructions ?? "")
        .trim()
        .slice(0, AGENT_INSTRUCTIONS),
      abilities: (Array.isArray(props.abilities) ? props.abilities : []).filter(
        (item): item is Ability => (OFFERED as string[]).includes(String(item)),
      ),
    }),
    [props],
  );
  const [name, setName] = useState(original.name);
  const [description, setDescription] = useState(original.description);
  const [instructions, setInstructions] = useState(original.instructions);
  const [abilities, setAbilities] = useState<Ability[]>(original.abilities);
  const [looked, setLooked] = useState(false);
  // While it is written, the card follows the writing.
  useEffect(() => {
    if (!live) return;
    setName(original.name);
    setDescription(original.description);
    setInstructions(original.instructions);
    setAbilities(original.abilities);
  }, [live, original]);
  const [mine, setMine] = useState<AppAgent[] | null>(null);
  const [made, setMade] = useState<{ state: string; updated: boolean } | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const action = useAction();
  useEffect(() => {
    let current = true;
    const ask = (fresh: boolean) =>
      void load(fresh).then(
        (have) => current && setMine(have.agents.filter((agent) => agent.mine)),
      );
    ask(false);
    // Another card made something: this one may now be about an agent that exists.
    const again = () => ask(true);
    window.addEventListener(BUILT, again);
    return () => {
      current = false;
      window.removeEventListener(BUILT, again);
    };
  }, []);
  // The person's own agent of this name: the card changes it, it does not make a second.
  const existing = mine?.find((agent) => same(agent.name, name));
  const tools = [...new Set(abilities.flatMap((ability) => ABILITY_TOOLS[ability]))];
  // Already there exactly as written here (made from this card earlier): nothing to do.
  const inPlace =
    !made &&
    existing !== undefined &&
    existing.instructions.trim() === instructions.trim() &&
    existing.description.trim() === description.trim() &&
    OFFERED.every(
      (ability) =>
        abilities.includes(ability) ===
        ABILITY_TOOLS[ability].every((tool) => existing.tools.includes(tool)),
    );
  const done = made ?? (inPlace && existing ? { state: existing.state, updated: false } : null);
  const save = () =>
    void action.run(async () => {
      setRefused(null);
      const body = {
        name: name.trim(),
        description: description.trim(),
        instructions: instructions.trim(),
        tools,
        // What the agent already carries stays with it.
        skills: (existing?.carries ?? []).filter((p) => p.kind === "skill").map((p) => p.id),
        knowledge: (existing?.carries ?? []).filter((p) => p.kind === "knowledge").map((p) => p.id),
        connectors: (existing?.carries ?? [])
          .filter((p) => p.kind === "connector")
          .map((p) => p.id),
      };
      try {
        const result = await api<{ state: string }>(
          existing ? `/api/app/agents/${existing.id}` : "/api/app/agents",
          { method: existing ? "PATCH" : "POST", body },
        );
        setMade({ state: result.state ?? "published", updated: Boolean(existing) });
        setMine((await load(true)).agents.filter((agent) => agent.mine));
        window.dispatchEvent(new Event(BUILT));
      } catch (failure) {
        if (failure instanceof ApiError) setRefused(errorText(failure));
        else throw failure;
      }
    });
  const locked = live || action.busy || Boolean(made);
  // Long instructions, or ones written after outside material was read, are opened first.
  const unread = (outside || longer(instructions)) && !looked;
  const ready = name.trim().length > 0 && instructions.trim().length > 0 && !unread;
  return (
    <Shell
      face={<AgentAvatar name={name || "?"} description={description} size="sm" />}
      kind={b.agent}
      note={
        live
          ? t.app.draft.writing
          : made?.updated
            ? b.updated
            : done
              ? b.created
              : existing
                ? b.exists
                : b.notYet
      }
      warning={outside && !done && b.readOutside}
    >
      <Row label={b.name}>
        <input
          aria-label={b.name}
          className={cn(field, "font-medium")}
          value={name}
          maxLength={60}
          disabled={locked}
          onChange={(event) => setName(event.target.value)}
        />
      </Row>
      <Row label={b.does}>
        <input
          aria-label={b.does}
          className={field}
          value={description}
          maxLength={300}
          disabled={locked}
          onChange={(event) => setDescription(event.target.value)}
        />
      </Row>
      <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-2">
        <span className="w-20 shrink-0 text-xs text-muted-foreground">{b.may}</span>
        {OFFERED.map((ability) => {
          const on = abilities.includes(ability);
          return (
            <button
              type="button"
              key={ability}
              disabled={locked}
              aria-pressed={on}
              onClick={() =>
                setAbilities(on ? abilities.filter((a) => a !== ability) : [...abilities, ability])
              }
              className={cn(
                "flex h-6 items-center gap-1 rounded-full border px-2 text-xs transition-colors disabled:opacity-70",
                on
                  ? ability === "sends"
                    ? "border-warn/40 bg-warn/15 text-warn"
                    : "border-transparent bg-foreground/12 text-foreground"
                  : "text-muted-foreground hover:bg-foreground/5",
              )}
            >
              {on && <CheckIcon className="size-3" />}
              {t.app.builder.ability[ability]}
            </button>
          );
        })}
      </div>
      <Long
        label={b.how}
        value={instructions}
        onChange={setInstructions}
        disabled={locked}
        max={AGENT_INSTRUCTIONS}
        onOpen={() => setLooked(true)}
      />
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        {done ? (
          <>
            <span className="flex items-center gap-1 text-xs text-ok">
              <CheckIcon className="size-3.5" />
              {done.state === "pending" ? b.waits : b.call(name.trim())}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto h-7"
              onClick={() => goApp("agents")}
            >
              {b.open}
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" className="h-7" disabled={locked || !ready} onClick={save}>
              <SparklesIcon />
              {existing ? b.update(existing.name) : b.create}
            </Button>
            <span className="min-w-0 flex-1 text-xs text-muted-foreground">
              {refused ??
                action.error ??
                (unread && !live
                  ? b.readFirst
                  : abilities.includes("sends")
                    ? b.sendsNote
                    : b.yours)}
            </span>
          </>
        )}
      </div>
    </Shell>
  );
}

export function SkillDraftCard({ props }: { props: Record<string, unknown> }) {
  const { t, errorText } = useI18n();
  const b = t.app.build;
  const { messageId, outside } = useContext(DraftScope);
  const live = !messageId;
  const original = useMemo(
    () => ({
      name: String(props.name ?? "")
        .trim()
        .slice(0, NAME),
      description: String(props.description ?? "")
        .trim()
        .slice(0, DESCRIPTION),
      instructions: String(props.instructions ?? "")
        .trim()
        .slice(0, SKILL_INSTRUCTIONS),
      template: String(props.template ?? "")
        .trim()
        .slice(0, 40_000),
    }),
    [props],
  );
  const [name, setName] = useState(original.name);
  const [description, setDescription] = useState(original.description);
  const [instructions, setInstructions] = useState(original.instructions);
  const [template, setTemplate] = useState(original.template);
  const [looked, setLooked] = useState(false);
  useEffect(() => {
    if (!live) return;
    setName(original.name);
    setDescription(original.description);
    setInstructions(original.instructions);
    setTemplate(original.template);
  }, [live, original]);
  const [mine, setMine] = useState<Skill[] | null>(null);
  const [made, setMade] = useState<{ held: boolean; updated: boolean } | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const action = useAction();
  useEffect(() => {
    let current = true;
    const ask = (fresh: boolean) =>
      void load(fresh).then(
        (have) => current && setMine(have.skills.filter((skill) => skill.mine)),
      );
    ask(false);
    const again = () => ask(true);
    window.addEventListener(BUILT, again);
    return () => {
      current = false;
      window.removeEventListener(BUILT, again);
    };
  }, []);
  const existing = mine?.find((skill) => same(skill.name, name));
  // Already there as written here (made from this card earlier): nothing to do.
  const done =
    made ??
    (existing &&
    existing.instructions.trim() === instructions.trim() &&
    existing.description.trim() === description.trim() &&
    (!template.trim() || existing.texts.some((text) => text.text.trim() === template.trim()))
      ? { held: existing.scanStatus === "failed", updated: false }
      : null);
  const save = () =>
    void action.run(async () => {
      setRefused(null);
      const body = {
        name: name.trim(),
        description: description.trim(),
        instructions: instructions.trim(),
        // The texts a skill already has stay with it: the card's template takes the place
        // of the one of its name, or is added.
        texts: [
          ...(existing?.texts ?? []).filter((text) => !template.trim() || text.name !== b.template),
          ...(template.trim() ? [{ name: b.template, text: template.trim() }] : []),
        ].slice(0, 5),
      };
      try {
        const result = await api<{ scanStatus?: string }>(
          existing ? `/api/app/skills/${existing.id}` : "/api/app/skills",
          { method: existing ? "PATCH" : "POST", body },
        );
        setMade({ held: result.scanStatus === "failed", updated: Boolean(existing) });
        setMine((await load(true)).skills.filter((skill) => skill.mine));
        window.dispatchEvent(new Event(BUILT));
      } catch (failure) {
        if (failure instanceof ApiError) setRefused(errorText(failure));
        else throw failure;
      }
    });
  const locked = live || action.busy || Boolean(made);
  const unread = (outside || longer(instructions)) && !looked;
  const ready = name.trim().length > 0 && instructions.trim().length > 0 && !unread;
  return (
    <Shell
      face={<AgentAvatar name={name || "?"} kind="skill" size="sm" />}
      kind={b.skill}
      note={
        live
          ? t.app.draft.writing
          : made?.updated
            ? b.updated
            : done
              ? b.created
              : existing
                ? b.exists
                : b.notYet
      }
      warning={outside && !done && b.readOutside}
    >
      <Row label={b.name}>
        <input
          aria-label={b.name}
          className={cn(field, "font-medium")}
          value={name}
          maxLength={60}
          disabled={locked}
          onChange={(event) => setName(event.target.value)}
        />
      </Row>
      <Row label={b.when}>
        <input
          aria-label={b.when}
          className={field}
          value={description}
          maxLength={300}
          disabled={locked}
          onChange={(event) => setDescription(event.target.value)}
        />
      </Row>
      <Long
        label={b.procedure}
        value={instructions}
        onChange={setInstructions}
        disabled={locked}
        max={SKILL_INSTRUCTIONS}
        onOpen={() => setLooked(true)}
      />
      {(template || !locked) && (
        <Long
          label={b.template}
          value={template}
          onChange={setTemplate}
          disabled={locked}
          max={40_000}
        />
      )}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        {done ? (
          <>
            <span
              className={cn("flex items-center gap-1 text-xs", done.held ? "text-warn" : "text-ok")}
            >
              <CheckIcon className="size-3.5" />
              {done.held ? b.held : b.use(name.trim())}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto h-7"
              onClick={() => goApp("agents/skills")}
            >
              {b.openSkills}
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" className="h-7" disabled={locked || !ready} onClick={save}>
              <SparklesIcon />
              {existing ? b.update(existing.name) : b.create}
            </Button>
            <span className="min-w-0 flex-1 text-xs text-muted-foreground">
              {refused ?? action.error ?? (unread && !live ? b.readFirst : b.scanned)}
            </span>
          </>
        )}
      </div>
    </Shell>
  );
}
