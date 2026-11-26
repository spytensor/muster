import { isId } from "@muster/protocol";
import type { Hono } from "hono";
import { z } from "zod";
import { type AppKit, type Ctx, type Env, fail } from "./app.js";
import { recordEvent } from "./audit.js";
import { PURGE_PASS, PURGE_WAITS_DAYS, purgeChain, purgeGuard } from "./chain.js";
import type { Db, Queryable } from "./db.js";
import { Refusal } from "./errors.js";
import type { Files } from "./files/service.js";

/**
 * How long things are kept, and taking them away for good: at the end of their keeping,
 * once a day; and everything of one person who has left, when an administrator asks.
 * A legal hold stops both. See docs/features/admin-console.md, "Retention and erasure".
 */

export const RETENTION_SCHEMA = [
  // A period left empty keeps that kind for as long as the organization is here.
  `create table retention (
    org_id uuid primary key references organizations(id) on delete cascade,
    conversations_days integer check (conversations_days between 30 and 3650),
    files_days integer check (files_days between 30 and 3650),
    traces_days integer check (traces_days between 30 and 3650),
    audit_days integer check (audit_days between 365 and 3650),
    hold boolean not null default false,
    hold_reason text not null default '',
    hold_by text,
    hold_at timestamptz,
    changed_at timestamptz not null default now(),
    purged_at timestamptz,
    purged jsonb
  )`,
];

export const KINDS = ["conversations", "files", "traces", "audit"] as const;
export type Kind = (typeof KINDS)[number];
export type Periods = Record<Kind, number | null>;
export type Counts = Record<Kind, number>;
/** The shortest and longest a period can be, in days. The record of who did what is kept a year at least. */
export const LIMITS: Record<Kind, { min: number; max: number }> = {
  conversations: { min: 30, max: 3650 },
  files: { min: 30, max: 3650 },
  traces: { min: 30, max: 3650 },
  audit: { min: 365, max: 3650 },
};
/** A change to the periods purges nothing for a day, so a slip can be put right. */
const GRACE_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const NOTHING: Counts = { conversations: 0, files: 0, traces: 0, audit: 0 };

type Row = {
  conversations: number | null;
  files: number | null;
  traces: number | null;
  audit: number | null;
  hold: boolean;
  holdReason: string;
  holdBy: string | null;
  holdAt: Date | null;
  changedAt: Date | null;
  purgedAt: Date | null;
  purged: Counts | null;
};
const COLUMNS = `conversations_days as conversations, files_days as files, traces_days as traces,
  audit_days as audit, hold, hold_reason as "holdReason", hold_by as "holdBy", hold_at as "holdAt",
  changed_at as "changedAt", purged_at as "purgedAt", purged`;
const UNSET: Row = {
  conversations: null,
  files: null,
  traces: null,
  audit: null,
  hold: false,
  holdReason: "",
  holdBy: null,
  holdAt: null,
  changedAt: null,
  purgedAt: null,
  purged: null,
};

async function rowOf(db: Queryable, orgId: string, lock = false): Promise<Row> {
  const row = (
    await db.query<Row>(
      `select ${COLUMNS} from retention where org_id = $1 ${lock ? "for update" : ""}`,
      [orgId],
    )
  )[0];
  return row ?? UNSET;
}

const before = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS);

// A conversation is old when nothing was said in it for the period. One that an agent is
// working in, that a schedule runs in, or that an agent is to come back to, is in use.
const OLD_CONVERSATIONS = `c.org_id = $1 and c.updated_at < $2
  and not exists (select 1 from messages m where m.conversation_id = c.id and (m.created_at >= $2 or m.status = 'running'))
  and not exists (select 1 from schedules s where s.conversation_id = c.id)
  and not exists (select 1 from followups w where w.conversation_id = c.id and w.status in ('waiting', 'waking'))`;
