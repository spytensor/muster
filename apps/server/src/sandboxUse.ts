import { newId } from "@muster/protocol";
import type { Hono } from "hono";
import { z } from "zod";
import { type AppKit, type Ctx, type Env, fail } from "./app.js";
import { recordEvent } from "./audit.js";
import type { Config } from "./config.js";
import type { Db, Queryable } from "./db.js";
import type { SandboxRun } from "./sandbox.js";

/**
 * What running code is held to, and what it used (docs/features/sandbox.md).
 *
 * Three things are kept here, none of them in the sandbox service, which keeps nothing:
 *
 *   - the hosts an organization's code may reach. One list, the administrator's. Until
 *     they change it, it is the package indexes. It goes with each run, and the sandbox
 *     service lets through that and nothing else;
 *   - a line for every run: who, how long, what went out. Written before the run starts
 *     and settled when it ends;
 *   - how much one person may run in a day (UTC, like the day's token allowance): so many
 *     runs and so many processor seconds, counted as the time a run took times the
 *     processors it was allowed. Past either, a run is refused with the reason.
 */

/** Where Python and Node packages come from: what a run reaches when nobody has said otherwise. */
export const DEFAULT_HOSTS = ["pypi.org", "files.pythonhosted.org", "registry.npmjs.org"];
export const HOSTS_MOST = 50;

/** Appended to the migrations as one step. */
export const SANDBOX_USE_SCHEMA = [
  `create table sandbox_hosts (
    org_id uuid primary key references organizations(id) on delete cascade,
    hosts text[] not null,
    updated_by uuid references users(id) on delete set null,
    updated_at timestamptz not null default now()
  )`,
  `create table sandbox_runs (
    id uuid primary key,
    org_id uuid not null references organizations(id) on delete cascade,
    user_id uuid not null references users(id) on delete cascade,
    conversation_id uuid,
    started_at timestamptz not null default now(),
    -- How it ended: 'ok', 'failed', 'timeout', or 'refused' when the sandbox would not or could not run it.
    ending text not null,
    seconds real not null default 0,
    cpu_seconds real not null default 0,
    peak_kb integer not null default 0,
    bytes_out bigint not null default 0,
    net_up bigint not null default 0,
    net_down bigint not null default 0,
    -- Connections let through, and connections refused.
    reached integer not null default 0,
    refused integer not null default 0
  )`,
  `create index sandbox_runs_person on sandbox_runs (org_id, user_id, started_at)`,
];

const NAME =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
/**
 * A host as the list holds it: a name, or `*.` and a name for every host under it. Null
 * for an address, a port, a path, a single label. The sandbox service checks again.
 */
export function hostEntry(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim().toLowerCase().replace(/\.$/, "");
  const name = text.startsWith("*.") ? text.slice(2) : text;
  if (!NAME.test(name) || /^\d+$/.test(name.split(".").at(-1) as string)) return null;
  return text.startsWith("*.") ? `*.${name}` : name;
}

/** The processors a run is allowed (apps/sandbox, `LIMITS.cpus`): what a second of a run is counted as, at most. */
export const SANDBOX_CPUS = 2;

export interface CodeToday {
  runs: number;
  cpuSeconds: number;
  /** 0: no limit. */
  limitRuns: number;
  limitCpuSeconds: number;
}

/** A day's allowance, and whose it is. */
export interface DayLimits {
  runs: number;
  cpuSeconds: number;
  from: "person" | "department" | "everyone" | "server";
}

export class SandboxUse {
  constructor(
    private readonly db: Db,
    private readonly limits: Config["sandboxDaily"],
  ) {}

  /** The hosts an organization's code may reach, and whether they are still the ones it began with. */
  async hosts(orgId: string, db: Queryable = this.db): Promise<{ hosts: string[]; own: boolean }> {
    const row = (
      await db.query<{ hosts: string[] }>("select hosts from sandbox_hosts where org_id = $1", [
        orgId,
      ])
    )[0];
    return row ? { hosts: row.hosts, own: true } : { hosts: [...DEFAULT_HOSTS], own: false };
  }

