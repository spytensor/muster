/**
 * The sandbox as an administrator runs it (docs/features/sandbox.md, "The Sandbox page"):
 * what is running and how to stop it, every run there was, the workspaces and how their
 * room comes back, how much a person may run in a day, and what code reached.
 *
 * A workspace is a conversation's working folder on the sandbox service's disk. It is
 * kept between runs so that a later step finds what an earlier one wrote, and so it adds
 * up. Its room comes back in three ways, all of them here and none of them asked of the
 * person:
 *
 *   - not used for the organization's number of days (7 unless changed, 1 to 90): released;
 *   - the organization's workspaces together over its cap, where it set one: the ones
 *     used longest ago are released until they are under it;
 *   - an administrator releases one, or all that are idle.
 *
 * Never one that something is running in (the sandbox service refuses, and a reply being
 * written in the conversation counts as running), never one whose conversation has a
 * proposal waiting to be sent to the code host (the proposal is the folder's contents:
 * releasing it would lose work a person was shown and has not yet decided on), and
 * nothing in an organization under a legal hold.
 *
 * A released workspace comes back by itself: the next run or opening in that
 * conversation makes a fresh, empty one. The agent is told so once, in that tool's
 * result (sandboxUse.ts, `releasedNote`).
 */
import type { Hono } from "hono";
import { z } from "zod";
import { type AppKit, type Ctx, type Env, fail } from "./app.js";
import { recordEvent } from "./audit.js";
import type { Config } from "./config.js";
import type { Db, Queryable } from "./db.js";
import { shownSql } from "./runtime/catalog.js";
import { type Sandbox, SandboxError, type SandboxSpace } from "./sandbox.js";
import { DEFAULT_HOSTS, SANDBOX_CPUS, type SandboxUse } from "./sandboxUse.js";

export const SANDBOX_ADMIN_SCHEMA = [
  // Who asked for a run, in what language and in which reply; what it printed; and what
  // it reached by host. The lines written before this say none of it.
  `alter table sandbox_runs add column if not exists agent_id uuid,
                            add column if not exists language text,
                            add column if not exists trace_id uuid,
                            add column if not exists printed bigint not null default 0,
                            add column if not exists net jsonb`,
  `create index if not exists sandbox_runs_org on sandbox_runs (org_id, started_at)`,
  // An organization's own rules: after how many days without use a workspace is released,
  // how much all of its workspaces may hold together (null: no cap of its own), and a
  // day's allowance for everyone (null: the server's settings).
  `create table if not exists sandbox_settings (
    org_id uuid primary key references organizations(id) on delete cascade,
    idle_days integer not null default 7 check (idle_days between 1 and 90),
    total_bytes bigint check (total_bytes > 0),
    runs integer check (runs >= 0),
    cpu_seconds integer check (cpu_seconds >= 0),
    updated_by uuid,
    updated_at timestamptz not null default now()
  )`,
  // A day's allowance for one department or one person, which comes before everyone's.
  `create table if not exists sandbox_limits (
    org_id uuid not null references organizations(id) on delete cascade,
    kind text not null check (kind in ('department', 'person')),
    subject uuid not null,
    runs integer not null check (runs >= 0),
    cpu_seconds integer not null check (cpu_seconds >= 0),
    updated_by uuid,
    updated_at timestamptz not null default now(),
    primary key (org_id, kind, subject)
  )`,
  // A workspace that was released, until the agent has been told: once, with the next
  // run or opening in that conversation.
  `create table if not exists sandbox_released (
    conversation_id uuid primary key references conversations(id) on delete cascade,
    org_id uuid not null references organizations(id) on delete cascade,
    released_at timestamptz not null default now(),
    idle_days integer not null default 0,
    why text not null check (why in ('idle', 'cap', 'admin')),
    told boolean not null default false
  )`,
  // When workspaces were last looked through ('pass': one line, which is also how several
  // server processes agree that one of them does it), and what the last pass came to in
  // each organization (its id).
  `create table if not exists sandbox_reclaim (
    id text primary key,
    at timestamptz not null,
    detail jsonb not null default '{}'
  )`,
];

export const IDLE_DAYS = 7;
/** How often workspaces are looked through, and how often a server asks whether it is time. */
export const RECLAIM_EVERY_MS = 60 * 60 * 1000;
export const RECLAIM_ASK_MS = 10 * 60 * 1000;
/** A folder on the sandbox's disk with no conversation is given this long before it goes. */
const ORPHAN_MS = 24 * 3600 * 1000;
const DAY = 24 * 3600 * 1000;
const MB = 1024 * 1024;

