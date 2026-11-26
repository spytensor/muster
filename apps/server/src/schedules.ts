import { isId, newId } from "@muster/protocol";
import type { Hono } from "hono";
import { z } from "zod";
import { type AppKit, type Ctx, type Env, fail } from "./app.js";
import { recordEvent } from "./audit.js";
import { instant, validZone, wall } from "./clock.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { notify } from "./notices.js";
import { shownSql } from "./runtime/catalog.js";
import { type Runs, titleFrom } from "./runtime/runs.js";
import { mayUseAgent } from "./sharing.js";

/**
 * Scheduled work: a message a person has an agent answer at set times, without asking
 * each time. A run is the person's own, through the same gateway as any conversation:
 * nothing outward happens unattended. See docs/features/marketplace.md, section 10.
 */
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const Cadence = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("once"),
    // A day of the calendar: 2027-02-31 is not one.
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine(
        (day) =>
          !Number.isNaN(Date.parse(`${day}T00:00:00Z`)) &&
          new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day,
      ),
    time: z.string().regex(TIME),
  }),
  z.strictObject({ kind: z.literal("daily"), time: z.string().regex(TIME) }),
  // 0 is Sunday.
  z.strictObject({
    kind: z.literal("weekly"),
    day: z.number().int().min(0).max(6),
    time: z.string().regex(TIME),
  }),
  // A day the month does not have means its last day.
  z.strictObject({
    kind: z.literal("monthly"),
    day: z.number().int().min(1).max(31),
    time: z.string().regex(TIME),
  }),
]);
export type Cadence = z.infer<typeof Cadence>;
const MAX_SCHEDULES = 20;
const MAX_FAILURES = 3;

/** When a schedule runs next after a moment, in the time zone it was set in. Null when it never will. */
export function nextRun(cadence: Cadence, zone: string, after: Date): Date | null {
  const [hh, mm] = cadence.time.split(":").map(Number) as [number, number];
  if (cadence.kind === "once") {
    const [y, m, d] = cadence.date.split("-").map(Number) as [number, number, number];
    const at = instant(y, m, d, hh, mm, zone);
    return at > after ? at : null;
  }
  const start = wall(after, zone);
  // Day by day from today, as the calendar of that zone counts them.
  for (let step = 0; step < 400; step++) {
    const day = new Date(Date.UTC(start.year, start.month - 1, start.day + step));
    const [y, m, d] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()];
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const due =
      cadence.kind === "daily" ||
      (cadence.kind === "weekly" && day.getUTCDay() === cadence.day) ||
      (cadence.kind === "monthly" && d === Math.min(cadence.day, last));
    if (!due) continue;
    const at = instant(y, m, d, hh, mm, zone);
    if (at > after) return at;
  }
  return null;
}

type Due = {
  id: string;
  org_id: string;
  user_id: string;
  email: string;
  agent_id: string;
  conversation_id: string;
  title: string;
  prompt: string;
  cadence: Cadence;
  timezone: string;
  failures: number;
  next_run_at: Date | null;
};

/** What became of one attempt to run a schedule. */
export type Ran = "started" | "busy" | { failed: string };

