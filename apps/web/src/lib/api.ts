export type Role = "owner" | "admin" | "auditor" | "billing" | "member";
export type Permission =
  | "console.access"
  | "members.read"
  | "members.manage"
  | "audit.read"
  | "settings.read"
  | "settings.manage"
  | "sessions.read"
  | "sessions.revoke"
  | "agents.read"
  | "agents.manage"
  | "traces.read"
  | "traces.annotate";

export interface Me {
  user: { id: string; email: string; name: string; avatarUrl: string | null };
  org: { id: string; name: string };
  role: Role;
  permissions: Permission[];
  sessionId: string;
}
export interface Member {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  lastLoginAt: string | null;
  role: Role;
  status: "active" | "suspended" | "removed";
  joinedAt: string;
  joinedVia: "invitation" | "domain" | "bootstrap" | "directory";
  departmentId: string | null;
  departmentName: string | null;
}
export interface Department {
  id: string;
  name: string;
  members: number;
}
export interface Invitation {
  id: string;
  email: string;
  role: Role;
  createdAt: string;
  expiresAt: string;
  departmentName: string | null;
  invitedBy: string;
  state: "pending" | "accepted" | "revoked" | "expired";
}
export interface AdminEvent {
  id: string;
  seq: number;
  time: string;
  actorEmail: string;
  action: string;
  targetType: string | null;
  targetLabel: string | null;
  detail: Record<string, unknown>;
  ip: string | null;
}
/** Where a check of the activity log first found it not proving itself. */
export interface ChainBroken {
  why: "changed" | "link" | "missing" | "start" | "end" | "checkpoint" | "anchor";
  chainNo: number | null;
  time: string | null;
  action: string | null;
}
/** Where the activity log is sent on to, and how far it has got. */
export interface AuditForward {
  kind: "json" | "splunk";
  url: string;
  enabled: boolean;
  hasToken: boolean;
  cursor: number;
  /** Records written and not yet delivered. */
  behind: number;
  deliveredAt: string | null;
  failures: number;
  error: string | null;
  errorAt: string | null;
  /** Since when nothing has got through; and whether that is long enough to say it has stalled. */
  failingSince: string | null;
  stalled: boolean;
  /** Days of failures after which records past their period are purged unsent. */
  purgeWaitsDays: number;
  nextAt: string | null;
}
export interface AuditChain {
  records: number;
  checkedAt: string | null;
  checkedOk: boolean | null;
  checked: { records: number; purged: number; broken: ChainBroken | null } | null;
  forward: AuditForward | null;
  canSeal: boolean;
  /** Whether a check signs for what it found. */
  signs: boolean;
}
export type RetentionKind = "conversations" | "files" | "traces" | "audit";
/** Days each kind is kept; null keeps it for as long as the organization is here. */
export type RetentionPeriods = Record<RetentionKind, number | null>;
export type RetentionCounts = Record<RetentionKind, number>;
export interface RetentionSettings {
  periods: RetentionPeriods;
  limits: Record<RetentionKind, { min: number; max: number }>;
  hold: { reason: string; by: string | null; at: string | null } | null;
  changedAt: string | null;
  purgedAt: string | null;
  /** What the last purge removed. */
  purged: (RetentionCounts & { auditUnsent?: number }) | null;
  /** Whether the activity log can be purged, and if not, why. */
  auditPurge: "ok" | "no_key" | "other_key";
  nextAt: string | null;
  /** What is past the saved periods now. */
  waiting: RetentionCounts;
}
/** What Muster holds of a removed member, before it is erased. */
export interface ErasePreview {
  email: string;
  removed: boolean;
  hold: boolean;
  holds: Record<string, number>;
  /** Not erased because other people use them: handed to whoever erases. */
  handed: Record<"projects" | "files", { count: number; names: string[] }>;
}
export type RunStatus = "ok" | "error" | "blocked" | "stopped" | "awaiting_approval" | "running";
export type Level = "A0" | "A1" | "A2" | "A3" | "A4";
export type Risk = "R1" | "R2" | "R3" | "R4";
export type SpanKind = "agent" | "llm" | "tool" | "retriever" | "policy" | "approval";