type Why = "idle" | "cap" | "admin";
type Outcome = "released" | "running" | "proposal" | "failed";

/** What one pass came to in one organization. */
export interface Reclaimed {
  workspaces: number;
  released: number;
  bytes: number;
  idle: number;
  cap: number;
  /** Kept although due: something was running there, or a proposal waits. */
  running: number;
  proposal: number;
  failed: number;
  held: boolean;
}

export interface OrgSettings {
  idleDays: number;
  totalBytes: number | null;
}

async function settingsOf(db: Queryable, orgId: string): Promise<OrgSettings> {
  const row = (
    await db.query<{ idle: number; total: string | number | null }>(
      "select idle_days as idle, total_bytes as total from sandbox_settings where org_id = $1",
      [orgId],
    )
  )[0];
  return {
    idleDays: row?.idle ?? IDLE_DAYS,
    totalBytes: row?.total === null || row?.total === undefined ? null : Number(row.total),
  };
}

/**
 * Gives one workspace's room back, unless it must be kept. The sandbox service is asked
 * before anything is written here: it is the one that knows whether something runs there.
 */
async function releaseOne(
  db: Db,
  sandbox: Sandbox,
  one: { space: string; orgId: string | null; used: number; files: number },
  why: Why,
  now: number,
): Promise<Outcome> {
  if (!sandbox.release) return "failed";
  if (one.orgId) {
    const row = (
      await db.query<{ state: string | null; replying: boolean }>(
        `select (select state from cloud_work where conversation_id = $1) as state,
                exists (select 1 from messages where conversation_id = $1 and status = 'running') as replying`,
        [one.space],
      )
    )[0];
    if (row?.state === "proposed" || row?.state === "sending") return "proposal";
    if (row?.replying) return "running";
  }
  try {
    await sandbox.release(one.space, one.used);
  } catch (error) {
    return error instanceof SandboxError && error.code === "in_use" ? "running" : "failed";
  }
  if (one.orgId)
    await db.tx(async (tx) => {
      // The repository that was open there is gone with the folder: it is opened again,
      // not compared with a folder that is now empty.
      const had = await tx.query(
        "delete from cloud_work where conversation_id = $1 and state in ('open', 'sent') returning 1",
        [one.space],
      );
      // Nothing was there to miss: nothing is said.
      if (one.files === 0 && had.length === 0) return;
      await tx.query(
        `insert into sandbox_released (conversation_id, org_id, idle_days, why) values ($1, $2, $3, $4)
         on conflict (conversation_id) do update set released_at = now(), idle_days = excluded.idle_days,
           why = excluded.why, told = false`,
        [one.space, one.orgId, Math.max(0, Math.floor((now - one.used) / DAY)), why],
      );
    });
  return "released";
}

/** Which of these workspaces are conversations, and whose. */
async function owners(db: Queryable, spaces: SandboxSpace[]): Promise<Map<string, string>> {
  if (!spaces.length) return new Map();
  const rows = await db.query<{ id: string; org: string }>(
    "select id, org_id as org from conversations where id = any($1::uuid[])",
    [spaces.map((one) => one.space)],
  );
  return new Map(rows.map((row) => [row.id, row.org]));
}

/**
 * Looks through every workspace and releases what is due. One pass at a time over all
 * server processes: whoever writes the line for this hour does it, the others see the
 * line and do not.
 */
export class SandboxReclaim {
  constructor(
    private readonly db: Db,
    private readonly sandbox: Sandbox | null,
  ) {}

  /** A pass, if none was made in the last hour. Null when it was not this one's to make. */
  async tick(now = new Date()): Promise<Map<string, Reclaimed> | null> {
    if (!this.sandbox?.spaces || !this.sandbox.release) return null;
    const mine = await this.db.query(
      `insert into sandbox_reclaim (id, at) values ('pass', $1::timestamptz)
       on conflict (id) do update set at = excluded.at
         where sandbox_reclaim.at <= $2::timestamptz
       returning id`,
      [now.toISOString(), new Date(now.getTime() - RECLAIM_EVERY_MS + 60_000).toISOString()],
    );
    if (!mine.length) return null;
    return this.pass(now);
  }