// A file is old when neither it nor a version of it was made within the period. Kept all
// the same: a project's key documents, a file made in a conversation that is still here,
// and a file attached to a message that is still here. A conversation that is kept keeps
// what it shows. A file already deleted by its owner has only its record left, which goes
// at the same age.
const OLD_FILES = `f.org_id = $1 and f.created_at < $2
  and not exists (select 1 from file_versions v where v.file_id = f.id and v.created_at >= $2)
  and not exists (select 1 from project_docs d where d.file_id = f.id)
  and not exists (select 1 from conversations c where c.id = f.conversation_id)
  and not exists (select 1 from messages m where m.org_id = f.org_id
                   and m.attachments @> jsonb_build_array(jsonb_build_object('id', f.id::text)))`;
const OLD_TRACES = `t.org_id = $1 and t.started_at < $2`;
// Only from the front of the record: up to the first row that is not old.
const OLD_AUDIT = `e.org_id = $1 and e.chain_no < coalesce(
  (select min(chain_no) from admin_events where org_id = $1 and time >= $2), 9223372036854775807)`;

/** How many of each kind are past these periods now: what a purge would take. */
export async function wouldGo(
  db: Queryable,
  orgId: string,
  periods: Periods,
  now = new Date(),
): Promise<Counts> {
  const count = async (kind: Kind, sql: string) => {
    const days = periods[kind];
    if (days === null) return 0;
    const row = (await db.query<{ n: string }>(sql, [orgId, before(now, days)]))[0];
    return Number(row?.n ?? 0);
  };
  return {
    conversations: await count(
      "conversations",
      `select count(*) as n from conversations c where ${OLD_CONVERSATIONS}`,
    ),
    files: await count("files", `select count(*) as n from files f where ${OLD_FILES}`),
    traces: await count("traces", `select count(*) as n from traces t where ${OLD_TRACES}`),
    audit: await count("audit", `select count(*) as n from admin_events e where ${OLD_AUDIT}`),
  };
}

const BATCH = 500;
const BATCHES = 40;
/** Passes of the activity log's purge in a day: 200,000 records at the most. */
const AUDIT_PASSES = 40;

/** Where code ran for a conversation: forgotten when the conversation is taken away. */
export type Spaces = { forget(space: string): Promise<void> } | null;
const forgetSpaces = async (spaces: Spaces | undefined, conversations: string[]) => {
  if (!spaces) return;
  // Best effort: a workspace nobody runs in is swept by the runner itself after a week.
  for (const id of conversations) await spaces.forget(id).catch(() => undefined);
};

/**
 * Takes away what is past its period in one organization. A little at a time, each batch
 * in a transaction of its own, so a long purge holds nothing up and one that is cut off
 * has done whole batches. Every batch looks at the hold again and holds it as it is until
 * the batch is done: a hold placed in the middle stops the purge at the next batch, and
 * whoever places it waits only for the batch in hand. Does nothing under a legal hold.
 */
