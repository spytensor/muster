import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { recordEvent } from "./audit.js";
import {
  AUDIT_BACKFILL,
  AuditForwarder,
  checkChain,
  exportChain,
  forwardRequest,
  purgeChain,
  purgeGuard,
  STALLED_AFTER,
  verifyChain,
  waitAfter,
} from "./chain.js";
import { openText } from "./connections.js";
import type { Db } from "./db.js";
import { type Net, NetError } from "./runtime/net.js";
import { harness } from "./test-support.js";

// Each case that tampers needs a database of its own, and a busy machine opens one slowly.
vi.setConfig({ testTimeout: 90_000 });

const json = async <T = unknown>(response: Response): Promise<T> => (await response.json()) as T;
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Does to the record what only someone with the database in their hands can. */
async function behindItsBack(db: Db, sql: string, params: unknown[] = []) {
  const guards = [
    ["admin_events", "admin_events_append_only"],
    ["audit_chain", "audit_chain_keep"],
    ["audit_checkpoints", "audit_checkpoints_keep"],
  ];
  for (const [table, trigger] of guards)
    await db.query(`alter table ${table} disable trigger ${trigger}`);
  try {
    await db.query(sql, params);
  } finally {
    for (const [table, trigger] of guards)
      await db.query(`alter table ${table} enable trigger ${trigger}`);
  }
}

/** A place the record is sent on to: answers what it is told to, and keeps what it took. */
function siem() {
  const took: { url: string; headers: Record<string, string>; body: string }[] = [];
  const state = { status: 200, down: false, calls: 0 };
  const net: Net = {
    async request(url, init = {}) {
      state.calls++;
      if (state.down) throw new NetError("The address could not be reached.");
      if (state.status < 300)
        took.push({ url, headers: init.headers ?? {}, body: init.body ?? "" });
      return { status: state.status, contentType: "", text: "", truncated: false, url };
    },
  };
  const numbers = () =>
    took.flatMap((one) =>
      (JSON.parse(one.body) as { events: { chain_no: number }[] }).events.map((e) => e.chain_no),
    );
  return { net, took, state, numbers };
}

async function fresh() {
  const h = await harness();
  const owner = (await h.signIn("owner@acme.test")).cookie as string;
  const orgId = (await h.db.query<{ id: string }>("select id from organizations"))[0]?.id as string;
  const note = (n: number) =>
    recordEvent(h.db, {
      orgId,
      actor: { userId: null, email: "someone@acme.test" },
      action: "test.noted",
      detail: { n, words: "逗号, “quotes” and \\ a backslash" },
    });
  const numbers = async () =>
    (
      await h.db.query<{ n: string }>(
        "select chain_no as n from admin_events where org_id = $1 order by chain_no",
        [orgId],
      )
    ).map((row) => Number(row.n));
  return { h, owner, orgId, note, numbers, key: h.config.secretKey };
}

