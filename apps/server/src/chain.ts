import { createHash, createHmac } from "node:crypto";
import { newId } from "@muster/protocol";
import type { Hono } from "hono";
import { z } from "zod";
import { type AppKit, type Ctx, type Env, fail } from "./app.js";
import { recordEvent } from "./audit.js";
import { openText, sealText } from "./connections.js";
import type { Db, Queryable } from "./db.js";
import { Refusal } from "./errors.js";
import { checkUrl, type Net, NetError } from "./runtime/net.js";

/**
 * The chain of the activity log. Every row of the record carries the hash of the row
 * before it and its own: `hash = sha256(prev_hash + "\n" + canonical)`, where `canonical`
 * is the row's fields as one JSON array written by the database (`admin_event_canonical`).
 * The database links a row as it is written, under a lock on the organization's head of
 * the chain, so two writers at once cannot give two rows the same place. A row changed,
 * removed or put in afterwards breaks the chain at that row.
 * See docs/features/admin-console.md, "The activity log proves itself".
 */
const HASH = `encode(sha256(convert_to(e.prev_hash || E'\\n' || admin_event_canonical(e), 'UTF8')), 'hex')`;

/** Links every row there is, each organization in the order its rows were written. */
export const AUDIT_BACKFILL = `do $$
   declare r admin_events%rowtype; last_org uuid; h text := ''; n bigint := 0;
   begin
     for r in select * from admin_events order by org_id, seq loop
       if last_org is distinct from r.org_id then
         h := ''; n := 0; last_org := r.org_id;
       end if;
       n := n + 1;
       r.chain_no := n;
       r.prev_hash := h;
       h := encode(sha256(convert_to(r.prev_hash || E'\\n' || admin_event_canonical(r), 'UTF8')), 'hex');
       update admin_events set chain_no = n, prev_hash = r.prev_hash, hash = h where id = r.id;
       insert into audit_chain (org_id, n, hash) values (r.org_id, n, h)
         on conflict (org_id) do update set n = excluded.n, hash = excluded.hash;
     end loop;
   end $$`;

export const AUDIT_CHAIN_SCHEMA = [
  `alter table admin_events add column chain_no bigint`,
  `alter table admin_events add column prev_hash text`,
  `alter table admin_events add column hash text`,
  // Where each organization's chain ends, and what the last check of it found.
  `create table audit_chain (
    org_id uuid primary key references organizations(id) on delete cascade,
    n bigint not null default 0,
    hash text not null default '',
    checked_at timestamptz,
    checked_ok boolean,
    checked_detail jsonb
  )`,
  // The row as it is hashed. The time is written in UTC to the microsecond, whatever the
  // session's zone, and the detail as the database writes jsonb: one text for one value.
  `create function admin_event_canonical(e admin_events) returns text language sql stable as $$
     select jsonb_build_array(
       e.chain_no, e.id::text, e.org_id::text,
       to_char(e.time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
       e.actor_user_id::text, e.actor_email, e.action,
       e.target_type, e.target_id, e.target_label, e.detail, e.ip
     )::text
   $$`,
  `create function admin_events_chain() returns trigger language plpgsql as $$
   declare head record;
   begin
     insert into audit_chain (org_id) values (new.org_id) on conflict (org_id) do nothing;
     select n, hash into head from audit_chain where org_id = new.org_id for update;
     new.chain_no := head.n + 1;
     new.prev_hash := head.hash;
     new.hash := encode(sha256(convert_to(new.prev_hash || E'\\n' || admin_event_canonical(new), 'UTF8')), 'hex');
     update audit_chain set n = new.chain_no, hash = new.hash where org_id = new.org_id;
     return new;
   end $$`,
  // What was recorded before there was a chain is linked now, in the order it was written.
  `alter table admin_events disable trigger admin_events_append_only`,
  AUDIT_BACKFILL,
  `alter table admin_events enable trigger admin_events_append_only`,
  `alter table admin_events alter column chain_no set not null`,
  `alter table admin_events alter column prev_hash set not null`,
  `alter table admin_events alter column hash set not null`,
  `create unique index admin_events_chain on admin_events (org_id, chain_no)`,
  `create trigger admin_events_chain before insert on admin_events
     for each row execute function admin_events_chain()`,
  // Rows that reached the end of their keeping are taken from the front of the chain, by
  // the purge and nothing else: it says so for its own transaction. What they were is
  // kept as a checkpoint, so the rest still proves itself.
  `create or replace function admin_events_append_only() returns trigger language plpgsql as $$
   begin
     if tg_op = 'DELETE' and not exists (select 1 from organizations where id = old.org_id) then
       return old;
     end if;
     if tg_op = 'DELETE' and current_setting('muster.audit_purge', true) = 'on' then
       return old;
     end if;
     raise exception 'The activity log is append-only: a row cannot be changed or removed.'
       using errcode = 'restrict_violation';
   end $$`,
  `create table audit_checkpoints (
    org_id uuid not null references organizations(id) on delete cascade,
    chain_no bigint not null,
    hash text not null,
    rows bigint not null,
    through timestamptz not null,
    mac text not null default '',
    created_at timestamptz not null default now(),
    primary key (org_id, chain_no)
  )`,
  // Where the record is sent on to, and how far it has been delivered.
  `create table audit_forward (
    org_id uuid primary key references organizations(id) on delete cascade,
    kind text not null check (kind in ('json', 'splunk')),
    url text not null,
    token_sealed text,
    enabled boolean not null default true,
    cursor bigint not null default 0,
    delivered_at timestamptz,
    failures integer not null default 0,
    error text,
    error_at timestamptz,
    next_at timestamptz,
    updated_at timestamptz not null default now()
  )`,
];