export class Scheduler {
  /** Runs under way, so a test or a shutdown can wait for what they leave on record. */
  private readonly watching = new Set<Promise<void>>();
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly runs: Runs,
  ) {}

  /** Starts every schedule that is due. Called by one loop in the server, and by "run now". */
  async tick(now = new Date(), only?: string): Promise<Ran | undefined> {
    let last: Ran | undefined;
    const due = await this.db.query<Due>(
      `select s.id, s.org_id, s.user_id, u.email, s.agent_id, s.conversation_id, s.title, s.prompt, s.cadence, s.timezone, s.failures, s.next_run_at
         from schedules s join users u on u.id = s.user_id
         join memberships m on m.user_id = s.user_id and m.org_id = s.org_id and m.status = 'active'
        where ${only ? "s.id = $1" : "not s.paused and s.next_run_at <= $1"}
        order by s.next_run_at nulls last limit 50`,
      [only ?? now],
    );
    for (const schedule of due)
      try {
        last = await this.run(schedule, now, Boolean(only));
      } catch (error) {
        // One schedule that cannot start does not hold up the rest, and does not try again
        // every half minute: it counts as a failure like any other.
        console.error("a scheduled run could not start:", error);
        await this.db
          .query(
            "update schedules set last_status = 'failed', last_detail = $2, failures = failures + 1, paused = paused or failures + 1 >= $3 where id = $1",
            [schedule.id, "It could not be started.", MAX_FAILURES],
          )
          .catch(() => undefined);
        last = { failed: "It could not be started." };
      }
    return last;
  }

  /** Whether a schedule's conversation has a run under way. */
  busy(conversationId: string): boolean {
    return this.runs.running(conversationId);
  }
  /** Runs one schedule now, whatever its times say. */
  now(id: string): Promise<Ran | undefined> {
    return this.tick(new Date(), id);
  }

  private async run(schedule: Due, now: Date, asked: boolean): Promise<Ran> {
    const at = { orgId: schedule.org_id, userIds: [schedule.user_id] };
    // Read when a notice is written: the schedule may be given a new conversation below.
    const link = () => `c/${schedule.conversation_id}`;
    // When it is next due, whatever happens to this run. A one-off has no next time.
    // Run by hand, its times stay as they were.
    const next = asked
      ? ((
          await this.db.query<{ at: Date | null }>(
            "select next_run_at as at from schedules where id = $1",
            [schedule.id],
          )
        )[0]?.at ?? null)
      : nextRun(schedule.cadence, schedule.timezone, now);
    const ends = !asked && next === null;
    // Claimed before anything starts: a second tick that saw the same due time finds it moved.
    if (!asked) {
      const claimed = await this.db.query(
        "update schedules set next_run_at = $2 where id = $1 and not paused and next_run_at is not distinct from $3 returning id",
        [schedule.id, next, schedule.next_run_at],
      );
      if (claimed.length === 0) return "busy";
    }
    const fail = async (why: string): Promise<Ran> => {
      const failures = schedule.failures + 1;
      const paused = failures >= MAX_FAILURES || ends;
      await this.db.query(
        "update schedules set next_run_at = $2, last_run_at = $3, last_status = 'failed', last_detail = $4, failures = $5, paused = paused or $6 where id = $1",
        [schedule.id, next, now, why, failures, paused],
      );
      await notify(
        this.db,
        at,
        "schedule_failed",
        {
          name: schedule.title,
          reason:
            failures >= MAX_FAILURES
              ? `${why} Paused after ${MAX_FAILURES} failures in a row.`
              : why,
        },
        "schedules",
      );
      return { failed: why } as Ran;
    };
    if (!(await mayUseAgent(this.db, schedule.org_id, schedule.user_id, schedule.agent_id)))
      return fail("Its agent is no longer yours to use.");
    // Its conversation was deleted: it gets a new one and goes on.
    const there = await this.db.query(
      "select 1 from conversations where id = $1 and archived_at is null",
      [schedule.conversation_id],
    );
    if (there.length === 0) {
      const fresh = newId();
      await this.db.query(
        "insert into conversations (id, org_id, user_id, agent_id, title) values ($1, $2, $3, $4, $5)",
        [fresh, schedule.org_id, schedule.user_id, schedule.agent_id, schedule.title],
      );
      await this.db.query("update schedules set conversation_id = $2 where id = $1", [
        schedule.id,
        fresh,
      ]);
      schedule.conversation_id = fresh;
    }
    // The organization's daily allowance holds for unattended work too.
    if (
      this.config.dailyTokensPerUser > 0 &&
      (await this.runs.usedToday(schedule.org_id, schedule.user_id)) >=
        this.config.dailyTokensPerUser
    )
      return fail("Today's allowance was used up.");
    if (await this.runs.budgets.reached(schedule.org_id, schedule.user_id))
      return fail("This month's budget for agents was used up.");
    const started = await this.runs.start({
      conversationId: schedule.conversation_id,
      orgId: schedule.org_id,
      user: { id: schedule.user_id, email: schedule.email },
      content: schedule.prompt,
      agentId: schedule.agent_id,
    });
    // Its conversation is still busy with the last run: this time is passed over.
    if (started === "busy") return "busy";
    if (started === "unavailable" || started === "nothing" || started === "closed")
      return fail("No agent could be started.");
    await this.db.query(
      "update schedules set next_run_at = $2, last_run_at = $3, last_status = 'running', last_detail = '', paused = paused or $4 where id = $1",
      [schedule.id, next, now, ends],
    );
    const messageId = started.assistantMessage.id;
    const watch = (async () => {
      await this.runs.settled(schedule.conversation_id);
      const ended = (
        await this.db.query<{ status: string; ending: string | null; detail: string | null }>(
          "select status, ending, ending_detail as detail from messages where id = $1",
          [messageId],
        )
      )[0];
      if (ended?.status === "complete" && ended.ending !== "error") {
        await this.db.query("update schedules set last_status = 'ok', failures = 0 where id = $1", [
          schedule.id,
        ]);
        await notify(this.db, at, "schedule_done", { name: schedule.title }, link());
        return;
      }
      const failures = schedule.failures + 1;
      const why =
        ended?.status === "stopped"
          ? "It was stopped, or it waited for your confirmation and none came."
          : (ended?.detail ?? "The reply did not finish.");
      await this.db.query(
        "update schedules set last_status = 'failed', last_detail = $2, failures = $3, paused = paused or $4 where id = $1",
        [schedule.id, why, failures, failures >= MAX_FAILURES],
      );
      await notify(
        this.db,
        at,
        "schedule_failed",
        {
          name: schedule.title,
          reason:
            failures >= MAX_FAILURES
              ? `${why} Paused after ${MAX_FAILURES} failures in a row.`
              : why,
        },
        link(),
      );
    })().catch((error) => console.error("recording a scheduled run failed:", error));
    this.watching.add(watch);
    void watch.finally(() => this.watching.delete(watch));
    return "started";
  }

  /** Waits until every run started so far is on record. */
  async idle(): Promise<void> {
    await Promise.all([...this.watching]);
  }
}