describe("the activity log's chain", () => {
  let t: Awaited<ReturnType<typeof fresh>>;
  beforeAll(async () => {
    t = await fresh();
  });

  it("links every row to the one before it, from the first", async () => {
    for (let n = 0; n < 5; n++) await t.note(n);
    const rows = await t.h.db.query<{ chainNo: string; prevHash: string; hash: string }>(
      `select chain_no as "chainNo", prev_hash as "prevHash", hash from admin_events
        where org_id = $1 order by chain_no`,
      [t.orgId],
    );
    expect(rows.length).toBeGreaterThanOrEqual(6);
    expect(rows[0]).toMatchObject({ chainNo: expect.anything(), prevHash: "" });
    rows.forEach((row, index) => {
      expect(Number(row.chainNo)).toBe(index + 1);
      if (index > 0) expect(row.prevHash).toBe(rows[index - 1]?.hash);
    });
    const state = await verifyChain(t.h.db, t.orgId, t.key);
    expect(state).toMatchObject({ ok: true, records: rows.length, first: 1, last: rows.length });
    expect(state.head).toBe(rows.at(-1)?.hash);
  });

  it("cannot be given a place or a hash by whoever writes a row", async () => {
    const id = "00000000-0000-4000-8000-00000000abcd";
    await t.h.db.query(
      `insert into admin_events (id, org_id, actor_email, action, chain_no, prev_hash, hash)
       values ($1, $2, 'x@acme.test', 'test.forged', 1, 'made-up', 'made-up')`,
      [id, t.orgId],
    );
    const row = (
      await t.h.db.query<{ n: string; hash: string }>(
        "select chain_no as n, hash from admin_events where id = $1",
        [id],
      )
    )[0];
    expect(Number(row?.n)).toBeGreaterThan(1);
    expect(row?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await verifyChain(t.h.db, t.orgId, t.key)).ok).toBe(true);
  });

  it("gives a file that proves itself with nothing but sha256", async () => {
    const file = await exportChain(t.h.db, t.orgId, { from: null, to: null });
    const [first, ...lines] = file.text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(first).toMatchObject({ muster_activity_log: 1, rows: lines.length, truncated: false });
    let before = "";
    for (const line of lines) {
      expect(line.prev_hash).toBe(before);
      expect(sha(`${line.prev_hash}\n${line.canonical}`)).toBe(line.hash);
      // What was hashed is the row itself: its place, who, what, when and the detail.
      const hashed = JSON.parse(line.canonical);
      expect(hashed[0]).toBe(line.chain_no);
      expect(hashed[1]).toBe(line.id);
      expect(new Date(hashed[3]).toISOString()).toBe(line.time);
      expect(hashed[5]).toBe(line.actor_email);
      expect(hashed[6]).toBe(line.action);
      expect(hashed[10]).toEqual(line.detail);
      before = line.hash;
    }
    expect(first.head).toEqual({ chain_no: lines.at(-1).chain_no, hash: before });
    const cut = await exportChain(t.h.db, t.orgId, { from: null, to: null }, 2);
    expect(cut).toMatchObject({ rows: 2, truncated: true });
    expect(
      (await exportChain(t.h.db, t.orgId, { from: "2001-01-01", to: "2001-01-02" })).rows,
    ).toBe(0);
  });

  it("keeps one chain when many write at once", async () => {
    const before = (await t.numbers()).length;
    await Promise.all(Array.from({ length: 40 }, (_, n) => t.note(100 + n)));
    // Some inside transactions of their own, as the routes write them.
    await Promise.all(
      Array.from({ length: 10 }, (_, n) =>
        t.h.db.tx(async (tx) => {
          await recordEvent(tx, {
            orgId: t.orgId,
            actor: { userId: null, email: "tx@acme.test" },
            action: "test.noted",
            detail: { n },
          });
        }),
      ),
    );
    const numbers = await t.numbers();
    expect(numbers).toEqual(Array.from({ length: before + 50 }, (_, index) => index + 1));
    expect((await verifyChain(t.h.db, t.orgId, t.key)).ok).toBe(true);
  });

  it("a row whose transaction is undone leaves no hole", async () => {
    const before = await t.numbers();
    await t.h.db
      .tx(async (tx) => {
        await recordEvent(tx, {
          orgId: t.orgId,
          actor: { userId: null, email: "x@acme.test" },
          action: "test.undone",
        });
        throw new Error("undone");
      })
      .catch(() => undefined);
    await t.note(999);
    expect(await t.numbers()).toEqual([...before, before.length + 1]);
    expect((await verifyChain(t.h.db, t.orgId, t.key)).ok).toBe(true);
  });

  it("still refuses a change or a removal of a row", async () => {
    await expect(
      t.h.db.query("update admin_events set actor_email = 'x' where org_id = $1", [t.orgId]),
    ).rejects.toThrow(/append-only/);
    await expect(
      t.h.db.query("delete from admin_events where org_id = $1", [t.orgId]),
    ).rejects.toThrow(/append-only/);
  });
});