  /**
   * What one person may run in a day, and whose word that is: their own allowance where
   * an administrator set one, else their department's, else the one set for everyone,
   * else the server's settings (sandboxAdmin.ts keeps them). 0 is no limit.
   */
  async limitsFor(orgId: string, userId: string, db: Queryable = this.db): Promise<DayLimits> {
    const rows = await db.query<{ kind: "person" | "department"; runs: number; cpu: number }>(
      `select l.kind, l.runs, l.cpu_seconds as cpu from sandbox_limits l
        where l.org_id = $1
          and ((l.kind = 'person' and l.subject = $2)
            or (l.kind = 'department' and l.subject = (
                 select m.department_id from memberships m where m.org_id = $1 and m.user_id = $2)))`,
      [orgId, userId],
    );
    for (const kind of ["person", "department"] as const) {
      const row = rows.find((one) => one.kind === kind);
      if (row) return { runs: row.runs, cpuSeconds: row.cpu, from: kind };
    }
    const all = (
      await db.query<{ runs: number | null; cpu: number | null }>(
        "select runs, cpu_seconds as cpu from sandbox_settings where org_id = $1",
        [orgId],
      )
    )[0];
    if (all && all.runs !== null && all.cpu !== null)
      return { runs: all.runs, cpuSeconds: all.cpu, from: "everyone" };
    return { runs: this.limits.runs, cpuSeconds: this.limits.cpuSeconds, from: "server" };
  }

  /**
   * What the agent is told, once, when a conversation's workspace was released since it
   * last ran anything there: said in the result of the run or the opening that finds it
   * empty, never in the agent's instructions (they stay the same from turn to turn).
   */
  async releasedNote(conversationId: string): Promise<string | null> {
    const row = (
      await this.db.query<{ days: number; why: string }>(
        "update sandbox_released set told = true where conversation_id = $1 and not told returning idle_days as days, why",
        [conversationId],
      )
    )[0];
    if (!row) return null;
    const why =
      row.why === "admin"
        ? "was released by an administrator"
        : row.why === "cap"
          ? `was released to make room, after ${row.days} day${row.days === 1 ? "" : "s"} without use (the organization's workspaces were over their cap)`
          : `was released after ${row.days} day${row.days === 1 ? "" : "s"} without use`;
    return `Note: this conversation's working folder ${why}, and starts empty. What earlier runs wrote there is gone; files that were kept are still in the person's files and can be named in "files" again. A repository that was open must be opened again. Say so only if it matters to what is asked.`;
  }

  /** What a person has run today, against what they may. A run under way counts, at the most it can come to. */
  async today(orgId: string, userId: string, db: Queryable = this.db): Promise<CodeToday> {
    const row = (
      await db.query<{ runs: string; cpu: number | null }>(
        `select count(*) as runs, coalesce(sum(cpu_seconds), 0)::float8 as cpu from sandbox_runs
          where org_id = $1 and user_id = $2 and ending <> 'refused'
            and started_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'`,
        [orgId, userId],
      )
    )[0];
    const limits = await this.limitsFor(orgId, userId, db);
    return {
      runs: Number(row?.runs ?? 0),
      cpuSeconds: Math.round(Number(row?.cpu ?? 0)),
      limitRuns: limits.runs,
      limitCpuSeconds: limits.cpuSeconds,
    };
  }