/**
 * What review of the chain asked for (MUS-29), as a step of its own.
 *
 * Nothing here stops whoever owns the database: they can drop a trigger. It stops a
 * session that can only read and write rows, which before could switch the purge on for
 * itself, move a chain's head, or rewrite a checkpoint.
 */
export const AUDIT_FIXES_SCHEMA = [
  // What the purge must show to be let through: the hash of a key only the server can
  // make from its secret. Written once, and then neither changed nor removed.
  `create table audit_guard (
    one boolean primary key default true check (one),
    verifier text not null,
    created_at timestamptz not null default now()
  )`,
  `create function audit_guard_keep() returns trigger language plpgsql as $$
   begin
     raise exception 'The key the purge is let through with cannot be changed or removed.'
       using errcode = 'restrict_violation';
   end $$`,
  `create trigger audit_guard_keep before update or delete or truncate on audit_guard
     for each statement execute function audit_guard_keep()`,
  // Whether this transaction has shown that key.
  `create function audit_purge_allowed() returns boolean language sql stable as $$
     select exists (
       select 1 from audit_guard g
        where g.verifier = encode(sha256(convert_to(
                coalesce(nullif(current_setting('muster.audit_purge', true), ''), '-'), 'UTF8')), 'hex'))
   $$`,
  `create or replace function admin_events_append_only() returns trigger language plpgsql as $$
   begin
     if tg_op = 'DELETE' and not exists (select 1 from organizations where id = old.org_id) then
       return old;
     end if;
     if tg_op = 'DELETE' and audit_purge_allowed() then
       return old;
     end if;
     raise exception 'The activity log is append-only: a row cannot be changed or removed.'
       using errcode = 'restrict_violation';
   end $$`,
  // The place a check last vouched for, signed with the server's key.
  `alter table audit_chain add column signed_n bigint`,
  `alter table audit_chain add column signed_hash text`,
  `alter table audit_chain add column signed_mac text`,
  // The head moves only as a row is linked (from inside that trigger). What a check found
  // may be written beside it; the place it vouched for only moves forward.
  `create function audit_chain_keep() returns trigger language plpgsql as $$
   begin
     if tg_op = 'DELETE' then
       if not exists (select 1 from organizations where id = old.org_id) then return old; end if;
     elsif new.org_id = old.org_id and new.n = old.n and new.hash = old.hash then
       if old.signed_n is null or (new.signed_n is not null and new.signed_n >= old.signed_n) then
         return new;
       end if;
     elsif pg_trigger_depth() > 1 and new.org_id = old.org_id and new.n = old.n + 1
           and new.signed_n is not distinct from old.signed_n
           and new.signed_hash is not distinct from old.signed_hash
           and new.signed_mac is not distinct from old.signed_mac then
       return new;
     end if;
     raise exception 'The head of the activity log is moved only by a record being written.'
       using errcode = 'restrict_violation';
   end $$`,
  `create trigger audit_chain_keep before update or delete on audit_chain
     for each row execute function audit_chain_keep()`,
  // A checkpoint is written by the purge and then left alone.
  `create function audit_checkpoints_keep() returns trigger language plpgsql as $$
   begin
     if tg_op = 'INSERT' then
       if audit_purge_allowed() then return new; end if;
     elsif tg_op = 'DELETE' and not exists (select 1 from organizations where id = old.org_id) then
       return old;
     end if;
     raise exception 'A checkpoint of the activity log is written by the purge and never changed.'
       using errcode = 'restrict_violation';
   end $$`,
  `create trigger audit_checkpoints_keep before insert or update or delete on audit_checkpoints
     for each row execute function audit_checkpoints_keep()`,
  // Sending on: since when it has not been getting through, and how many go in a request.
  `alter table audit_forward add column failing_since timestamptz`,
  `alter table audit_forward add column batch integer not null default 200`,
];