describe("a record that was tampered with", () => {
  it("says which row was changed", async () => {
    const t = await fresh();
    for (let n = 0; n < 6; n++) await t.note(n);
    await behindItsBack(
      t.h.db,
      "update admin_events set actor_email = 'nobody@acme.test' where org_id = $1 and chain_no = 4",
      [t.orgId],
    );
    const state = await verifyChain(t.h.db, t.orgId, t.key);
    expect(state.ok).toBe(false);
    expect(state.broken).toMatchObject({ why: "changed", chainNo: 4 });
  });

  it("says so when the detail alone was changed", async () => {
    const t = await fresh();
    for (let n = 0; n < 3; n++) await t.note(n);
    await behindItsBack(
      t.h.db,
      `update admin_events set detail = '{"n": 7}'::jsonb where org_id = $1 and chain_no = 2`,
      [t.orgId],
    );
    expect((await verifyChain(t.h.db, t.orgId, t.key)).broken).toMatchObject({
      why: "changed",
      chainNo: 2,
    });
  });

  it("says where rows are missing: in the middle, at the start and at the end", async () => {
    const middle = await fresh();
    for (let n = 0; n < 6; n++) await middle.note(n);
    await behindItsBack(
      middle.h.db,
      "delete from admin_events where org_id = $1 and chain_no = 3",
      [middle.orgId],
    );
    expect((await verifyChain(middle.h.db, middle.orgId, middle.key)).broken).toMatchObject({
      why: "missing",
      chainNo: 4,
    });

    const start = await fresh();
    for (let n = 0; n < 4; n++) await start.note(n);
    await behindItsBack(
      start.h.db,
      "delete from admin_events where org_id = $1 and chain_no <= 2",
      [start.orgId],
    );
    expect((await verifyChain(start.h.db, start.orgId, start.key)).broken).toMatchObject({
      why: "missing",
      chainNo: 3,
    });

    const end = await fresh();
    for (let n = 0; n < 4; n++) await end.note(n);
    const last = (await end.numbers()).at(-1) as number;
    await behindItsBack(end.h.db, "delete from admin_events where org_id = $1 and chain_no = $2", [
      end.orgId,
      last,
    ]);
    expect((await verifyChain(end.h.db, end.orgId, end.key)).broken).toMatchObject({
      why: "end",
      chainNo: last - 1,
    });
  });

  it("says so when a row was changed and its own hash made to fit", async () => {
    const t = await fresh();
    for (let n = 0; n < 5; n++) await t.note(n);
    await behindItsBack(
      t.h.db,
      `update admin_events e set actor_email = 'nobody@acme.test' where org_id = $1 and chain_no = 3`,
      [t.orgId],
    );
    await behindItsBack(
      t.h.db,
      `update admin_events e set hash = encode(sha256(convert_to(e.prev_hash || E'\\n' || admin_event_canonical(e), 'UTF8')), 'hex')
        where org_id = $1 and chain_no = 3`,
      [t.orgId],
    );
    // The row now agrees with itself; the one after it no longer follows it.
    expect((await verifyChain(t.h.db, t.orgId, t.key)).broken).toMatchObject({
      why: "link",
      chainNo: 4,
    });
  });
});

describe("what was recorded before there was a chain", () => {
  it("is linked in the order it was written, each organization on its own", async () => {
    const t = await fresh();
    for (let n = 0; n < 4; n++) await t.note(n);
    const other = "00000000-0000-4000-8000-0000000000aa";
    await t.h.db.query("insert into organizations (id, name) values ($1, 'Other')", [other]);
    await recordEvent(t.h.db, {
      orgId: other,
      actor: { userId: null, email: "o@other.test" },
      action: "test.noted",
    });
    // As the rows stood before: no place, no hashes, no head.
    await behindItsBack(
      t.h.db,
      "update admin_events set chain_no = -seq, prev_hash = '', hash = ''",
    );
    await behindItsBack(t.h.db, "delete from audit_chain");
    expect((await verifyChain(t.h.db, t.orgId, t.key)).ok).toBe(false);
    await behindItsBack(t.h.db, AUDIT_BACKFILL);
    const mine = await verifyChain(t.h.db, t.orgId, t.key);
    expect(mine).toMatchObject({ ok: true, first: 1 });
    expect(mine.records).toBe((await t.numbers()).length);
    expect(await verifyChain(t.h.db, other, t.key)).toMatchObject({
      ok: true,
      records: 1,
      last: 1,
    });
    // And what is written after goes on from there.
    await t.note(50);
    expect((await verifyChain(t.h.db, t.orgId, t.key)).ok).toBe(true);
  });
});