  /**
   * Takes a run's place in the person's day before it starts, or says why it has none.
   *
   * The place is a line written now, counted at the most the run can come to (the time
   * it may take, on every processor it may use), and brought down to what it did come to
   * when it ends (`settle`). One person's reservations are made one at a time (their row
   * is held while the day is counted), so conversations asking at the same moment cannot
   * each see room for the last run. A line left "running" by a server that stopped is
   * closed by `sweep`.
   */
  async reserve(
    at: {
      orgId: string;
      userId: string;
      conversationId: string | null;
      /** Which agent asked, in what language, and in which reply: for whoever reads the runs. */
      agentId?: string | null;
      language?: string | null;
      traceId?: string | null;
    },
    seconds: number,
  ): Promise<{ id: string } | { refused: string }> {
    const most = Math.max(1, seconds) * SANDBOX_CPUS;
    return this.db.tx(async (tx) => {
      await tx.query("select 1 from users where id = $1 for update", [at.userId]);
      const used = await this.today(at.orgId, at.userId, tx);
      const over =
        used.limitRuns > 0 && used.runs >= used.limitRuns
          ? `${used.limitRuns} runs`
          : used.limitCpuSeconds > 0 && used.cpuSeconds >= used.limitCpuSeconds
            ? `${Math.round(used.limitCpuSeconds / 60)} minutes of processor time`
            : null;
      if (over)
        return {
          refused: `Not run: the person has used today's allowance for running code (${over}). It starts again at midnight UTC. Tell them so in a sentence, and that an administrator can raise it; do not try again today.`,
        };
      const id = newId();
      await tx.query(
        `insert into sandbox_runs (id, org_id, user_id, conversation_id, ending, cpu_seconds, agent_id, language, trace_id)
         values ($1, $2, $3, $4, 'running', $5, $6, $7, $8)`,
        [
          id,
          at.orgId,
          at.userId,
          at.conversationId,
          most,
          at.agentId ?? null,
          at.language ?? null,
          at.traceId ?? null,
        ],
      );
      return { id };
    });
  }

  /**
   * Says how a reserved run ended and what it came to. Processor time is the time it
   * took on the sandbox service's clock times the processors it was allowed: the most it
   * can have used. What the code inside says it used is not asked: it could say anything.
   * A run the sandbox would not start ("refused") counts for nothing; every other ending
   * counts, a stopped or broken one too.
   */
  async settle(
    id: string,
    how: {
      ending: "ok" | "failed" | "timeout" | "broke" | "stopped" | "refused";
      /** Seconds it took. For a run that was stopped, by this server's clock. */
      wall: number;
      ran?: SandboxRun;
    },
  ): Promise<void> {
    const net = how.ran?.net ?? [];
    const sum = (pick: (one: (typeof net)[number]) => number) =>
      net.reduce((total, one) => total + (Number(pick(one)) || 0), 0);
    const wall = how.ending === "refused" ? 0 : Math.max(0, Number(how.wall) || 0);
    await this.db.query(
      `update sandbox_runs set ending = $2, seconds = $3, cpu_seconds = least(cpu_seconds, $4),
              bytes_out = $5, net_up = $6, net_down = $7, reached = $8, refused = $9,
              printed = $10, net = $11::jsonb
        where id = $1 and ending = 'running'`,
      [
        id,
        how.ending,
        wall,
        wall * (how.ran?.cpus ?? SANDBOX_CPUS),
        Math.round(how.ran?.bytesOut ?? 0),
        sum((one) => one.up),
        sum((one) => one.down),
        sum((one) => (one.ok ? one.times : 0)),
        sum((one) => (one.ok ? 0 : one.times)),
        (how.ran?.stdout.length ?? 0) + (how.ran?.stderr.length ?? 0),
        // By host, for the page that says which hosts code reached and which it was refused.
        JSON.stringify(
          net.slice(0, 100).map((one) => ({
            host: String(one.host).slice(0, 255),
            ok: one.ok === true,
            times: Number(one.times) || 0,
            up: Number(one.up) || 0,
            down: Number(one.down) || 0,
          })),
        ),
      ],
    );
  }
}

/** How long after the time a run asked for its line may still say "running" (seconds). */
export const LOST_AFTER = 10 * 60;

/**
 * Closes the lines of runs nobody is waiting for any more: a server that stopped while
 * code ran never said how it ended, and its line said "running" for the rest of the day
 * (MUS-53). Once the time such a run asked for is well past, the line is closed as
 * "lost", at the time it asked for on every processor it might have used: nothing better
 * is known, the code may have run all of it, and it is the count the line already held.
 * One statement, which changes a line once: several servers asking at once agree.
 */
