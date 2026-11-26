/** The shapes the server sends. Kept in step with `apps/web/src/app/api.ts`. */

export type Level = "A0" | "A1" | "A2" | "A3" | "A4";
export type Risk = "R1" | "R2" | "R3" | "R4";

export interface Me {
  user: { id: string; email: string; name: string; avatarUrl: string | null };
  org: { id: string; name: string };
  role: string;
  sessionId: string;
}
/**
 * The name an agent is shown by. The general agent every organization starts with is kept
 * as "Assistant" where it is stored; to people it is Muster (the owner, 2026-11-24).
 *
 * Which agent is the general one is said by its row: the company's, kept under that name,
 * or marked so by the server. A person's own agent named "Assistant" from before the name
 * was refused keeps its name. Only a list of agents needs this: wherever the server names
 * an agent beside something else (who replied, who wants an approval, who a step is with,
 * who wrote a note) it already says the shown name
 * (`apps/server/src/runtime/catalog.ts`, `shownSql`).
 */
type Named = { name: string; source?: string; general?: boolean };
export const isGeneral = (agent: Named): boolean =>
  Boolean(agent.general || (agent.source === "platform" && agent.name === "Assistant"));
export const shownName = (agent: Named): string => (isGeneral(agent) ? "Muster" : agent.name);
/** The agent a new conversation starts with when nobody chose one. */
export const generalOf = <T extends Named>(agents: T[]): T | undefined =>
  agents.find(isGeneral) ?? agents.find((agent) => agent.name === "Assistant");

export interface AppAgent {
  id: string;
  name: string;
  description: string;
  source: "platform" | "org" | "user";
  risk: Risk;
  state: "draft" | "pending" | "published" | "suspended";
  instructions: string;
  tools: string[];
  mine: boolean | null;
  /** What it carries beside its instructions and tools: skills, knowledge bases, connectors. */
  carries?: { kind: "skill" | "knowledge" | "connector"; id: string; name: string }[];
}
export interface Tool {
  name: string;
  level: Level;
  summary: string;
}
export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
  agentId: string;
  agentName: string;
  running: boolean;
}
export type FileKind =
  | "document"
  | "spreadsheet"
  | "slides"
  | "pdf"
  | "image"
  | "page"
  | "text"
  | "data";
