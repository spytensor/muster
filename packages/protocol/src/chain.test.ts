import { describe, expect, it } from "vitest";
import { GENESIS, sealEvent, verifyChain } from "./chain.js";
import type { AuditEvent, AuditEventBody } from "./events.js";
import { newId } from "./ids.js";

const tenantId = newId();
const userId = newId();
const agentId = newId();
const runId = newId();

function body(seq: number, overrides: Partial<AuditEventBody> = {}): AuditEventBody {
  return {
    id: newId(),
    tenantId,
    seq,
    time: new Date(Date.UTC(2026, 10, 14, 8, 0, seq)).toISOString(),
    actor: { userId, agentId, agentVersion: "a".repeat(64), runId },
    action: {
      kind: "tool_call",
      name: "files.read",
      toolCallId: newId(),
      argsDigest: "b".repeat(64),
      dataClass: "internal",
    },
    decision: { effect: "allow", policyId: "default-allow-read" },
    outcome: { status: "ok" },
    ...overrides,
  } as AuditEventBody;
}

async function chain(length: number): Promise<AuditEvent[]> {
  const events: AuditEvent[] = [];
  let prev = GENESIS.hash;
  for (let seq = 0; seq < length; seq++) {
    const event = await sealEvent(body(seq), prev);
    events.push(event);
    prev = event.hash;
  }
  return events;
}

describe("sealEvent", () => {
  it("links each event to the one before it", async () => {
    const [first, second] = await chain(2);
    expect(first?.prevHash).toBe(GENESIS.hash);
    expect(second?.prevHash).toBe(first?.hash);
    expect(first?.hash).not.toBe(second?.hash);
  });

  it("refuses an event that breaks the schema", async () => {
    await expect(sealEvent(body(-1), GENESIS.hash)).rejects.toThrow();
    await expect(sealEvent({ ...body(0), extra: true } as never, GENESIS.hash)).rejects.toThrow();
    const approvedWithoutApprover = body(0, {
      decision: { effect: "approved", policyId: "needs-approval" } as never,
    });
    await expect(sealEvent(approvedWithoutApprover, GENESIS.hash)).rejects.toThrow(/approverId/);
    const allowedWithApprover = body(0, {
      decision: { effect: "allow", policyId: "p", approverId: userId } as never,
    });
    await expect(sealEvent(allowedWithApprover, GENESIS.hash)).rejects.toThrow(/approverId/);
  });

  it("refuses a record that contradicts itself", async () => {
    const deniedButOk = body(0, { decision: { effect: "deny", policyId: "p" } as never });
    await expect(sealEvent(deniedButOk, GENESIS.hash)).rejects.toThrow(/blocked/);
    const blockedButAllowed = body(0, { outcome: { status: "blocked" } });
    await expect(sealEvent(blockedButAllowed, GENESIS.hash)).rejects.toThrow(/blocked/);
    const okWithError = body(0, { outcome: { status: "ok", errorCode: "E1" } });
    await expect(sealEvent(okWithError, GENESIS.hash)).rejects.toThrow(/errorCode/);
    const errorWithoutCode = body(0, { outcome: { status: "error" } });
    await expect(sealEvent(errorWithoutCode, GENESIS.hash)).rejects.toThrow(/errorCode/);
    const denied = body(0, {
      decision: { effect: "deny", policyId: "p" } as never,
      outcome: { status: "blocked" },
    });
    await expect(sealEvent(denied, GENESIS.hash)).resolves.toMatchObject({ seq: 0 });
    const failed = body(0, { outcome: { status: "error", errorCode: "E1" } });
    await expect(sealEvent(failed, GENESIS.hash)).resolves.toMatchObject({ seq: 0 });
  });

  it("requires millisecond UTC timestamps", async () => {
    await expect(
      sealEvent(body(0, { time: "2026-11-14T08:00:00.123456Z" }), GENESIS.hash),
    ).rejects.toThrow();
    await expect(
      sealEvent(body(0, { time: "2026-11-14T08:00:00Z" }), GENESIS.hash),
    ).rejects.toThrow();
    await expect(
      sealEvent(body(0, { time: "2026-11-14T12:00:00.000+04:00" }), GENESIS.hash),
    ).rejects.toThrow();
  });

  it("accepts an approval that names its approver", async () => {
    const approved = body(0, {
      decision: { effect: "approved", policyId: "needs-approval", approverId: userId } as never,
    });
    const event = await sealEvent(approved, GENESIS.hash);
    expect(await verifyChain([event])).toEqual({ ok: true, head: { seq: 0, hash: event.hash } });
  });
});