export async function purgeOrg(
  db: Db,
  files: Files,
  orgId: string,
  secretKey: string,
  now = new Date(),
  spaces?: Spaces,
): Promise<(Counts & { auditUnsent: number }) | null> {
  const settings = await rowOf(db, orgId);
  if (settings.hold) return null;
  const gone = { ...NOTHING, auditUnsent: 0 };
  let held = false;
  /** One batch, unless a hold is in place. Null when there is one. */
  const unheld = <T>(work: (tx: Queryable) => Promise<T>): Promise<T | null> =>
    db.tx(async (tx) => {
      const row = (
        await tx.query<{ hold: boolean }>(
          "select hold from retention where org_id = $1 for share",
          [orgId],
        )
      )[0];
      if (!row || row.hold) {
        held = true;
        return null;
      }
      return work(tx);
    });
  const batches = async (kind: Kind, one: (cutoff: Date) => Promise<number | null>) => {
    const days = settings[kind];
    if (days === null || held) return;
    for (let batch = 0; batch < BATCHES; batch++) {
      const n = await one(before(now, days));
      if (n === null) return;
      gone[kind] += n;
      if (n < BATCH) break;
    }
  };
  await batches("conversations", async (cutoff) => {
    const rows = await unheld((tx) =>
      tx.query<{ id: string }>(
        `delete from conversations where id in
           (select c.id from conversations c where ${OLD_CONVERSATIONS} limit ${BATCH}) returning id`,
        [orgId, cutoff],
      ),
    );
    if (rows === null) return null;
    await forgetSpaces(
      spaces,
      rows.map((row) => row.id),
    );
    return rows.length;
  });
  await batches("files", async (cutoff) => {
    const done = await unheld(async (tx) => {
      const old = await tx.query<{ id: string }>(
        `select f.id from files f where ${OLD_FILES} limit ${BATCH}`,
        [orgId, cutoff],
      );
      return files.erase(
        tx,
        orgId,
        old.map((file) => file.id),
      );
    });
    if (done === null) return null;
    await done.contents();
    return done.erased;
  });
  await batches("traces", async (cutoff) => {
    const rows = await unheld((tx) =>
      tx.query(
        `delete from traces where id in
           (select t.id from traces t where ${OLD_TRACES} limit ${BATCH}) returning id`,
        [orgId, cutoff],
      ),
    );
    return rows === null ? null : rows.length;
  });
  if (settings.audit !== null && !held) {
    const cutoff = before(now, settings.audit);
    for (let pass = 0; pass < AUDIT_PASSES; pass++) {
      const went = await unheld(async (tx) => {
        // What is being sent on and has not been yet stays until it has: unless nothing
        // has got through for a week, after which the period is kept and the unsent go.
        const sending = (
          await tx.query<{ cursor: string; failingSince: Date | null }>(
            `select cursor, failing_since as "failingSince" from audit_forward
              where org_id = $1 and enabled`,
            [orgId],
          )
        )[0];
        const waits =
          sending &&
          !(
            sending.failingSince &&
            new Date(sending.failingSince).getTime() <= now.getTime() - PURGE_WAITS_DAYS * DAY_MS
          );
        const first = Number(
          (
            await tx.query<{ first: string | null }>(
              "select min(chain_no) as first from admin_events where org_id = $1",
              [orgId],
            )
          )[0]?.first ?? 0,
        );
        const n = await purgeChain(
          tx,
          orgId,
          cutoff,
          secretKey,
          waits ? Number(sending.cursor) : null,
        );
        const unsent =
          sending && n > 0
            ? Math.max(0, first + n - 1 - Math.max(Number(sending.cursor), first - 1))
            : 0;
        return { n, unsent };
      });
      if (went === null) break;
      gone.audit += went.n;
      gone.auditUnsent += went.unsent;
      if (went.n < PURGE_PASS) break;
    }
  }
  const total = gone.conversations + gone.files + gone.traces + gone.audit;
  await db.tx(async (tx) => {
    await tx.query("update retention set purged_at = $2, purged = $3::jsonb where org_id = $1", [
      orgId,
      now,
      JSON.stringify(gone),
    ]);
    if (total > 0)
      await recordEvent(tx, {
        orgId,
        actor: { userId: null, email: "muster" },
        action: "retention.purged",
        detail: { ...gone },
      });
  });
  return gone;
}

/** Purges, once a day, every organization that has set a period and is not on hold. */
export class Retention {
  private busy = false;
  constructor(
    private readonly db: Db,
    private readonly files: Files,
    private readonly secretKey: string,
    private readonly spaces: Spaces = null,
  ) {}

  async tick(now = new Date()): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    try {
      const grace = new Date(now.getTime() - GRACE_MS);
      const day = new Date(now.getTime() - DAY_MS);
      const due = await this.db.query<{ id: string }>(
        `select org_id as id from retention
          where not hold and changed_at <= $1 and (purged_at is null or purged_at <= $2)
            and (conversations_days is not null or files_days is not null
                 or traces_days is not null or audit_days is not null)`,
        [grace, day],
      );
      let purged = 0;
      for (const org of due) {
        // Taken before the work, by one process only: a second one finds it done. And
        // only if it is still due: periods changed, or a hold lifted, since it was listed
        // start their day of grace again.
        const mine = await this.db.query(
          `update retention set purged_at = $2 where org_id = $1 and not hold
              and changed_at <= $4 and (purged_at is null or purged_at <= $3) returning org_id`,
          [org.id, now, day, grace],
        );
        if (mine.length === 0) continue;
        purged++;
        await purgeOrg(this.db, this.files, org.id, this.secretKey, now, this.spaces).catch(
          (error) => console.error(`purging organization ${org.id} failed:`, error),
        );
      }
      return purged;
    } finally {
      this.busy = false;
    }
  }
}