  async pass(now = new Date()): Promise<Map<string, Reclaimed>> {
    const done = new Map<string, Reclaimed>();
    const sandbox = this.sandbox;
    if (!sandbox?.spaces || !sandbox.release) return done;
    const spaces = await sandbox.spaces();
    const owner = await owners(this.db, spaces);
    const held = new Set(
      (await this.db.query<{ org: string }>("select org_id as org from retention where hold")).map(
        (row) => row.org,
      ),
    );
    const byOrg = new Map<string, SandboxSpace[]>();
    for (const one of spaces) {
      const org = owner.get(one.space);
      if (org) byOrg.set(org, [...(byOrg.get(org) ?? []), one]);
      // No conversation has this folder: it was deleted while the sandbox could not be reached.
      else if (now.getTime() - one.used > ORPHAN_MS && !one.busy)
        await releaseOne(this.db, sandbox, { ...one, orgId: null }, "idle", now.getTime());
    }
    for (const [orgId, own] of byOrg) {
      const counts: Reclaimed = {
        workspaces: own.length,
        released: 0,
        bytes: 0,
        idle: 0,
        cap: 0,
        running: 0,
        proposal: 0,
        failed: 0,
        held: held.has(orgId),
      };
      done.set(orgId, counts);
      const settings = await settingsOf(this.db, orgId);
      if (!counts.held) {
        // Longest idle first: for the cap that is the rule, for the days it does no harm.
        const kept: SandboxSpace[] = [];
        const release = async (one: SandboxSpace, why: Exclude<Why, "admin">) => {
          const outcome = one.busy
            ? "running"
            : await releaseOne(this.db, sandbox, { ...one, orgId }, why, now.getTime());
          if (outcome === "released") {
            counts.released += 1;
            counts.bytes += one.bytes;
            counts[why] += 1;
          } else counts[outcome] += 1;
          return outcome === "released";
        };
        for (const one of [...own].sort((a, b) => a.used - b.used))
          if (now.getTime() - one.used >= settings.idleDays * DAY) {
            if (!(await release(one, "idle"))) kept.push(one);
          } else kept.push(one);
        if (settings.totalBytes !== null) {
          let total = kept.reduce((sum, one) => sum + one.bytes, 0);
          for (const one of kept) {
            if (total <= settings.totalBytes) break;
            if (await release(one, "cap")) total -= one.bytes;
          }
        }
      }
      await this.db.tx(async (tx) => {
        await tx.query(
          `insert into sandbox_reclaim (id, at, detail) values ($1, $2::timestamptz, $3::jsonb)
           on conflict (id) do update set at = excluded.at, detail = excluded.detail`,
          [orgId, now.toISOString(), JSON.stringify(counts)],
        );
        // One line for a pass that released something. A pass that found nothing to do
        // is on the page ("last run"), not in the activity log, which it would fill.
        if (counts.released > 0)
          await recordEvent(tx, {
            orgId,
            actor: { userId: null, email: "muster" },
            action: "sandbox.reclaimed",
            target: { type: "sandbox", id: orgId, label: `${counts.released} workspaces` },
            detail: {
              released: counts.released,
              bytes: counts.bytes,
              idle: counts.idle,
              overCap: counts.cap,
              keptRunning: counts.running,
              keptProposal: counts.proposal,
              failed: counts.failed,
              idleDays: settings.idleDays,
              totalBytes: settings.totalBytes,
            },
          });
      });
    }
    return done;
  }
}

const RANGES: Record<string, number> = { "24h": 1, "7d": 7, "30d": 30, "90d": 90 };
const ENDINGS: Record<string, string[]> = {
  ok: ["ok"],
  failed: ["failed", "broke"],
  timeout: ["timeout"],
  stopped: ["stopped"],
  lost: ["lost"],
  refused: ["refused"],
  running: ["running"],
};
const PAGE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const Settings = z.strictObject({
  idleDays: z.number().int().min(1).max(90),
  // Null: no cap of the organization's own. Else 64 MB at least: less holds nothing.
  totalBytes: z
    .number()
    .int()
    .min(64 * MB)
    .max(10 * 1024 * 1024 * MB)
    .nullable(),
});
const Limit = z.strictObject({
  kind: z.enum(["everyone", "department", "person"]),
  id: z.string().regex(UUID).optional(),
  runs: z.number().int().min(0).max(100_000),
  cpuSeconds: z.number().int().min(0).max(1_000_000),
});

