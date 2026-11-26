import { type FormAction, readAction, readableText, UI_VERSION } from "@muster/ui-schema";
import {
  AlertTriangleIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  ArrowUpRightIcon,
  AtSignIcon,
  BanIcon,
  BellRingIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CopyIcon,
  CornerDownRightIcon,
  FileDiffIcon,
  FolderIcon,
  GlobeIcon,
  ListChecksIcon,
  LoaderCircleIcon,
  MailIcon,
  MessageSquareTextIcon,
  MessagesSquareIcon,
  PlayIcon,
  RotateCcwIcon,
  ScrollTextIcon,
  SquareIcon,
  SquareTerminalIcon,
  StampIcon,
  XIcon,
} from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { goApp } from "@/App";
import { useConfirm } from "@/components/confirm";
import { MoreMenu } from "@/components/more";
import { Loading, Notice, useAction, useLoad } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { useI18n } from "@/i18n";
import { generalOf, shownAgent } from "@/lib/agentName";
import { ApiError, api, type Me } from "@/lib/api";
import { desktop } from "@/lib/desktop";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "./AgentAvatar";
import type {
  AppAgent,
  Approval,
  ConversationDetail,
  DeviceCall,
  DocumentSummary,
  FileItem,
  LiveEvent,
  Message,
  PlanItem,
  Project,
  Step,
  StepDetail,
  Writing,
} from "./api";
import { worksIn } from "./api";
import { ApprovalCard } from "./approval";
import { AttachButton, AttachmentTray, useAttachments } from "./attach";
import { BUILT } from "./builders";
import { CloudWork } from "./CloudWork";
import { PANE_LEFT, PANE_MIN, paneWidth, WorkPane } from "./code";
import { seedSchedule, skillFor, taughtCall, teachCall } from "./discovery";
import { type DraftCard, DraftScope, DraftsProvider, useDraftCards } from "./drafts";
import { FileTypeIcon } from "./FileTypeIcon";
import { FileChip, useOpenFile } from "./FileViewer";
import { AnswerCard, type AnswerForm, FormScope, formPlace } from "./forms";
import { type Mode, ModeChip, preferMode, preferredMode } from "./ModeChip";
import { Markdown } from "./markdown";
import { PlusMenu } from "./PlusMenu";
import { ProjectPicker, preferProject, preferredProject } from "./Projects";
import { lastLines, ranCode } from "./ranCode";
import { Reply, ReplyActions, runsOf } from "./reply";
import { ResultCard } from "./results";
import type { Skill } from "./Skills";

/**
 * What a message says about this computer: the names of the folders attached to the
 * conversation's project, when it is sent from the desktop app. Where they are stays here.
 */
export async function deviceFor(projectId: string | null, conversationId?: string) {
  if (!desktop || !projectId) return {};
  const folders = await desktop.folders(projectId).catch(() => []);
  if (!folders.length) return {};
  // What each folder is, so an agent that works on code knows the repositories it is in:
  // their branch, whether the person has work in them, and what they say of themselves.
  const notes = await desktop.describe?.(projectId, conversationId).catch(() => undefined);
  return {
    device: { folders: folders.map((folder) => folder.name), ...(notes ? { notes } : {}) },
  };
}

const AGENT_KEY = "muster.agent";
/** Remembers which agent the next new conversation starts with. */
export const preferAgent = (id: string) => localStorage.setItem(AGENT_KEY, id);
export const preferredAgent = () => localStorage.getItem(AGENT_KEY);
/** An agent called from its own page for the next conversation only, like "@" in the message box. */
const CALL_KEY = "muster.call";
export const callAgent = (id: string) => sessionStorage.setItem(CALL_KEY, id);
const calledAgent = () => sessionStorage.getItem(CALL_KEY);
const forgetCall = () => sessionStorage.removeItem(CALL_KEY);

/** What the workspace hands a conversation: whether its details panel is open, and the person's documents. */
export interface Side {
  open: boolean;
  /** Which view of the work pane is in front, and the way to show one (or close the pane it is on). */
  view: string;
  show(view: string): void;
  /** Opens the pane or puts it away, on the view it had. */
  toggle(): void;
  documents: DocumentSummary[];
  files: FileItem[];
  projects: Project[];
  /** How many schedules the person has. */
  schedules: number;
  /** Opens the dialog that makes a project. */
  newProject(): void;
  /** Opens a project's settings: its name, what agents are told, its folders. */
  editProject(id: string): void;
  /** Opens Settings on the section where connections are managed. */
  manageConnections(): void;
}
/** The two ends of a pane's top bar, supplied by the workspace: the menu button and the window's controls. */
export interface Bar {
  lead: ReactNode;
  trail: ReactNode;
}

const merge = (messages: Message[], ...more: Message[]) => {
  const byId = new Map(messages.map((message) => [message.id, message]));
  for (const message of more) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
};

/** The views of the work pane, in the order of their buttons: this work, the commands, the changes, a page, the files. */
const PANE_VIEWS = [
  ["work", ListChecksIcon],
  ["running", SquareTerminalIcon],
  ["changes", FileDiffIcon],
  ["preview", GlobeIcon],
  ["files", FolderIcon],
] as const;

/** The top bar of the main pane: what is open on the left, controls on the right. */
export function PaneBar({ bar, children }: { bar: Bar; children?: ReactNode }) {
  return (
    <header className="app-drag flex h-10 shrink-0 items-center gap-2 border-b px-2 md:px-3">
      {bar.lead}
      <div className="flex min-w-0 flex-1 items-center gap-2 text-[13px]">{children}</div>
      {bar.trail}
    </header>
  );
}

/**
 * Says so when nothing has come from the agent for a while: the person is not left looking
 * at "Working…" for minutes without knowing whether anything is happening.
 */
function SlowNote({ beat }: { beat: string }) {
  const { t } = useI18n();
  const [quiet, setQuiet] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: every sign of life starts the count again
  useEffect(() => {
    setQuiet(0);
    const started = Date.now();
    const timer = setInterval(() => setQuiet(Math.floor((Date.now() - started) / 1000)), 5000);
    return () => clearInterval(timer);
  }, [beat]);
  if (quiet < 30) return null;
  return <p className="text-xs text-muted-foreground">{t.app.slow(quiet)}</p>;
}

/** A step that is something the agent said while it worked, not a tool it used. */
const NOTE = "note";
/** A step that is something the person added while the agent was working. */
const ASIDE = "aside";
/** A step that says the earlier part of the conversation was made smaller to fit the model. */
const COMPACT = "compact";
/** Steps that are words, the agent's or the person's, and not something done. */
const spoken = (step: Step) => step.tool === NOTE || step.tool === ASIDE || step.tool === COMPACT;
const said = (steps: Step[]) => steps.filter(spoken);

/**
 * The line where an agent came back by itself. The message under it was written by
 * Muster for the agent; the person is shown what was awaited and why it is back, not
 * the instructions.
 */