// ---- one person ----

export const PERSON_KINDS = [
  "conversations",
  "files",
  "documents",
  "projects",
  "memories",
  "traces",
  "schedules",
] as const;
export type PersonCounts = Record<(typeof PERSON_KINDS)[number], number>;
/** What is not erased because other people are using it, and is handed on instead. */
export interface Handed {
  projects: string[];
  files: string[];
}

/**
 * What of a person's is in use by others, so that taking it away would take it from them:
 * a project other people were brought into or have conversations in, with its key
 * documents; and a file shared with someone else or with a department.
 */
export async function inUseByOthers(tx: Queryable, orgId: string, userId: string): Promise<Handed> {
  const projects = (
    await tx.query<{ id: string }>(
      `select p.id from projects p
        where p.org_id = $1 and p.user_id = $2
          and (exists (select 1 from project_members pm where pm.project_id = p.id and pm.user_id <> $2)
            or exists (select 1 from conversations c where c.project_id = p.id and c.user_id <> $2))`,
      [orgId, userId],
    )
  ).map((row) => row.id);
  const files = (
    await tx.query<{ id: string }>(
      `select f.id from files f
        where f.org_id = $1 and f.user_id = $2 and f.deleted_at is null
          and (exists (select 1 from shares s where s.org_id = f.org_id and s.kind = 'file'
                        and s.item_id = f.id and not (s.to_kind = 'user' and s.to_id = $2))
            or exists (select 1 from project_docs d where d.file_id = f.id
                        and d.project_id = any($3::uuid[])))`,
      [orgId, userId, projects],
    )
  ).map((row) => row.id);
  return { projects, files };
}

/** What Muster holds that is one person's and would be erased: not what is handed on. */
export async function holdsOf(db: Queryable, orgId: string, userId: string): Promise<PersonCounts> {
  const handed = await inUseByOthers(db, orgId, userId);
  const row = (
    await db.query<Record<string, string>>(
      `select
         (select count(*) from conversations where org_id = $1 and user_id = $2) as conversations,
         (select count(*) from files where org_id = $1 and user_id = $2 and deleted_at is null
            and not (id = any($4::uuid[]))) as files,
         (select count(*) from documents where org_id = $1 and user_id = $2) as documents,
         (select count(*) from projects where org_id = $1 and user_id = $2
            and not (id = any($3::uuid[]))) as projects,
         (select count(*) from memories where org_id = $1 and user_id = $2) as memories,
         (select count(*) from traces where org_id = $1 and user_id = $2) as traces,
         (select count(*) from schedules where org_id = $1 and user_id = $2) as schedules`,
      [orgId, userId, handed.projects, handed.files],
    )
  )[0] as Record<string, string>;
  return Object.fromEntries(PERSON_KINDS.map((kind) => [kind, Number(row[kind])])) as PersonCounts;
}

// In this order: what hangs on a conversation or a project goes with it.
const PERSON_TABLES = [
  "approvals",
  "followups",
  "schedules",
  "sent_drafts",
  "conversations",
  "project_docs",
  "project_updates",
  "project_steps",
  "project_members",
  "projects",
  "documents",
  "memories",
  "notices",
  "saved_views",
  "connections",
  "connection_attempts",
  "app_logins",
];

/**
 * Takes away everything that is one person's: what they said and were answered, their
 * files, documents, projects, what was remembered about them, the runs made for them,
 * their connections, what they were told, and what they wrote on other people's files
 * and runs. What other people are using is not taken from them: a project with other
 * people in it and a file shared with others are handed to whoever erases, who is an
 * administrator and can pass them on or delete them. What stays: that they were a member
 * (so a domain rule does not let them back in), the activity log, and what they made for
 * the company: agents, skills and knowledge bases.
 *
 * The hold is looked at, and the erasing is recorded, in the same transaction as the
 * erasing: it cannot happen under a hold placed a moment before, nor without a record.
 */