export interface Broken {
  /**
   * changed: the row is not what was hashed. link: it does not follow the row before it.
   * missing: rows before it are gone. start: the first row is not where the record begins.
   * end: rows after the last one are gone. checkpoint: the note of what was purged is not ours.
   * anchor: the record is not the one a check last vouched for.
   */
  why: "changed" | "link" | "missing" | "start" | "end" | "checkpoint" | "anchor";
  chainNo: number | null;
  time: string | null;
  action: string | null;
}
export interface ChainState {
  ok: boolean;
  /** Rows now in the record, and the place of the first and the last. */
  records: number;
  first: number | null;
  last: number;
  head: string;
  /** Rows purged at the end of their keeping, vouched for by a checkpoint. */
  purged: number;
  broken: Broken | null;
}

const mac = (secretKey: string, orgId: string, chainNo: number, hash: string) =>
  secretKey
    ? createHmac("sha256", secretKey)
        .update(`audit-checkpoint\n${orgId}\n${chainNo}\n${hash}`)
        .digest("hex")
    : "";

/** The key the purge shows the database, made from the server's secret and kept nowhere. */
const purgeKey = (secretKey: string) =>
  createHmac("sha256", secretKey).update("muster-audit-purge").digest("hex");
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Whether this server can purge the activity log, and why not: with no secret key a
 * checkpoint could be written by anyone, and with another key than the one the database
 * was first told of, the database refuses. The first server with a key tells it.
 */
export async function purgeGuard(
  db: Queryable,
  secretKey: string,
): Promise<"ok" | "no_key" | "other_key"> {
  if (!secretKey) return "no_key";
  const verifier = sha256(purgeKey(secretKey));
  await db.query("insert into audit_guard (verifier) values ($1) on conflict (one) do nothing", [
    verifier,
  ]);
  const kept = (await db.query<{ verifier: string }>("select verifier from audit_guard"))[0];
  return kept?.verifier === verifier ? "ok" : "other_key";
}

async function latestCheckpoint(tx: Queryable, orgId: string) {
  const row = (
    await tx.query<{ chainNo: string; hash: string; mac: string }>(
      `select chain_no as "chainNo", hash, mac from audit_checkpoints
        where org_id = $1 order by chain_no desc limit 1`,
      [orgId],
    )
  )[0];
  return row ? { chainNo: Number(row.chainNo), hash: row.hash, mac: row.mac } : null;
}

/**
 * Walks an organization's chain from its start to its end and says where it first fails
 * to prove itself. It reads one moment of the database (a snapshot), in which a row and
 * the head it moved are either both there or both not, so nobody writing waits for it.
 */
export async function verifyChain(db: Db, orgId: string, secretKey: string): Promise<ChainState> {
  await db.query("insert into audit_chain (org_id) values ($1) on conflict (org_id) do nothing", [
    orgId,
  ]);
  return db.tx(async (tx) => {
    await tx.query("set transaction isolation level repeatable read read only");
    const head = (
      await tx.query<{
        n: string;
        hash: string;
        signedN: string | null;
        signedHash: string | null;
        signedMac: string | null;
      }>(
        `select n, hash, signed_n as "signedN", signed_hash as "signedHash", signed_mac as "signedMac"
           from audit_chain where org_id = $1`,
        [orgId],
      )
    )[0] ?? { n: "0", hash: "", signedN: null, signedHash: null, signedMac: null };
    const ends = (
      await tx.query<{ records: string; first: string | null }>(
        `select count(*) as records, min(chain_no) as first from admin_events where org_id = $1`,
        [orgId],
      )
    )[0] as { records: string; first: string | null };
    const checkpoint = await latestCheckpoint(tx, orgId);
    const state: ChainState = {
      ok: true,
      records: Number(ends.records),
      first: ends.first === null ? null : Number(ends.first),
      last: Number(head.n),
      head: head.hash,
      purged: checkpoint?.chainNo ?? 0,
      broken: null,
    };
    type At = { chainNo: string; time: Date; action: string };
    const fail = (why: Broken["why"], at?: At | null): ChainState => ({
      ...state,
      ok: false,
      broken: {
        why,
        chainNo: at ? Number(at.chainNo) : null,
        time: at ? new Date(at.time).toISOString() : null,
        action: at?.action ?? null,
      },
    });
    if (checkpoint && checkpoint.mac !== mac(secretKey, orgId, checkpoint.chainNo, checkpoint.hash))
      return fail("checkpoint");
    // The start comes before any fault inside, so it is looked at first.
    const starts = (
      await tx.query<At & { prevHash: string }>(
        `select chain_no as "chainNo", time, action, prev_hash as "prevHash"
           from admin_events where org_id = $1 order by chain_no limit 1`,
        [orgId],
      )
    )[0];
    const from = { chainNo: checkpoint?.chainNo ?? 0, hash: checkpoint?.hash ?? "" };
    if (starts && (Number(starts.chainNo) !== from.chainNo + 1 || starts.prevHash !== from.hash))
      return fail(Number(starts.chainNo) > from.chainNo + 1 ? "missing" : "start", starts);
    const inside = (
      await tx.query<At & { why: Broken["why"] }>(
        `with walked as (
           select e.chain_no, e.time, e.action, e.prev_hash, e.hash, ${HASH} as expect,
                  lag(e.hash) over (order by e.chain_no) as before,
                  lag(e.chain_no) over (order by e.chain_no) as before_no
             from admin_events e where e.org_id = $1)
         select chain_no as "chainNo", time, action,
                case when hash <> expect then 'changed'
                     when chain_no <> before_no + 1 then 'missing' else 'link' end as why
           from walked
          where hash <> expect
             or (before_no is not null and (chain_no <> before_no + 1 or prev_hash <> before))
          order by chain_no limit 1`,
        [orgId],
      )
    )[0];
    if (inside) return fail(inside.why, inside);
    const last = (
      await tx.query<At & { hash: string }>(
        `select chain_no as "chainNo", time, action, hash
           from admin_events where org_id = $1 order by chain_no desc limit 1`,
        [orgId],
      )
    )[0];
    const end = last ? { chainNo: Number(last.chainNo), hash: last.hash } : from;
    if (end.chainNo !== Number(head.n) || end.hash !== head.hash) return fail("end", last);
    // A record rebuilt from end to end agrees with itself. It does not agree with the
    // place a check last signed for, unless whoever rebuilt it had the server's key.
    if (head.signedN !== null && secretKey) {
      const signedN = Number(head.signedN);
      const signedHash = head.signedHash ?? "";
      if (head.signedMac !== mac(secretKey, orgId, signedN, signedHash)) return fail("anchor");
      if (signedN > Number(head.n)) return fail("anchor", last);
      if (signedN > from.chainNo) {
        const there = (
          await tx.query<At & { hash: string }>(
            `select chain_no as "chainNo", time, action, hash
               from admin_events where org_id = $1 and chain_no = $2`,
            [orgId, signedN],
          )
        )[0];
        if (!there || there.hash !== signedHash) return fail("anchor", there);
      }
    }
    return state;
  });
}