export async function sweepSandboxRuns(db: Queryable, now = new Date()): Promise<number> {
  const closed = await db.query(
    `update sandbox_runs
        set ending = 'lost', seconds = cpu_seconds / $2
      where ending = 'running'
        and started_at < $1::timestamptz - ((cpu_seconds / $2 + $3) || ' seconds')::interval
      returning id`,
    [now.toISOString(), SANDBOX_CPUS, LOST_AFTER],
  );
  return closed.length;
}

export function registerSandboxUse(app: Hono<Env>, kit: AppKit, db: Db, use: SandboxUse): void {
  const { need, actorOf, clientIp } = kit;
  const org = (c: Ctx) => c.get("session").org.id;

  // The hosts code may reach: seen with the rest of the settings, changed by who may change them.
  app.get("/api/sandbox/hosts", async (c) => {
    const denied = need(c, "settings.read");
    if (denied) return denied;
    return c.json({
      ...(await use.hosts(org(c))),
      defaults: DEFAULT_HOSTS,
      most: HOSTS_MOST,
      canManage: !need(c, "settings.manage"),
    });
  });

  app.put("/api/sandbox/hosts", async (c) => {
    const denied = need(c, "settings.manage");
    if (denied) return denied;
    const body = z
      .strictObject({ hosts: z.array(z.string().max(300)).max(HOSTS_MOST) })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(c, "invalid_sandbox_host");
    const hosts: string[] = [];
    for (const raw of body.data.hosts) {
      const host = hostEntry(raw);
      // One that is not a host refuses the list: left out in silence, it would look allowed.
      if (!host) return fail(c, "invalid_sandbox_host");
      if (!hosts.includes(host)) hosts.push(host);
    }
    await db.tx(async (tx) => {
      const before = (await use.hosts(org(c), tx)).hosts;
      await tx.query(
        `insert into sandbox_hosts (org_id, hosts, updated_by) values ($1, $2, $3)
         on conflict (org_id) do update set hosts = excluded.hosts, updated_by = excluded.updated_by, updated_at = now()`,
        [org(c), hosts, c.get("session").user.id],
      );
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "sandbox.hosts_changed",
        target: { type: "sandbox", id: org(c), label: `${hosts.length} hosts` },
        detail: { before, after: hosts },
        ip: clientIp(c),
      });
    });
    return c.json({ hosts, own: true });
  });

  // What running code used, by person: beside what agents cost, for those who see that.
  app.get("/api/sandbox/usage", async (c) => {
    const denied = need(c, "console.access");
    if (denied) return denied;
    const ranges: Record<string, number> = { "24h": 1, "7d": 7, "30d": 30, "90d": 90 };
    const range = c.req.query("range") ?? "30d";
    const days = Object.hasOwn(ranges, range) ? ranges[range] : undefined;
    if (!days) return fail(c, "invalid_request");
    const sums = `count(*) filter (where r.ending <> 'refused') as runs,
                  count(*) filter (where r.ending in ('failed', 'timeout', 'broke')) as failed,
                  coalesce(sum(r.cpu_seconds), 0)::float8 as "cpuSeconds",
                  coalesce(sum(r.net_up + r.net_down), 0) as "netBytes",
                  coalesce(sum(r.refused), 0) as refused`;
    const scope = "r.org_id = $1 and r.started_at > now() - ($2 || ' days')::interval";
    const numbers = <T extends Record<string, unknown>>(row: T) => ({
      ...row,
      runs: Number(row.runs),
      failed: Number(row.failed),
      cpuSeconds: Math.round(Number(row.cpuSeconds)),
      netBytes: Number(row.netBytes),
      refused: Number(row.refused),
    });
    const [totals, people] = await Promise.all([
      db.query(`select ${sums} from sandbox_runs r where ${scope}`, [org(c), String(days)]),
      db.query(
        `select u.id, u.name, u.email, ${sums} from sandbox_runs r join users u on u.id = r.user_id
          where ${scope} group by u.id, u.name, u.email order by "cpuSeconds" desc, u.email limit 50`,
        [org(c), String(days)],
      ),
    ]);
    return c.json({
      range,
      totals: numbers(totals[0] ?? { runs: 0, failed: 0, cpuSeconds: 0, netBytes: 0, refused: 0 }),
      people: people.map(numbers),
    });
  });
}
