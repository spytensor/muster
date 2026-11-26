import { z } from "zod";
import { Sha256 } from "./digest.js";
import { AgentId, EventId, RunId, StepId, TenantId, ToolCallId, UserId } from "./ids.js";

export const DataClass = z.enum(["public", "internal", "confidential", "restricted"]);
export type DataClass = z.infer<typeof DataClass>;

/** Who acted. A sub-agent's run names the run that started it. */
export const Actor = z.strictObject({
  userId: UserId,
  agentId: AgentId,
  agentVersion: Sha256,
  runId: RunId,
  parentRunId: RunId.optional(),
  stepId: StepId.optional(),
});
export type Actor = z.infer<typeof Actor>;

/** What was attempted. Arguments are recorded as a digest, never as content. */
export const Action = z.strictObject({
  kind: z.enum(["tool_call", "model_call", "network", "file", "lifecycle"]),
  name: z.string().min(1),
  toolCallId: ToolCallId.optional(),
  argsDigest: Sha256,
  dataClass: DataClass,
});
export type Action = z.infer<typeof Action>;

/** Why it was or was not allowed. An approval names the person who approved. */
export const Decision = z
  .strictObject({
    effect: z.enum(["allow", "deny", "approved"]),
    policyId: z.string().min(1),
    approverId: UserId.optional(),
  })
  .refine((decision) => (decision.effect === "approved") === (decision.approverId !== undefined), {
    message: "approverId is required when effect is 'approved' and forbidden otherwise",
  });
export type Decision = z.infer<typeof Decision>;

export const Outcome = z.strictObject({
  status: z.enum(["ok", "error", "blocked"]),
  errorCode: z.string().min(1).optional(),
});
export type Outcome = z.infer<typeof Outcome>;

const eventShape = z.strictObject({
  id: EventId,
  tenantId: TenantId,
  /** Position in the tenant's log, starting at 0 and increasing by 1. */
  seq: z.number().int().nonnegative(),
  /** UTC, millisecond precision, so one instant has exactly one text. */
  time: z.iso.datetime({ precision: 3 }),
  actor: Actor,
  action: Action,
  decision: Decision,
  outcome: Outcome,
});

/** A record must not contradict itself: "denied, and it succeeded" is not a fact. */
function consistent(
  event: { decision: Decision; outcome: Outcome },
  ctx: z.core.$RefinementCtx,
): void {
  if ((event.decision.effect === "deny") !== (event.outcome.status === "blocked")) {
    ctx.addIssue({
      code: "custom",
      path: ["outcome", "status"],
      message: "status is 'blocked' exactly when the decision is 'deny'",
    });
  }
  if ((event.outcome.status === "error") !== (event.outcome.errorCode !== undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["outcome", "errorCode"],
      message: "errorCode is required when status is 'error' and forbidden otherwise",
    });
  }
}

/** An audit event before it is sealed into a chain. */
export const AuditEventBody = eventShape.superRefine(consistent);
export type AuditEventBody = z.infer<typeof AuditEventBody>;

/** A sealed event: it carries the previous event's hash and its own. */
export const AuditEvent = eventShape
  .extend({
    prevHash: Sha256,
    hash: Sha256,
  })
  .superRefine(consistent);
export type AuditEvent = z.infer<typeof AuditEvent>;