describe("rows at the end of their keeping", () => {
  it("go from the front, and a checkpoint lets the rest still prove itself", async () => {
    const t = await fresh();
    const old = new Date("2020-01-01T00:00:00Z");
    for (let n = 0; n < 3; n++)
      await recordEvent(t.h.db, {
        orgId: t.orgId,
        actor: { userId: null, email: "old@acme.test" },
        action: "test.old",
        time: old,
      });
    await t.note(1);
    const all = await t.numbers();
    // The sign-in was written first and is not old: nothing before it can go.
    expect(await t.h.db.tx((tx) => purgeChain(tx, t.orgId, new Date("2021-01-01"), t.key))).toBe(0);
    // Everything is old enough by tomorrow.
    const gone = await t.h.db.tx((tx) =>
      purgeChain(tx, t.orgId, new Date(Date.now() + 86_400_000), t.key, all.length - 2),
    );
    // Held back: the two rows not yet sent on.
    expect(gone).toBe(all.length - 2);
    expect(await t.numbers()).toEqual(all.slice(-2));
    const state = await verifyChain(t.h.db, t.orgId, t.key);
    expect(state).toMatchObject({ ok: true, records: 2, purged: all.length - 2 });
    await t.note(2);
    expect((await verifyChain(t.h.db, t.orgId, t.key)).ok).toBe(true);
    // Everything can go: the chain goes on from the checkpoint alone.
    await t.h.db.tx((tx) => purgeChain(tx, t.orgId, new Date(Date.now() + 86_400_000), t.key));
    expect(await verifyChain(t.h.db, t.orgId, t.key)).toMatchObject({ ok: true, records: 0 });
    await t.note(3);
    expect(await verifyChain(t.h.db, t.orgId, t.key)).toMatchObject({ ok: true, records: 1 });
    // The file says where it starts.
    const first = JSON.parse(
      (await exportChain(t.h.db, t.orgId, { from: null, to: null })).text.split("\n")[0] as string,
    );
    expect(first.purged_through.chain_no).toBe(all.length + 1);
  });

  it("a checkpoint written by someone else is not believed", async () => {
    const t = await fresh();
    for (let n = 0; n < 3; n++) await t.note(n);
    await t.h.db.tx((tx) => purgeChain(tx, t.orgId, new Date(Date.now() + 86_400_000), t.key));
    expect((await verifyChain(t.h.db, t.orgId, t.key)).ok).toBe(true);
    // With another key it is not ours; and so with a hash made up to cover a removal.
    expect((await verifyChain(t.h.db, t.orgId, "another-key")).broken?.why).toBe("checkpoint");
    await expect(
      t.h.db.query("update audit_checkpoints set hash = 'made-up' where org_id = $1", [t.orgId]),
    ).rejects.toThrow(/written by the purge/);
    await behindItsBack(t.h.db, "update audit_checkpoints set hash = 'made-up' where org_id = $1", [
      t.orgId,
    ]);
    expect((await verifyChain(t.h.db, t.orgId, t.key)).broken?.why).toBe("checkpoint");
  });

  it("go a pass at a time, each pass leaving its own checkpoint", async () => {
    const t = await fresh();
    for (let n = 0; n < 6; n++) await t.note(n);
    const all = await t.numbers();
    const tomorrow = new Date(Date.now() + 86_400_000);
    const pass = () => t.h.db.tx((tx) => purgeChain(tx, t.orgId, tomorrow, t.key, null, 3));
    expect(await pass()).toBe(3);
    expect(await t.numbers()).toEqual(all.slice(3));
    expect(await verifyChain(t.h.db, t.orgId, t.key)).toMatchObject({ ok: true, purged: 3 });
    expect(await pass()).toBe(3);
    expect(await pass()).toBe(all.length - 6);
    expect(await pass()).toBe(0);
    expect(await verifyChain(t.h.db, t.orgId, t.key)).toMatchObject({
      ok: true,
      records: 0,
      purged: all.length,
    });
    expect(
      (await t.h.db.query("select 1 from audit_checkpoints where org_id = $1", [t.orgId])).length,
    ).toBe(3);
  });

  it("do not go at all without the server's key, or with another than the first", async () => {
    const t = await fresh();
    for (let n = 0; n < 3; n++) await t.note(n);
    const all = await t.numbers();
    const tomorrow = new Date(Date.now() + 86_400_000);
    expect(await purgeGuard(t.h.db, "")).toBe("no_key");
    expect(await t.h.db.tx((tx) => purgeChain(tx, t.orgId, tomorrow, ""))).toBe(0);
    expect(await purgeGuard(t.h.db, t.key)).toBe("ok");
    expect(await purgeGuard(t.h.db, "another-key-of-thirty-two-characters")).toBe("other_key");
    expect(
      await t.h.db.tx((tx) =>
        purgeChain(tx, t.orgId, tomorrow, "another-key-of-thirty-two-characters"),
      ),
    ).toBe(0);
    expect(await t.numbers()).toEqual(all);
    expect((await t.h.db.query("select 1 from audit_checkpoints")).length).toBe(0);
  });
});