const Body = z.strictObject({
  title: z.string().trim().max(80).default(""),
  prompt: z.string().trim().min(1).max(4000),
  agentId: z.string().refine(isId),
  cadence: Cadence,
  timezone: z.string().max(64).refine(validZone),
});

export function registerSchedules(app: Hono<Env>, kit: AppKit, db: Db, scheduler: Scheduler): void {
  const { actorOf, clientIp, need } = kit;
  const org = (c: Ctx) => c.get("session").org.id;
  const me = (c: Ctx) => c.get("session").user.id;
  const COLUMNS = `s.id, s.title, s.prompt, s.cadence, s.timezone, s.paused, s.failures,
    s.next_run_at as "nextRunAt", s.last_run_at as "lastRunAt", s.last_status as "lastStatus", s.last_detail as "lastDetail",
    s.conversation_id as "conversationId", s.agent_id as "agentId", ${shownSql("a")} as "agentName"`;

  // Someone suspended or removed has nothing running for them, on a schedule or otherwise.
  kit.onMemberBlocked(async (userId) => {
    await db.query("update schedules set paused = true where user_id = $1", [userId]);
  });

  app.get("/api/app/schedules", async (c) =>
    c.json(
      await db.query(
        `select ${COLUMNS} from schedules s join agents a on a.id = s.agent_id
          where s.org_id = $1 and s.user_id = $2 order by s.paused, s.next_run_at nulls last, s.title`,
        [org(c), me(c)],
      ),
    ),
  );

  app.post("/api/app/schedules", async (c) => {
    const parsed = Body.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, "invalid_schedule");
    const body = parsed.data;
    if (!(await mayUseAgent(db, org(c), me(c), body.agentId))) return fail(c, "agent_unavailable");
    const next = nextRun(body.cadence, body.timezone, new Date());
    // A one-off set for a moment that has passed would never run.
    if (!next) return fail(c, "invalid_schedule");
    const held = await db.query("select 1 from schedules where org_id = $1 and user_id = $2", [
      org(c),
      me(c),
    ]);
    if (held.length >= MAX_SCHEDULES) return fail(c, "too_many_schedules");
    const id = newId();
    const conversation = newId();
    const title = body.title || titleFrom(body.prompt);
    await db.tx(async (tx) => {
      // Its own conversation: every run adds to it, and asks there when it must.
      await tx.query(
        "insert into conversations (id, org_id, user_id, agent_id, title) values ($1, $2, $3, $4, $5)",
        [conversation, org(c), me(c), body.agentId, title],
      );
      await tx.query(
        `insert into schedules (id, org_id, user_id, agent_id, conversation_id, title, prompt, cadence, timezone, next_run_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
        [
          id,
          org(c),
          me(c),
          body.agentId,
          conversation,
          title,
          body.prompt,
          JSON.stringify(body.cadence),
          body.timezone,
          next,
        ],
      );
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "schedule.created",
        target: { type: "schedule", id, label: title },
        detail: { cadence: body.cadence, timezone: body.timezone, agentId: body.agentId },
        ip: clientIp(c),
      });
    });
    return c.json({ id, conversationId: conversation, nextRunAt: next });
  });

  const mine = async (c: Ctx) => {
    const id = c.req.param("id") ?? "";
    if (!isId(id)) return null;
    return (
      (
        await db.query<{
          id: string;
          title: string;
          cadence: Cadence;
          timezone: string;
          conversation_id: string;
        }>(
          "select id, title, cadence, timezone, conversation_id from schedules where id = $1 and org_id = $2 and user_id = $3",
          [id, org(c), me(c)],
        )
      )[0] ?? null
    );
  };

  app.patch("/api/app/schedules/:id", async (c) => {
    const schedule = await mine(c);
    const parsed = Body.partial()
      .extend({ paused: z.boolean().optional() })
      .safeParse(await c.req.json().catch(() => null));
    if (!schedule) return fail(c, "not_found");
    if (!parsed.success) return fail(c, "invalid_schedule");
    const body = parsed.data;
    if (body.agentId && !(await mayUseAgent(db, org(c), me(c), body.agentId)))
      return fail(c, "agent_unavailable");
    const cadence = body.cadence ?? schedule.cadence;
    const timezone = body.timezone ?? schedule.timezone;
    const next = nextRun(cadence, timezone, new Date());
    // A one-off that has run has no next time. Its name and what it asks can still be
    // changed; only giving it a time that has passed, or resuming it, is refused.
    const retimed = body.cadence !== undefined || body.timezone !== undefined;
    if (!next && (retimed || body.paused === false)) return fail(c, "invalid_schedule");
    await db.query(
      `update schedules set title = coalesce($2::text, title), prompt = coalesce($3::text, prompt),
              agent_id = coalesce($4::uuid, agent_id), cadence = $5::jsonb, timezone = $6, next_run_at = $7,
              paused = coalesce($8::boolean, paused),
              failures = case when $8::boolean = false then 0 else failures end
        where id = $1`,
      [
        schedule.id,
        body.title || null,
        body.prompt ?? null,
        body.agentId ?? null,
        JSON.stringify(cadence),
        timezone,
        next,
        body.paused ?? null,
      ],
    );
    await recordEvent(db, {
      orgId: org(c),
      actor: actorOf(c),
      action: "schedule.changed",
      target: { type: "schedule", id: schedule.id, label: body.title || schedule.title },
      detail: { ...(body.paused === undefined ? {} : { paused: body.paused }), cadence, timezone },
      ip: clientIp(c),
    });
    return c.json({ ok: true, nextRunAt: next });
  });

  // Runs it once now, whatever its times say. Its times stay as they are.
  app.post("/api/app/schedules/:id/run", async (c) => {
    const schedule = await mine(c);
    if (!schedule) return fail(c, "not_found");
    if (scheduler.busy(schedule.conversation_id)) return fail(c, "run_in_progress");
    const ran = await scheduler.now(schedule.id);
    // Said from what this call did, not from what an earlier run left behind.
    if (ran === "busy" || ran === undefined) return fail(c, "run_in_progress");
    if (ran !== "started")
      return c.json({ error: { code: "schedule_not_started", message: ran.failed } }, 409);
    const after = (
      await db.query<{ conversation: string }>(
        "select conversation_id as conversation from schedules where id = $1",
        [schedule.id],
      )
    )[0];
    return c.json({ ok: true, conversationId: after?.conversation ?? schedule.conversation_id });
  });

  app.delete("/api/app/schedules/:id", async (c) => {
    const schedule = await mine(c);
    if (!schedule) return fail(c, "not_found");
    // What it did stays in its conversation; only the schedule goes.
    await db.query("delete from schedules where id = $1", [schedule.id]);
    await recordEvent(db, {
      orgId: org(c),
      actor: actorOf(c),
      action: "schedule.deleted",
      target: { type: "schedule", id: schedule.id, label: schedule.title },
      ip: clientIp(c),
    });
    return c.json({ ok: true });
  });

  // For those who run the organization: every schedule, without what it asks.
  app.get("/api/schedules", async (c) => {
    const denied = need(c, "agents.read");
    if (denied) return denied;
    return c.json(
      await db.query(
        `select s.id, s.title, s.cadence, s.timezone, s.paused, s.failures, s.next_run_at as "nextRunAt",
                s.last_run_at as "lastRunAt", s.last_status as "lastStatus", ${shownSql("a")} as "agentName",
                u.name as "userName", u.email as "userEmail"
           from schedules s join agents a on a.id = s.agent_id join users u on u.id = s.user_id
          where s.org_id = $1 order by s.paused, s.next_run_at nulls last`,
        [org(c)],
      ),
    );
  });
  app.post("/api/schedules/:id/pause", async (c) => {
    const denied = need(c, "agents.manage");
    if (denied) return denied;
    const id = c.req.param("id");
    const paused = isId(id)
      ? await db.query<{ title: string; user_id: string }>(
          "update schedules set paused = true, last_detail = 'Paused by an administrator.' where id = $1 and org_id = $2 returning title, user_id",
          [id, org(c)],
        )
      : [];
    if (!paused[0]) return fail(c, "not_found");
    // Its owner is told: it would otherwise simply stop running.
    await notify(
      db,
      { orgId: org(c), userIds: [paused[0].user_id] },
      "schedule_paused",
      { name: paused[0].title, by: actorOf(c).email },
      "schedules",
    );
    await recordEvent(db, {
      orgId: org(c),
      actor: actorOf(c),
      action: "schedule.paused",
      target: { type: "schedule", id, label: paused[0].title },
      detail: { by: "administrator", userId: paused[0].user_id },
      ip: clientIp(c),
    });
    return c.json({ ok: true });
  });
}

/** See schema.ts, migration 18. */
export const SCHEDULES_SCHEMA = [
  `create table schedules (
    id uuid primary key,
    org_id uuid not null references organizations(id) on delete cascade,
    user_id uuid not null references users(id) on delete cascade,
    agent_id uuid not null references agents(id) on delete cascade,
    conversation_id uuid not null references conversations(id) on delete cascade,
    title text not null,
    prompt text not null,
    cadence jsonb not null,
    timezone text not null,
    next_run_at timestamptz,
    paused boolean not null default false,
    failures integer not null default 0,
    last_run_at timestamptz,
    last_status text,
    last_detail text not null default '',
    created_at timestamptz not null default now()
  )`,
  `create index schedules_due on schedules (next_run_at) where not paused`,
];