/** Checks the chain and keeps what was found, for the page and for whoever asks later. */
export async function checkChain(db: Db, orgId: string, secretKey: string): Promise<ChainState> {
  const state = await verifyChain(db, orgId, secretKey);
  // A record that proved itself is signed for up to where it then ended.
  const sign = state.ok && secretKey && state.last > 0;
  await db.query(
    `update audit_chain set checked_at = now(), checked_ok = $2, checked_detail = $3::jsonb,
            signed_n = case when $4 and coalesce(signed_n, 0) <= $5 then $5 else signed_n end,
            signed_hash = case when $4 and coalesce(signed_n, 0) <= $5 then $6 else signed_hash end,
            signed_mac = case when $4 and coalesce(signed_n, 0) <= $5 then $7 else signed_mac end
      where org_id = $1`,
    [
      orgId,
      state.ok,
      JSON.stringify(state),
      Boolean(sign),
      state.last,
      state.head,
      mac(secretKey, orgId, state.last, state.head),
    ],
  );
  return state;
}

/** Once a day for every organization. What fails is said on the page and in the server's log. */
export async function checkChainsDue(db: Db, secretKey: string): Promise<number> {
  const due = await db.query<{ id: string }>(
    `select o.id from organizations o left join audit_chain a on a.org_id = o.id
      where a.checked_at is null or a.checked_at < now() - interval '24 hours' limit 50`,
  );
  for (const org of due) {
    const state = await checkChain(db, org.id, secretKey);
    if (!state.ok)
      console.error(
        `the activity log of organization ${org.id} does not prove itself:`,
        JSON.stringify(state.broken),
      );
  }
  return due.length;
}

/** How many rows one pass of the purge takes: one transaction never holds more. */
export const PURGE_PASS = 5_000;

/**
 * Takes rows before a day off the front of the chain, `most` at the most, and leaves a
 * checkpoint in their place. Only whole rows from the start go: the chain never has a
 * hole. `sentThrough` holds back rows not yet sent on. Returns how many went: fewer than
 * `most` when there is no more to take. Nothing goes without the server's key, since the
 * checkpoint would then be one anybody could have written.
 */
