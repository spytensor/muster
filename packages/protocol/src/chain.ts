import { digestOf, type Sha256 } from "./digest.js";
import { AuditEvent, AuditEventBody } from "./events.js";

/** The last event known to be good: its position and its hash. */
export interface Checkpoint {
  seq: number;
  hash: Sha256;
}

/** The checkpoint before the first event of a log. */
export const GENESIS: Checkpoint = Object.freeze({ seq: -1, hash: "0".repeat(64) });

/** Seals an event onto the chain: its hash covers its content and the previous hash. */
export async function sealEvent(body: AuditEventBody, prevHash: Sha256): Promise<AuditEvent> {
  const parsed = withoutUndefined(AuditEventBody.parse(body));
  const hash = await digestOf({ ...parsed, prevHash });
  return AuditEvent.parse({ ...parsed, prevHash, hash });
}

export type ChainResult =
  | { ok: true; head: Checkpoint }
  | {
      ok: false;
      /** Index of the first event that fails. */
      index: number;
      reason:
        | "invalid_event"
        | "wrong_seq"
        | "broken_link"
        | "wrong_hash"
        | "mixed_tenant"
        | "duplicate_id";
    };

/**
 * Checks that `events` is an unbroken continuation of the log after `after`, and
 * returns the checkpoint of the last event.
 *
 * WHAT THIS DOES NOT PROVE. The hash is unkeyed, so anyone who can write the log can
 * also recompute it. A writer who edits an event and re-seals every event after it,
 * appends forged events, or drops events from the end produces a list that passes.
 * On its own this function only catches changes made without recomputing the hashes
 * (corruption, a careless edit).
 *
 * The guarantee comes from the caller: compare the returned `head` with a checkpoint
 * kept where the log's writer cannot change it. If they match, every event up to
 * that checkpoint is exactly what was recorded.
 *
 * @param after the trusted checkpoint the first event must follow. Defaults to
 *   `GENESIS`, which is right when `events` starts at the beginning of the log.
 */
export async function verifyChain(
  events: readonly unknown[],
  after: Checkpoint = GENESIS,
): Promise<ChainResult> {
  let head = after;
  let tenantId: string | undefined;
  const seen = new Set<string>();
  for (const [index, raw] of events.entries()) {
    const parsed = AuditEvent.safeParse(raw);
    if (!parsed.success) return { ok: false, index, reason: "invalid_event" };
    const { hash, prevHash, ...body } = withoutUndefined(parsed.data);
    if (body.seq !== head.seq + 1) return { ok: false, index, reason: "wrong_seq" };
    if (prevHash !== head.hash) return { ok: false, index, reason: "broken_link" };
    if ((await digestOf({ ...body, prevHash })) !== hash) {
      return { ok: false, index, reason: "wrong_hash" };
    }
    tenantId ??= body.tenantId;
    if (body.tenantId !== tenantId) return { ok: false, index, reason: "mixed_tenant" };
    if (seen.has(body.id)) return { ok: false, index, reason: "duplicate_id" };
    seen.add(body.id);
    head = { seq: body.seq, hash };
  }
  return { ok: true, head };
}

/**
 * Drops properties whose value is `undefined`, at every depth. An optional field
 * that is absent and one explicitly set to `undefined` mean the same thing, so they
 * must hash the same.
 */
function withoutUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withoutUndefined) as T;
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = withoutUndefined(item);
  }
  return out as T;
}
