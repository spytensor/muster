import type { Level, Risk } from "@/lib/api";

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
  /** Who shared it, when it is a colleague's that was shared with this person. */
  sharedBy?: { name: string; email: string } | null;
  /** How many people and departments the person's own agent is shared with. */
  shares?: number;
  /** What it carries beside its instructions and tools. */
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
  /** The project it belongs to, if any. */
  projectId: string | null;
}
/** A person's place for one piece of ongoing work. */
export interface Project {
  id: string;
  name: string;
  /** What every agent working in the project is told, on top of its own brief. */
  instructions: string;
  updatedAt: string;
  conversations: number;
  /** Where the project's work stands: kept by the agents working in it and by the person. */
  notes: string;
  notesAt: string | null;
  /** Counted up with every change of the notes: what a page says it started from. */
  notesRev: number;
  /** The agent that last wrote the notes; null when the person did. */
  notesBy: string | null;
  /** The notes as they were before the last change can be brought back. */
  notesEarlier: boolean;
  /** How many steps the project has, and how many of them are done. */
  steps: number;
  stepsDone: number;
  /** How the project was last said to be going; null when no update was written. */
  health: Health | null;
  /** What the person is to it: its owner, or brought into it to work in it or to see it. */
  role: ProjectRole;
  /** Whose it is, when it is a colleague's. */
  owner: { id: string; name: string } | null;
  /** How many colleagues were brought into it, the owner not counted. */
  people: number;
  /** How many things live in it, and how many of them are repositories. */
  items: number;
  repos: number;
  /** When it was last said how it is going; null when no update was written. */
  updateAt: string | null;
}
export type ProjectRole = "owner" | "work" | "view";
/** What lives in a project, by kind, in the order its page shows them. */
export const ITEM_KINDS = ["repo", "guide", "environment", "link", "contact", "fact"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
/** One thing that lives in a project: put there by a person or an agent, read by both. */
export interface ProjectItem {
  id: string;
  /** Its number in the project, as an agent names it; 0 for a pinned file. */
  n: number;
  kind: ItemKind;
  title: string;
  /** What it is and how it is used: what Muster is told of it. */
  detail: string;
  url: string | null;
  /** A repository as its code host names it: "owner/name". */
  ref: string | null;
  /** A guide that is a file of the library, pinned in the project. */
  file: {
    id: string;
    name: string;
    kind: string;
    size: number;
    version: number;
    shadowed: boolean;
  } | null;
  state: {
    version?: string;
    versionAt?: string;
    branch?: string;
    doc?: string;
    /** A contact's address and number. */
    email?: string;
    phone?: string;
    /** A day it is due by: a milestone, a renewal, a report. */
    due?: string;
  };
  position: number;
  /** Who last changed it: an agent, or a person. */
  by: string | null;
  byAgent: boolean;
  updatedAt: string;
}
/** How a repository stands on the code host, when that can be learned. */
export interface RepoFacts {
  branch: string;
  pulls: number | null;
  checks: "passing" | "failing" | "running" | null;
}
/** Someone in a project: its owner, or a colleague brought into it. */
export interface ProjectMember {
  id: string;
  name: string;
  email: string;
  role: ProjectRole;
  /** False for someone no longer with the company. */
  active: boolean;
  /** Whether this is the person looking. */
  me: boolean;
}
/** Whether the person may change what is in a project, not only see it. */
export const worksIn = (project: Pick<Project, "role">) => project.role !== "view";
export type Health = "on_track" | "at_risk" | "off_track";
export type DocKind = "spec" | "decisions" | "research" | "release" | "other";
/** A file pinned in a project for what it is. */
export interface ProjectDoc {
  fileId: string;
  kind: DocKind;
  name: string;
  /** The person has a newer file of the same name. */
  shadowed: boolean;
  fileKind: string;
  size: number;
  version: number;
}
/** How a project was going at a moment, as it was told then. */
export interface ProjectUpdate {
  id: string;
  health: Health;
  text: string;
  /** The agent that wrote it; null when a person did. */
  by: string | null;
  /** Who posted it, or in whose conversation the agent wrote it. */
  author: { id: string; name: string } | null;
  /** Whether that is the person looking. */
  mine: boolean;
  /** Whether the person looking may take it back: the owner any, others their own. */
  canRemove: boolean;
  createdAt: string;
}
/** One thing still to do in a project, or done in it. */
export interface ProjectStep {
  id: string;
  /** Its number in the project: how an agent names it. */
  n: number;
  title: string;
  state: "todo" | "doing" | "waiting" | "done";
  /** A day, 2026-11-30, or none. */
  due: string | null;
  agentId: string | null;
  agentName: string | null;
  /** The conversation working on it, or that finished it, when it is the person's own. */
  conversationId: string | null;
  conversationTitle: string | null;
  /** False when a colleague's conversation is working on it: there is nothing to open. */
  conversationMine: boolean;
  /** What came of it, or what it waits for. */
  result: string;
  /** The agent that last changed it; null when the person did. */
  by: string | null;
  updatedAt: string;
  doneAt: string | null;
  /** Its work item in the company's tracker, when the project is linked to one. */
  ticket?: { key: string; url: string } | null;
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
  /** Which version of the file this is, for a file an agent made and changed since. */
  version?: number;
}
/** One of the person's files. */
export interface FileItem extends Attachment {
  /** Whether it is the person's own, and whether they may change it. */
  mine?: boolean;
  canChange?: boolean;
  /** Whose it is, when a colleague shared it with the person. */
  sharedBy?: { name: string; email: string } | null;
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
export interface SheetGrid {
  name: string;
  rows: string[][];
  totalRows: number;
  totalColumns: number;
  merges: [number, number, number, number][];
  /** How cells are dressed where the workbook says so, by "row:column" counted from 0. */
  looks?: Record<string, { fill?: string; color?: string; bold?: true }>;
  /** Each column's width in characters; 0 where the workbook sets none. */
  widths?: number[];
  frozenRows: number;
  frozenColumns: number;
  /** The charts on the sheet, as what they showed when the workbook was saved. */
  charts?: {
    kind: "bar" | "line" | "pie";
    title: string;
    categories: string[];
    series: { name: string; color: string; values: (number | null)[] }[];
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
  /** Why a reply ended when it did not simply finish, and for an error, what went wrong. */
  /** The agent that gave this reply, or that the person's message was for. */
  agentId?: string | null;
  agentName?: string | null;
  /** "no_steps" and "only_read": the reply speaks of work its steps do not show. */
  /** "checks_failed": the project's own checks, run by Muster after the reply's changes, still fail. */
  /** "walkthrough_unmatched": the Walkthrough it ends with says what its steps do not bear out (C1); `endingDetail` holds what. */
  ending?:
    | "allowance"
    | "budget_company"
    | "budget_department"
    | "budget_person"
    | "length"
    | "error"
    | "no_steps"
    | "only_read"
    | "checks_failed"
    | "walkthrough_unmatched"
    | null;
  endingDetail?: string | null;
  /** A reply that did not finish and whose work was kept: it can be gone on with, not only started again. */
  canContinue?: boolean;
  /** What the person's message answers, when it answers a form in a reply. Read with `readAction`. */
  action?: unknown;
  /** Who wrote a message that is not the person's own: "followup" when Muster brought an agent back. */
  origin?: string | null;
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
  /** Why a command asks in every mode, when it is one that does. */
  why?: string;
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
  userEmail?: string;
  userName?: string;
  traceId?: string;
}
export interface Step {
  id: string;
  tool: string;
  status: "running" | "ok" | "error" | "blocked";
  /** What the call is about: a document's title or an address. */
  detail: string;
  ms: number | null;
  /** The agent that did it, when it is one the reply's own agent passed a step to (CHA-264). */
  by?: string;
  /** The file this step made or changed, by id. Absent on replies written before 2026-11-18. */
  file?: string;
  /** Every file the step made, when it made more than one: a run of code may keep several. */
  files?: string[];
  /** What a step that is still running has printed, the last of it. Gone once it ends. */
  said?: string;
}
/** One step opened: what was asked and what came back, as kept on the run's record. */
export interface StepDetail {
  tool: string;
  status: string;
  asked: string;
  returned: string;
  ms: number;
  level: string | null;
  effect: string | null;
  mode: string | null;
  /** The length at which what is kept is cut. */
  limit: number;
}
export interface ConversationDetail {
  id: string;
  title: string;
  projectId: string | null;
  /** How much the person lets agents do here without asking. */
  mode: "ask" | "auto" | "full";
  agent: {
    id: string;
    name: string;
    description: string;
    risk: Risk;
    state: string;
    tools: string[];
    /** The agent a conversation has when nobody called one: the page names it Muster. */
    general?: boolean;
  };
  messages: Message[];
  approvals: Approval[];
  /** Ids of files a reply here made that were deleted since. */
  gone?: string[];
  /** How full the model's window was at its last call here, and what that call was made of. */
  context?: ConversationContext;
  /** The summary the conversation's agents start from instead of its messages up to `seq`. */
  summary?: { seq: number; at: string | null; text: string } | null;
}
/** What one asking of the model was made of, by part, as the run estimated it (server context.ts). */
export interface ContextParts {
  instructions: number;
  tools: number;
  toolCount: number;
  skills: number;
  skillCount: number;
  project: number;
  memory: number;
  memoryCount: number;
  conversation: number;
  work: number;
}
export interface ConversationContext {
  /** The provider's count of what the last call sent: 0 when it reported none. */
  tokens: number;
  window: number;
  /** Where compaction begins within a reply: above it is kept for the answer. */
  compactAt?: number;
  /** About how many tokens the next reply's conversation part takes: the summary and what follows it. */
  nextConversation?: number;
  parts?: ContextParts | null;
}
export interface DocumentSummary {
  id: string;
  title: string;
  size: number;
  updatedAt: string;
}

/** Something an agent asked the person's computer to do in a project's folders. */
export interface DeviceCall {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

/** What the model is in the middle of preparing: which tool, what about, and how many characters so far. */
export interface Writing {
  tool: string;
  detail: string;
  size: number;
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
      device?: DeviceCall[];
      writing?: Writing | null;
      thinking?: number | null;
    }
  | { type: "writing"; writing: Writing | null }
  | { type: "thinking"; chars: number | null }
  | { type: "device"; call: DeviceCall }
  | { type: "plan"; plan: PlanItem[] }
  | { type: "text"; delta: string }
  | { type: "step"; step: Step }
  | { type: "approval"; approval: Approval | null }
  | { type: "done"; message: Message; title: string };