export async function purgeChain(
  tx: Queryable,
  orgId: string,
  before: Date,
  secretKey: string,
  sentThrough: number | null = null,
  most = PURGE_PASS,
): Promise<number> {
  if ((await purgeGuard(tx, secretKey)) !== "ok") return 0;
  await tx.query("insert into audit_chain (org_id) values ($1) on conflict (org_id) do nothing", [
    orgId,
  ]);
  await tx.query("select 1 from audit_chain where org_id = $1 for update", [orgId]);
  // The first row that stays: the oldest that is not old enough, or not yet sent on.
  const kept = (
    await tx.query<{ first: string | null }>(
      `select min(chain_no) as first from admin_events
        where org_id = $1 and (time >= $2 or ($3::bigint is not null and chain_no > $3::bigint))`,
      [orgId, before, sentThrough],
    )
  )[0]?.first;
  // The last row of this pass: so many from the front, and none that stays.
  const end = (
    await tx.query<{ chainNo: string; hash: string; time: Date }>(
      `select chain_no as "chainNo", hash, time from
         (select chain_no, hash, time from admin_events
           where org_id = $1 and ($2::bigint is null or chain_no < $2::bigint)
           order by chain_no limit $3) front
        order by chain_no desc limit 1`,
      [orgId, kept ?? null, most],
    )
  )[0];
  if (!end) return 0;
  const chainNo = Number(end.chainNo);
  await tx.query("select set_config('muster.audit_purge', $1, true)", [purgeKey(secretKey)]);
  const gone = await tx.query(
    "delete from admin_events where org_id = $1 and chain_no <= $2 returning id",
    [orgId, chainNo],
  );
  await tx.query(
    `insert into audit_checkpoints (org_id, chain_no, hash, rows, through, mac)
     values ($1, $2, $3, $4, $5, $6)`,
    [orgId, chainNo, end.hash, gone.length, end.time, mac(secretKey, orgId, chainNo, end.hash)],
  );
  await tx.query("select set_config('muster.audit_purge', '', true)");
  return gone.length;
}

const CHAIN_COLUMNS = `e.chain_no as "chainNo", e.id, e.time, e.actor_user_id as "actorUserId",
  e.actor_email as "actorEmail", e.action, e.target_type as "targetType", e.target_id as "targetId",
  e.target_label as "targetLabel", e.detail, e.ip, e.prev_hash as "prevHash", e.hash`;
type ChainRow = {
  chainNo: string;
  id: string;
  time: Date;
  actorUserId: string | null;
  actorEmail: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  targetLabel: string | null;
  detail: unknown;
  ip: string | null;
  prevHash: string;
  hash: string;
  canonical?: string;
};
/** A row as it leaves: in an export or to the place the record is sent on to. */
const outward = (row: ChainRow) => ({
  chain_no: Number(row.chainNo),
  id: row.id,
  time: new Date(row.time).toISOString(),
  actor_user_id: row.actorUserId,
  actor_email: row.actorEmail,
  action: row.action,
  target_type: row.targetType,
  target_id: row.targetId,
  target_label: row.targetLabel,
  detail: row.detail,
  ip: row.ip,
  prev_hash: row.prevHash,
  hash: row.hash,
  ...(row.canonical === undefined ? {} : { canonical: row.canonical }),
});
export type Outward = ReturnType<typeof outward>;

export const CHAIN_EXPORT_ROWS = 100_000;
/**
 * The record with its hashes, one JSON object a line, oldest first: a first line that says
 * what the file is and how a row's hash is made, then the rows. Each row carries the exact
 * text that was hashed, so the file can be checked with nothing but sha256.
 */
export async function exportChain(
  db: Queryable,
  orgId: string,
  range: { from: string | null; to: string | null },
  most = CHAIN_EXPORT_ROWS,
): Promise<{ text: string; rows: number; truncated: boolean }> {
  const rows = await db.query<ChainRow>(
    `select ${CHAIN_COLUMNS}, admin_event_canonical(e) as canonical
       from admin_events e
      where e.org_id = $1 and ($2::date is null or e.time >= $2::date)
        and ($3::date is null or e.time < $3::date + 1)
      order by e.chain_no limit $4`,
    [orgId, range.from, range.to, most + 1],
  );
  const truncated = rows.length > most;
  const kept = truncated ? rows.slice(0, most) : rows;
  const head = (
    await db.query<{ n: string; hash: string }>(
      "select n, hash from audit_chain where org_id = $1",
      [orgId],
    )
  )[0];
  const checkpoint = await latestCheckpoint(db, orgId);
  const first = {
    muster_activity_log: 1,
    org_id: orgId,
    exported_at: new Date().toISOString(),
    from: range.from,
    to: range.to,
    rows: kept.length,
    truncated,
    head: { chain_no: Number(head?.n ?? 0), hash: head?.hash ?? "" },
    purged_through: checkpoint ? { chain_no: checkpoint.chainNo, hash: checkpoint.hash } : null,
    how: 'hash = lowercase hex of sha256(prev_hash + "\\n" + canonical), as UTF-8. prev_hash of row 1 is empty. canonical is a JSON array: chain_no, id, org_id, time, actor_user_id, actor_email, action, target_type, target_id, target_label, detail, ip.',
  };
  const lines = [first, ...kept.map(outward)].map((line) => JSON.stringify(line));
  return { text: `${lines.join("\n")}\n`, rows: kept.length, truncated };
}

// ---- sending the record on ----

export const FORWARD_KINDS = ["json", "splunk"] as const;
export type ForwardKind = (typeof FORWARD_KINDS)[number];
const REQUESTS_A_TICK = 12;
/** After so many failures in a row the page says it has stalled. It still tries, hourly. */
export const STALLED_AFTER = 20;
/**
 * How long the purge waits for records that are not getting through. After this many days
 * of nothing but failures, records past their keeping go unsent: a retention period is a
 * promise too, and an address that never answers must not keep the record for ever.
 */