function CameBack({ content }: { content: string }) {
  const { t } = useI18n();
  const f = t.app.followups;
  const awaited = /You were waiting for: (.*?)\. You said you would then: /s.exec(content)?.[1];
  const mail = /You are back because a mail from (\S+) has arrived/.exec(content)?.[1];
  return (
    <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      <BellRingIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        {mail ? f.backMail(mail) : f.backTime}
        {awaited ? ` · ${awaited}` : ""}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/** Something said along the way, in its place: the agent's words as text, the person's as theirs. */
function Said({ step, quiet }: { step: Step; quiet?: boolean }) {
  if (step.tool === ASIDE)
    return (
      <p className="ml-auto max-w-[80%] rounded-2xl bg-foreground/8 px-3 py-1.5 whitespace-pre-wrap">
        {step.detail}
      </p>
    );
  return (
    // What the agent said along the way, with its `code` and **bold** as in the reply. What the
    // person added (above) is shown as they typed it.
    // A long one (a whole earlier answer, kept as a word along the way) is cut to three lines:
    // its tables and lists come out as one run of words, and the answer itself is below.
    <p className={cn("line-clamp-3 whitespace-pre-wrap", quiet && "text-muted-foreground")}>
      {runsOf(step.detail)}
    </p>
  );
}

/**
 * What is happening right now, in words, from the moment a message is sent: a person who
 * asks for something is answered at once, not shown a spinner. It says which part of the
 * work this is and, once it has taken a few seconds, how long.
 */
function Doing({
  steps,
  beat,
  thinking,
  inline,
}: {
  steps: Step[];
  beat: string;
  /** Characters the model has thought so far in this call, when it is thinking. */
  thinking?: number | null;
  /** Drawn inside the line for the steps, not as a line of its own. */
  inline?: boolean;
}) {
  const { t } = useI18n();
  const [seconds, setSeconds] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: every sign of life starts the count again
  useEffect(() => {
    setSeconds(0);
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [beat]);
  const acts = steps.filter((step) => !spoken(step));
  const words = (
    <>
      <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin" />
      <span className={inline ? "shrink-0 text-foreground" : undefined}>
        {thinking
          ? t.app.doing.thinking
          : acts.length > 0
            ? t.app.doing.next
            : steps.length > 0
              ? t.app.doing.go
              : t.app.doing.start}
      </span>
      {seconds >= 5 && <span className="num text-xs">{t.app.doing.seconds(seconds)}</span>}
      {/* How much it has thought, in the unit the allowance is counted in: about three characters a token. */}
      {thinking ? (
        <span className="num text-xs">· {t.app.doing.thought(Math.round(thinking / 3))}</span>
      ) : null}
    </>
  );
  // On the line for the steps it is part of that line; alone, it is the line.
  return inline ? (
    words
  ) : (
    <p className="flex items-center gap-2 text-[13px] text-muted-foreground">{words}</p>
  );
}

/** A tool with no wording of its own, such as a company connector's action: "ticket desk · create". */
const plainTool = (tool: string) =>
  tool.startsWith("company.") ? tool.slice(8).replaceAll("_", " ").replace(".", " · ") : tool;

export function Composer({
  placeholder,
  disabled,
  running,
  onSend,
  onStop,
  hint,
  large,
  onInvite,
  seed,
  side,
  bar,
}: {
  /** The roomy form of the start page: the text on top, the buttons in a row under it. */
  large?: boolean;
  /** An agent was called with "@": whoever was called before is no longer. */
  onInvite?: () => void;
  /** What the workspace offers beside files: projects and connections. With it the paperclip becomes a + menu. */
  side?: Side;
  /** What sits beside the + in the box's bottom row: the project this message belongs to. */
  bar?: ReactNode;
  /** Text to put in the box, with a number that changes each time it is asked for. */
  seed?: { text: string; n: number };
  placeholder: string;
  disabled: boolean;
  running: boolean;
  /** Sends it. Answers false when it was refused, so what was typed can be put back. */
  onSend(text: string, files: FileItem[], skills: string[], agentId?: string): Promise<boolean>;
  onStop?(): void;
  hint?: ReactNode;
}) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const attach = useAttachments();
  const [over, setOver] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  // Skills for this message. Typing "/" lists the person's skills; a picked one is a chip.
  const [picked, setPicked] = useState<Skill[]>([]);
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const asking = /^\/(\S*)$/.exec(text);
  // Skills are also wanted once the person writes something one may fit (Q-2).
  const writing = text.trim().length >= 4;
  useEffect(() => {
    if (!(asking || writing) || skills) return;
    void api<Skill[]>("/api/app/skills").then(setSkills, () => setSkills([]));
  }, [asking, writing, skills]);
  // A skill what is being written plainly speaks of, offered under the box: Tab takes it,
  // Escape puts it away for this message. "/" is learned from it, not from a line of help.
  const [declined, setDeclined] = useState<string[]>([]);
  const fits =
    !asking && writing
      ? skillFor(
          text,
          (skills ?? []).filter(
            (skill) => !picked.some((one) => one.id === skill.id) && !declined.includes(skill.id),
          ),
        )
      : null;
  const offered = asking
    ? (skills ?? []).filter(
        (skill) =>
          !picked.some((one) => one.id === skill.id) &&
          skill.name.toLowerCase().includes((asking[1] ?? "").toLowerCase()),
      )
    : [];
  // The agent invited to answer this message. Typing "@" lists the agents the person may use.
  const [invited, setInvited] = useState<AppAgent | null>(null);
  const [agents, setAgents] = useState<AppAgent[] | null>(null);
  const calling = /^@(\S*)$/.exec(text);
  useEffect(() => {
    if (!calling || agents) return;
    void api<{ agents: AppAgent[] }>("/api/app/agents").then(
      (result) => setAgents(result.agents.filter((agent) => agent.state === "published")),
      () => setAgents([]),
    );
  }, [calling, agents]);
  // An agent or a skill made from a card in this page can be called or picked at once.
  useEffect(() => {
    const again = () => {
      setAgents(null);
      setSkills(null);
    };
    window.addEventListener(BUILT, again);
    return () => window.removeEventListener(BUILT, again);
  }, []);
  const callable = calling
    ? (agents ?? []).filter((agent) =>
        // By the name it is shown by, or the one it is kept under: "@mus" and "@assi" both find it.
        `${shownAgent(agent)} ${agent.name}`
          .toLowerCase()
          .includes((calling[1] ?? "").toLowerCase()),
      )
    : [];
  const invite = (agent: AppAgent) => {
    onInvite?.();
    setInvited(agent);
    setText("");
    box.current?.focus();
  };
  const pick = (skill: Skill) => {
    setPicked((now) => [...now, skill].slice(0, 3));
    setText("");
    box.current?.focus();
  };
  /** Takes the skill offered for what is written, and leaves the words where they are. */
  const take = (skill: Skill) => {
    setPicked((now) => [...now, skill].slice(0, 3));
    box.current?.focus();
  };
  useEffect(() => {
    if (!seed) return;
    setText(seed.text);
    box.current?.focus();
  }, [seed]);
  const add = side ? (
    <PlusMenu attach={attach} disabled={disabled} onManage={side.manageConnections} />
  ) : (
    <AttachButton attach={attach} disabled={disabled} />
  );
  // While a reply is being written only words can be added to it, and not too many.
  const waits = running && (attach.ready.length > 0 || picked.length > 0 || invited !== null);
  const long = running && text.trim().length > 4000;
  const send = () => {
    const content = text.trim();
    // A message says something or brings something.
    if ((!content && attach.ready.length === 0) || disabled || attach.busy) return;
    // While a reply is being written, words are added to it; a file, a skill or another
    // agent is a message of its own and waits for the reply.
    if (running && (!content || waits || long)) return;
    const sent = attach.ready;
    const using = picked;
    const asked = invited;
    setText("");
    setPicked([]);
    setInvited(null);
    setDeclined([]);
    attach.clear();
    // A refused message is not lost: its words go back in the box, unless the person typed on.
    void onSend(
      content,
      sent,
      using.map((skill) => skill.id),
      asked?.id,
    ).then((ok) => {
      if (ok) return;
      setText((now) => now || content);
      setPicked(using);
      setInvited(asked);
      attach.restore(sent);
    });
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dropping files here is an extra way in; the paperclip is the one everyone can use
    <div
      className={cn(
        "glass-thick rounded-2xl p-1.5 pl-1.5 focus-within:border-ring",
        over && "border-brand ring-1 ring-brand",
      )}
      onDragOver={(event) => {
        if (disabled || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        setOver(false);
        if (disabled || event.dataTransfer.files.length === 0) return;
        event.preventDefault();
        attach.add(event.dataTransfer.files);
      }}
    >
      <div className="pl-1.5">
        <AttachmentTray attach={attach} />
        {(picked.length > 0 || invited) && (
          <div className="flex flex-wrap gap-1.5 pt-1 pb-0.5">
            {invited && (
              <span className="flex items-center gap-1 rounded-full bg-foreground/8 py-0.5 pr-1 pl-2 text-xs">
                <AtSignIcon className="size-3" />
                {shownAgent(invited)}
                <button
                  type="button"
                  aria-label={t.common.remove}
                  className="rounded-full p-0.5 hover:bg-foreground/10"
                  onClick={() => setInvited(null)}
                >
                  <XIcon className="size-3" />
                </button>
              </span>
            )}
            {picked.map((skill) => (
              <span
                key={skill.id}
                className="flex items-center gap-1 rounded-full bg-brand/12 py-0.5 pr-1 pl-2 text-xs text-brand-text"
              >
                <ScrollTextIcon className="size-3" />
                {skill.name}
                <button
                  type="button"
                  aria-label={t.common.remove}
                  className="rounded-full p-0.5 hover:bg-brand/20"
                  onClick={() => setPicked((now) => now.filter((one) => one.id !== skill.id))}
                >
                  <XIcon className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
      {calling && (
        <div className="relative">
          <ul
            className={cn(
              "absolute left-1 z-20 max-h-56 w-80 overflow-y-auto rounded-xl border bg-popover p-1 text-popover-foreground shadow-lg",
              // On the start page the box sits high: the list opens under the line being typed.
              large ? "top-9" : "bottom-1",
            )}
          >
            <li className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
              {t.app.invite.pick}
            </li>
            {callable.length === 0 && (
              <li className="px-2 py-1.5 text-xs text-muted-foreground">
                {agents ? t.app.invite.noMatch : t.common.loading}
              </li>
            )}
            {callable.map((agent) => (
              <li key={agent.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-accent"
                  onClick={() => invite(agent)}
                >
                  <AgentAvatar name={shownAgent(agent)} description={agent.description} size="sm" />
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="truncate text-sm font-medium">{shownAgent(agent)}</span>
                    {agent.description && (
                      <span className="truncate text-xs text-muted-foreground">
                        {t.app.described[agent.description] ?? agent.description}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {asking && (
        <div className="relative">
          <ul
            className={cn(
              "absolute left-1 z-20 max-h-56 w-80 overflow-y-auto rounded-xl border bg-popover p-1 text-popover-foreground shadow-lg",
              // On the start page the box sits high: the list opens under the line being typed.
              large ? "top-9" : "bottom-1",
            )}
          >
            <li className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
              {t.app.skills.pick}
            </li>
            {offered.length === 0 && (
              <li className="px-2 py-1.5 text-xs text-muted-foreground">
                {skills
                  ? skills.length
                    ? t.app.skills.noMatch
                    : t.app.skills.none
                  : t.common.loading}
              </li>
            )}
            {offered.map((skill) => (
              <li key={skill.id}>
                <button
                  type="button"
                  className="grid w-full gap-0.5 rounded-lg px-2 py-1.5 text-left hover:bg-accent"
                  onClick={() => pick(skill)}
                >
                  <span className="truncate text-sm font-medium">{skill.name}</span>
                  {skill.description && (
                    <span className="truncate text-xs text-muted-foreground">
                      {skill.description}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1">
        <Textarea
          ref={box}
          value={text}
          rows={large ? 3 : 1}
          placeholder={placeholder}
          aria-label={placeholder}
          disabled={disabled}
          className={cn(
            "max-h-48 resize-none border-0 bg-transparent shadow-none [field-sizing:content] focus-visible:ring-0",
            large
              ? "min-h-20 w-full basis-full px-2.5 py-2 text-[15px]"
              : "min-h-9 w-full basis-full px-2.5 pt-2 pb-1 text-sm",
          )}
          onChange={(event) => setText(event.target.value)}
          onPaste={(event) => {
            // A pasted screenshot or file goes along as an attachment.
            if (event.clipboardData.files.length === 0) return;
            event.preventDefault();
            attach.add(event.clipboardData.files);
          }}
          onKeyDown={(event) => {
            if (fits && !event.nativeEvent.isComposing) {
              if (event.key === "Tab" && !event.shiftKey) {
                event.preventDefault();
                take(fits);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setDeclined((now) => [...now, fits.id]);
                return;
              }
            }
            // Enter sends; Shift+Enter is a new line; Enter while composing Chinese confirms the word.
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              // While skills are listed, Enter takes the first.
              if (asking) {
                if (offered[0]) pick(offered[0]);
                return;
              }
              // While agents are listed, Enter calls the first: "@name" is not a message.
              if (calling) {
                if (callable[0]) invite(callable[0]);
                return;
              }
              send();
            }
          }}
        />
        {add}
        {bar}
        <span className="flex-1" />
        {running && onStop ? (
          <>
            {(text.trim() || waits) && (
              // What cannot be added to a reply being written is said, not silently left.
              <Button
                size="icon"
                className="size-8 rounded-full"
                disabled={disabled || waits || long}
                title={waits ? t.app.aside.waits : long ? t.app.aside.long : t.app.aside.send}
                onClick={send}
              >
                <ArrowUpIcon />
                <span className="sr-only">
                  {waits ? t.app.aside.waits : long ? t.app.aside.long : t.app.aside.send}
                </span>
              </Button>
            )}
            <Button
              size="icon"
              variant="secondary"
              className="size-8 rounded-full"
              onClick={onStop}
            >
              <SquareIcon className="size-3.5 fill-current" />
              <span className="sr-only">{t.app.stop}</span>
            </Button>
          </>
        ) : (
          <Button
            size="icon"
            className="size-8 rounded-full"
            disabled={disabled || (!text.trim() && attach.ready.length === 0) || attach.busy}
            onClick={send}
          >
            <ArrowUpIcon />
            <span className="sr-only">{t.app.send}</span>
          </Button>
        )}
      </div>
      {fits && (
        <button
          type="button"
          className="flex w-full items-center gap-1.5 rounded-lg px-2.5 pt-1 pb-0.5 text-left text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() => take(fits)}
        >
          <ScrollTextIcon className="size-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{t.app.skillTip(fits.name)}</span>
          <kbd className="rounded border px-1 font-sans text-[10px]">Tab</kbd>
        </button>
      )}
      {hint && (
        <div className="flex items-center gap-2 pt-1 pr-1 pb-0.5 text-[11px] text-muted-foreground">
          {hint}
        </div>
      )}
    </div>
  );
}

/** Which message tells the person about which agent, while this page is open: the first one that can. */
const tellsOf = new Map<string, string>();

/**
 * Under a reply in which another agent did a step: the person can call that agent with "@"
 * next time. Said once per agent, under the first reply where it happened (Q-2).
 */
function CallTip({ messageId, steps }: { messageId: string; steps: Step[] }) {
  const { t } = useI18n();
  const [names] = useState(() =>
    [...new Set(steps.flatMap((step) => (step.by ? [step.by] : [])))].filter((name) => {
      const claimed = tellsOf.get(name);
      if (claimed && claimed !== messageId) return false;
      if (!claimed && taughtCall(name)) return false;
      tellsOf.set(name, messageId);
      return true;
    }),
  );
  useEffect(() => {
    for (const name of names) teachCall(name);
  }, [names]);
  if (names.length === 0) return null;
  return (
    <p className="flex items-center gap-1 text-xs text-muted-foreground">
      <AtSignIcon className="size-3 shrink-0" />
      {t.app.callTip(names.map((name) => `@${name}`).join(", "))}
    </p>
  );
}

const stepIcon = {
  running: LoaderCircleIcon,
  ok: CheckIcon,
  error: AlertTriangleIcon,
  blocked: BanIcon,
};

/** The conversation whose steps are being shown: a step is opened by asking for it there. */
const StepScope = createContext<string | null>(null);

/** What a step asked for, laid out to be read: arguments one to a line, text as it is. */
const readable = (asked: string) => {
  try {
    const value = JSON.parse(asked) as unknown;
    return value && typeof value === "object" ? JSON.stringify(value, null, 2) : asked;
  } catch {
    return asked;
  }
};

/** One step opened: what the agent asked for and what came back. */
function StepOpened({ step }: { step: Step }) {
  const { t } = useI18n();
  const conversation = useContext(StepScope);
  const { data, error } = useLoad(
    () =>
      api<StepDetail>(
        `/api/app/conversations/${conversation}/steps/${encodeURIComponent(step.id)}`,
      ),
    [conversation, step.id, step.status],
  );
  const block =
    "max-h-56 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[11px] whitespace-pre-wrap break-words";
  if (error)
    return (
      <p className="py-1 pl-5.5 text-[11px] text-muted-foreground">
        {step.status === "running" ? t.app.stepOpened.notYet : t.app.stepOpened.none}
      </p>
    );
  if (!data)
    return <p className="py-1 pl-5.5 text-[11px] text-muted-foreground">{t.app.working}</p>;
  // Code is shown as code; any other step as what was asked, argument by argument.
  const ran = step.tool === "code.run" ? ranCode(data.asked) : null;
  return (
    <div className="grid gap-1.5 py-1 pl-5.5">
      {(data.level || data.effect) && (
        <p className="text-[11px] text-muted-foreground">
          {[
            data.level ? `${data.level} · ${t.level[data.level] ?? ""}` : "",
            data.effect ? (t.app.stepOpened.effect[data.effect] ?? data.effect) : "",
            data.mode
              ? t.app.stepOpened.mode(
                  (t.app.modes.name as Record<string, string>)[data.mode] ?? data.mode,
                )
              : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
      {ran ? (
        <>
          <p className="section-title">
            {t.app.stepOpened.code(ran.language === "shell" ? "Shell" : "Python")}
          </p>
          <pre className={cn(block, "whitespace-pre")}>{ran.code}</pre>
          {(ran.files.length > 0 || ran.keep.length > 0) && (
            <p className="text-[11px] text-muted-foreground">
              {[
                ran.files.length ? t.app.stepOpened.wentIn(ran.files.join(", ")) : "",
                ran.keep.length ? t.app.stepOpened.kept(ran.keep.join(", ")) : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}
          <p className="text-[11px] text-muted-foreground">{t.app.stepOpened.sandbox}</p>
        </>
      ) : (
        <>
          <p className="section-title">{t.app.stepOpened.asked}</p>
          <pre className={block}>{readable(data.asked) || t.app.stepOpened.nothing}</pre>
        </>
      )}
      <p className="section-title">{t.app.stepOpened.returned}</p>
      <pre className={block}>{data.returned || t.app.stepOpened.nothing}</pre>
      {(data.asked.length >= data.limit || data.returned.length >= data.limit) && (
        <p className="text-[11px] text-muted-foreground">{t.app.stepOpened.cut(data.limit)}</p>
      )}
    </div>
  );
}

export function StepRow({ step }: { step: Step }) {
  const { t, duration } = useI18n();
  const [open, setOpen] = useState(false);
  // What the agent said between steps is shown as words, in its place among them.
  if (step.tool === NOTE)
    return (
      <li className="flex min-w-0 items-start gap-2 py-0.5 text-xs text-muted-foreground">
        <MessageSquareTextIcon className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0 flex-1">{step.detail}</span>
      </li>
    );
  if (step.tool === COMPACT)
    return (
      <li className="flex min-w-0 items-start gap-2 py-0.5 text-xs text-muted-foreground">
        <ScrollTextIcon className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0 flex-1">
          {step.detail === "summarised" ? t.app.compact.summarised : t.app.compact.trimmed}
        </span>
      </li>
    );
  if (step.tool === ASIDE)
    return (
      <li className="flex min-w-0 items-start gap-2 py-0.5 text-xs">
        <CornerDownRightIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="text-muted-foreground">{t.app.aside.you} </span>
          {step.detail}
        </span>
      </li>
    );
  const Icon = stepIcon[step.status];
  const action = t.app.toolName[step.tool] ?? plainTool(step.tool);
  return (
    <li className="grid min-w-0 text-xs">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(
          "flex h-6 min-w-0 items-center gap-2 rounded text-left hover:bg-foreground/5",
          // What another agent did for this reply stands under the step that was passed to it.
          step.by && "ml-[7px] border-l pl-3",
        )}
      >
        <Icon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground",
            step.status === "running" && "animate-spin text-brand-text",
            step.status === "ok" && "text-ok",
            step.status === "error" && "text-destructive",
            step.status === "blocked" && "text-warn",
          )}
        />
        <span className="shrink-0">
          {step.status === "ok"
            ? (t.app.toolDone[step.tool] ?? plainTool(step.tool))
            : t.app.step[step.status](action)}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-muted-foreground",
            // Who it went to and why are words, not an address or a file's name.
            step.tool !== "agent.ask" && "font-mono text-[11px]",
          )}
        >
          {step.detail}
        </span>
        {step.by && <span className="shrink-0 text-[11px] text-muted-foreground">{step.by}</span>}
        {step.ms !== null && (
          <span className="num shrink-0 text-[11px] text-muted-foreground">
            {duration(step.ms)}
          </span>
        )}
        <ChevronRightIcon
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
      </button>
      {/* What running code prints, as it prints it: the last lines, under the step. */}
      {step.status === "running" && step.said && (
        <pre className="mt-0.5 ml-5.5 max-h-24 overflow-hidden rounded-md bg-muted/50 px-2 py-1 font-mono text-[11px] leading-4 whitespace-pre-wrap break-words text-muted-foreground">
          {lastLines(step.said)}
        </pre>
      )}
      {open && <StepOpened step={step} />}
    </li>
  );
}

/**
 * The steps of one reply, as one line: what is being done right now while it runs, and
 * what was done, counted by kind, once it is over. Most people want to know that it is
 * moving and what it is on, not each call; the whole list is one press away.
 */
function Activity({
  steps: all,
  running,
  doing,
}: {
  steps: Step[];
  running: boolean;
  /** Between steps of a run: what is happening now, said on this same line. */
  doing?: ReactNode;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  // Counted and summed up by what was done; what was said is read in the open list.
  const steps = all.filter((step) => !spoken(step));
  if (steps.length === 0) return null;
  const now = running ? steps.findLast((step) => step.status === "running") : undefined;
  // "Searched the web ×6 · Read a web page ×11 · Made a file", in the order they first happened.
  const counts = new Map<string, number>();
  for (const step of steps)
    if (step.status === "ok") counts.set(step.tool, (counts.get(step.tool) ?? 0) + 1);
  const summary = [...counts]
    .map(([tool, n]) => `${t.app.toolDone[tool] ?? plainTool(tool)}${n > 1 ? ` ×${n}` : ""}`)
    .join(" · ");
  // Only what was not allowed is flagged up front. A page that would not load is ordinary:
  // the agent goes on to the next, and the list says which.
  const blocked = steps.some((step) => step.status === "blocked");
  return (
    // One quiet line of text, not a box: what is being done, or what was. The list it opens is the box.
    <div className="grid min-w-0 gap-1.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-6 w-fit max-w-full min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
      >
        {now ? (
          <>
            <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin" />
            <span className="shrink-0 text-foreground">
              {t.app.step.running(t.app.toolName[now.tool] ?? now.tool)}
            </span>
            <span
              className={cn(
                "min-w-0 truncate text-left",
                now.tool !== "agent.ask" && "font-mono text-[11px]",
              )}
            >
              {now.by ? `${now.by} · ${now.detail}` : now.detail}
            </span>
          </>
        ) : doing ? (
          // Between two steps the line still says what is happening, and for how long.
          doing
        ) : (
          <>
            <span className="shrink-0">{t.app.usedTools(steps.length)}</span>
            <span className="min-w-0 truncate text-left">{summary}</span>
          </>
        )}
        {(now || doing) && steps.length > 1 && (
          <span className="num shrink-0">{t.app.usedTools(steps.length)}</span>
        )}
        {blocked && <AlertTriangleIcon className="size-3.5 shrink-0 text-warn" />}
        <ChevronRightIcon
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
        />
      </button>
      {open && (
        <ul className="max-h-[28rem] overflow-y-auto rounded-lg border px-2 py-1">
          {all.map((step) => (
            <StepRow key={step.id} step={step} />
          ))}
        </ul>
      )}
    </div>
  );
}

const planIcon = {
  done: CircleCheckIcon,
  in_progress: LoaderCircleIcon,
  pending: CircleDashedIcon,
};

/** The steps of a plan. Once the reply is over nothing is in progress: a step left unfinished shows as not done. */
function PlanList({ plan, live }: { plan: PlanItem[]; live: boolean }) {
  const { t } = useI18n();
  return (
    <ul className="grid gap-1">
      {plan.map((item, index) => {
        const status = !live && item.status === "in_progress" ? "pending" : item.status;
        const Icon = planIcon[status];
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: a plan is replaced whole, never reordered
          <li key={index} className="flex min-h-6 items-start gap-2 text-[13px]">
            <Icon
              className={cn(
                "mt-[3px] size-3.5 shrink-0",
                status === "done" && "text-muted-foreground",
                status === "in_progress" && "animate-spin text-foreground",
                status === "pending" && "text-muted-foreground/70",
              )}
            />
            <span
              className={cn(
                status === "done" && "text-muted-foreground",
                status === "in_progress" && "font-medium text-foreground",
                status === "pending" && "text-muted-foreground",
              )}
            >
              {/* The mark is a picture: its meaning is said too, for those who do not see it. */}
              <span className="sr-only">{t.app.planStatus[status]} </span>
              {item.title}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

const doneOf = (plan: PlanItem[]) => plan.filter((item) => item.status === "done").length;

/**
 * The agent's plan for a reply. It is not announced: while the reply is written it is a
 * short list that ticks itself off, just above the line that says what is being done;
 * afterwards it is one line saying how much was done, which opens the list.
 */
function PlanCard({ plan, live }: { plan: PlanItem[]; live: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (plan.length === 0) return null;
  if (live)
    return (
      <section aria-label={t.app.plan} className="rounded-xl border px-3 py-2">
        <p className="sr-only">{t.app.planProgress(doneOf(plan), plan.length)}</p>
        <PlanList plan={plan} live />
      </section>
    );
  const done = doneOf(plan);
  return (
    <section aria-label={t.app.plan} className="grid min-w-0 gap-1.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-6 w-fit items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
      >
        <span>{t.app.planProgress(done, plan.length)}</span>
        <ChevronRightIcon
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
        />
      </button>
      {open && (
        <div className="rounded-xl border px-3 py-2">
          <PlanList plan={plan} live={false} />
        </div>
      )}
    </section>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-1 border-b px-1 py-2.5 last:border-b-0">
      <h3 className="section-title">{title}</h3>
      {children}
    </section>
  );
}
const None = ({ children }: { children: ReactNode }) => (
  <p className="px-2 text-xs text-muted-foreground">{children}</p>
);

/**
 * The side panel: this piece of work, not the agent's leaflet. What waits for the person,
 * what was made and sent, what was read. What the agent can do is under one line at the
 * bottom, for when someone wants it.
 */
function Work({
  approval,
  touched,
  pages,
  onOpen,
  versionOf,
  beside,
}: {
  /** Shown under the pane's own account of where the work is: an empty list says nothing. */
  beside?: boolean;
  approval: boolean;
  touched: [string, { how: "saved" | "read"; file: boolean }][];
  pages: string[];
  onOpen(title: string, file: boolean): void;
  /** Which version a file the agent made is at. */
  versionOf(title: string): number | undefined;
}) {
  const { t } = useI18n();
  const p = t.app.panel;
  const cards = useDraftCards();
  // One whose sending is not known waits for the person too: they have to look.
  const waiting = cards.filter((card) => card.status === "unsent" || card.status === "unknown");
  const sent = cards.filter((card) => card.status === "sent");
  const made = touched.filter(([, { how }]) => how === "saved");
  const read = touched.filter(([, { how }]) => how === "read");
  const jump = (id: string) =>
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "center" });
  const draftRow = (card: DraftCard, note: string) => {
    const Icon = card.kind === "mail" ? MailIcon : MessagesSquareIcon;
    return (
      <button type="button" key={card.id} className="row" onClick={() => jump(card.id)}>
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{card.title}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">{note}</span>
      </button>
    );
  };
  const host = (address: string) => {
    try {
      return new URL(address).host.replace(/^www\./, "");
    } catch {
      return address;
    }
  };
  const nothing = !approval && cards.length === 0 && touched.length === 0 && pages.length === 0;
  return (
    <>
      {nothing && !beside && (
        <Section title={p.work}>
          <None>{p.nothing}</None>
        </Section>
      )}
      {(approval || waiting.length > 0) && (
        <Section title={p.waiting}>
          {approval && (
            <p className="flex items-center gap-2 px-2 text-xs">
              <StampIcon className="size-3.5 shrink-0 text-warn" />
              {p.approval}
            </p>
          )}
          {waiting.map((card) => draftRow(card, card.status === "unknown" ? p.unknown : p.notSent))}
        </Section>
      )}
      {(made.length > 0 || sent.length > 0) && (
        <Section title={p.made}>
          {sent.map((card) => draftRow(card, p.sent))}
          {made.map(([title, { file }]) => (
            <button type="button" key={title} className="row" onClick={() => onOpen(title, file)}>
              <FileTypeIcon name={title} note={!file} small className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{title}</span>
              {/* A file changed since it was made says which version it is at. */}
              {file && (versionOf(title) ?? 1) > 1 ? (
                <span className="num shrink-0 rounded bg-foreground/8 px-1 text-[10px] font-medium">
                  v{versionOf(title)}
                </span>
              ) : (
                <span className="shrink-0 text-[11px] text-muted-foreground">{p.saved}</span>
              )}
            </button>
          ))}
        </Section>
      )}
      {(read.length > 0 || pages.length > 0) && (
        <Section title={p.readTitle}>
          {read.map(([title, { file }]) => (
            <button type="button" key={title} className="row" onClick={() => onOpen(title, file)}>
              <FileTypeIcon name={title} note={!file} small className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{title}</span>
            </button>
          ))}
          {pages.slice(0, 12).map((address) => (
            <a
              key={address}
              className="row"
              href={address}
              target="_blank"
              rel="noopener noreferrer"
              title={address}
            >
              <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{host(address)}</span>
            </a>
          ))}
        </Section>
      )}
    </>
  );
}

function Panel({
  children,
  wide,
  head,
}: {
  children: ReactNode;
  wide?: boolean;
  /** What stays at the top of the narrow panel while the rest scrolls. */
  head?: ReactNode;
}) {
  const { t } = useI18n();
  // The wide pane and the narrow one each keep the width the person dragged them to.
  const key = wide ? "muster.pane.width" : "muster.panel.width";
  const [width, setWidth] = useState<number | null>(() => {
    const kept = Number(localStorage.getItem(key));
    return kept > 0 ? kept : null;
  });
  const [dragging, setDragging] = useState(false);
  const pane = useRef<HTMLElement>(null);
  const now = () => pane.current?.getBoundingClientRect().width ?? 0;
  // What the pane and the conversation share: the two of them, not the window with its list.
  const room = () =>
    now() + (pane.current?.previousElementSibling?.getBoundingClientRect().width ?? 0);
  const keep = (asked: number | null) => {
    if (asked === null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(paneWidth(asked, room())));
  };
  const set = (asked: number | null, kept = true) => {
    setWidth(asked === null ? null : paneWidth(asked, room()));
    if (kept) keep(asked);
  };
  // Said once drawn: what a pane never dragged measures is not known before.
  const [measured, setMeasured] = useState(0);
  const [most, setMost] = useState(PANE_MIN);
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured again when the width was set
  useEffect(() => {
    const measure = () => {
      setMeasured(Math.round(now()));
      setMost(Math.max(PANE_MIN, Math.round(room() - PANE_LEFT)));
      // A window made smaller takes from the pane, not from the conversation. What was
      // kept stays: a window made larger again gives it back on the next visit.
      setWidth((had) => (had === null || room() === 0 ? had : paneWidth(had, room())));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [width]);
  const ended = () => {
    if (!dragging) return;
    setDragging(false);
    // Kept when the drag ends, not at every move.
    keep(now());
  };
  return (
    <aside
      ref={pane}
      className={cn(
        "glass relative hidden shrink-0 overflow-hidden rounded-xl lg:block",
        // The work pane holds code and a page: it takes what a second column needs.
        wide ? "w-[min(46vw,760px)]" : "w-72",
      )}
      style={width === null ? undefined : { width, minWidth: PANE_MIN }}
    >
      {/* The edge towards the conversation is dragged to make the pane wider or narrower;
          pressed twice, or with Home, it goes back to the width it has by itself. */}
      {/* biome-ignore lint/a11y/useSemanticElements: a separator that is moved is not a rule */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t.app.code.resize}
        aria-valuenow={measured}
        aria-valuemin={PANE_MIN}
        aria-valuemax={most}
        tabIndex={0}
        title={t.app.code.resize}
        className={cn(
          "absolute inset-y-2 left-0 z-30 w-1.5 cursor-col-resize rounded-full transition-colors hover:bg-foreground/15 focus-visible:bg-foreground/25 focus-visible:outline-none",
          dragging && "bg-foreground/25",
        )}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
        }}
        onPointerMove={(event) => {
          // Asked of the element, not of what was drawn last: the first moves come before that.
          if (!event.currentTarget.hasPointerCapture(event.pointerId) || !pane.current) return;
          set(pane.current.getBoundingClientRect().right - event.clientX, false);
        }}
        onPointerUp={ended}
        onPointerCancel={ended}
        onLostPointerCapture={ended}
        onDoubleClick={() => set(null)}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") set(now() + 24);
          else if (event.key === "ArrowRight") set(now() - 24);
          else if (event.key === "Home") set(null);
          else return;
          event.preventDefault();
        }}
      />
      {/* While dragged, nothing under the pointer takes it: a page in a frame would. */}
      {dragging && <div className="absolute inset-0 z-20 cursor-col-resize" />}
      {wide ? (
        children
      ) : (
        // The narrow panel scrolls under its title: its edge and its title stay where they are.
        <div className="grid h-full grid-rows-[auto_minmax(0,1fr)]">
          <div>{head}</div>
          <div className="overflow-y-auto px-1.5">{children}</div>
        </div>
      )}
    </aside>
  );
}

/** The start of a new conversation: who to talk to, the first message, and where the person left off. */
function Home({ me, onChange, side, bar }: { me: Me; onChange(): void; side: Side; bar: Bar }) {
  const { t, ago } = useI18n();
  const { data, error } = useLoad(() =>
    api<{ agents: AppAgent[]; canRun: boolean }>("/api/app/agents"),
  );
  // Who answers is not something to choose before speaking: it is the person's usual
  // agent (the general assistant unless they set another), and "@" calls a different one.
  const [called, setCalled] = useState<string | null>(calledAgent);
  // Taken once: the next visit to this page starts with the usual agent again.
  useEffect(forgetCall, []);
  const [projectId, setProjectId] = useState<string | null>(preferredProject);
  // The mode the next conversation starts in: the person's own choice.
  const [mode, setWanted] = useState<Mode>(preferredMode);
  /**
   * The suggestions are a short course (Q-1): first what the person has not used yet, each
   * giving way once it has been, then the everyday ones.
   */
  const lessons = [
    { text: t.app.lessons.file, used: side.files.length > 0 },
    { text: t.app.lessons.document, used: side.documents.length > 0 },
    { text: t.app.lessons.schedule, used: side.schedules > 0, schedule: "weekly" as const },
  ].filter((lesson) => !lesson.used);
  const suggestions = [
    ...lessons,
    ...t.app.starters
      .filter((text) => !lessons.some((lesson) => lesson.text === text))
      .map((text) => ({ text, schedule: undefined })),
  ].slice(0, 4);
  // A project made or picked elsewhere (the sidebar, the dialog) is the one new work starts in.
  const remembered = preferredProject();
  useEffect(() => setProjectId(remembered), [remembered]);
  // New work starts in a project the person works in: one they were brought into only
  // to see is not among the choices.
  const workable = side.projects.filter(worksIn);
  const project = workable.find((item) => item.id === projectId);
  const { busy, error: failure, run } = useAction();
  const [seed, setSeed] = useState<{ text: string; n: number }>();
  const usable = data?.agents.filter((agent) => agent.state === "published") ?? [];
  const agent =
    usable.find((candidate) => candidate.id === preferredAgent()) ?? generalOf(usable) ?? usable[0];
  /** The agent called for this conversation from its own page. */
  const guest = usable.find((candidate) => candidate.id === called && candidate.id !== agent?.id);
  const start = async (content: string, files: FileItem[], skills: string[], agentId?: string) =>
    (await run(async () => {
      if (!agent) return false;
      const { id } = await api<{ id: string }>("/api/app/conversations", {
        method: "POST",
        // An agent invited in the first message is the one the conversation starts with.
        body: {
          agentId: agentId ?? guest?.id ?? agent.id,
          mode,
          ...(project ? { projectId: project.id } : {}),
        },
      });
      try {
        await api(`/api/app/conversations/${id}/messages`, {
          method: "POST",
          body: {
            content,
            files: files.map((file) => file.id),
            ...(skills.length ? { skills } : {}),
            ...(await deviceFor(project?.id ?? null)),
            ui: UI_VERSION,
          },
        });
      } catch (refused) {
        // The server said no, so the conversation made for it would be an empty one in the list.
        // A lost connection is different: the message may have arrived, and its conversation stays.
        if (refused instanceof ApiError)
          await api(`/api/app/conversations/${id}`, { method: "DELETE" }).catch(() => undefined);
        throw refused;
      }
      onChange();
      goApp(`c/${id}`);
      return true;
    })) === true;
  return (
    <div className="glass-strong flex min-w-0 flex-1 flex-col rounded-xl">
      <PaneBar bar={bar}>
        <span className="font-medium">{t.app.newChat}</span>
      </PaneBar>
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        {/* The start page is one thing to do, in the middle of the page: say what you need.
            It sits a little above the middle, where the eye rests, and never against the top. */}
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center gap-4 px-4 pt-8 pb-[14vh]">
          <h2 className="text-center text-3xl font-semibold tracking-tight">
            {t.app.greeting((me.user.name || me.user.email).split(/[ @]/)[0] ?? "")}
          </h2>
          {error && <Notice tone="bad">{error}</Notice>}
          {data && !data.canRun && <Notice>{t.app.noModel}</Notice>}
          {failure && <Notice tone="bad">{failure}</Notice>}
          {/* Above the suggestions under it, so the lists the box opens are not painted over. */}
          <div className="relative z-10 grid gap-2 pt-2">
            <Composer
              large
              onInvite={() => setCalled(null)}
              seed={seed}
              placeholder={t.app.composerHome}
              disabled={!agent || !data?.canRun || busy}
              running={false}
              onSend={start}
              side={side}
              bar={
                <>
                  {guest && (
                    <span className="flex h-7 max-w-56 items-center gap-1 rounded-full bg-foreground/8 pr-1 pl-2.5 text-[13px] font-medium">
                      <AtSignIcon className="size-3.5 shrink-0" />
                      <span className="truncate">{shownAgent(guest)}</span>
                      <button
                        type="button"
                        aria-label={t.common.remove}
                        className="rounded-full p-0.5 hover:bg-foreground/10"
                        onClick={() => setCalled(null)}
                      >
                        <XIcon className="size-3" />
                      </button>
                    </span>
                  )}
                  {/* Always there: hidden until a mode was chosen (Q-3), nobody found it, and
                      people allowed one action after another (the owner, 2026-11-21). */}
                  <ModeChip
                    mode={mode}
                    onChoose={(next) => {
                      preferMode(next);
                      setWanted(next);
                    }}
                  />
                </>
              }
            />
            {/* Where the work is, on a shelf under the box: the project this conversation
                starts in, chosen or made from here. Always there, with no project too: the
                way to make the first one is where it will be chosen afterwards. */}
            <div className="mx-4 -mt-2 flex items-center gap-1 rounded-b-2xl bg-foreground/[0.04] px-2 py-1.5">
              <ProjectPicker
                projects={workable}
                chosen={project}
                onChoose={(id) => {
                  preferProject(id);
                  setProjectId(id);
                }}
                onNew={side.newProject}
                onSettings={
                  project?.role === "owner" ? () => side.editProject(project.id) : undefined
                }
              />
            </div>
            {/* Only an agent called from its own page is described here. "@" and "/" are taught
                by what happens, not by a line under the box (Q-2). */}
            {guest && (
              <p className="px-1 text-xs text-muted-foreground">
                {`${t.app.described[guest.description] ?? guest.description}${guest.tools.includes("web.send") ? ` ${t.app.asksFirst}` : ""}`}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            {suggestions.map((starter, index) => (
              <button
                type="button"
                key={starter.text}
                className="glass-thick flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] hover:bg-accent/60"
                onClick={() => {
                  // Work that runs on its own is set up on its own form, with these words in it.
                  if (starter.schedule) {
                    seedSchedule({ text: starter.text, kind: starter.schedule });
                    goApp("schedules");
                  } else setSeed({ text: starter.text, n: index + Date.now() });
                }}
              >
                {starter.text}
                <ArrowUpRightIcon className="size-3.5 text-muted-foreground" />
              </button>
            ))}
          </div>
          {side.documents.length > 0 && (
            <div className="grid gap-1 pt-4">
              <h3 className="section-title px-0">{t.app.recentDocuments}</h3>
              <div className="glass-thick grid rounded-xl p-1 md:grid-cols-2">
                {side.documents.slice(0, 6).map((doc) => (
                  <button
                    type="button"
                    key={doc.id}
                    className="row"
                    onClick={() => goApp(`documents/${encodeURIComponent(doc.title)}`)}
                  >
                    <FileTypeIcon note small className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{doc.title}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {ago(doc.updatedAt)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface Live {
  running: boolean;
  text: string;
  steps: Step[];
  plan: PlanItem[];
  approval: Approval | null;
  writing: Writing | null;
  /** Characters the model has thought so far, while it has not yet said or done anything. */
  thinking: number | null;
}
const idle: Live = {
  running: false,
  text: "",
  steps: [],
  plan: [],
  approval: null,
  writing: null,
  thinking: null,
};

function Conversation({
  id,
  onChange,
  side,
  bar,
}: {
  id: string;
  onChange(): void;
  side: Side;
  bar: Bar;
}) {
  const { t, errorText } = useI18n();
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  // What the open work pane counted: said on its buttons. Not known while it is away.
  const [counts, setCounts] = useState<Record<string, number>>({});
  // biome-ignore lint/correctness/useExhaustiveDependencies: another conversation's counts are not this one's
  useEffect(() => {
    if (!side.open) setCounts({});
  }, [side.open, id]);
  // The conversation's project, for what is done on this computer; read by handlers that outlive a render.
  const projectOf = useRef<string | null>(null);
  projectOf.current = detail?.projectId ?? null;
  const inProject = side.projects.find((item) => item.id === detail?.projectId);
  const [missing, setMissing] = useState<string | null>(null);
  const [live, setLive] = useState<Live>(idle);
  const { error, run } = useAction();
  // The mode is being kept: a second choice waits, so two answers cannot cross.
  const [changing, setChanging] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  /**
   * Whether the list goes down with what is being written. It does while the person is at
   * the end of it; once they scroll up to read, their place is theirs until they come
   * back down or ask for the latest (CHA-270). The phone app goes by the same rule.
   */
  const following = useRef(true);
  const [away, setAway] = useState(false);
  /** Where the list last stood: only coming back down to the end starts following again. */
  const stood = useRef(0);
  /** The person has moved to read further up: nothing pulls them back from here. */
  const leave = useCallback(() => {
    following.current = false;
    setAway(true);
  }, []);
  const toLatest = useCallback(() => {
    following.current = true;
    setAway(false);
    const list = end.current?.closest<HTMLElement>("[data-scroller]");
    if (list) list.scrollTop = list.scrollHeight;
  }, []);
  // An action that waits for the person is at the end: they are taken to it, wherever
  // they were reading. Nothing else on the page says that the run now waits.
  const asking = live.approval?.id;
  useEffect(() => {
    if (asking) toLatest();
  }, [asking, toLatest]);
  // The keys that go up say the same as the wheel does.
  useEffect(() => {
    const list = end.current?.closest<HTMLElement>("[data-scroller]");
    const onKey = (event: KeyboardEvent) => {
      if (["PageUp", "ArrowUp", "Home"].includes(event.key)) leave();
    };
    list?.addEventListener("keydown", onKey);
    return () => list?.removeEventListener("keydown", onKey);
  }, [leave]);
  // Another conversation is read from its end.
  // biome-ignore lint/correctness/useExhaustiveDependencies: again for each conversation
  useEffect(() => {
    following.current = true;
    setAway(false);
  }, [id]);
  const changed = useRef(onChange);
  changed.current = onChange;
  const translate = useRef(errorText);
  translate.current = errorText;
  /** What the desktop app says when something happens while its window is in the background. */
  const words = useRef({ approval: "", approvalLead: "", ready: "" });
  words.current = {
    approval: t.app.approval.title,
    approvalLead: t.app.approval.lead(shownAgent(detail?.agent)),
    ready: t.app.replyReady,
  };

  const latest = useRef(0);
  const load = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const loaded = await api<ConversationDetail>(`/api/app/conversations/${id}`);
      // An older answer must not replace a newer one.
      if (mine !== latest.current) return;
      setMissing(null);
      setDetail(loaded);
      // A reply the server says is being written is shown as being written, even if the
      // stream that tells of it was away when it began.
      const going = loaded.messages.some((message) => message.status === "running");
      setLive((now) => ({
        ...now,
        running: now.running || going,
        approval: now.approval ?? loaded.approvals[0] ?? null,
      }));
    } catch (failure) {
      setMissing(translate.current(failure));
    }
  }, [id]);

  useEffect(() => {
    void load();
    // The stream is opened once every handler below is known (`open`), and opened again when
    // it has gone quiet: see the end of this effect.
    const handlers: [string, (event: MessageEvent) => void][] = [];
    const on = <T extends LiveEvent["type"]>(
      type: T,
      handle: (event: Extract<LiveEvent, { type: T }>) => void,
    ) => handlers.push([type, (event) => handle(JSON.parse(event.data))]);
    // What an agent asks of this computer is done here, in the project's folders, and
    // answered once. A browser has no folders and says nothing: the desktop app the
    // message was sent from is the one that answers.
    const answered = new Set<string>();
    const onDevice = async (call: DeviceCall) => {
      if (!desktop || answered.has(call.id)) return;
      answered.add(call.id);
      // The call can arrive before the conversation has loaded and said which project it is in.
      for (let waited = 0; !projectOf.current && waited < 10_000; waited += 200)
        await new Promise((resolve) => setTimeout(resolve, 200));
      const project = projectOf.current;
      if (!project) return;
      // The page only says which call this is. The app does it and answers the server
      // itself, once, whether it heard of the call from the page or over its own connection.
      const result = await desktop
        .local(project, call.tool, call.args, { conversation: id, id: call.id })
        .catch(() => ({
          ok: false,
          text: "That could not be done on this computer.",
        }));
      // The app has it in hand by another way.
      if ("skip" in result && result.skip) return;
      await api(`/api/app/conversations/${id}/device/${call.id}`, {
        method: "POST",
        body: { ok: result.ok, text: result.text.slice(0, 380_000) },
      }).catch(() => undefined);
    };
    on("device", (event) => void onDevice(event.call));
    on("state", (event) => {
      for (const call of event.device ?? []) void onDevice(call);
      // The server's word on whether a run is going is final. If none is, what the page
      // holds may be out of date (the run ended while the stream was away): fetch it again.
      if (!event.running) void load();
      setLive({
        running: event.running,
        text: event.text,
        steps: event.steps,
        plan: event.plan,
        approval: event.approval,
        writing: event.writing ?? null,
        thinking: event.thinking ?? null,
      });
    });
    on("writing", (event) =>
      setLive((now) => ({ ...now, running: true, thinking: null, writing: event.writing })),
    );
    on("thinking", (event) => setLive((now) => ({ ...now, running: true, thinking: event.chars })));
    on("text", (event) =>
      setLive((now) => ({ ...now, running: true, thinking: null, text: now.text + event.delta })),
    );
    on("step", (event) =>
      setLive((now) => ({
        ...now,
        running: true,
        // The call that was being written has now begun.
        writing: null,
        // What the agent said before going to work is now a step in its place, not the reply so far.
        text: event.step.tool === NOTE ? "" : now.text,
        steps: now.steps.some((step) => step.id === event.step.id)
          ? now.steps.map((step) => (step.id === event.step.id ? event.step : step))
          : [...now.steps, event.step],
      })),
    );
    on("plan", (event) => setLive((now) => ({ ...now, running: true, plan: event.plan })));
    on("approval", (event) => {
      setLive((now) => ({ ...now, approval: event.approval }));
      if (event.approval) notify("approvals", words.current.approval, words.current.approvalLead);
      changed.current();
    });
    on("done", (event) => {
      notify("replies", event.title, words.current.ready);
      setLive(idle);
      // A reply that did not finish, however it was stopped (here, on another device, by a
      // fault): the commands it was waiting on are ended on this computer. Jobs go on.
      if (event.message.status !== "complete" && projectOf.current)
        void desktop?.halt?.(projectOf.current).catch(() => undefined);
      // Any load still on its way predates this reply; ask again so the page ends on the truth.
      void load();
      setDetail(
        (now) =>
          now && { ...now, title: event.title, messages: merge(now.messages, event.message) },
      );
      changed.current();
    });
    // A stream can die without closing: after the window sat in the background (the system
    // put the app to sleep, a proxy dropped the connection) it looked open and nothing came,
    // while the desktop app went on doing the work over its own channel. The page stood on
    // an approval already given until it was reloaded (found trying C1, 2026-11-22). The
    // server says something at least every 25 seconds, so a minute of silence, or the window
    // coming back to the front after a quiet spell, opens it again; the server begins every
    // stream with where the conversation stands.
    let source: EventSource | null = null;
    let heard = Date.now();
    const open = () => {
      source?.close();
      heard = Date.now();
      const next = new EventSource(`/api/app/conversations/${id}/events`);
      for (const [type, handle] of handlers)
        next.addEventListener(type, (event) => {
          heard = Date.now();
          handle(event as MessageEvent);
        });
      next.addEventListener("ping", () => {
        heard = Date.now();
      });
      source = next;
    };
    open();
    const watch = setInterval(() => {
      if (Date.now() - heard > 60_000) open();
    }, 15_000);
    const back = () => {
      if (document.visibilityState === "visible" && Date.now() - heard > 30_000) open();
    };
    document.addEventListener("visibilitychange", back);
    window.addEventListener("focus", back);
    return () => {
      clearInterval(watch);
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("focus", back);
      source?.close();
    };
  }, [id, load]);

  // While a reply is being written the page asks now and then whether it still is. If the
  // stream dropped and the end was missed, the page would otherwise sit on "working" for good.
  useEffect(() => {
    if (!live.running) return;
    // An answer that arrives after this run is over is about a run that is gone.
    let current = true;
    const timer = setInterval(() => {
      void api<ConversationDetail>(`/api/app/conversations/${id}`).then(
        (loaded) => {
          if (!current || loaded.messages.some((message) => message.status === "running")) return;
          setDetail(loaded);
          setLive(idle);
        },
        () => undefined,
      );
    }, 20_000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [id, live.running]);

  /**
   * Who the person is talking to, as the page says it. A conversation nobody called an
   * agent for is with Muster: the person's usual agent answers, and passes a step to
   * another when one fits (CHA-271, CHA-264). The server says which agent that is. What
   * an agent asks leave for, and the record, still name the agent itself.
   */
  const answers = shownAgent(detail?.agent);
  const count = detail?.messages.length ?? 0;
  // Which replies' file changes the desktop app can still put back (CHA-274).
  const [undoable, setUndoable] = useState<Map<string, string[]>>(new Map());
  const [undone, setUndone] = useState<Record<string, string>>({});
  const project = detail?.projectId ?? null;
  const readUndoable = useCallback(() => {
    if (!project) return;
    void desktop
      ?.undoable?.(project)
      .then((list) => setUndoable(new Map(list.map((one) => [one.reply, one.files]))))
      .catch(() => undefined);
  }, [project]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again when a reply ends
  useEffect(readUndoable, [readUndoable, count, live.running]);
  const undoReply = async (reply: string) => {
    // Which files will change is said before anything does: how many, and the first of them.
    const files = undoable.get(reply) ?? [];
    if (!project || !(await confirm(t.app.code.undo, t.app.code.undoFiles(files)))) return;
    const said = (await desktop?.undo?.(project, reply).catch(() => [])) ?? [];
    setUndone((now) => ({ ...now, [reply]: said.join("\n") || t.app.code.undoNothing }));
    readUndoable();
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls whenever the conversation grows
  useEffect(() => {
    // Only the conversation's own list moves. Bringing the end "into view" would also
    // slide every box around it, and the whole app with them.
    const list = end.current?.closest<HTMLElement>("[data-scroller]");
    if (list && following.current) list.scrollTop = list.scrollHeight;
  }, [count, live.text, live.steps.length, live.plan, live.approval]);

  const send = useCallback(
    async (
      content: string,
      files: { id: string }[] = [],
      skills: string[] = [],
      agentId?: string,
    ) =>
      (await run(async () => {
        // What the person just said is at the end: they are taken there.
        toLatest();
        const sent = await api<
          { userMessage: Message; assistantMessage: Message } | { aside: true }
        >(`/api/app/conversations/${id}/messages`, {
          method: "POST",
          body: {
            content,
            files: files.map((file) => file.id),
            ...(skills.length ? { skills } : {}),
            ...(agentId ? { agentId } : {}),
            ...(await deviceFor(projectOf.current, id)),
            ui: UI_VERSION,
          },
        });
        // Added to the reply being written: it shows among that reply's steps, as the
        // stream reports it. There is no new message and no new reply.
        if ("aside" in sent) return true;
        setDetail(
          (now) =>
            now && {
              ...now,
              // The reply may already have finished; keep the finished one.
              messages: merge([sent.userMessage, sent.assistantMessage], ...now.messages),
            },
        );
        // Taken: said at once, whether or not the stream of the run has spoken yet.
        if (sent.assistantMessage.status === "running")
          setLive((now) => (now.running ? now : { ...idle, running: true }));
        return true;
      })) === true,
    [id, run, toLatest],
  );
  /** Answers a form in the last reply. The server writes the message from the form and the values. */
  const answer = useCallback<AnswerForm>(
    async (action) => {
      const taken =
        (await run(async () => {
          const sent = await api<
            { userMessage: Message; assistantMessage: Message } | { aside: true }
          >(`/api/app/conversations/${id}/messages`, {
            method: "POST",
            // The folders of this computer go with an answer as with any message.
            body: { action, ui: UI_VERSION, ...(await deviceFor(projectOf.current, id)) },
          });
          // The server never takes an answer as words added to a run. If it ever said so,
          // the form was not answered.
          if ("aside" in sent) return false;
          setDetail(
            (now) =>
              now && {
                ...now,
                messages: merge([sent.userMessage, sent.assistantMessage], ...now.messages),
              },
          );
          if (sent.assistantMessage.status === "running")
            setLive((now) => (now.running ? now : { ...idle, running: true }));
          return true;
        })) === true;
      // Refused: the conversation is not as this page shows it (answered elsewhere, or moved
      // on). It is read again, so the form shows where it now stands.
      if (!taken) void load();
      return taken;
    },
    [id, run, load],
  );
  /** Goes on with the last reply from what it had already done. */
  const goOn = () =>
    void run(async () => {
      const sent = await api<{ userMessage: Message; assistantMessage: Message }>(
        `/api/app/conversations/${id}/continue`,
        { method: "POST", body: { ...(await deviceFor(projectOf.current, id)), ui: UI_VERSION } },
      );
      setDetail(
        (now) =>
          now && {
            ...now,
            // The same reply, being written again: its old ending no longer stands.
            messages: now.messages.map((item) =>
              item.id === sent.assistantMessage.id ? sent.assistantMessage : item,
            ),
          },
      );
      setLive((now) =>
        now.running
          ? now
          : {
              ...idle,
              running: true,
              steps: sent.assistantMessage.steps,
              plan: sent.assistantMessage.plan,
            },
      );
    });
  const stop = () =>
    void run(async () => {
      await api(`/api/app/conversations/${id}/stop`, { method: "POST" });
      // The commands the run was waiting on are ended on this computer. Jobs go on.
      if (projectOf.current) await desktop?.halt?.(projectOf.current).catch(() => undefined);
    });
  const { confirm, dialog } = useConfirm();
  const remove = async () => {
    if (!(await confirm(t.app.delete, t.app.deleteConfirm))) return;
    await run(async () => {
      await api(`/api/app/conversations/${id}`, { method: "DELETE" });
      onChange();
      goApp("");
    });
  };
  /** The title while it is being edited; null when it is just shown. */
  const [naming, setNaming] = useState<string | null>(null);
  const rename = () => {
    const title = naming?.trim();
    setNaming(null);
    if (!title || title === detail?.title) return;
    void run(async () => {
      await api(`/api/app/conversations/${id}`, { method: "PATCH", body: { title } });
      setDetail((now) => now && { ...now, title });
      onChange();
    });
  };
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (message: Message) =>
    void navigator.clipboard.writeText(readableText(message.content)).then(() => {
      setCopied(message.id);
      setTimeout(() => setCopied((now) => (now === message.id ? null : now)), 1500);
    });

  const running = live.running;
  const actions = useMemo(() => ({ send, disabled: running }), [send, running]);
  const usable = detail?.agent.state === "published";
  // A message for, or a reply by, an agent other than the conversation's own.
  const guest = (message: Message) =>
    Boolean(message.agentId && message.agentName && message.agentId !== detail?.agent.id);
  const replies = detail?.messages.filter((message) => message.role === "assistant") ?? [];
  /** Documents this conversation read or saved, newest first, each once. */
  /** The person's file with this name, newest first: how a step that names a file finds it. */
  const fileNamed = useCallback(
    (name: string) => side.files.find((file) => file.name === name),
    [side.files],
  );
  const makes = (step: Step) =>
    (step.tool === "files.create" || step.tool === "files.change") && step.status === "ok";
  /**
   * Files an agent made or changed while writing a reply. A step says which file by its
   * id (CHA-269): a file uploaded later under the same name is another file. Replies
   * written before steps said so are matched by name, as they always were.
   */
  const madeBy = (message: Message) =>
    message.steps.flatMap((step) => {
      // What a run of code kept for the person: one file or several, each by its id.
      if (step.tool === "code.run")
        return step.status === "ok"
          ? (step.files ?? (step.file ? [step.file] : [])).flatMap((id) => {
              const kept = side.files.find((one) => one.id === id);
              return kept ? [kept] : [];
            })
          : [];
      const file =
        makes(step) &&
        (step.file ? side.files.find((one) => one.id === step.file) : fileNamed(step.detail));
      // A file built or changed in several steps is one file.
      return file ? [file] : [];
    });
  /** The names of files a reply made that are no longer there. */
  const goneFrom = (message: Message) => [
    ...new Set(
      message.steps.flatMap((step) =>
        // The server says so. The page's own list is cut at the newest few hundred and is
        // read after a reply ends: a file missing from it may only not be in it yet.
        makes(step) && step.file && detail?.gone?.includes(step.file) ? [step.detail] : [],
      ),
    ),
  ];
  // The newest reply that made or changed each file: its card speaks for the file's version.
  const lastMade = new Map<string, string>();
  for (const reply of replies) for (const file of madeBy(reply)) lastMade.set(file.id, reply.id);
  const touched = useMemo(() => {
    const seen = new Map<string, { how: "saved" | "read"; file: boolean }>();
    for (const step of [...replies.flatMap((message) => message.steps), ...live.steps]) {
      if (step.status !== "ok" || !step.detail) continue;
      const file = step.tool.startsWith("files.");
      if (
        step.tool === "docs.write" ||
        step.tool === "files.create" ||
        step.tool === "files.change"
      )
        seen.set(step.detail, { how: "saved", file });
      else if ((step.tool === "docs.read" || step.tool === "files.read") && !seen.has(step.detail))
        seen.set(step.detail, { how: "read", file });
    }
    return [...seen].reverse();
  }, [replies, live.steps]);
  const openFile = useOpenFile();
  // The pages agents read here, newest first, each once.
  const pages = useMemo(() => {
    const seen = new Set<string>();
    for (const step of [...replies.flatMap((reply) => reply.steps ?? []), ...live.steps])
      if (step.tool === "web.fetch" && step.status === "ok" && step.detail) seen.add(step.detail);
    return [...seen].reverse();
  }, [replies, live.steps]);
  // What a draft's card is told about the reply it is in.
  const HOLDS_DRAFT = /\b(?:MailDraft|TeamsDraft)\(/;
  const lastDraft = replies.findLast((reply) => HOLDS_DRAFT.test(reply.content))?.id;
  // Anything an agent took in that is not the person's own words: a page, a mailbox, a
  // chat, a company system, a file, a knowledge base, a folder. The same list the server
  // goes by before it keeps a memory. It counts from the first reply that read any: a
  // draft written two replies later still stands on it.
  const READ_OUTSIDE =
    /^(?:web\.|m365\.|company\.|files\.read|knowledge\.search|local\.(?:read|search|list))/;
  const firstOutside = replies.findIndex((reply) =>
    (reply.steps ?? []).some((step) => step.status === "ok" && READ_OUTSIDE.test(step.tool)),
  );
  const draftScope = (message: (typeof replies)[number]) => ({
    messageId: message.id,
    outside: firstOutside >= 0 && replies.indexOf(message) >= firstOutside,
    superseded: HOLDS_DRAFT.test(message.content) && message.id !== lastDraft,
  });

  return (
    <ReplyActions.Provider value={actions}>
      <DraftsProvider conversation={id} beat={count}>
        <div className="glass-strong flex min-w-0 flex-1 flex-col rounded-xl">
          <PaneBar bar={bar}>
            {naming === null ? (
              <button
                type="button"
                title={t.app.rename}
                className="min-w-0 truncate rounded px-1 font-medium hover:bg-accent"
                onClick={() => detail && setNaming(detail.title)}
              >
                {detail?.title || t.app.untitled}
              </button>
            ) : (
              <input
                // biome-ignore lint/a11y/noAutofocus: the person just asked to edit this
                autoFocus
                value={naming}
                maxLength={120}
                aria-label={t.app.rename}
                className="h-6 min-w-0 flex-1 rounded border bg-background px-1 font-medium outline-none focus:border-ring"
                onChange={(event) => setNaming(event.target.value)}
                onBlur={rename}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) rename();
                  if (event.key === "Escape") setNaming(null);
                }}
              />
            )}
            {detail && (
              <>
                <span className="shrink-0 text-muted-foreground">{answers}</span>
                <MoreMenu
                  className="ml-auto"
                  label={t.common.more}
                  items={[
                    { label: t.app.delete, destructive: true, onSelect: () => void remove() },
                  ]}
                />
                {desktop && (
                  // Each view of the work pane has its own button: one press shows it, a
                  // second puts the pane away. A conversation outside a project has the one.
                  <div className="hidden shrink-0 items-center gap-0.5 lg:flex">
                    {(detail.projectId ? PANE_VIEWS : PANE_VIEWS.slice(0, 1)).map(
                      ([name, Icon]) => {
                        const on = side.open && (detail.projectId ? side.view === name : true);
                        const label = t.app.code[name];
                        return (
                          <Button
                            key={name}
                            variant="ghost"
                            size="icon"
                            className={cn("relative size-7", on && "bg-accent")}
                            aria-pressed={on}
                            title={label}
                            aria-label={label}
                            // Outside a project there is the one view: its button opens and closes.
                            onClick={() => (detail.projectId ? side.show(name) : side.toggle())}
                          >
                            <Icon className="size-4" />
                            {/* What changed and what runs is said on the button, whatever view is in front. */}
                            {detail.projectId && (counts[name] ?? 0) > 0 && (
                              <span className="num absolute -top-0.5 -right-0.5 min-w-3.5 rounded-full bg-primary px-0.5 text-center text-[9px] leading-3.5 font-medium text-primary-foreground">
                                {(counts[name] ?? 0) > 99 ? "99+" : counts[name]}
                              </span>
                            )}
                          </Button>
                        );
                      },
                    )}
                  </div>
                )}
              </>
            )}
          </PaneBar>
          <div
            data-scroller
            className="relative min-h-0 flex-1 overflow-y-auto"
            // Going up is a wish to read, from its first movement: text that arrives in
            // that moment must not pull the list back before 80 px are covered.
            onWheel={(event) => {
              if (event.deltaY < 0) leave();
            }}
            onTouchMove={leave}
            onScroll={(event) => {
              const list = event.currentTarget;
              const near = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
              const down = list.scrollTop >= stood.current;
              stood.current = list.scrollTop;
              if (!near) leave();
              else if (down) {
                following.current = true;
                setAway(false);
              }
            }}
          >
            <div className="mx-auto grid w-full max-w-3xl grid-cols-[minmax(0,1fr)] gap-3 px-4 py-4">
              {missing && <Notice tone="bad">{missing}</Notice>}
              {!detail && !missing && <Loading />}
              {detail?.messages.flatMap((message) => [
                message.role === "user" && message.origin === "followup" ? (
                  <CameBack key={message.id} content={message.content} />
                ) : message.role === "user" ? (
                  <div
                    key={message.id}
                    className="ml-auto grid max-w-[85%] justify-items-end gap-1"
                  >
                    {message.attachments.length > 0 && (
                      <div className="flex flex-wrap justify-end gap-1.5">
                        {message.attachments.map((file) => (
                          <FileChip key={file.id} file={file} />
                        ))}
                      </div>
                    )}
                    {readAction(message.action) && (
                      <AnswerCard action={readAction(message.action) as FormAction} />
                    )}
                    {message.content && !readAction(message.action) && (
                      <div className="rounded-2xl bg-secondary px-3 py-1.5 text-sm whitespace-pre-wrap break-words">
                        {guest(message) && (
                          <span className="mr-1.5 font-medium text-brand-text">
                            @{message.agentName}
                          </span>
                        )}
                        {message.content}
                      </div>
                    )}
                  </div>
                ) : message.status === "running" && running ? (
                  <div
                    key={message.id}
                    className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 text-sm"
                    aria-live="polite"
                  >
                    {/* What the agent said as it went to work, in its own words. */}
                    {said(live.steps)
                      .slice(-2)
                      .map((note) => (
                        <Said key={note.id} step={note} />
                      ))}
                    {/* The plan sits just above what is being done now, and stays there afterwards. */}
                    <PlanCard plan={live.plan} live />
                    <StepScope.Provider value={id}>
                      <Activity
                        steps={live.steps}
                        running
                        doing={
                          live.approval || live.writing || live.text ? undefined : (
                            <Doing
                              inline
                              steps={live.steps}
                              thinking={live.thinking}
                              beat={`${live.steps.length}:${live.steps.at(-1)?.status ?? ""}`}
                            />
                          )
                        }
                      />
                    </StepScope.Provider>
                    {!live.approval && live.steps.at(-1)?.status !== "running" && (
                      <SlowNote
                        beat={`${live.text.length}:${live.steps.length}:${live.steps.at(-1)?.status ?? ""}:${live.writing?.size ?? 0}:${live.thinking ?? 0}`}
                      />
                    )}
                    <Reply
                      text={live.text}
                      streaming
                      fallback={
                        live.approval ||
                        live.writing ||
                        live.steps.at(-1)?.status === "running" ||
                        // Once there are steps, their line says what is happening now.
                        live.steps.some((step) => !spoken(step)) ? null : (
                          <Doing
                            steps={live.steps}
                            thinking={live.thinking}
                            beat={`${live.steps.length}:${live.steps.at(-1)?.status ?? ""}`}
                          />
                        )
                      }
                    />
                    {live.writing && !live.approval && (
                      <p className="flex min-w-0 items-center gap-2 text-[13px] text-muted-foreground">
                        <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin" />
                        <span className="shrink-0">
                          {Object.hasOwn(t.app.toolDoing, live.writing.tool)
                            ? t.app.toolDoing[live.writing.tool]
                            : t.app.working}
                        </span>
                        {live.writing.detail && (
                          <span className="truncate font-mono text-xs">{live.writing.detail}</span>
                        )}
                        {live.writing.size >= 200 && (
                          <span className="shrink-0 tabular-nums">
                            {t.app.written(live.writing.size)}
                          </span>
                        )}
                      </p>
                    )}
                    {live.approval && (
                      <ApprovalCard
                        approval={live.approval}
                        // The agent that wants it: one a step was passed to, when it is not the reply's own.
                        // The server names it as it is shown (the general agent as Muster).
                        agentName={live.approval.agentName || answers}
                        onAskLess={
                          detail.mode === "ask"
                            ? async () => {
                                await api(`/api/app/conversations/${id}/mode`, {
                                  method: "PUT",
                                  body: { mode: "auto" },
                                });
                                setDetail((now) => now && { ...now, mode: "auto" });
                              }
                            : undefined
                        }
                      />
                    )}
                  </div>
                ) : (
                  <div
                    key={message.id}
                    className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 text-sm"
                  >
                    {guest(message) && (
                      <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                        <AtSignIcon className="size-3" />
                        {message.agentName}
                      </span>
                    )}
                    {/*
                      Once the reply is over, what the agent said along the way is in the list
                      of steps, each in its place, one press away: a long piece of work said a
                      dozen such lines, and they stood above the answer (CHA-268). What the
                      person added stays in sight: it is theirs. So do the agent's words when
                      there is no list to hold them.
                    */}
                    {said(message.steps ?? [])
                      .filter(
                        (note) =>
                          note.tool === ASIDE ||
                          !(message.steps ?? []).some((step) => !spoken(step)),
                      )
                      .map((note) => (
                        <Said key={note.id} step={note} quiet />
                      ))}
                    <PlanCard plan={message.plan} live={false} />
                    <StepScope.Provider value={id}>
                      <Activity steps={message.steps} running={false} />
                    </StepScope.Provider>
                    <DraftScope.Provider value={draftScope(message)}>
                      <FormScope.Provider
                        value={formPlace(message, detail.messages, answers, answer)}
                      >
                        <Reply text={message.content} streaming={false} />
                      </FormScope.Provider>
                    </DraftScope.Provider>
                    {madeBy(message).length > 0 && (
                      // What the reply made, each as a card with the thing itself in small.
                      <div className="flex flex-wrap gap-2">
                        {[...new Map(madeBy(message).map((file) => [file.id, file])).values()].map(
                          (file) => (
                            <ResultCard
                              key={file.id}
                              file={file}
                              latest={lastMade.get(file.id) === message.id}
                            />
                          ),
                        )}
                      </div>
                    )}
                    <CallTip messageId={message.id} steps={message.steps ?? []} />
                    {goneFrom(message).map((name) => (
                      // The file this reply made was deleted since: said, not left out.
                      <p key={name} className="text-xs text-muted-foreground">
                        {t.app.result.gone(name)}
                      </p>
                    ))}
                    {message.status === "failed" && (
                      <Notice tone="bad">
                        {t.app.failed}
                        {message.endingDetail && (
                          <span className="block pt-0.5 text-xs opacity-80">
                            {message.endingDetail}
                          </span>
                        )}
                      </Notice>
                    )}
                    {message.status === "stopped" &&
                      (message.ending === "allowance" ? (
                        <Notice>{t.app.endedAllowance}</Notice>
                      ) : message.ending === "budget_company" ||
                        message.ending === "budget_department" ||
                        message.ending === "budget_person" ? (
                        <Notice>{t.app.endedBudget[message.ending]}</Notice>
                      ) : (
                        <p className="text-xs text-muted-foreground">{t.app.stopped}</p>
                      ))}
                    {message.status === "complete" && message.ending === "length" && (
                      <Notice>{t.app.endedLength}</Notice>
                    )}
                    {message.status === "complete" && message.ending === "no_steps" && (
                      <Notice>{t.app.endedNoSteps}</Notice>
                    )}
                    {message.status === "complete" && message.ending === "only_read" && (
                      <Notice>{t.app.endedOnlyRead}</Notice>
                    )}
                    {message.status === "complete" && message.ending === "checks_failed" && (
                      <Notice tone="bad">{t.app.endedChecksFailed}</Notice>
                    )}
                    {message.status === "complete" &&
                      message.ending === "walkthrough_unmatched" && (
                        <Unmatched detail={message.endingDetail ?? null} />
                      )}
                    {desktop && detail.projectId && undoable.has(message.id) && (
                      // What this reply changed in the folders can be put back, file by file.
                      <button
                        type="button"
                        className="w-fit text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                        onClick={() => void undoReply(message.id)}
                      >
                        {t.app.code.undo}
                      </button>
                    )}
                    {undone[message.id] && (
                      <p className="text-xs whitespace-pre-wrap text-muted-foreground">
                        {undone[message.id]}
                      </p>
                    )}
                    <div className="flex items-center gap-1 text-muted-foreground">
                      {message.content && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-6"
                          title={t.app.copy}
                          onClick={() => copy(message)}
                        >
                          {copied === message.id ? (
                            <CheckIcon className="size-3.5 text-ok" />
                          ) : (
                            <CopyIcon className="size-3.5" />
                          )}
                          <span className="sr-only">{t.app.copy}</span>
                        </Button>
                      )}
                      {message.id === replies.at(-1)?.id && message.canContinue && (
                        <Button
                          size="sm"
                          className="h-6 gap-1 px-2 text-xs"
                          disabled={running || !usable}
                          title={t.app.continueHint}
                          onClick={goOn}
                        >
                          <PlayIcon className="size-3.5" />
                          {t.app.continueRun}
                        </Button>
                      )}
                      {message.id === replies.at(-1)?.id && message.status !== "complete" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 gap-1 px-1.5 text-xs"
                          disabled={running || !usable}
                          title={message.canContinue ? t.app.retryHint : undefined}
                          onClick={() => {
                            // What the person last said: a line where the agent came back
                            // by itself was written by Muster and is never sent as theirs.
                            const asked = detail.messages.findLast(
                              (item) => item.role === "user" && item.origin !== "followup",
                            );
                            // The same message again, with the files it brought.
                            if (asked) send(asked.content, asked.attachments);
                          }}
                        >
                          <RotateCcwIcon className="size-3.5" />
                          {t.app.retry}
                        </Button>
                      )}
                    </div>
                  </div>
                ),
                // Where the conversation's summary ends: what is above reaches its agents as the summary.
                detail.summary && message.seq === detail.summary.seq ? (
                  <Summarised key={`summary-${message.id}`} summary={detail.summary} />
                ) : null,
              ])}
              <div ref={end} />
            </div>
            {away && (
              // Over the end of the list, in nobody's way: the way back to what is newest.
              <div className="pointer-events-none sticky bottom-3 flex justify-center">
                <button
                  type="button"
                  onClick={toLatest}
                  className="pointer-events-auto flex h-7 items-center gap-1.5 rounded-full border bg-background px-3 text-xs shadow-sm hover:bg-accent"
                >
                  <ArrowDownIcon className="size-3.5" />
                  {t.app.toLatest}
                </button>
              </div>
            )}
          </div>
          <div className="mx-auto grid w-full max-w-3xl gap-2 px-4 pb-3">
            {error && <Notice tone="bad">{error}</Notice>}
            {detail && !usable && (
              <Notice>
                {detail.agent.state === "suspended"
                  ? t.app.builder.suspendedNote
                  : t.app.builder.pendingNote}
              </Notice>
            )}
            {/* Work on one of the company's repositories, done in the sandbox: what changed, and the press that sends it. */}
            {detail && <CloudWork conversationId={id} running={running} />}
            <Composer
              placeholder={
                running ? t.app.aside.placeholder : detail ? t.app.composer(answers) : ""
              }
              disabled={!usable}
              running={running}
              onSend={send}
              onStop={stop}
              side={side}
              bar={
                <>
                  {inProject && (
                    <button
                      type="button"
                      className="flex h-7 max-w-56 items-center gap-1.5 rounded-full bg-foreground/8 px-2.5 text-[13px] font-medium hover:bg-foreground/12"
                      title={t.app.projects.edit}
                      onClick={() => side.editProject(inProject.id)}
                    >
                      <FolderIcon className="size-3.5 shrink-0" />
                      <span className="truncate">{inProject.name}</span>
                    </button>
                  )}
                  {/* The mode, and the way to change it: always there (see the start page). */}
                  {detail && (
                    <ModeChip
                      mode={detail.mode}
                      busy={changing}
                      onChoose={(next) => {
                        if (changing) return;
                        setChanging(true);
                        void run(async () => {
                          await api(`/api/app/conversations/${id}/mode`, {
                            method: "PUT",
                            body: { mode: next },
                          });
                          preferMode(next);
                          setDetail((now) => now && { ...now, mode: next });
                        }).finally(() => setChanging(false));
                      }}
                    />
                  )}
                </>
              }
            />
          </div>
        </div>
        {side.open &&
          (desktop && detail?.projectId ? (
            // In the desktop app, in a project: the work pane, with what the conversation
            // made and read as one of its views.
            <Panel wide key="wide">
              <WorkPane
                view={side.view}
                // From within the pane a view is brought forward, never put away.
                show={(view) => {
                  if (!(side.open && side.view === view)) side.show(view);
                }}
                projectId={detail.projectId}
                conversationId={id}
                // What a button in the pane asks of the agent is said as the person's own message.
                ask={live.running ? undefined : (text) => void send(text)}
                counted={setCounts}
                close={side.toggle}
                mode={t.app.modes.name[detail.mode]}
                context={detail.context}
                compacting={{
                  conversationId: id,
                  running: live.running,
                  messages: detail.messages.length,
                  fresh: detail.messages.filter(
                    (message) => message.seq > (detail.summary?.seq ?? -1),
                  ).length,
                  summarisedAt: detail.summary?.at ?? null,
                  onCompacted: () => void load(),
                }}
                beat={`${live.steps.length}:${live.running}:${count}`}
                work={
                  <Work
                    beside
                    approval={Boolean(live.approval)}
                    touched={touched}
                    pages={pages}
                    versionOf={(title) => fileNamed(title)?.version}
                    onOpen={(title, file) => {
                      const found = file && fileNamed(title);
                      if (found) openFile(found);
                      else goApp(`documents/${encodeURIComponent(title)}`);
                    }}
                  />
                }
              />
            </Panel>
          ) : (
            <Panel
              key="narrow"
              head={
                <>
                  {/* Like the work pane: it says what it is and can be put away where it is. */}
                  <div className="flex h-10 items-center border-b px-3 text-[13px] font-medium">
                    <span className="flex-1">{t.app.code.work}</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="-mr-1 size-7 text-muted-foreground"
                      title={t.common.close}
                      aria-label={t.common.close}
                      onClick={side.toggle}
                    >
                      <XIcon className="size-4" />
                    </Button>
                  </div>
                </>
              }
            >
              <Work
                approval={Boolean(live.approval)}
                touched={touched}
                pages={pages}
                versionOf={(title) => fileNamed(title)?.version}
                onOpen={(title, file) => {
                  const found = file && fileNamed(title);
                  if (found) openFile(found);
                  else goApp(`documents/${encodeURIComponent(title)}`);
                }}
              />
            </Panel>
          ))}
        {dialog}
      </DraftsProvider>
    </ReplyActions.Provider>
  );
}

export function Chat({
  id,
  me,
  onChange,
  side,
  bar,
}: {
  id: string | null;
  me: Me;
  onChange(): void;
  side: Side;
  bar: Bar;
}) {
  return id ? (
    <Conversation key={id} id={id} onChange={onChange} side={side} bar={bar} />
  ) : (
    <Home me={me} onChange={onChange} side={side} bar={bar} />
  );
}

/**
 * What the Walkthrough a reply ended with says that its own steps do not bear out, after
 * the agent was told twice (C1): each point in the person's language, with the files and
 * commands as they are.
 */
function Unmatched({ detail }: { detail: string | null }) {
  const { t } = useI18n();
  const u = t.app.unmatched;
  let gap: {
    missing?: boolean;
    noSummary?: boolean;
    unnamed?: string[];
    notRun?: string[];
    stale?: string[];
    wrong?: { what: string; code: number; ok: boolean }[];
    unlisted?: string[];
    piped?: string[];
    noChecks?: "ran" | "none";
  } = {};
  try {
    gap = JSON.parse(detail ?? "{}") ?? {};
  } catch {
    // Nothing readable: the notice says only that it does not hold.
  }
  const names = (items?: string[]) => (items ?? []).join(", ");
  const points = [
    gap.missing && u.missing,
    gap.noSummary && u.noSummary,
    gap.unnamed?.length && u.unnamed(names(gap.unnamed)),
    gap.notRun?.length && u.notRun(names(gap.notRun)),
    gap.stale?.length && u.stale(names(gap.stale)),
    ...(gap.wrong ?? []).map((wrong) => u.wrong(wrong.what, wrong.code, wrong.ok)),
    gap.unlisted?.length && u.unlisted(names(gap.unlisted)),
    gap.piped?.length && u.piped(names(gap.piped)),
    gap.noChecks === "ran" && u.noChecksRan,
    gap.noChecks === "none" && u.noChecksNone,
  ].filter((point): point is string => typeof point === "string" && point.length > 0);
  return (
    <Notice tone="bad">
      {u.title}
      {points.length > 0 && (
        <ul className="list-disc pt-1 pl-4 text-xs opacity-90">
          {points.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
      )}
    </Notice>
  );
}

/**
 * A line in the conversation where its summary ends (docs/design/context-panel.md): the
 * messages above stay as they were, and its agents start from the summary. The summary
 * opens beneath it.
 */
function Summarised({ summary }: { summary: { at: string | null; text: string } }) {
  const { t, ago } = useI18n();
  const c = t.app.code;
  const [open, setOpen] = useState(false);
  return (
    <div className="grid gap-2">
      {/* A narrow conversation wraps the words rather than hide the button. */}
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px min-w-6 flex-1 bg-border" />
        <span className="min-w-0 text-center text-balance">
          {c.summaryDivider(summary.at ? ago(summary.at) : "")}
          {" · "}
          <button
            type="button"
            className="whitespace-nowrap text-foreground/80 underline-offset-2 hover:text-foreground hover:underline"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? c.hideSummary : c.viewSummary}
          </button>
        </span>
        <span className="h-px min-w-6 flex-1 bg-border" />
      </div>
      {open && (
        <div className="rounded-xl border bg-foreground/[0.02] px-4 py-3">
          <Markdown text={summary.text} className="text-[13px]" />
        </div>
      )}
    </div>
  );
}