/** A file as a message carries it. */
export interface Attachment {
  id: string;
  name: string;
  kind: FileKind;
  size: number;
}
/** One of the person's files. */
export interface FileItem extends Attachment {
  mime: string;
  source: "upload" | "agent";
  conversationId: string | null;
  createdAt: string;
}
export interface FileLimits {
  maxBytes: number;
  quotaBytes: number;
  endings: string[];
}
/** One place the person is signed in. */
export interface DeviceSession {
  id: string;
  provider: string;
  kind: "browser" | "app";
  lastSeenAt: string;
  userAgent: string | null;
  current: boolean;
}
export interface UsageSums {
  runs: number;
  tokens: number;
  costMicros: number;
  /** What went in and what came out; what went in and was read from the model's cache. Absent from an older server. */
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
}
export interface Usage {
  totals: UsageSums;
  byAgent: (UsageSums & { agent: string })[];
  byDay: (UsageSums & { day: string })[];
  /** This month against each limit that holds for the person; money only for their own. */
  month?: {
    scope: "person" | "department" | "company";
    share: number;
    limitMicros?: number;
    spentMicros?: number;
  }[];
}
export interface PlanItem {
  title: string;
  status: "pending" | "in_progress" | "done";
}
export interface Message {
  id: string;
  seq: number;
  role: "user" | "assistant";
  content: string;
  status: "running" | "complete" | "failed" | "stopped";
  traceId: string | null;
  createdAt: string;
  /** What the agent did while writing this reply, and the plan it showed. Empty for the person's messages. */
  steps: Step[];
  plan: PlanItem[];
  /** Files the person sent with this message. */
  attachments: Attachment[];
  /** What the person's message answers, when it answers a form in a reply. Read with `readAction`. */
  action?: unknown;
  /** Who wrote a message that is not the person's own: "followup" when Muster brought an agent back. */
  origin?: string | null;
  /** The agent that gave this reply, when it is not the conversation's own. */
  agentName?: string | null;
  /** Why a reply ended when it did not simply finish. "length": cut off at the longest a reply can be. */
  ending?: string | null;
  /** With "walkthrough_unmatched": what does not hold, as JSON (C1). */
  endingDetail?: string | null;
}
/** What an approval shows the person: built by the server from the actual call, never written by the model. */
export interface ApprovalSummary {
  /** The whole address, query string included. */
  destination: string;
  method: string;
  /** Empty when nothing is sent. */
  contentType: string;
  bytes: number;
  preview: string;
}
export interface Approval {
  id: string;
  tool: string;
  level: Level;
  summary: ApprovalSummary;
  status: "pending" | "approved" | "rejected" | "expired";
  requestedAt: string;
  /** When a waiting action is given up. */
  expiresAt?: string;
  decidedAt?: string | null;
  conversationId?: string;
  agentName?: string;
}
export interface Step {
  id: string;
  tool: string;
  status: "running" | "ok" | "error" | "blocked";
  /** What the call is about: a document's title or an address. */
  detail: string;
  ms: number | null;
  /** The agent that did it, when it is one the reply's own agent passed a step to. */
  by?: string;
  /** The file this step made or changed, by id. Absent on replies written before 2026-11-18. */
  file?: string;
  /** Every file the step made, when it made more than one: a run of code may keep several. */
  files?: string[];
}
/** One step opened: what was asked and what came back, as kept on the run's record. */
export interface StepDetail {
  tool: string;
  status: string;
  asked: string;
  returned: string;
  ms: number;
  /** The length at which what is kept is cut. */
  limit: number;
}
export type Health = "on_track" | "at_risk" | "off_track";
/** A project as the list gives it: the person's own, or one they were brought into. */
export interface Project {
  id: string;
  name: string;
  steps: number;
  stepsDone: number;
  /** How it was last said to be going; null when no update was written. */
  health: Health | null;
  /** What the person is to it. */
  role: "owner" | "work" | "view";
  owner?: { id: string; name: string } | null;
}
export interface ProjectStep {
  id: string;
  n: number;
  title: string;
  state: "todo" | "doing" | "waiting" | "done";
  /** A day, 2026-11-30, or none. */
  due: string | null;
  agentName: string | null;
  /** What came of it, or what it waits for. */
  result: string;
}
export interface ProjectUpdate {
  id: string;
  health: Health;
  text: string;
  /** The agent that wrote it; null when a person did. */
  by: string | null;
  author: { id: string; name: string } | null;
  createdAt: string;
}
export interface ProjectDoc {
  fileId: string;
  kind: "spec" | "decisions" | "research" | "release" | "other";
  name: string;
  fileKind: string;
  size: number;
}
export interface ConversationDetail {
  id: string;
  title: string;
  agent: {
    id: string;
    name: string;
    description: string;
    risk: Risk;
    state: string;
    tools: string[];
    /** The agent a conversation has when nobody called one: the app names it Muster. */
    general?: boolean;
  };
  messages: Message[];
  approvals: Approval[];
}
export interface DocumentSummary {
  id: string;
  title: string;
  size: number;
  updatedAt: string;
}
export interface DocumentDetail {
  id: string;
  title: string;
  content: string;
  updatedAt: string;
}

/** Events on a conversation's live stream. */
export type LiveEvent =
  | {
      type: "state";
      running: boolean;
      text: string;
      steps: Step[];
      plan: PlanItem[];
      approval: Approval | null;
    }
  | { type: "plan"; plan: PlanItem[] }
  | { type: "text"; delta: string }
  | { type: "step"; step: Step }
  | { type: "approval"; approval: Approval | null }
  | { type: "done"; message: Message; title: string }
  | { type: "ping" };