describe("what a session that only reads and writes rows cannot do", () => {
  it("switch the purge on for itself, move the head, or write a checkpoint", async () => {
    const t = await fresh();
    for (let n = 0; n < 3; n++) await t.note(n);
    expect(await purgeGuard(t.h.db, t.key)).toBe("ok");
    const all = await t.numbers();
    // What used to be enough, and anything else it can think of to say.
    for (const said of ["on", "true", "", "muster-audit-purge"])
      await expect(
        t.h.db.tx(async (tx) => {
          await tx.query("select set_config('muster.audit_purge', $1, true)", [said]);
          await tx.query("delete from admin_events where org_id = $1", [t.orgId]);
        }),
        said,
      ).rejects.toThrow(/append-only/);
    // The verifier it can read is not the key.
    const verifier = (
      await t.h.db.query<{ verifier: string }>("select verifier from audit_guard")
    )[0]?.verifier as string;
    await expect(
      t.h.db.tx(async (tx) => {
        await tx.query("select set_config('muster.audit_purge', $1, true)", [verifier]);
        await tx.query("delete from admin_events where org_id = $1", [t.orgId]);
      }),
    ).rejects.toThrow(/append-only/);
    for (const sql of [
      "update audit_guard set verifier = 'mine'",
      "delete from audit_guard",
      "update audit_chain set n = 1, hash = 'mine'",
      "update audit_chain set n = n + 1",
      "update audit_chain set hash = 'mine'",
      "delete from audit_chain",
      `insert into audit_checkpoints (org_id, chain_no, hash, rows, through)
       select org_id, 2, 'mine', 2, now() from audit_chain limit 1`,
    ])
      await expect(t.h.db.query(sql), sql).rejects.toThrow(
        /cannot be changed or removed|moved only by a record|written by the purge/,
      );
    await expect(
      t.h.db.query("insert into audit_guard (verifier) values ('mine')"),
    ).rejects.toThrow();
    expect(await t.numbers()).toEqual(all);
    await t.note(9);
    expect((await verifyChain(t.h.db, t.orgId, t.key)).ok).toBe(true);
  });

  it("rebuild the record from end to end without the check noticing", async () => {
    const t = await fresh();
    for (let n = 0; n < 4; n++) await t.note(n);
    // A check signs for where the record then ended.
    expect((await checkChain(t.h.db, t.orgId, t.key)).ok).toBe(true);
    await t.note(5);
    expect((await checkChain(t.h.db, t.orgId, t.key)).ok).toBe(true);
    // Someone with the database in their hands changes a row and makes every fingerprint
    // after it, and the head, fit again.
    await behindItsBack(
      t.h.db,
      "update admin_events set actor_email = 'nobody@acme.test', chain_no = -seq where org_id = $1 and chain_no = 2",
      [t.orgId],
    );
    await behindItsBack(t.h.db, "update admin_events set chain_no = -seq where chain_no > 0");
    await behindItsBack(t.h.db, AUDIT_BACKFILL);
    // The record agrees with itself; it is not the one that was signed for.
    expect((await verifyChain(t.h.db, t.orgId, "")).ok).toBe(true);
    expect((await verifyChain(t.h.db, t.orgId, t.key)).broken).toMatchObject({ why: "anchor" });
    // And the place signed for cannot be moved back or taken away to hide it.
    for (const sql of [
      "update audit_chain set signed_n = null, signed_hash = null, signed_mac = null",
      "update audit_chain set signed_n = 1",
    ])
      await expect(t.h.db.query(sql), sql).rejects.toThrow(/moved only by a record/);
  });
});