export async function erasePerson(
  db: Db,
  files: Files,
  orgId: string,
  userId: string,
  by: { userId: string; email: string },
  ip: string | null = null,
  spaces?: Spaces,
): Promise<{ erased: PersonCounts; handed: { projects: number; files: number } }> {
  const done = await db.tx(async (tx) => {
    // Only of someone who has left, and they cannot be brought back while it happens.
    const member = (
      await tx.query<{ status: string; email: string }>(
        `select m.status, u.email from memberships m join users u on u.id = m.user_id
          where m.org_id = $1 and m.user_id = $2 for update of m`,
        [orgId, userId],
      )
    )[0];
    if (member?.status !== "removed") throw new Refusal("erase_not_removed");
    const hold = (
      await tx.query<{ hold: boolean }>("select hold from retention where org_id = $1 for share", [
        orgId,
      ])
    )[0];
    if (hold?.hold) throw new Refusal("on_hold");

    const handed = await inUseByOthers(tx, orgId, userId);
    for (const id of handed.projects) {
      // Two of one person's projects cannot have one name: the one handed on gives way.
      const name = (
        await tx.query<{ name: string }>("select name from projects where id = $1", [id])
      )[0]?.name as string;
      let free = name;
      for (let n = 2; ; n++) {
        const taken = await tx.query(
          "select 1 from projects where user_id = $1 and lower(name) = lower($2)",
          [by.userId, free],
        );
        if (taken.length === 0) break;
        free = `${name.slice(0, 70)} (${n})`;
      }
      await tx.query("update projects set user_id = $2, name = $3 where id = $1", [
        id,
        by.userId,
        free,
      ]);
      // Whoever owns a project is not also brought into it.
      await tx.query("delete from project_members where project_id = $1 and user_id = $2", [
        id,
        by.userId,
      ]);
      for (const table of ["project_steps", "project_updates", "project_docs"])
        await tx.query(`update ${table} set user_id = $2 where project_id = $1`, [id, by.userId]);
    }
    if (handed.files.length > 0)
      await tx.query("update files set user_id = $2 where org_id = $1 and id = any($3::uuid[])", [
        orgId,
        by.userId,
        handed.files,
      ]);

    const erased = await holdsOf(tx, orgId, userId);
    const conversations = (
      await tx.query<{ id: string }>(
        "select id from conversations where org_id = $1 and user_id = $2",
        [orgId, userId],
      )
    ).map((row) => row.id);
    const theirs = await tx.query<{ id: string }>(
      "select id from files where org_id = $1 and user_id = $2",
      [orgId, userId],
    );
    const { contents } = await files.erase(
      tx,
      orgId,
      theirs.map((file) => file.id),
    );
    for (const table of PERSON_TABLES)
      await tx.query(`delete from ${table} where org_id = $1 and user_id = $2`, [orgId, userId]);
    await tx.query("delete from traces where org_id = $1 and user_id = $2", [orgId, userId]);
    // What they wrote on what is other people's, and what names them where nothing else would.
    await tx.query("delete from file_comments where org_id = $1 and user_id = $2", [orgId, userId]);
    await tx.query("delete from annotations where org_id = $1 and author_user_id = $2", [
      orgId,
      userId,
    ]);
    await tx.query("delete from alerts where org_id = $1 and subject = $2", [
      orgId,
      `user:${userId}`,
    ]);
    await tx.query(
      "update project_updates set author_id = null where org_id = $1 and author_id = $2",
      [orgId, userId],
    );
    await tx.query(
      "update project_members set added_by = null where org_id = $1 and added_by = $2",
      [orgId, userId],
    );
    // A person belongs to one organization, so what is kept by person alone is theirs here.
    for (const table of ["profiles", "additions", "share_hidden"])
      await tx.query(`delete from ${table} where user_id = $1`, [userId]);
    await tx.query("delete from shares where org_id = $1 and to_kind = 'user' and to_id = $2", [
      orgId,
      userId,
    ]);
    const counts = { projects: handed.projects.length, files: handed.files.length };
    await recordEvent(tx, {
      orgId,
      actor: by,
      action: "member.erased",
      target: { type: "member", id: userId, label: member.email },
      detail: { ...erased, handedProjects: counts.projects, handedFiles: counts.files },
      ip,
    });
    return { erased, handed: counts, contents, conversations };
  });
  await done.contents();
  await forgetSpaces(spaces, done.conversations);
  return { erased: done.erased, handed: done.handed };
}