export interface Agent {
  id: string;
  name: string;
  description: string;
  source: "platform" | "org" | "user";
  risk: Risk;
  state: "draft" | "pending" | "published" | "suspended";
  version: string;
  model: string;
  ownerName: string | null;
  ownerEmail: string | null;
  instructions: string;
  tools: string[];
  /** Set when its builder deleted it. Its record stays. */
  deletedAt: string | null;
  runs: number;
  users: number;
  errors: number;
  blocked: number;
  lastRunAt: string | null;
}
export interface Trace {
  id: string;
  status: RunStatus;
  startedAt: string;
  durationMs: number;
  venue: "cloud" | "device";
  input: string;
  output: string;
  promptTokens: number;
  completionTokens: number;
  costMicros: number;
  spanCount: number;
  maxAction: Level;
  conversationId: string;
  agentVersion: string;
  agentId: string;
  agentName: string;
  agentRisk: Risk;
  userEmail: string | null;
  userName: string | null;
  annotations: number;
}
export interface TraceSummary {
  total: number;
  errors: number;
  blocked: number;
  awaiting: number;
  p50: number;
  p95: number;
  tokens: number;
  costMicros: number;
}
export interface Span {
  id: string;
  parentId: string | null;
  seq: number;
  kind: SpanKind;
  name: string;
  status: "ok" | "error" | "blocked" | "stopped";
  startOffsetMs: number;
  durationMs: number;
  input: string;
  output: string;
  attributes: Record<string, unknown>;
  events: { name: string; atMs: number; message: string }[];
  promptTokens: number;
  completionTokens: number;
  costMicros: number;
}
export interface Annotation {
  id: string;
  spanId: string | null;
  label: string;
  score: number | null;
  note: string;
  createdAt: string;
  authorEmail: string;
  authorName: string;
  authorId: string;
}
export interface SpanRow {
  id: string;
  traceId: string;
  kind: SpanKind;
  name: string;
  status: "ok" | "error" | "blocked" | "stopped";
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  costMicros: number;
  input: string;
  output: string;
  startedAt: string;
  agentName: string;
}
export interface Conversation {
  id: string;
  traces: number;
  startedAt: string;
  lastAt: string;
  durationMs: number;
  tokens: number;
  costMicros: number;
  agentName: string;
  userEmail: string | null;
  problems: number;
  firstInput: string;
}
export interface SavedView {
  id: string;
  name: string;
  filters: Record<string, string>;
}
export interface Totals {
  runs: number;
  ok: number;
  errors: number;
  blocked: number;
  /** Runs that ended without finishing and without a fault. */
  stopped: number;
  awaiting: number;
  users: number;
  p50: number;
  p95: number;
  tokens: number;
  costMicros: number;
}
export interface KeyValue {
  key: string;
  value: number;
}
export interface Dashboard {
  range: string;
  bucket: "hour" | "day";
  /** Null for roles that may not see who is in the organization. */
  people: null | {
    members: number;
    suspended: number;
    invitations: number;
    sessions: number;
    departments: number;
    byRole: KeyValue[];
  };
  activity: null | {
    totals: Totals;
    previous: Totals;
    agents: { total: number; pending: number; byRisk: KeyValue[] };
    series: {
      at: string;
      ok: number;
      error: number;
      blocked: number;
      stopped: number;
      awaiting: number;
      p50: number;
      p95: number;
      costMicros: number;
      tokens: number;
      users: number;
    }[];
    byAgent: { key: string; risk: Risk; runs: number; errors: number; costMicros: number }[];
    byDepartment: { key: string; runs: number; users: number; costMicros: number }[];
    byModel: { key: string; calls: number; tokens: number; costMicros: number }[];
    byLevel: { key: Level; value: number; blocked: number }[];
    byTool: { key: string; calls: number; errors: number; p50: number }[];
    byVenue: KeyValue[];
    heat: { dow: number; hour: number; value: number }[];
  };
}
export interface SignInSettings {
  providers: { id: string; label: string; directory: string | null; admits: boolean }[];
  domains: { domain: string; autoJoin: boolean }[];
  sessionDays: number;
  invitationDays: number;
}
export interface Session {
  id: string;
  email: string;
  name: string;
  provider: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

let onSignedOut: (() => void) | undefined;
export const whenSignedOut = (handler: () => void) => {
  onSignedOut = handler;
};

const ZONE = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: init.method ?? "GET",
      credentials: "same-origin",
      headers: {
        // The person's own clock, so "tomorrow at nine" is theirs when an agent is told the time.
        "x-muster-timezone": ZONE,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiError(0, "network", "network");
  }
  if (response.status === 401) onSignedOut?.();
  const payload = (await response.json().catch(() => null)) as {
    error?: { code: string; message: string };
  } | null;
  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload?.error?.code ?? "unknown",
      payload?.error?.message ?? "",
    );
  }
  return payload as T;
}