describe("sending the record on", () => {
  const setUp = async (t: Awaited<ReturnType<typeof fresh>>, body: Record<string, unknown>) =>
    t.h.api(t.owner, "PUT", "/api/audit/forward", {
      kind: "json",
      url: "https://siem.example.com/in",
      ...body,
    });
  const status = async (t: Awaited<ReturnType<typeof fresh>>) =>
    (
      await json<{
        forward: {
          cursor: number;
          behind: number;
          failures: number;
          error: string | null;
          nextAt: string | null;
          hasToken: boolean;
          stalled: boolean;
          failingSince: string | null;
          deliveredAt: string | null;
        };
      }>(await t.h.api(t.owner, "GET", "/api/audit/chain"))
    ).forward;

  it("delivers in order from where it got to, and loses nothing while the other end is down", async () => {
    const t = await fresh();
    const out = siem();
    let now = new Date("2026-11-24T00:00:00Z");
    const forwarder = new AuditForwarder(t.h.db, t.key, out.net, () => now);
    for (let n = 0; n < 3; n++) await t.note(n);
    expect((await setUp(t, { token: "s3cret", start: "beginning" })).status).toBe(200);
    const all = await t.numbers();

    out.state.down = true;
    expect(await forwarder.tick()).toBe(0);
    let s = await status(t);
    expect(s).toMatchObject({ cursor: 0, behind: all.length, failures: 1, hasToken: true });
    expect(s.error).toBe("The address could not be reached.");
    // Not tried again before its time.
    out.state.down = false;
    expect(await forwarder.tick()).toBe(0);
    expect(out.state.calls).toBe(1);

    // A refusal is a failure too, and the wait doubles.
    now = new Date(now.getTime() + 31_000);
    out.state.status = 503;
    expect(await forwarder.tick()).toBe(0);
    s = await status(t);
    expect(s).toMatchObject({ cursor: 0, failures: 2, error: "The address answered 503." });
    expect(new Date(s.nextAt as string).getTime() - now.getTime()).toBe(60_000);

    now = new Date(now.getTime() + 61_000);
    out.state.status = 200;
    expect(await forwarder.tick()).toBe(all.length);
    expect(out.numbers()).toEqual(all);
    expect(out.took[0]?.headers.authorization).toBe("Bearer s3cret");
    s = await status(t);
    expect(s).toMatchObject({ cursor: all.length, behind: 0, failures: 0, error: null });
    expect(s.deliveredAt).toBe(now.toISOString());

    // What is written after goes next, once.
    await t.note(9);
    expect(await forwarder.tick()).toBe(1);
    expect(await forwarder.tick()).toBe(0);
    expect(out.numbers()).toEqual([...all, all.length + 1]);
  });

  it("sends a long record in batches, and what a failed batch held again", async () => {
    const t = await fresh();
    const out = siem();
    let now = new Date("2026-11-24T00:00:00Z");
    const forwarder = new AuditForwarder(t.h.db, t.key, out.net, () => now);
    await setUp(t, { start: "beginning" });
    for (let n = 0; n < 250; n++) await t.note(n);
    const all = await t.numbers();
    // The second batch is refused: the first stays delivered, the rest waits.
    let calls = 0;
    const flaky: Net = {
      request: (url, init) => {
        calls++;
        out.state.status = calls === 2 ? 500 : 200;
        return out.net.request(url, init);
      },
    };
    const first = new AuditForwarder(t.h.db, t.key, flaky, () => now);
    expect(await first.tick()).toBe(200);
    now = new Date(now.getTime() + 31_000);
    out.state.status = 200;
    expect(await forwarder.tick()).toBe(all.length - 200);
    expect(out.numbers()).toEqual(all);
  });

  it("starts from now unless asked for everything, and stops when switched off", async () => {
    const t = await fresh();
    const out = siem();
    const forwarder = new AuditForwarder(t.h.db, t.key, out.net);
    for (let n = 0; n < 3; n++) await t.note(n);
    await setUp(t, {});
    // Setting it up is itself recorded, and is the first thing sent.
    const all = await t.numbers();
    expect(await forwarder.tick()).toBe(1);
    expect(out.numbers()).toEqual([all.length]);
    await setUp(t, { enabled: false });
    await t.note(5);
    expect(await forwarder.tick()).toBe(0);
    // A change keeps its place: switched on again, it goes on from where it was.
    await setUp(t, { enabled: true, start: "beginning" });
    expect(await forwarder.tick()).toBe(3);
    expect(out.numbers().at(-1)).toBe((await t.numbers()).length);
    expect(out.numbers()[0]).toBe(all.length);
  });

  it("halves a request the other end finds too big, down to what it takes", async () => {
    const t = await fresh();
    const sizes: number[] = [];
    const picky: Net = {
      async request(url, init = {}) {
        const n = (JSON.parse(init.body ?? "{}") as { events: unknown[] }).events.length;
        sizes.push(n);
        return { status: n > 30 ? 413 : 200, contentType: "", text: "", truncated: false, url };
      },
    };
    await setUp(t, { start: "beginning" });
    for (let n = 0; n < 130; n++) await t.note(n);
    const all = await t.numbers();
    const forwarder = new AuditForwarder(t.h.db, t.key, picky);
    let sent = 0;
    for (let tick = 0; tick < 4 && sent < all.length; tick++) sent += await forwarder.tick();
    expect(sent).toBe(all.length);
    // 135 or so waiting: 200 asked for, so all at once; then 67, 33, 16, and 16 from then on.
    expect(sizes.slice(0, 4).map((n) => n > 30)).toEqual([true, true, true, false]);
    expect(Math.max(...sizes.slice(3))).toBeLessThanOrEqual(30);
    const s = await status(t);
    // Being too big was never counted as the other end failing.
    expect(s).toMatchObject({ behind: 0, failures: 0, error: null });
  });

  it("says it has stalled after twenty failures in a row, and since when", async () => {
    const t = await fresh();
    const out = siem();
    let now = new Date("2026-11-24T00:00:00Z");
    const forwarder = new AuditForwarder(t.h.db, t.key, out.net, () => now);
    await setUp(t, { start: "beginning" });
    out.state.status = 500;
    for (let n = 0; n < STALLED_AFTER - 1; n++) {
      await forwarder.tick();
      now = new Date(now.getTime() + 3_600_001);
    }
    let s = await status(t);
    expect(s).toMatchObject({ failures: STALLED_AFTER - 1, stalled: false });
    expect(s.failingSince).toBe("2026-11-24T00:00:00.000Z");
    await forwarder.tick();
    s = await status(t);
    expect(s).toMatchObject({ failures: STALLED_AFTER, stalled: true, cursor: 0 });
    // Stalled is not given up: it still tries, and one answer puts everything right.
    now = new Date(now.getTime() + 3_600_001);
    out.state.status = 200;
    expect(await forwarder.tick()).toBeGreaterThan(0);
    s = await status(t);
    expect(s).toMatchObject({ failures: 0, stalled: false, failingSince: null, behind: 0 });
  });

  it("speaks Splunk's collector when asked", async () => {
    const { body, headers } = forwardRequest("splunk", "tok", [
      {
        chain_no: 1,
        id: "a",
        time: "2026-11-24T00:00:00.000Z",
        actor_user_id: null,
        actor_email: "a@acme.test",
        action: "auth.login",
        target_type: null,
        target_id: null,
        target_label: null,
        detail: {},
        ip: null,
        prev_hash: "",
        hash: "h",
      },
    ]);
    expect(headers.authorization).toBe("Splunk tok");
    expect(JSON.parse(body)).toMatchObject({
      time: 1795478400,
      sourcetype: "muster:audit",
      event: { chain_no: 1, action: "auth.login" },
    });
    expect([1, 2, 3, 8, 30].map(waitAfter)).toEqual([
      30_000, 60_000, 120_000, 3_600_000, 3_600_000,
    ]);
  });

  it("takes only a public https address, keeps the token sealed and never gives it back", async () => {
    const t = await fresh();
    for (const url of [
      "http://siem.example.com/in",
      "https://127.0.0.1/in",
      "https://10.0.0.8/in",
      "https://localhost/in",
      "https://user:pw@siem.example.com/in",
      "https://siem.example.com:8088/in",
      "not an address",
    ])
      expect((await setUp(t, { url })).status, url).toBe(400);
    expect((await setUp(t, { kind: "syslog" })).status).toBe(400);
    expect((await setUp(t, { token: "s3cret-token" })).status).toBe(200);
    const page = await (await t.h.api(t.owner, "GET", "/api/audit/chain")).text();
    expect(page).not.toContain("s3cret-token");
    const sealed = (
      await t.h.db.query<{ sealed: string }>("select token_sealed as sealed from audit_forward")
    )[0]?.sealed as string;
    expect(sealed).not.toContain("s3cret-token");
    expect(openText(t.key, sealed)).toBe("s3cret-token");
    // A token kept is for the address it was entered with.
    expect((await setUp(t, { url: "https://elsewhere.example.com/in" })).status).toBe(409);
    expect(
      (await setUp(t, { url: "https://elsewhere.example.com/in", token: "another" })).status,
    ).toBe(200);
    // Left out, it stays; given empty, it goes.
    await setUp(t, { url: "https://elsewhere.example.com/other" });
    expect((await status(t)).hasToken).toBe(true);
    await setUp(t, { url: "https://elsewhere.example.com/other", token: "" });
    expect((await status(t)).hasToken).toBe(false);
    const said = (
      await t.h.db.query<{ action: string; detail: unknown }>(
        "select action, detail from admin_events where action like 'audit.forward%' order by seq",
      )
    ).map((row) => JSON.stringify(row));
    expect(said.join("\n")).not.toMatch(/s3cret|another/);
    expect((await t.h.api(t.owner, "DELETE", "/api/audit/forward")).status).toBe(200);
    expect((await t.h.api(t.owner, "DELETE", "/api/audit/forward")).status).toBe(404);
    expect((await status(t)) ?? null).toBeNull();
  });

  it("tries the address as saved when asked, without touching the record", async () => {
    const out = siem();
    const h = await harness({}, { net: out.net });
    const owner = (await h.signIn("owner@acme.test")).cookie as string;
    expect((await h.api(owner, "POST", "/api/audit/forward/test")).status).toBe(404);
    await h.api(owner, "PUT", "/api/audit/forward", {
      kind: "json",
      url: "https://siem.example.com/in",
    });
    const before = (await h.db.query("select 1 from admin_events")).length;
    expect(await json(await h.api(owner, "POST", "/api/audit/forward/test"))).toEqual({
      ok: true,
      problem: null,
    });
    expect(JSON.parse(out.took[0]?.body ?? "{}").events[0]).toMatchObject({
      action: "audit.forward_test",
      detail: { test: true },
    });
    out.state.status = 401;
    expect(await json(await h.api(owner, "POST", "/api/audit/forward/test"))).toEqual({
      ok: false,
      problem: "The address answered 401.",
    });
    expect((await h.db.query("select 1 from admin_events")).length).toBe(before);
  });
});