/** The names of what would be handed on, for the dialog that asks: twenty of each at the most. */
async function handedNames(tx: Queryable, orgId: string, userId: string) {
  const handed = await inUseByOthers(tx, orgId, userId);
  const names = async (table: string, ids: string[]) =>
    (
      await tx.query<{ name: string }>(
        `select name from ${table} where id = any($1::uuid[]) order by name limit 20`,
        [ids],
      )
    ).map((row) => row.name);
  return {
    projects: { count: handed.projects.length, names: await names("projects", handed.projects) },
    files: { count: handed.files.length, names: await names("files", handed.files) },
  };
}

// ---- what the console asks ----

const days = (kind: Kind) =>
  z.number().int().min(LIMITS[kind].min).max(LIMITS[kind].max).nullable();
const PeriodsBody = z.strictObject({
  conversations: days("conversations"),
  files: days("files"),
  traces: days("traces"),
  audit: days("audit"),
});
const HoldBody = z.strictObject({
  on: z.boolean(),
  reason: z.string().trim().max(300).default(""),
});
const EraseBody = z.strictObject({ email: z.string().trim().max(320) });

export function registerRetention(
  app: Hono<Env>,
  kit: AppKit,
  db: Db,
  files: Files,
  /** The server's key, without which the activity log is not purged; and where code runs. */
  more: { secretKey?: string; spaces?: Spaces } = {},
): void {
  const { need, actorOf, clientIp } = kit;
  const org = (c: Ctx) => c.get("session").org.id;
  // The database is told of the purge's key as the server starts, before anyone else can.
  void purgeGuard(db, more.secretKey ?? "").catch(() => undefined);
  const periodsOf = (row: Row): Periods => ({
    conversations: row.conversations,
    files: row.files,
    traces: row.traces,
    audit: row.audit,
  });

  app.get("/api/retention", async (c) => {
    const denied = need(c, "settings.read");
    if (denied) return denied;
    const row = await rowOf(db, org(c));
    const periods = periodsOf(row);
    const set = KINDS.some((kind) => periods[kind] !== null);
    // The first purge that these periods apply to: a day after they were set, and a day
    // after the last one. Looked at hourly, so it may come up to an hour later.
    const next =
      set && !row.hold
        ? new Date(
            Math.max(
              (row.changedAt?.getTime() ?? Date.now()) + GRACE_MS,
              (row.purgedAt?.getTime() ?? 0) + DAY_MS,
            ),
          )
        : null;
    return c.json({
      periods,
      limits: LIMITS,
      hold: row.hold ? { reason: row.holdReason, by: row.holdBy, at: row.holdAt } : null,
      changedAt: row.changedAt,
      purgedAt: row.purgedAt,
      purged: row.purged,
      nextAt: next,
      waiting: await wouldGo(db, org(c), periods),
      // Why the activity log's period cannot be kept, when it cannot: "no_key" or "other_key".
      auditPurge: await purgeGuard(db, more.secretKey ?? ""),
    });
  });

  // What these periods would take if they were the ones set: asked before saving.
  app.post("/api/retention/preview", async (c) => {
    const denied = need(c, "settings.read");
    if (denied) return denied;
    const parsed = PeriodsBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, "invalid_retention");
    return c.json(await wouldGo(db, org(c), parsed.data));
  });

  app.put("/api/retention", async (c) => {
    const denied = need(c, "settings.manage");
    if (denied) return denied;
    const parsed = PeriodsBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, "invalid_retention");
    const to = parsed.data;
    return kit.inTx(c, async (tx) => {
      await tx.query("insert into retention (org_id) values ($1) on conflict (org_id) do nothing", [
        org(c),
      ]);
      const from = periodsOf(await rowOf(tx, org(c), true));
      if (KINDS.every((kind) => from[kind] === to[kind])) return c.json({ ok: true });
      await tx.query(
        `update retention set conversations_days = $2, files_days = $3, traces_days = $4,
                audit_days = $5, changed_at = now() where org_id = $1`,
        [org(c), to.conversations, to.files, to.traces, to.audit],
      );
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "retention.changed",
        detail: { from, to },
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    });
  });

  app.put("/api/retention/hold", async (c) => {
    const denied = need(c, "settings.manage");
    if (denied) return denied;
    const parsed = HoldBody.safeParse(await c.req.json().catch(() => null));
    // A hold says why: whoever lifts it months later has to know what it was for.
    if (!parsed.success || (parsed.data.on && !parsed.data.reason))
      return fail(c, "invalid_retention");
    const { on, reason } = parsed.data;
    return kit.inTx(c, async (tx) => {
      await tx.query("insert into retention (org_id) values ($1) on conflict (org_id) do nothing", [
        org(c),
      ]);
      const was = await rowOf(tx, org(c), true);
      if (was.hold === on) return c.json({ ok: true });
      // Lifting a hold starts the day of grace again: nothing goes the moment it is lifted.
      await tx.query(
        `update retention set hold = $2, hold_reason = $3, hold_by = $4,
                hold_at = case when $2 then now() else null end, changed_at = now()
          where org_id = $1`,
        [org(c), on, on ? reason : "", on ? actorOf(c).email : null],
      );
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: on ? "retention.hold_on" : "retention.hold_off",
        detail: on ? { reason } : { reason: was.holdReason },
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    });
  });

  /** The person to erase: someone already removed from this organization, and not oneself. */
  const leaver = async (c: Ctx, tx: Queryable) => {
    const id = c.req.param("id") ?? "";
    if (!isId(id)) throw new Refusal("not_found");
    const target = (
      await tx.query<{ email: string; status: string }>(
        `select u.email, m.status from memberships m join users u on u.id = m.user_id
          where m.org_id = $1 and m.user_id = $2`,
        [org(c), id],
      )
    )[0];
    if (!target) throw new Refusal("not_found");
    if (id === c.get("session").user.id) throw new Refusal("self");
    return { id, ...target };
  };

  // What would go, for the dialog that asks.
  app.get("/api/members/:id/erase", async (c) => {
    const denied = need(c, "members.manage");
    if (denied) return denied;
    return kit.inTx(c, async (tx) => {
      const target = await leaver(c, tx);
      return c.json({
        email: target.email,
        removed: target.status === "removed",
        hold: (await rowOf(tx, org(c))).hold,
        holds: await holdsOf(tx, org(c), target.id),
        // Not erased, because other people are using them: handed to whoever erases.
        handed: await handedNames(tx, org(c), target.id),
      });
    });
  });

  app.post("/api/members/:id/erase", async (c) => {
    const denied = need(c, "members.manage");
    if (denied) return denied;
    const parsed = EraseBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, "erase_unconfirmed");
    let target: Awaited<ReturnType<typeof leaver>>;
    try {
      target = await leaver(c, db);
    } catch (error) {
      if (error instanceof Refusal) return fail(c, error.code);
      throw error;
    }
    if (target.status !== "removed") return fail(c, "erase_not_removed");
    if (parsed.data.email.toLowerCase() !== target.email.toLowerCase())
      return fail(c, "erase_unconfirmed");
    try {
      const done = await erasePerson(
        db,
        files,
        org(c),
        target.id,
        actorOf(c),
        clientIp(c),
        more.spaces,
      );
      return c.json({ ok: true, ...done });
    } catch (error) {
      if (error instanceof Refusal) return fail(c, error.code);
      throw error;
    }
  });
}