export const PURGE_WAITS_DAYS = 7;
const FIRST_WAIT_MS = 30_000;
const LONGEST_WAIT_MS = 60 * 60 * 1000;
/** How long to wait after so many failures in a row: doubling from half a minute to an hour. */
export const waitAfter = (failures: number) =>
  Math.min(FIRST_WAIT_MS * 2 ** Math.min(20, Math.max(0, failures - 1)), LONGEST_WAIT_MS);

type ForwardRow = {
  orgId: string;
  kind: ForwardKind;
  url: string;
  tokenSealed: string | null;
  cursor: string;
  failures: number;
  batch: number;
};

/** What is posted for a batch, and with what credential. */
export function forwardRequest(
  kind: ForwardKind,
  token: string | null,
  events: Outward[],
): { body: string; headers: Record<string, string> } {
  if (kind === "splunk")
    return {
      // Splunk's HTTP Event Collector takes events one after another, not as a list.
      body: events
        .map((event) =>
          JSON.stringify({
            time: Date.parse(event.time) / 1000,
            source: "muster",
            sourcetype: "muster:audit",
            event,
          }),
        )
        .join("\n"),
      headers: token ? { authorization: `Splunk ${token}` } : {},
    };
  return {
    body: JSON.stringify({ source: "muster", events }),
    headers: token ? { authorization: `Bearer ${token}` } : {},
  };
}

/**
 * Sends the record on to the place an administrator named, in order, from where it last
 * got to. A batch is marked delivered only when the other end says yes, so nothing is
 * lost while it is down: it is sent again, which the other end may see as a repeat
 * (each event carries its `id` and `chain_no` to tell). It never gives up on an event;
 * it waits longer between tries, up to an hour, and after twenty failures in a row the
 * page says it has stalled. A request the other end finds too big is tried again with
 * half as many records. The address is checked as any address the server calls is:
 * public, https, and never redirected.
 */