export function registerSandboxAdmin(
  app: Hono<Env>,
  kit: AppKit,
  db: Db,
  at: {
    sandbox: Sandbox | null;
    use: SandboxUse;
    server: Config["sandboxDaily"];
    reclaim: SandboxReclaim;
  },
): void {
  const { need, actorOf, clientIp } = kit;
  const { sandbox, use } = at;
  const org = (c: Ctx) => c.get("session").org.id;
  const days = (c: Ctx): number | null => {
    const range = c.req.query("range") ?? "30d";
    return Object.hasOwn(RANGES, range) ? (RANGES[range] as number) : null;
  };

  /** The organization's own workspaces, as the sandbox has them, with whose each is. */
  const workspaces = async (orgId: string) => {
    const spaces = sandbox?.spaces ? await sandbox.spaces() : [];
    if (!spaces.length) return [];
    const rows = await db.query<{
      id: string;
      title: string;
      name: string;
      email: string;
      repository: string | null;
      state: string | null;
    }>(
      `select c.id, c.title, u.name, u.email, w.repository, w.state
         from conversations c join users u on u.id = c.user_id
         left join cloud_work w on w.conversation_id = c.id
        where c.org_id = $1 and c.id = any($2::uuid[])`,
      [orgId, spaces.map((one) => one.space)],
    );
    const by = new Map(rows.map((row) => [row.id, row]));
    return spaces.flatMap((one) => {
      const row = by.get(one.space);
      return row ? [{ ...one, ...row }] : [];
    });
  };

  // ---- the page as a whole ----

  app.get("/api/sandbox/overview", async (c) => {
    const denied = need(c, "settings.read");
    if (denied) return denied;
    const [status, health, settings, own, hold, everyone, limits, departments, people, passes] =
      await Promise.all([
        sandbox?.status ? sandbox.status() : null,
        sandbox ? sandbox.health(true) : null,
        settingsOf(db, org(c)),
        workspaces(org(c)).catch(() => []),
        db.query<{ hold: boolean }>("select hold from retention where org_id = $1", [org(c)]),
        db.query<{ runs: number | null; cpu: number | null }>(
          "select runs, cpu_seconds as cpu from sandbox_settings where org_id = $1",
          [org(c)],
        ),
        db.query<{
          kind: "department" | "person";
          id: string;
          name: string;
          email: string | null;
          runs: number;
          cpuSeconds: number;
        }>(
          `select l.kind, l.subject as id, coalesce(d.name, nullif(u.name, ''), u.email) as name,
                  u.email, l.runs, l.cpu_seconds as "cpuSeconds"
             from sandbox_limits l
             left join departments d on l.kind = 'department' and d.id = l.subject and d.org_id = l.org_id
             left join users u on l.kind = 'person' and u.id = l.subject
            where l.org_id = $1 and (d.id is not null or u.id is not null)
            order by l.kind, name`,
          [org(c)],
        ),
        db.query("select id, name from departments where org_id = $1 order by name", [org(c)]),
        db.query(
          `select u.id, u.name, u.email from memberships m join users u on u.id = m.user_id
            where m.org_id = $1 and m.status = 'active' order by u.email limit 500`,
          [org(c)],
        ),
        db.query<{ id: string; at: Date; detail: Reclaimed }>(
          "select id, at, detail from sandbox_reclaim where id in ('pass', $1)",
          [org(c)],
        ),
      ]);
    const pass = passes.find((row) => row.id === "pass");
    const mine = passes.find((row) => row.id === org(c));
    const lastAt = pass ? new Date(pass.at) : null;
    const all = everyone[0];
    return c.json({
      canManage: !need(c, "settings.manage"),
      configured: sandbox !== null,
      state:
        status ??
        (health
          ? {
              ...health,
              runtime: null,
              image: null,
              waiting: 0,
              slots: null,
              built: null,
              disk: null,
              limits: null,
            }
          : null),
      workspaces: { count: own.length, bytes: own.reduce((sum, one) => sum + one.bytes, 0) },
      settings,
      reclaim: {
        on: Boolean(sandbox?.spaces && sandbox.release),
        hold: hold[0]?.hold === true,
        lastAt,
        nextAt: lastAt ? new Date(lastAt.getTime() + RECLAIM_EVERY_MS) : null,
        // What the latest pass came to here; an earlier pass's counts are not shown as its.
        last:
          mine && lastAt && Math.abs(new Date(mine.at).getTime() - lastAt.getTime()) < 1000
            ? mine.detail
            : null,
      },
      limits: {
        server: at.server,
        everyone:
          all && all.runs !== null && all.cpu !== null
            ? { runs: all.runs, cpuSeconds: all.cpu }
            : null,
        rows: limits,
        cpus: SANDBOX_CPUS,
      },
      departments,
      people,
    });
  });

  // ---- running now ----

  app.get("/api/sandbox/running", async (c) => {
    const denied = need(c, "settings.read");
    if (denied) return denied;
    // The lines this organization's runs wrote as they began: who, which agent, which reply.
    const lines = await db.query<{
      conversation: string;
      title: string | null;
      name: string;
      email: string;
      agent: string | null;
      language: string | null;
      trace: string | null;
      started: Date;
      most: number;
    }>(
      `select r.conversation_id as conversation, c.title, u.name, u.email, ${shownSql("a")} as agent,
              r.language, r.trace_id as trace, r.started_at as started, r.cpu_seconds as most
         from sandbox_runs r join users u on u.id = r.user_id
         left join conversations c on c.id = r.conversation_id
         left join agents a on a.id = r.agent_id
        where r.org_id = $1 and r.ending = 'running' and r.conversation_id is not null
        order by r.started_at desc`,
      [org(c)],
    );
    const line = new Map<string, (typeof lines)[number]>();
    for (const one of lines) if (!line.has(one.conversation)) line.set(one.conversation, one);
    let flights: Awaited<ReturnType<NonNullable<Sandbox["running"]>>> | null = null;
    if (sandbox?.running) flights = await sandbox.running().catch(() => null);
    if (flights) {
      // The sandbox says what runs; the organization's own are the ones that are its conversations'.
      const mine = await db.query<{
        id: string;
        title: string;
        name: string;
        email: string;
        agent: string | null;
      }>(
        `select c.id, c.title, u.name, u.email, ${shownSql("a")} as agent
           from conversations c join users u on u.id = c.user_id left join agents a on a.id = c.agent_id
          where c.org_id = $1 and c.id = any($2::uuid[])`,
        [org(c), flights.map((one) => one.space)],
      );
      const by = new Map(mine.map((row) => [row.id, row]));
      return c.json({
        live: true,
        runs: flights.flatMap((one) => {
          const row = by.get(one.space);
          if (!row) return [];
          const known = line.get(one.space);
          return [
            {
              conversation: one.space,
              title: row.title,
              person: { name: row.name, email: row.email },
              agent: known?.agent ?? row.agent,
              language: one.language,
              state: one.state,
              askedAt: new Date(one.asked),
              startedAt: one.started ? new Date(one.started) : null,
              seconds: one.seconds,
              printed: one.printed,
              connections: one.connections,
              traceId: known?.trace ?? null,
            },
          ];
        }),
      });
    }
    // The sandbox cannot say: what the lines say is running, without what it printed.
    return c.json({
      live: false,
      runs: [...line.values()].map((one) => ({
        conversation: one.conversation,
        title: one.title ?? "",
        person: { name: one.name, email: one.email },
        agent: one.agent,
        language: one.language ?? "python",
        state: "running",
        askedAt: one.started,
        startedAt: one.started,
        seconds: Math.round(Number(one.most) / SANDBOX_CPUS),
        printed: null,
        connections: null,
        traceId: one.trace,
      })),
    });
  });

  /** The conversation named, if it is this organization's. */
  const conversation = async (c: Ctx) => {
    const id = c.req.param("conversation") ?? "";
    if (!UUID.test(id)) return null;
    return (
      (
        await db.query<{ id: string; title: string; email: string }>(
          `select c.id, c.title, u.email from conversations c join users u on u.id = c.user_id
            where c.id = $1 and c.org_id = $2`,
          [id, org(c)],
        )
      )[0] ?? null
    );
  };

  app.post("/api/sandbox/running/:conversation/stop", async (c) => {
    const denied = need(c, "settings.manage");
    if (denied) return denied;
    const found = await conversation(c);
    if (!found) return fail(c, "not_found");
    if (!sandbox?.stop) return fail(c, "sandbox_unavailable");
    let ended = 0;
    try {
      ended = await sandbox.stop(found.id);
    } catch {
      return fail(c, "sandbox_unavailable");
    }
    if (!ended) return fail(c, "sandbox_not_running");
    await db.tx((tx) =>
      recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "sandbox.run_stopped",
        target: { type: "conversation", id: found.id, label: found.title.slice(0, 120) },
        detail: { person: found.email, runs: ended },
        ip: clientIp(c),
      }),
    );
    return c.json({ ok: true, ended });
  });

  // ---- every run there was ----

  app.get("/api/sandbox/runs", async (c) => {
    const denied = need(c, "settings.read");
    if (denied) return denied;
    const range = days(c);
    const ending = c.req.query("ending") ?? "";
    const person = c.req.query("person") ?? "";
    const page = Math.floor(Number(c.req.query("page") ?? "1"));
    if (
      !range ||
      (ending && !Object.hasOwn(ENDINGS, ending)) ||
      (person && !UUID.test(person)) ||
      !Number.isFinite(page) ||
      page < 1 ||
      page > 10_000
    )
      return fail(c, "invalid_request");
    const where = `r.org_id = $1 and r.started_at > now() - ($2 || ' days')::interval
      and ($3::uuid is null or r.user_id = $3::uuid)
      and ($4::text[] is null or r.ending = any($4::text[]))`;
    const params = [org(c), String(range), person || null, ending ? ENDINGS[ending] : null];
    const [total, rows, people] = await Promise.all([
      db.query<{ n: string }>(`select count(*) as n from sandbox_runs r where ${where}`, params),
      db.query(
        `select r.id, r.started_at as "startedAt", r.ending, r.seconds::float8 as seconds,
                r.cpu_seconds::float8 as "cpuSeconds", r.peak_kb as "peakKb", r.printed,
                r.bytes_out as "bytesOut", r.net_up as "netUp", r.net_down as "netDown",
                r.reached, r.refused, r.language, r.trace_id as "traceId",
                r.conversation_id as conversation, c.title, ${shownSql("a")} as agent, u.name, u.email
           from sandbox_runs r join users u on u.id = r.user_id
           left join conversations c on c.id = r.conversation_id
           left join agents a on a.id = r.agent_id
          where ${where}
          order by r.started_at desc, r.id
          limit ${PAGE} offset ${(page - 1) * PAGE}`,
        params,
      ),
      db.query(
        `select distinct u.id, u.name, u.email from sandbox_runs r join users u on u.id = r.user_id
          where r.org_id = $1 and r.started_at > now() - ($2 || ' days')::interval
          order by u.email limit 200`,
        [org(c), String(range)],
      ),
    ]);
    return c.json({
      page,
      size: PAGE,
      total: Number(total[0]?.n ?? 0),
      people,
      rows: rows.map((row) => ({
        id: row.id,
        startedAt: row.startedAt,
        ending: row.ending,
        seconds: Math.round(Number(row.seconds ?? 0) * 100) / 100,
        cpuSeconds: Math.round(Number(row.cpuSeconds ?? 0) * 100) / 100,
        peakKb: row.peakKb === null ? null : Number(row.peakKb),
        printed: Number(row.printed ?? 0),
        bytesOut: Number(row.bytesOut ?? 0),
        netUp: Number(row.netUp ?? 0),
        netDown: Number(row.netDown ?? 0),
        reached: Number(row.reached ?? 0),
        refused: Number(row.refused ?? 0),
        language: row.language,
        traceId: row.traceId,
        conversation: row.conversation,
        title: row.title ?? "",
        agent: row.agent,
        person: { name: row.name, email: row.email },
      })),
    });
  });

  // ---- workspaces ----

  app.get("/api/sandbox/workspaces", async (c) => {
    const denied = need(c, "settings.read");
    if (denied) return denied;
    if (!sandbox?.spaces) return c.json({ available: false, workspaces: [] });
    let own: Awaited<ReturnType<typeof workspaces>>;
    try {
      own = await workspaces(org(c));
    } catch {
      return c.json({ available: false, workspaces: [] });
    }
    return c.json({
      available: true,
      workspaces: own.map((one) => ({
        conversation: one.space,
        title: one.title,
        person: { name: one.name, email: one.email },
        files: one.files,
        bytes: one.bytes,
        usedAt: new Date(one.used),
        busy: one.busy,
        repository: one.repository,
        // Kept whatever its age: what was proposed is in this folder until it is sent or dropped.
        proposal: one.state === "proposed" || one.state === "sending",
      })),
    });
  });

  /** Releases some of the organization's workspaces for an administrator, and says what came of it. */
  const releaseFor = async (c: Ctx, which: Awaited<ReturnType<typeof workspaces>>) => {
    const counts = { released: 0, bytes: 0, running: 0, proposal: 0, failed: 0, held: false };
    if (!sandbox) return counts;
    // Under a legal hold nothing is released, by the hour's pass or by hand.
    counts.held =
      (await db.query("select 1 from retention where org_id = $1 and hold", [org(c)])).length > 0;
    if (counts.held) return counts;
    const now = Date.now();
    for (const one of which) {
      const outcome = one.busy
        ? "running"
        : await releaseOne(db, sandbox, { ...one, orgId: org(c) }, "admin", now);
      if (outcome === "released") {
        counts.released += 1;
        counts.bytes += one.bytes;
      } else counts[outcome] += 1;
    }
    return counts;
  };

  app.delete("/api/sandbox/workspaces/:conversation", async (c) => {
    const denied = need(c, "settings.manage");
    if (denied) return denied;
    const found = await conversation(c);
    if (!found) return fail(c, "not_found");
    if (!sandbox?.spaces || !sandbox.release) return fail(c, "sandbox_unavailable");
    let own: Awaited<ReturnType<typeof workspaces>>;
    try {
      own = await workspaces(org(c));
    } catch {
      return fail(c, "sandbox_unavailable");
    }
    const one = own.find((space) => space.space === found.id);
    if (!one) return fail(c, "not_found");
    const counts = await releaseFor(c, [one]);
    if (counts.held) return fail(c, "sandbox_held");
    if (counts.running) return fail(c, "sandbox_in_use");
    if (counts.proposal) return fail(c, "sandbox_proposal_waiting");
    if (!counts.released) return fail(c, "sandbox_unavailable");
    await db.tx((tx) =>
      recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "sandbox.workspace_released",
        target: { type: "conversation", id: found.id, label: found.title.slice(0, 120) },
        detail: { person: found.email, workspaces: 1, bytes: one.bytes, files: one.files },
        ip: clientIp(c),
      }),
    );
    return c.json({ ok: true, ...counts });
  });

  // Every workspace nobody has used for so many days: what "Release all idle" does.
  app.post("/api/sandbox/workspaces/release-idle", async (c) => {
    const denied = need(c, "settings.manage");
    if (denied) return denied;
    const body = z
      .strictObject({ days: z.number().int().min(0).max(90) })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(c, "invalid_request");
    if (!sandbox?.spaces || !sandbox.release) return fail(c, "sandbox_unavailable");
    let own: Awaited<ReturnType<typeof workspaces>>;
    try {
      own = await workspaces(org(c));
    } catch {
      return fail(c, "sandbox_unavailable");
    }
    const before = Date.now() - body.data.days * DAY;
    const counts = await releaseFor(
      c,
      own.filter((one) => one.used <= before),
    );
    if (counts.held) return fail(c, "sandbox_held");
    if (counts.released)
      await db.tx((tx) =>
        recordEvent(tx, {
          orgId: org(c),
          actor: actorOf(c),
          action: "sandbox.workspace_released",
          target: { type: "sandbox", id: org(c), label: `${counts.released} workspaces` },
          detail: {
            workspaces: counts.released,
            bytes: counts.bytes,
            idleDays: body.data.days,
            keptRunning: counts.running,
            keptProposal: counts.proposal,
          },
          ip: clientIp(c),
        }),
      );
    return c.json({ ok: true, ...counts });
  });

  // ---- the rules ----

  app.put("/api/sandbox/settings", async (c) => {
    const denied = need(c, "settings.manage");
    if (denied) return denied;
    const body = Settings.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(c, "invalid_sandbox_settings");
    await db.tx(async (tx) => {
      const before = await settingsOf(tx, org(c));
      await tx.query(
        `insert into sandbox_settings (org_id, idle_days, total_bytes, updated_by) values ($1, $2, $3, $4)
         on conflict (org_id) do update set idle_days = excluded.idle_days, total_bytes = excluded.total_bytes,
           updated_by = excluded.updated_by, updated_at = now()`,
        [org(c), body.data.idleDays, body.data.totalBytes, c.get("session").user.id],
      );
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "sandbox.settings_changed",
        target: { type: "sandbox", id: org(c), label: `${body.data.idleDays} days` },
        detail: { before, after: body.data },
        ip: clientIp(c),
      });
    });
    return c.json(body.data);
  });

  /** Whose allowance this is, if they are this organization's: the name the record keeps. */
  const subject = async (tx: Queryable, orgId: string, kind: "department" | "person", id: string) =>
    (
      await tx.query<{ label: string }>(
        kind === "department"
          ? "select name as label from departments where id = $2 and org_id = $1"
          : `select u.email as label from memberships m join users u on u.id = m.user_id
              where m.org_id = $1 and m.user_id = $2 and m.status <> 'removed'`,
        [orgId, id],
      )
    )[0]?.label ?? null;

  app.put("/api/sandbox/limits", async (c) => {
    const denied = need(c, "settings.manage");
    if (denied) return denied;
    const body = Limit.safeParse(await c.req.json().catch(() => null));
    if (!body.success || (body.data.kind !== "everyone") !== Boolean(body.data.id))
      return fail(c, "invalid_sandbox_limit");
    const { kind, id, runs, cpuSeconds } = body.data;
    const done = await db.tx(async (tx) => {
      let label = "everyone";
      if (kind === "everyone")
        await tx.query(
          `insert into sandbox_settings (org_id, runs, cpu_seconds, updated_by) values ($1, $2, $3, $4)
           on conflict (org_id) do update set runs = excluded.runs, cpu_seconds = excluded.cpu_seconds,
             updated_by = excluded.updated_by, updated_at = now()`,
          [org(c), runs, cpuSeconds, c.get("session").user.id],
        );
      else {
        const found = await subject(tx, org(c), kind, id as string);
        if (!found) return false;
        label = found;
        await tx.query(
          `insert into sandbox_limits (org_id, kind, subject, runs, cpu_seconds, updated_by)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (org_id, kind, subject) do update set runs = excluded.runs,
             cpu_seconds = excluded.cpu_seconds, updated_by = excluded.updated_by, updated_at = now()`,
          [org(c), kind, id, runs, cpuSeconds, c.get("session").user.id],
        );
      }
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "sandbox.limit_set",
        target: { type: kind === "person" ? "user" : kind, id: id ?? org(c), label },
        detail: { for: kind, runs, cpuSeconds },
        ip: clientIp(c),
      });
      return true;
    });
    return done ? c.json({ ok: true }) : fail(c, "invalid_sandbox_limit");
  });

  // An allowance taken away: the next one in line holds again (the department's,
  // everyone's, the server's settings).
  app.delete("/api/sandbox/limits/:kind/:id?", async (c) => {
    const denied = need(c, "settings.manage");
    if (denied) return denied;
    const kind = c.req.param("kind");
    const id = c.req.param("id") ?? "";
    if (kind !== "everyone" && kind !== "department" && kind !== "person")
      return fail(c, "invalid_sandbox_limit");
    if ((kind !== "everyone") !== UUID.test(id)) return fail(c, "invalid_sandbox_limit");
    const done = await db.tx(async (tx) => {
      const gone =
        kind === "everyone"
          ? await tx.query(
              "update sandbox_settings set runs = null, cpu_seconds = null, updated_at = now() where org_id = $1 and runs is not null returning 1",
              [org(c)],
            )
          : await tx.query(
              "delete from sandbox_limits where org_id = $1 and kind = $2 and subject = $3 returning 1",
              [org(c), kind, id],
            );
      if (!gone.length) return false;
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "sandbox.limit_removed",
        target: {
          type: kind === "person" ? "user" : kind,
          id: id || org(c),
          label: kind === "everyone" ? "everyone" : ((await subject(tx, org(c), kind, id)) ?? kind),
        },
        detail: { for: kind },
        ip: clientIp(c),
      });
      return true;
    });
    return done ? c.json({ ok: true }) : fail(c, "not_found");
  });

  // ---- what code reached ----

  app.get("/api/sandbox/network", async (c) => {
    const denied = need(c, "settings.read");
    if (denied) return denied;
    const range = days(c);
    if (!range) return fail(c, "invalid_request");
    const [listed, reached] = await Promise.all([
      use.hosts(org(c)),
      db.query<{
        host: string;
        allowed: string;
        refused: string;
        up: string;
        down: string;
      }>(
        `select h->>'host' as host,
                coalesce(sum((h->>'times')::bigint) filter (where (h->>'ok')::boolean), 0) as allowed,
                coalesce(sum((h->>'times')::bigint) filter (where not (h->>'ok')::boolean), 0) as refused,
                coalesce(sum((h->>'up')::bigint), 0) as up,
                coalesce(sum((h->>'down')::bigint), 0) as down
           from sandbox_runs r cross join lateral jsonb_array_elements(r.net) h
          where r.org_id = $1 and r.started_at > now() - ($2 || ' days')::interval
            and jsonb_typeof(r.net) = 'array'
          group by 1 order by 2 desc, 3 desc, 1 limit 200`,
        [org(c), String(range)],
      ),
    ]);
    return c.json({
      hosts: listed.hosts,
      own: listed.own,
      defaults: DEFAULT_HOSTS,
      reached: reached.map((row) => ({
        host: row.host,
        allowed: Number(row.allowed),
        refused: Number(row.refused),
        up: Number(row.up),
        down: Number(row.down),
      })),
    });
  });
}
