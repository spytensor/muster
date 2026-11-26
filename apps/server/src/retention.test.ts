import { newId } from "@muster/protocol";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { recordEvent } from "./audit.js";
import { verifyChain } from "./chain.js";
import type { Db } from "./db.js";
import { erasePerson, purgeOrg, Retention } from "./retention.js";
import { type Harness, harness } from "./test-support.js";

vi.setConfig({ testTimeout: 90_000 });

const json = async <T = unknown>(response: Response): Promise<T> => (await response.json()) as T;
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

/** What the store itself holds for a file: the content, apart from its record. */
const bytesOf = (h: Harness, orgId: string, id: string) =>
  (h.files as unknown as { store: { read(key: string): Promise<Uint8Array | null> } }).store.read(
    `${orgId}/${id}`,
  );

interface Page {
  periods: Record<string, number | null>;
  hold: { reason: string; by: string } | null;
  nextAt: string | null;
  purgedAt: string | null;
  purged: Record<string, number> | null;
  waiting: Record<string, number>;
}

async function world() {
  const h = await harness();
  const owner = (await h.signIn("owner@acme.test")).cookie as string;
  await h.api(owner, "POST", "/api/invitations", { email: "mo@acme.test", role: "member" });
  await h.api(owner, "POST", "/api/invitations", { email: "au@acme.test", role: "auditor" });
  const mo = (await h.signIn("mo@acme.test")).cookie as string;
  const auditor = (await h.signIn("au@acme.test")).cookie as string;
  const orgId = (await h.db.query<{ id: string }>("select id from organizations"))[0]?.id as string;
  const idOf = async (email: string) =>
    (await h.db.query<{ id: string }>("select id from users where email = $1", [email]))[0]
      ?.id as string;
  const agent = (
    await json<{ id: string }>(
      await h.api(owner, "POST", "/api/app/agents", {
        name: "Reader",
        description: "Reads",
        instructions: "Read.",
        tools: ["files.read"],
      }),
    )
  ).id;
  /** A conversation last spoken in so many days ago, with a run made for it. */
  const conversation = async (userId: string, days: number) => {
    const id = newId();
    const when = ago(days);
    await h.db.query(
      `insert into conversations (id, org_id, user_id, agent_id, title, created_at, updated_at)
       values ($1, $2, $3, $4, 'Talk', $5, $5)`,
      [id, orgId, userId, agent, when],
    );
    await h.db.query(
      `insert into messages (id, conversation_id, org_id, seq, role, content, created_at)
       values ($1, $2, $3, 1, 'user', 'hello', $4)`,
      [newId(), id, orgId, when],
    );
    await h.db.query(
      `insert into traces (id, org_id, agent_id, agent_version, user_id, conversation_id, venue,
                           status, started_at, duration_ms, max_action)
       values ($1, $2, $3, 'v1', $4, $5, 'cloud', 'ok', $6, 10, 'A0')`,
      [newId(), orgId, agent, userId, id, when],
    );
    return id;
  };
  /** A file uploaded so many days ago. */
  const file = async (cookie: string, name: string, days: number) => {
    const { id } = await json<{ id: string }>(await h.upload(cookie, name, `words in ${name}`));
    await h.db.query("update files set created_at = $2 where id = $1", [id, ago(days)]);
    return id;
  };
  const count = async (table: string, where = "true", params: unknown[] = []) =>
    Number(
      (
        await h.db.query<{ n: string }>(`select count(*) as n from ${table} where ${where}`, params)
      )[0]?.n,
    );
  const page = async (as = owner) => json<Page>(await h.api(as, "GET", "/api/retention"));
  const set = (periods: Record<string, number | null>, as = owner) =>
    h.api(as, "PUT", "/api/retention", {
      conversations: null,
      files: null,
      traces: null,
      audit: null,
      ...periods,
    });
  return { h, owner, mo, auditor, orgId, idOf, conversation, file, count, page, set };
}