export class AuditForwarder {
  private busy = false;
  constructor(
    private readonly db: Db,
    private readonly secretKey: string,
    private readonly net: Net,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Sends what is waiting, for every organization that is due. Returns how many events went. */
  async tick(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    try {
      const due = await this.db.query<{ orgId: string }>(
        `select f.org_id as "orgId" from audit_forward f join audit_chain a on a.org_id = f.org_id
          where f.enabled and a.n > f.cursor and (f.next_at is null or f.next_at <= $1)`,
        [this.now()],
      );
      let sent = 0;
      for (const row of due) sent += await this.send(row.orgId);
      return sent;
    } finally {
      this.busy = false;
    }
  }

  private async send(orgId: string): Promise<number> {
    let sent = 0;
    for (let request = 0; request < REQUESTS_A_TICK; request++) {
      const went = await this.one(orgId);
      if (went === null) break;
      sent += went;
    }
    return sent;
  }

  /**
   * One request. The organization's row is held for as long as it takes, and a process
   * that finds it held leaves it: two servers never post the same records. Returns how
   * many went (none when the request was too big and is to be tried smaller), or null
   * when there is nothing more to do this time.
   */
  private one(orgId: string): Promise<number | null> {
    return this.db.tx(async (tx) => {
      const row = (
        await tx.query<ForwardRow>(
          `select org_id as "orgId", kind, url, token_sealed as "tokenSealed", cursor, failures, batch
             from audit_forward
            where org_id = $1 and enabled and (next_at is null or next_at <= $2)
            for update skip locked`,
          [orgId, this.now()],
        )
      )[0];
      if (!row) return null;
      const cursor = Number(row.cursor);
      const rows = await tx.query<ChainRow>(
        `select ${CHAIN_COLUMNS} from admin_events e
          where e.org_id = $1 and e.chain_no > $2 order by e.chain_no limit $3`,
        [orgId, cursor, row.batch],
      );
      if (rows.length === 0) return null;
      const { problem, status } = await this.post(row, rows.map(outward));
      if (problem === null) {
        await tx.query(
          `update audit_forward set cursor = $2, delivered_at = $3, failures = 0, error = null,
                  error_at = null, next_at = null, failing_since = null
            where org_id = $1`,
          [orgId, Number((rows.at(-1) as ChainRow).chainNo), this.now()],
        );
        return rows.length;
      }
      // Too much in one request, or a request the other end will not read: half as many
      // next, at once, down to one record. Only one record refused is a failure.
      if ((status === 413 || status === 400) && rows.length > 1) {
        await tx.query("update audit_forward set batch = $2 where org_id = $1", [
          orgId,
          Math.max(1, Math.floor(rows.length / 2)),
        ]);
        return 0;
      }
      const failures = row.failures + 1;
      await tx.query(
        `update audit_forward set failures = $2, error = $3, error_at = $4, next_at = $5,
                failing_since = coalesce(failing_since, $4)
          where org_id = $1`,
        [
          orgId,
          failures,
          problem.slice(0, 300),
          this.now(),
          new Date(this.now().getTime() + waitAfter(failures)),
        ],
      );
      return null;
    });
  }

  /** No problem when the other end took it; otherwise why it did not, in words for the page. */
  private async post(
    row: Pick<ForwardRow, "kind" | "url" | "tokenSealed">,
    events: Outward[],
  ): Promise<{ problem: string | null; status: number | null }> {
    const no = (problem: string, status: number | null = null) => ({ problem, status });
    let token: string | null = null;
    if (row.tokenSealed) {
      token = this.secretKey ? openText(this.secretKey, row.tokenSealed) : null;
      if (token === null)
        return no("The token cannot be opened with this server's key. Enter it again.");
    }
    const { body, headers } = forwardRequest(row.kind, token, events);
    try {
      if (checkUrl(row.url).protocol !== "https:") return no("The address is not https.");
      const response = await this.net.request(row.url, {
        method: "POST",
        headers,
        body,
        contentType: "application/json",
        noRedirect: true,
      });
      if (response.status >= 200 && response.status < 300)
        return { problem: null, status: response.status };
      return no(`The address answered ${response.status}.`, response.status);
    } catch (error) {
      return no(error instanceof NetError ? error.message : "The address could not be reached.");
    }
  }

  /** Sends one event that is not part of the record, to see that the address takes it. */
  test(row: {
    kind: ForwardKind;
    url: string;
    tokenSealed: string | null;
  }): Promise<string | null> {
    return this.send1(row);
  }
  private async send1(row: Pick<ForwardRow, "kind" | "url" | "tokenSealed">) {
    const { problem } = await this.post(row, [
      {
        chain_no: 0,
        id: newId(),
        time: this.now().toISOString(),
        actor_user_id: null,
        actor_email: "muster",
        action: "audit.forward_test",
        target_type: null,
        target_id: null,
        target_label: null,
        detail: { test: true },
        ip: null,
        prev_hash: "",
        hash: "",
      },
    ]);
    return problem;
  }
}

// ---- what the console asks ----

const DAY = /^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const ForwardBody = z.strictObject({
  kind: z.enum(FORWARD_KINDS),
  url: z.string().trim().min(1).max(500),
  /** Left out on a change: the one kept stays. An empty text takes it away. */
  token: z.string().trim().max(2000).optional(),
  enabled: z.boolean().default(true),
  /** Only when sending is first set up: everything kept so far, or only what comes after. */
  start: z.enum(["now", "beginning"]).default("now"),
});

export function registerChain(
  app: Hono<Env>,
  kit: AppKit,
  db: Db,
  secretKey: string,
  forwarder: AuditForwarder,
): void {
  const { need, actorOf, clientIp } = kit;
  const org = (c: Ctx) => c.get("session").org.id;
  const begin = (tx: Queryable, orgId: string) =>
    tx.query("insert into audit_chain (org_id) values ($1) on conflict (org_id) do nothing", [
      orgId,
    ]);

  const forwardOf = async (orgId: string) => {
    const row = (
      await db.query<{
        cursor: string;
        behind: string;
        tokenSealed: string | null;
        failures: number;
      }>(
        `select f.kind, f.url, f.token_sealed as "tokenSealed", f.enabled, f.cursor,
                greatest(a.n - f.cursor, 0) as behind, f.delivered_at as "deliveredAt",
                f.failures, f.error, f.error_at as "errorAt", f.next_at as "nextAt",
                f.failing_since as "failingSince"
           from audit_forward f join audit_chain a on a.org_id = f.org_id where f.org_id = $1`,
        [orgId],
      )
    )[0];
    if (!row) return null;
    const { tokenSealed, ...rest } = row;
    return {
      ...rest,
      cursor: Number(row.cursor),
      behind: Number(row.behind),
      hasToken: tokenSealed !== null,
      stalled: row.failures >= STALLED_AFTER,
      purgeWaitsDays: PURGE_WAITS_DAYS,
    };
  };

  // How the record stands: what the last check found, and where it is sent on to.
  app.get("/api/audit/chain", async (c) => {
    const denied = need(c, "audit.read");
    if (denied) return denied;
    await begin(db, org(c));
    const chain = (
      await db.query<{ records: string }>(
        `select n as records, checked_at as "checkedAt", checked_ok as "checkedOk",
                checked_detail as "checked" from audit_chain where org_id = $1`,
        [org(c)],
      )
    )[0];
    return c.json({
      ...chain,
      records: Number(chain?.records ?? 0),
      forward: await forwardOf(org(c)),
      canSeal: Boolean(secretKey),
      // Whether a check signs for what it found, which is what shows a record rebuilt whole.
      signs: Boolean(secretKey),
    });
  });

  // Checking is reading, so whoever may read the record may check it. That it was checked,
  // and what was found, is on the record after.
  app.post("/api/audit/chain/verify", async (c) => {
    const denied = need(c, "audit.read");
    if (denied) return denied;
    // One a minute for an organization: a check reads the whole record.
    const recent = await db.query(
      "select 1 from audit_chain where org_id = $1 and checked_at > now() - interval '1 minute'",
      [org(c)],
    );
    if (recent.length > 0) return fail(c, "audit_check_recent");
    const state = await checkChain(db, org(c), secretKey);
    await recordEvent(db, {
      orgId: org(c),
      actor: actorOf(c),
      action: "audit.verified",
      detail: { ok: state.ok, records: state.records, ...(state.broken ?? {}) },
      ip: clientIp(c),
    });
    return c.json(state);
  });

  app.get("/api/audit/chain/export", async (c) => {
    const denied = need(c, "audit.read");
    if (denied) return denied;
    const from = c.req.query("from") || null;
    const to = c.req.query("to") || null;
    if ((from && !DAY.test(from)) || (to && !DAY.test(to))) return fail(c, "invalid_request");
    // Asking only for the headers takes nothing, so nothing is recorded as taken.
    if (c.req.method === "HEAD")
      return c.body(null, 200, { "content-type": "application/x-ndjson" });
    const file = await exportChain(db, org(c), { from, to });
    await recordEvent(db, {
      orgId: org(c),
      actor: actorOf(c),
      action: "audit.exported",
      detail: { rows: file.rows, from, to, format: "jsonl" },
      ip: clientIp(c),
    });
    return new Response(file.text, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "content-disposition": 'attachment; filename="muster-activity-log.jsonl"',
        "cache-control": "no-store",
      },
    });
  });

  app.put("/api/audit/forward", async (c) => {
    const denied = need(c, "settings.manage");
    if (denied) return denied;
    const parsed = ForwardBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, "invalid_forward");
    const body = parsed.data;
    let url: URL;
    try {
      url = checkUrl(body.url);
    } catch {
      return fail(c, "invalid_forward");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      return fail(c, "invalid_forward");
    if (body.token && !secretKey) return fail(c, "connector_unsealed");
    return kit.inTx(c, async (tx) => {
      const had = (
        await tx.query<{ url: string; tokenSealed: string | null }>(
          `select url, token_sealed as "tokenSealed" from audit_forward where org_id = $1 for update`,
          [org(c)],
        )
      )[0];
      // A token kept was for the address it was entered with, and goes nowhere else.
      if (had?.tokenSealed && body.token === undefined && new URL(had.url).origin !== url.origin)
        throw new Refusal("connector_credential_again");
      const sealed =
        body.token === undefined
          ? (had?.tokenSealed ?? null)
          : body.token
            ? sealText(secretKey, body.token)
            : null;
      await begin(tx, org(c));
      // Where sending starts is chosen once, when it is set up: a change keeps its place.
      await tx.query(
        `insert into audit_forward (org_id, kind, url, token_sealed, enabled, cursor)
         values ($1, $2, $3, $4, $5,
                 case when $6 then coalesce((select max(chain_no) from audit_checkpoints where org_id = $1), 0)
                      else (select n from audit_chain where org_id = $1) end)
         on conflict (org_id) do update set kind = excluded.kind, url = excluded.url,
           token_sealed = excluded.token_sealed, enabled = excluded.enabled, updated_at = now(),
           failures = 0, error = null, error_at = null, next_at = null, failing_since = null,
           batch = 200`,
        [org(c), body.kind, url.toString(), sealed, body.enabled, body.start === "beginning"],
      );
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: had ? "audit.forward_changed" : "audit.forward_set",
        target: { type: "forward", id: org(c), label: url.host },
        detail: { kind: body.kind, enabled: body.enabled, ...(had ? {} : { start: body.start }) },
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    });
  });

  app.delete("/api/audit/forward", async (c) => {
    const denied = need(c, "settings.manage");
    if (denied) return denied;
    return kit.inTx(c, async (tx) => {
      const gone = await tx.query<{ url: string }>(
        "delete from audit_forward where org_id = $1 returning url",
        [org(c)],
      );
      if (!gone[0]) throw new Refusal("not_found");
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "audit.forward_removed",
        target: { type: "forward", id: org(c), label: new URL(gone[0].url).host },
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    });
  });

  // One event that is not part of the record, to the address as saved.
  app.post("/api/audit/forward/test", async (c) => {
    const denied = need(c, "settings.manage");
    if (denied) return denied;
    const row = (
      await db.query<{ kind: ForwardKind; url: string; tokenSealed: string | null }>(
        `select kind, url, token_sealed as "tokenSealed" from audit_forward where org_id = $1`,
        [org(c)],
      )
    )[0];
    if (!row) return fail(c, "not_found");
    const problem = await forwarder.test(row);
    return c.json({ ok: problem === null, problem });
  });
}