describe("the console's part", () => {
  let t: Awaited<ReturnType<typeof fresh>>;
  let auditor: string;
  let member: string;
  beforeAll(async () => {
    t = await fresh();
    await t.h.api(t.owner, "POST", "/api/invitations", { email: "au@acme.test", role: "auditor" });
    await t.h.api(t.owner, "POST", "/api/invitations", { email: "mo@acme.test", role: "member" });
    auditor = (await t.h.signIn("au@acme.test")).cookie as string;
    member = (await t.h.signIn("mo@acme.test")).cookie as string;
  });

  it("checks the record when asked, keeps what it found and records that it was checked", async () => {
    const before = await json<{ checkedAt: string | null; records: number }>(
      await t.h.api(auditor, "GET", "/api/audit/chain"),
    );
    expect(before.checkedAt).toBeNull();
    const state = await json<{ ok: boolean; records: number }>(
      await t.h.api(auditor, "POST", "/api/audit/chain/verify"),
    );
    expect(state).toMatchObject({ ok: true, records: before.records });
    const after = await json<{
      checkedAt: string | null;
      checkedOk: boolean;
      records: number;
      checked: { records: number };
    }>(await t.h.api(auditor, "GET", "/api/audit/chain"));
    expect(after.checkedAt).not.toBeNull();
    expect(after).toMatchObject({ checkedOk: true, records: before.records + 1 });
    const noted = await t.h.db.query<{ detail: { ok: boolean } }>(
      "select detail from admin_events where action = 'audit.verified'",
    );
    expect(noted.map((row) => row.detail.ok)).toEqual([true]);
  });

  it("says on the page what a check found wrong", async () => {
    await behindItsBack(
      t.h.db,
      "update admin_events set action = 'auth.logout' where org_id = $1 and chain_no = 2",
      [t.orgId],
    );
    // Asked again within the minute, it is refused: what was found is already on the page.
    const soon = await t.h.api(t.owner, "POST", "/api/audit/chain/verify");
    expect(soon.status).toBe(429);
    expect((await json<{ error: { code: string } }>(soon)).error.code).toBe("audit_check_recent");
    await t.h.db.query("update audit_chain set checked_at = now() - interval '2 minutes'");
    const state = await json<{ ok: boolean; broken: { why: string; chainNo: number } }>(
      await t.h.api(t.owner, "POST", "/api/audit/chain/verify"),
    );
    expect(state).toMatchObject({ ok: false, broken: { why: "changed", chainNo: 2 } });
    expect(
      await json<{ checkedOk: boolean }>(await t.h.api(t.owner, "GET", "/api/audit/chain")),
    ).toMatchObject({ checkedOk: false, checked: { broken: { chainNo: 2 } } });
  });

  it("gives the file to whoever may read the record, and records the taking", async () => {
    const file = await t.h.api(auditor, "GET", "/api/audit/chain/export?from=2020-01-01");
    expect(file.status).toBe(200);
    expect(file.headers.get("content-disposition")).toContain("muster-activity-log.jsonl");
    const lines = (await file.text()).trim().split("\n");
    expect(JSON.parse(lines[0] as string).rows).toBe(lines.length - 1);
    expect((await t.h.api(auditor, "GET", "/api/audit/chain/export?from=yesterday")).status).toBe(
      400,
    );
    const taken = await t.h.db.query<{ detail: { format: string } }>(
      "select detail from admin_events where action = 'audit.exported'",
    );
    expect(taken.map((row) => row.detail.format)).toEqual(["jsonl"]);
  });

  it("is closed to members, and an auditor reads but sets nothing", async () => {
    for (const [method, path] of [
      ["GET", "/api/audit/chain"],
      ["POST", "/api/audit/chain/verify"],
      ["GET", "/api/audit/chain/export"],
      ["PUT", "/api/audit/forward"],
      ["DELETE", "/api/audit/forward"],
      ["POST", "/api/audit/forward/test"],
    ] as const)
      expect(
        (await t.h.api(member, method, path, method === "PUT" ? {} : undefined)).status,
        path,
      ).toBe(403);
    const body = { kind: "json", url: "https://siem.example.com/in" };
    expect((await t.h.api(auditor, "PUT", "/api/audit/forward", body)).status).toBe(403);
    expect((await t.h.api(auditor, "DELETE", "/api/audit/forward")).status).toBe(403);
    expect((await t.h.api(auditor, "POST", "/api/audit/forward/test")).status).toBe(403);
  });
});