describe("how long things are kept", () => {
  let w: Awaited<ReturnType<typeof world>>;
  let me: string;
  beforeAll(async () => {
    w = await world();
    me = await w.idOf("owner@acme.test");
  });

  it("is forever until a period is set, and a period has its limits", async () => {
    const first = await w.page();
    expect(first.periods).toEqual({ conversations: null, files: null, traces: null, audit: null });
    expect(first).toMatchObject({ hold: null, nextAt: null, purgedAt: null });
    const bads: Record<string, number | null>[] = [
      { conversations: 29 },
      { files: 3651 },
      { traces: 90.5 },
      { audit: 364 },
      { conversations: "90" as unknown as number },
    ];
    for (const bad of bads) expect((await w.set(bad)).status, JSON.stringify(bad)).toBe(400);
    expect((await w.h.api(w.owner, "PUT", "/api/retention", { conversations: 90 })).status).toBe(
      400,
    );
    expect((await w.set({ conversations: 90 }, w.auditor)).status).toBe(403);
    expect((await w.h.api(w.mo, "GET", "/api/retention")).status).toBe(403);
    expect((await w.page(w.auditor)).periods.conversations).toBeNull();
  });

  it("says what a period would take before it is saved", async () => {
    await w.conversation(me, 200);
    await w.conversation(me, 100);
    await w.conversation(me, 1);
    await w.file(w.owner, "old.txt", 200);
    await w.file(w.owner, "new.txt", 1);
    const preview = async (periods: Record<string, number | null>, as = w.owner) =>
      json<Record<string, number>>(
        await w.h.api(as, "POST", "/api/retention/preview", {
          conversations: null,
          files: null,
          traces: null,
          audit: null,
          ...periods,
        }),
      );
    expect(await preview({ conversations: 90, files: 90, traces: 150 })).toEqual({
      conversations: 2,
      files: 1,
      traces: 1,
      audit: 0,
    });
    expect(await preview({ conversations: 365 }, w.auditor)).toMatchObject({ conversations: 0 });
    // Asking takes nothing.
    expect(await w.count("conversations")).toBe(3);
  });

  it("is recorded when changed, and purges nothing for a day after", async () => {
    expect((await w.set({ conversations: 90, files: 90, traces: 150 })).status).toBe(200);
    const page = await w.page();
    expect(page.periods).toEqual({ conversations: 90, files: 90, traces: 150, audit: null });
    expect(page.waiting).toMatchObject({ conversations: 2, files: 1, traces: 1 });
    expect(new Date(page.nextAt as string).getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    const noted = await w.h.db.query<{ detail: { from: unknown; to: { conversations: number } } }>(
      "select detail from admin_events where action = 'retention.changed'",
    );
    expect(noted.length).toBe(1);
    expect(noted[0]?.detail.to.conversations).toBe(90);
    // Saved again unchanged: no second record, and the day of grace does not start over.
    await w.set({ conversations: 90, files: 90, traces: 150 });
    expect(await w.count("admin_events", "action = 'retention.changed'")).toBe(1);
    const retention = new Retention(w.h.db, w.h.files, w.h.config.secretKey);
    await retention.tick();
    expect(await w.count("conversations")).toBe(3);
    expect((await w.page()).purgedAt).toBeNull();
  });

  it("takes what is past its period once the day has passed, and nothing else", async () => {
    const kept = await w.file(w.owner, "spec.txt", 300);
    const project = await json<{ id: string }>(
      await w.h.api(w.owner, "POST", "/api/app/projects", { name: "Launch" }),
    );
    expect(
      (
        await w.h.api(w.owner, "PUT", `/api/app/projects/${project.id}/docs/${kept}`, {
          kind: "spec",
        })
      ).status,
    ).toBe(200);
    const running = await w.conversation(me, 400);
    await w.h.db.query("update messages set status = 'running' where conversation_id = $1", [
      running,
    ]);
    const stored = async (id: string) =>
      (await w.h.api(w.owner, "GET", `/api/app/files/${id}/content`)).status;
    const old = (
      await w.h.db.query<{ id: string }>("select id from files where name = 'old.txt'")
    )[0]?.id as string;
    expect(await stored(old)).toBe(200);

    const retention = new Retention(w.h.db, w.h.files, w.h.config.secretKey);
    const tomorrow = new Date(Date.now() + DAY + 60_000);
    expect(await retention.tick(tomorrow)).toBe(1);
    // By tomorrow's clock the 100-day-old ones are 101 days old; the day-old ones are not old.
    expect(await w.count("conversations")).toBe(2);
    expect(await w.count("conversations", "id = $1", [running])).toBe(1);
    expect(await w.count("messages")).toBe(2);
    expect(await w.count("files", "name = 'old.txt'")).toBe(0);
    expect(await w.count("files", "name in ('new.txt', 'spec.txt')")).toBe(2);
    expect(await stored(old)).toBe(404);
    expect(await bytesOf(w.h, w.orgId, old)).toBeNull();
    expect(await stored(kept)).toBe(200);
    // Runs have their own period: the 200- and 400-day-old go, the 100-day-old stays.
    expect(await w.count("traces")).toBe(2);
    const page = await w.page();
    expect(page.purged).toMatchObject({ conversations: 2, files: 1, traces: 2, audit: 0 });
    expect(page.purgedAt).not.toBeNull();
    const noted = await w.h.db.query<{ actor: string; detail: Record<string, number> }>(
      "select actor_email as actor, detail from admin_events where action = 'retention.purged'",
    );
    expect(noted).toEqual([
      {
        actor: "muster",
        detail: { conversations: 2, files: 1, traces: 2, audit: 0, auditUnsent: 0 },
      },
    ]);
    // Not again the same day, whoever asks; and the day after, with nothing to take, no record.
    expect(await retention.tick(new Date(tomorrow.getTime() + 3_600_000))).toBe(0);
    expect(await new Retention(w.h.db, w.h.files, "k").tick(tomorrow)).toBe(0);
    expect(await retention.tick(new Date(tomorrow.getTime() + DAY + 1))).toBe(1);
    expect(await w.count("admin_events", "action = 'retention.purged'")).toBe(1);
  });

  it("stops under a legal hold, which says why and who", async () => {
    await w.conversation(me, 500);
    const hold = (body: unknown, as = w.owner) => w.h.api(as, "PUT", "/api/retention/hold", body);
    expect((await hold({ on: true })).status).toBe(400);
    expect((await hold({ on: true, reason: "x" }, w.auditor)).status).toBe(403);
    expect((await hold({ on: true, reason: "Case 2026-114, counsel's letter" })).status).toBe(200);
    const page = await w.page();
    expect(page.hold).toMatchObject({
      reason: "Case 2026-114, counsel's letter",
      by: "owner@acme.test",
    });
    expect(page.nextAt).toBeNull();
    const retention = new Retention(w.h.db, w.h.files, w.h.config.secretKey);
    const later = new Date(Date.now() + 5 * DAY);
    expect(await retention.tick(later)).toBe(0);
    expect(await purgeOrg(w.h.db, w.h.files, w.orgId, w.h.config.secretKey, later)).toBeNull();
    expect(await w.count("conversations")).toBe(3);
    // A file its owner deletes meanwhile leaves their list and keeps its content.
    const held = await w.file(w.owner, "held.txt", 1);
    expect((await w.h.api(w.owner, "DELETE", `/api/app/files/${held}`)).status).toBe(200);
    expect((await w.h.api(w.owner, "GET", `/api/app/files/${held}/content`)).status).toBe(404);
    expect(await bytesOf(w.h, w.orgId, held)).not.toBeNull();
    // As if the last purge was days ago, so only the hold and its lifting decide.
    await w.h.db.query("update retention set purged_at = $1", [ago(3)]);
    // Lifted: nothing goes that moment; a day later it does.
    expect((await hold({ on: false })).status).toBe(200);
    expect(await retention.tick(new Date(Date.now() + 3_600_000))).toBe(0);
    expect(await w.count("conversations")).toBe(3);
    expect(await retention.tick(new Date(Date.now() + DAY + 60_000))).toBe(1);
    expect(await w.count("conversations")).toBe(2);
    const noted = await w.h.db.query<{ action: string; detail: { reason: string } }>(
      "select action, detail from admin_events where action like 'retention.hold%' order by seq",
    );
    expect(noted.map((row) => [row.action, row.detail.reason])).toEqual([
      ["retention.hold_on", "Case 2026-114, counsel's letter"],
      ["retention.hold_off", "Case 2026-114, counsel's letter"],
    ]);
  });
});

describe("the activity log's own period", () => {
  it("takes old records from the front and leaves a record that still proves itself", async () => {
    const w = await world();
    const key = w.h.config.secretKey;
    // Sign-ins and invitations came first and are new, so old ones are put before them
    // the only way they can be: in an organization of their own.
    const other = "00000000-0000-4000-8000-0000000000bb";
    await w.h.db.query("insert into organizations (id, name) values ($1, 'Old')", [other]);
    for (let n = 0; n < 5; n++)
      await recordEvent(w.h.db, {
        orgId: other,
        actor: { userId: null, email: "old@old.test" },
        action: "test.old",
        time: ago(n < 3 ? 500 : 10),
      });
    await w.h.db.query(
      "insert into retention (org_id, audit_days, changed_at) values ($1, 365, $2)",
      [other, ago(3)],
    );
    // Being sent on, and only the first two have gone: the third waits though it is old.
    await w.h.db.query(
      `insert into audit_forward (org_id, kind, url, cursor) values ($1, 'json', 'https://siem.example.com/in', 2)`,
      [other],
    );
    expect(await purgeOrg(w.h.db, w.h.files, other, key)).toMatchObject({ audit: 2 });
    expect(await verifyChain(w.h.db, other, key)).toMatchObject({ ok: true, purged: 2, first: 3 });
    await w.h.db.query("update audit_forward set cursor = 5 where org_id = $1", [other]);
    expect(await purgeOrg(w.h.db, w.h.files, other, key)).toMatchObject({ audit: 1 });
    // The purge wrote its own record after the two that were kept.
    expect(await verifyChain(w.h.db, other, key)).toMatchObject({ ok: true, purged: 3, first: 4 });
    expect(
      (
        await w.h.db.query<{ action: string }>(
          "select action from admin_events where org_id = $1 order by chain_no",
          [other],
        )
      ).map((row) => row.action),
    ).toEqual(["test.old", "test.old", "retention.purged", "retention.purged"]);
  });
});

describe("erasing a person who has left", () => {
  let w: Awaited<ReturnType<typeof world>>;
  let mo: string;
  let owner: string;
  let moFile: string;
  let ownerFile: string;
  const at = () => `/api/members/${mo}/erase`;
  beforeAll(async () => {
    w = await world();
    mo = await w.idOf("mo@acme.test");
    owner = await w.idOf("owner@acme.test");
    await w.conversation(mo, 3);
    await w.conversation(mo, 2);
    await w.conversation(owner, 2);
    moFile = await w.file(w.mo, "mine.txt", 1);
    ownerFile = await w.file(w.owner, "theirs.txt", 1);
    await w.h.api(w.mo, "POST", "/api/app/projects", { name: "Mo's" });
    await w.h.db.query(
      "insert into memories (id, org_id, user_id, text) values ($1, $2, $3, 'Likes tea')",
      [newId(), w.orgId, mo],
    );
  });

  it("is only for someone already removed, and says first what would go", async () => {
    const asked = await json<{ email: string; removed: boolean; holds: Record<string, number> }>(
      await w.h.api(w.owner, "GET", at()),
    );
    expect(asked).toMatchObject({
      email: "mo@acme.test",
      removed: false,
      holds: { conversations: 2, files: 1, projects: 1, memories: 1, traces: 2 },
    });
    expect((await w.h.api(w.owner, "POST", at(), { email: "mo@acme.test" })).status).toBe(409);
    expect((await w.h.api(w.auditor, "GET", at())).status).toBe(403);
    expect((await w.h.api(w.auditor, "POST", at(), { email: "mo@acme.test" })).status).toBe(403);
    expect((await w.h.api(w.owner, "GET", `/api/members/${owner}/erase`)).status).toBe(400);
    expect(await w.count("conversations", "user_id = $1", [mo])).toBe(2);
  });

  it("asks for the address typed out, and is refused under a hold", async () => {
    expect((await w.h.api(w.owner, "DELETE", `/api/members/${mo}`)).status).toBe(200);
    expect((await w.h.api(w.owner, "POST", at(), { email: "mo@acme" })).status).toBe(400);
    expect((await w.h.api(w.owner, "POST", at(), {})).status).toBe(400);
    await w.h.api(w.owner, "PUT", "/api/retention/hold", { on: true, reason: "Case 7" });
    expect((await w.h.api(w.owner, "POST", at(), { email: "mo@acme.test" })).status).toBe(409);
    await w.h.api(w.owner, "PUT", "/api/retention/hold", { on: false });
    expect(await w.count("conversations", "user_id = $1", [mo])).toBe(2);
  });

  it("takes everything that is theirs and nothing that is not", async () => {
    const done = await json<{ ok: boolean; erased: Record<string, number> }>(
      await w.h.api(w.owner, "POST", at(), { email: "MO@acme.test" }),
    );
    expect(done).toMatchObject({
      ok: true,
      erased: { conversations: 2, files: 1, projects: 1, memories: 1, traces: 2 },
    });
    for (const table of ["conversations", "files", "projects", "memories", "traces", "notices"])
      expect(await w.count(table, "user_id = $1", [mo]), table).toBe(0);
    expect(await w.count("messages")).toBe(1);
    expect(await w.count("conversations", "user_id = $1", [owner])).toBe(1);
    expect(await w.count("traces", "user_id = $1", [owner])).toBe(1);
    expect((await w.h.api(w.owner, "GET", `/api/app/files/${ownerFile}/content`)).status).toBe(200);
    expect(await w.count("files", "id = $1", [moFile])).toBe(0);
    expect(await bytesOf(w.h, w.orgId, moFile)).toBeNull();
    expect(await bytesOf(w.h, w.orgId, ownerFile)).not.toBeNull();
    // They are still known to have been a member, and it is on the record who erased what.
    expect(await w.count("memberships", "user_id = $1 and status = 'removed'", [mo])).toBe(1);
    const noted = await w.h.db.query<{ label: string; detail: Record<string, number> }>(
      "select target_label as label, detail from admin_events where action = 'member.erased'",
    );
    expect(noted).toEqual([
      { label: "mo@acme.test", detail: expect.objectContaining({ conversations: 2, files: 1 }) },
    ]);
    // Asked again, there is nothing left to take.
    const again = await json<{ erased: Record<string, number> }>(
      await w.h.api(w.owner, "POST", at(), { email: "mo@acme.test" }),
    );
    expect(Object.values(again.erased).every((n) => n === 0)).toBe(true);
    expect((await verifyChain(w.h.db, w.orgId, w.h.config.secretKey)).ok).toBe(true);
  });
});

describe("what a purge must leave alone", () => {
  it("keeps a file a kept conversation shows, and takes it once the conversation goes", async () => {
    const w = await world();
    const me = await w.idOf("owner@acme.test");
    const key = w.h.config.secretKey;
    const talk = await w.conversation(me, 100);
    const made = await w.file(w.owner, "made.txt", 200);
    const sent = await w.file(w.owner, "sent.txt", 200);
    const loose = await w.file(w.owner, "loose.txt", 200);
    await w.h.db.query("update files set conversation_id = $2 where id = $1", [made, talk]);
    await w.h.db.query("update messages set attachments = $2::jsonb where conversation_id = $1", [
      talk,
      JSON.stringify([{ id: sent, name: "sent.txt", kind: "text", size: 3 }]),
    ]);
    // Files are kept 90 days and conversations for good: only the file nothing shows goes.
    await w.h.db.query(
      "insert into retention (org_id, files_days, changed_at) values ($1, 90, $2)",
      [w.orgId, ago(3)],
    );
    expect(
      await json<Record<string, number>>(
        await w.h.api(w.owner, "POST", "/api/retention/preview", {
          conversations: null,
          files: 90,
          traces: null,
          audit: null,
        }),
      ),
    ).toMatchObject({ files: 1 });
    expect(await purgeOrg(w.h.db, w.h.files, w.orgId, key)).toMatchObject({ files: 1 });
    expect(await w.count("files", "id = any($1::uuid[])", [[made, sent]])).toBe(2);
    expect(await w.count("files", "id = $1", [loose])).toBe(0);
    expect(await bytesOf(w.h, w.orgId, made)).not.toBeNull();
    // With a period for conversations too, the conversation goes first and its files after.
    await w.h.db.query("update retention set conversations_days = 30 where org_id = $1", [w.orgId]);
    expect(await purgeOrg(w.h.db, w.h.files, w.orgId, key)).toMatchObject({
      conversations: 1,
      files: 2,
    });
    expect(await bytesOf(w.h, w.orgId, made)).toBeNull();
  });

  it("forgets where code ran for a conversation it takes", async () => {
    const w = await world();
    const me = await w.idOf("owner@acme.test");
    const old = await w.conversation(me, 100);
    const recent = await w.conversation(me, 1);
    await w.h.db.query(
      "insert into retention (org_id, conversations_days, changed_at) values ($1, 30, $2)",
      [w.orgId, ago(3)],
    );
    const forgotten: string[] = [];
    const spaces = {
      forget: async (space: string) => {
        forgotten.push(space);
        // The runner being away is no reason for the purge to fail.
        throw new Error("the sandbox is not there");
      },
    };
    const retention = new Retention(w.h.db, w.h.files, w.h.config.secretKey, spaces);
    expect(await retention.tick()).toBe(1);
    expect(forgotten).toEqual([old]);
    expect(await w.count("conversations", "id = $1", [recent])).toBe(1);
  });

  it("stops at the next batch when a hold is placed while it runs", async () => {
    const w = await world();
    const me = await w.idOf("owner@acme.test");
    await w.conversation(me, 100);
    await w.file(w.owner, "old.txt", 100);
    await w.h.db.query(
      `insert into retention (org_id, conversations_days, files_days, traces_days, changed_at)
       values ($1, 30, 30, 30, $2)`,
      [w.orgId, ago(3)],
    );
    // The hold arrives after the first batch (conversations) and before the second (files).
    let batches = 0;
    const db: Db = {
      ...w.h.db,
      tx: async (work) => {
        if (++batches === 2)
          await w.h.db.query("update retention set hold = true, hold_reason = 'Case 9'");
        return w.h.db.tx(work);
      },
    };
    const gone = await purgeOrg(db, w.h.files, w.orgId, w.h.config.secretKey);
    expect(gone).toMatchObject({ conversations: 1, files: 0, traces: 0 });
    expect(await w.count("files", "name = 'old.txt'")).toBe(1);
    expect(await w.count("traces")).toBe(1);
  });

  it("does not start for periods changed after it was listed as due", async () => {
    const w = await world();
    const me = await w.idOf("owner@acme.test");
    await w.conversation(me, 100);
    await w.h.db.query(
      "insert into retention (org_id, conversations_days, changed_at) values ($1, 30, $2)",
      [w.orgId, ago(3)],
    );
    // Between being listed and being taken, someone saves other periods.
    const db: Db = {
      ...w.h.db,
      query: async (sql: string, params?: unknown[]) => {
        const rows = await w.h.db.query(sql, params);
        if (sql.startsWith("select org_id as id from retention"))
          await w.h.db.query("update retention set changed_at = now()");
        return rows as never;
      },
    };
    expect(await new Retention(db, w.h.files, w.h.config.secretKey).tick()).toBe(0);
    expect(await w.count("conversations")).toBe(1);
    expect((await w.page()).purgedAt).toBeNull();
  });
});

describe("the activity log's period and what is not getting through", () => {
  const old = async (
    w: Awaited<ReturnType<typeof world>>,
    cursor: number,
    failing: Date | null,
  ) => {
    const other = newId();
    await w.h.db.query("insert into organizations (id, name) values ($1, 'Old')", [other]);
    for (let n = 0; n < 4; n++)
      await recordEvent(w.h.db, {
        orgId: other,
        actor: { userId: null, email: "old@old.test" },
        action: "test.old",
        time: ago(500),
      });
    await w.h.db.query(
      "insert into retention (org_id, audit_days, changed_at) values ($1, 365, $2)",
      [other, ago(3)],
    );
    await w.h.db.query(
      `insert into audit_forward (org_id, kind, url, cursor, failures, failing_since)
       values ($1, 'json', 'https://siem.example.com/in', $2, $3, $4)`,
      [other, cursor, failing ? 30 : 0, failing],
    );
    return other;
  };

  it("waits for a week of failures, then keeps the period and says how many went unsent", async () => {
    const w = await world();
    const key = w.h.config.secretKey;
    // Failing for two days: the unsent wait.
    const waiting = await old(w, 1, ago(2));
    expect(await purgeOrg(w.h.db, w.h.files, waiting, key)).toMatchObject({
      audit: 1,
      auditUnsent: 0,
    });
    // Failing for eight days: the period is kept, and the record of the purge says what went unsent.
    const stalled = await old(w, 1, ago(8));
    expect(await purgeOrg(w.h.db, w.h.files, stalled, key)).toMatchObject({
      audit: 4,
      auditUnsent: 3,
    });
    expect(await verifyChain(w.h.db, stalled, key)).toMatchObject({ ok: true, purged: 4 });
    const noted = await w.h.db.query<{ detail: { auditUnsent: number } }>(
      "select detail from admin_events where org_id = $1 and action = 'retention.purged'",
      [stalled],
    );
    expect(noted.map((row) => row.detail.auditUnsent)).toEqual([3]);
  });

  it("is not kept at all without the server's key, and the page says so", async () => {
    const w = await world();
    const none = await old(w, 4, null);
    expect(await purgeOrg(w.h.db, w.h.files, none, "")).toMatchObject({ audit: 0 });
    expect(await w.count("admin_events", "org_id = $1", [none])).toBe(4);
    expect(await w.count("audit_checkpoints")).toBe(0);
    expect((await w.page()) as unknown as { auditPurge: string }).toMatchObject({
      auditPurge: "ok",
    });
  });
});

describe("erasing someone whose things other people use", () => {
  it("hands those to whoever erases, says so first, and takes the rest", async () => {
    const w = await world();
    const mo = await w.idOf("mo@acme.test");
    const owner = await w.idOf("owner@acme.test");
    const auditor = await w.idOf("au@acme.test");
    const project = async (as: string, name: string) =>
      (await json<{ id: string }>(await w.h.api(as, "POST", "/api/app/projects", { name }))).id;
    // Mo's: a project the auditor was brought into, with a key document; one of their own.
    const shared = await project(w.mo, "Launch");
    const own = await project(w.mo, "Private");
    await project(w.owner, "Launch");
    await w.h.db.query(
      "insert into project_members (project_id, org_id, user_id, role, added_by) values ($1, $2, $3, 'work', $4)",
      [shared, w.orgId, auditor, mo],
    );
    const spec = await w.file(w.mo, "spec.txt", 1);
    expect(
      (await w.h.api(w.mo, "PUT", `/api/app/projects/${shared}/docs/${spec}`, { kind: "spec" }))
        .status,
    ).toBe(200);
    await w.h.api(w.mo, "POST", `/api/app/projects/${shared}/updates`, {
      health: "on_track",
      text: "Going well.",
    });
    // Mo's files: one shared with the owner, one nobody else has.
    const given = await w.file(w.mo, "given.txt", 1);
    const kept = await w.file(w.mo, "kept.txt", 1);
    await w.h.db.query(
      `insert into shares (id, org_id, kind, item_id, to_kind, to_id, by_user_id)
       values ($1, $2, 'file', $3, 'user', $4, $5)`,
      [newId(), w.orgId, given, owner, mo],
    );
    // What Mo left on other people's things: a place in the owner's project, a comment on
    // the owner's file, a note on the owner's run, and an alert that names them.
    const theirs = await project(w.owner, "Owner's");
    await w.h.db.query(
      "insert into project_members (project_id, org_id, user_id, role, added_by) values ($1, $2, $3, 'view', $4)",
      [theirs, w.orgId, mo, owner],
    );
    const ownerFile = await w.file(w.owner, "plan.txt", 1);
    await w.h.db.query(
      "insert into file_comments (id, org_id, file_id, n, user_id, body) values ($1, $2, $3, 1, $4, 'Mo thinks not')",
      [newId(), w.orgId, ownerFile, mo],
    );
    await w.h.db.query(
      "insert into file_comments (id, org_id, file_id, n, user_id, body) values ($1, $2, $3, 2, $4, 'Owner agrees')",
      [newId(), w.orgId, ownerFile, owner],
    );
    await w.conversation(owner, 1);
    const run = (await w.h.db.query<{ id: string }>("select id from traces limit 1"))[0]?.id;
    await w.h.db.query(
      "insert into annotations (id, org_id, trace_id, author_user_id, label, note) values ($1, $2, $3, $4, 'bad', 'Mo saw this')",
      [newId(), w.orgId, run, mo],
    );
    await w.h.db.query(
      "insert into alerts (id, org_id, rule, subject, label) values ($1, $2, 'spend', $3, 'mo@acme.test')",
      [newId(), w.orgId, `user:${mo}`],
    );
    const talk = await w.conversation(mo, 1);

    expect((await w.h.api(w.owner, "DELETE", `/api/members/${mo}`)).status).toBe(200);
    const asked = await json<{
      holds: Record<string, number>;
      handed: Record<string, { count: number; names: string[] }>;
    }>(await w.h.api(w.owner, "GET", `/api/members/${mo}/erase`));
    expect(asked.handed).toEqual({
      projects: { count: 1, names: ["Launch"] },
      files: { count: 2, names: ["given.txt", "spec.txt"] },
    });
    expect(asked.holds).toMatchObject({ projects: 1, files: 1, conversations: 1 });

    const forgotten: string[] = [];
    const done = await erasePerson(
      w.h.db,
      w.h.files,
      w.orgId,
      mo,
      { userId: owner, email: "owner@acme.test" },
      null,
      { forget: async (space) => void forgotten.push(space) },
    );
    expect(done.handed).toEqual({ projects: 1, files: 2 });
    expect(done.erased).toMatchObject({ projects: 1, files: 1, conversations: 1 });
    expect(forgotten).toEqual([talk]);
    // The project other people work in is the owner's now, whole, under a name that is free.
    const handed = (
      await w.h.db.query<{ userId: string; name: string }>(
        `select user_id as "userId", name from projects where id = $1`,
        [shared],
      )
    )[0];
    expect(handed).toEqual({ userId: owner, name: "Launch (2)" });
    expect(
      await w.count("project_members", "project_id = $1 and user_id = $2", [shared, auditor]),
    ).toBe(1);
    expect(
      await w.count("project_updates", "project_id = $1 and user_id = $2", [shared, owner]),
    ).toBe(1);
    expect(await w.count("project_updates", "author_id = $1", [mo])).toBe(0);
    expect(await w.count("project_docs", "project_id = $1 and file_id = $2", [shared, spec])).toBe(
      1,
    );
    // The owner can open it as any of their own.
    expect((await w.h.api(w.owner, "GET", `/api/app/projects/${shared}/steps`)).status).toBe(200);
    for (const id of [spec, given]) {
      expect(await w.count("files", "id = $1 and user_id = $2", [id, owner]), id).toBe(1);
      expect((await w.h.api(w.owner, "GET", `/api/app/files/${id}/content`)).status).toBe(200);
    }
    // What was only Mo's is gone, content and all.
    expect(await w.count("projects", "id = $1", [own])).toBe(0);
    expect(await w.count("files", "id = $1", [kept])).toBe(0);
    expect(await bytesOf(w.h, w.orgId, kept)).toBeNull();
    expect(await w.count("conversations", "user_id = $1", [mo])).toBe(0);
    // And what Mo left on other people's things, without those things.
    expect(await w.count("project_members", "user_id = $1", [mo])).toBe(0);
    expect(await w.count("project_members", "added_by = $1", [mo])).toBe(0);
    expect(await w.count("projects", "id = $1", [theirs])).toBe(1);
    expect(await w.count("file_comments", "user_id = $1", [mo])).toBe(0);
    expect(await w.count("file_comments", "file_id = $1", [ownerFile])).toBe(1);
    expect(await w.count("annotations", "author_user_id = $1", [mo])).toBe(0);
    expect(await w.count("traces", "id = $1", [run])).toBe(1);
    expect(await w.count("alerts", "subject = $1", [`user:${mo}`])).toBe(0);
    // One record, written with the erasing, of what went and what was handed on.
    const noted = await w.h.db.query<{ detail: Record<string, number> }>(
      "select detail from admin_events where action = 'member.erased'",
    );
    expect(noted.map((row) => row.detail)).toEqual([
      expect.objectContaining({ projects: 1, files: 1, handedProjects: 1, handedFiles: 2 }),
    ]);
  });

  it("neither erases nor records anything when a hold is in place as it begins", async () => {
    const w = await world();
    const mo = await w.idOf("mo@acme.test");
    const owner = await w.idOf("owner@acme.test");
    await w.conversation(mo, 1);
    await w.h.api(w.owner, "DELETE", `/api/members/${mo}`);
    await w.h.db.query(
      "insert into retention (org_id, hold, hold_reason) values ($1, true, 'Case 3')",
      [w.orgId],
    );
    await expect(
      erasePerson(w.h.db, w.h.files, w.orgId, mo, { userId: owner, email: "owner@acme.test" }),
    ).rejects.toThrow("on_hold");
    expect(await w.count("conversations", "user_id = $1", [mo])).toBe(1);
    expect(await w.count("admin_events", "action = 'member.erased'")).toBe(0);
  });
});