describe("verifyChain", () => {
  it("accepts an untouched log and reports its head", async () => {
    const events = await chain(5);
    expect(await verifyChain(events)).toEqual({
      ok: true,
      head: { seq: 4, hash: events[4]?.hash },
    });
    expect(await verifyChain([])).toEqual({ ok: true, head: GENESIS });
  });

  it("detects an edited event at the event that was edited", async () => {
    const events = await chain(5);
    const edited = structuredClone(events);
    (edited[2] as AuditEvent).action.name = "files.delete";
    expect(await verifyChain(edited)).toEqual({ ok: false, index: 2, reason: "wrong_hash" });
  });

  it("detects an edit when only that event's own hash is recomputed", async () => {
    const events = await chain(5);
    const forged = structuredClone(events);
    const { hash: _hash, prevHash, ...rest } = forged[2] as AuditEvent;
    forged[2] = await sealEvent({ ...rest, action: { ...rest.action, name: "x" } }, prevHash);
    expect(await verifyChain(forged)).toEqual({ ok: false, index: 3, reason: "broken_link" });
  });

  it("detects an event removed from the middle", async () => {
    const events = await chain(5);
    const removed = events.filter((_, index) => index !== 2);
    expect(await verifyChain(removed)).toEqual({ ok: false, index: 2, reason: "wrong_seq" });
  });

  it("detects two events swapped", async () => {
    const events = await chain(5);
    const swapped = [events[0], events[2], events[1], events[3], events[4]];
    expect(await verifyChain(swapped)).toEqual({ ok: false, index: 1, reason: "wrong_seq" });
  });

  it("detects an inserted event", async () => {
    const events = await chain(3);
    const inserted = await sealEvent(body(1), (events[0] as AuditEvent).hash);
    const result = await verifyChain([events[0], inserted, events[1], events[2]]);
    expect(result).toEqual({ ok: false, index: 2, reason: "wrong_seq" });
  });

  it("detects a log whose beginning was cut off", async () => {
    const events = await chain(4);
    expect(await verifyChain(events.slice(1))).toEqual({
      ok: false,
      index: 0,
      reason: "wrong_seq",
    });
  });

  it("verifies a later segment against the checkpoint it must follow", async () => {
    const events = await chain(6);
    const anchor = { seq: 2, hash: (events[2] as AuditEvent).hash };
    expect(await verifyChain(events.slice(3), anchor)).toEqual({
      ok: true,
      head: { seq: 5, hash: events[5]?.hash },
    });
    expect(await verifyChain(events.slice(4), anchor)).toEqual({
      ok: false,
      index: 0,
      reason: "wrong_seq",
    });
    expect(await verifyChain(events.slice(3), { seq: 2, hash: "f".repeat(64) })).toEqual({
      ok: false,
      index: 0,
      reason: "broken_link",
    });
  });

  it("reports a malformed event instead of throwing", async () => {
    const events = await chain(2);
    expect(await verifyChain([events[0], { nonsense: true }])).toEqual({
      ok: false,
      index: 1,
      reason: "invalid_event",
    });
  });

  it("reports an event with a malformed hash field", async () => {
    const [event] = await chain(1);
    expect(await verifyChain([{ ...event, hash: "XYZ" }])).toEqual({
      ok: false,
      index: 0,
      reason: "invalid_event",
    });
  });

  it("treats an optional field set to undefined the same as an absent one", async () => {
    const [event] = (await chain(1)) as [AuditEvent];
    const withUndefined = { ...event, actor: { ...event.actor, stepId: undefined } };
    expect(await verifyChain([withUndefined])).toEqual({
      ok: true,
      head: { seq: 0, hash: event.hash },
    });
    const sealed = await sealEvent(
      body(0, { id: event.id, action: event.action, actor: withUndefined.actor } as never),
      GENESIS.hash,
    );
    expect(sealed.hash).toBe(event.hash);
  });

  it("rejects a log that mixes tenants", async () => {
    const [first] = (await chain(1)) as [AuditEvent];
    const other = await sealEvent(body(1, { tenantId: newId() } as never), first.hash);
    expect(await verifyChain([first, other])).toEqual({
      ok: false,
      index: 1,
      reason: "mixed_tenant",
    });
  });

  it("rejects a repeated event id", async () => {
    const [first] = (await chain(1)) as [AuditEvent];
    const repeat = await sealEvent(body(1, { id: first.id }), first.hash);
    expect(await verifyChain([first, repeat])).toEqual({
      ok: false,
      index: 1,
      reason: "duplicate_id",
    });
  });
});

describe("what verifyChain cannot prove without a trusted checkpoint", () => {
  it("accepts a log whose end was removed", async () => {
    const events = await chain(5);
    const result = await verifyChain(events.slice(0, 3));
    expect(result).toEqual({ ok: true, head: { seq: 2, hash: events[2]?.hash } });
  });

  it("accepts an edit when the writer re-seals every later event", async () => {
    const events = await chain(5);
    const forged: AuditEvent[] = events.slice(0, 2);
    let prev = (events[1] as AuditEvent).hash;
    for (const original of events.slice(2)) {
      const { hash: _hash, prevHash: _prev, ...rest } = original;
      const edited = rest.seq === 2 ? { ...rest, action: { ...rest.action, name: "x" } } : rest;
      const sealed = await sealEvent(edited, prev);
      forged.push(sealed);
      prev = sealed.hash;
    }
    const result = await verifyChain(forged);
    expect(result.ok).toBe(true);
  });

  it("is caught by comparing the head with a checkpoint kept elsewhere", async () => {
    const events = await chain(5);
    const trusted = { seq: 4, hash: (events[4] as AuditEvent).hash };

    const truncated = await verifyChain(events.slice(0, 3));
    expect(truncated).not.toEqual({ ok: true, head: trusted });

    const { hash: _hash, prevHash, ...last } = events[4] as AuditEvent;
    const resealed = await sealEvent({ ...last, action: { ...last.action, name: "x" } }, prevHash);
    const forged = await verifyChain([...events.slice(0, 4), resealed]);
    expect(forged.ok).toBe(true);
    expect(forged).not.toEqual({ ok: true, head: trusted });

    expect(await verifyChain(events)).toEqual({ ok: true, head: trusted });
  });
});
