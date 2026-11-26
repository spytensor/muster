import { createHmac, randomBytes } from "node:crypto";
import { isId, newId } from "@muster/protocol";
import type { Hono } from "hono";
import { z } from "zod";
import { type AppKit, type Ctx, type Env, fail } from "./app.js";
import { recordEvent } from "./audit.js";
import type { Config } from "./config.js";
import { openText, sealText } from "./connections.js";
import type { Db, Queryable } from "./db.js";
import { Refusal } from "./errors.js";
import { notify } from "./notices.js";
import { shownSql } from "./runtime/catalog.js";
import { checkUrl, type Net, NetError, publicNet } from "./runtime/net.js";
import type { Sandbox } from "./sandbox.js";

/**
 * Alerts: what those who run the organization should be told without having to look.
 * A handful of rules, each a question asked of what is already recorded (runs, steps,
 * submissions, the sandbox). While the answer is yes there is one alert for it; when the
 * answer turns to no the alert resolves by itself. See docs/features/admin-console.md,
 * "Alerts".
 */

/** Windows a rule can look back over, in minutes: the ranges the Traces page can show. */
export const WINDOWS = [15, 60, 720, 1440] as const;

interface RuleShape {
  /** What the threshold counts, for the page's wording and its limits. */
  threshold: number;
  min: number;
  max: number;
  /** Minutes looked back over. Null where the rule has no window of its own. */
  window: (typeof WINDOWS)[number] | null;
}

export const RULES = {
  /** The share of runs that failed, in percent, once there are RUNS_NEEDED of them. */
  run_failures: { threshold: 20, min: 1, max: 100, window: 60 },
  /** Actions refused for one person, or for one agent across several people. */
  blocked_actions: { threshold: 5, min: 2, max: 1000, window: 60 },
  /** The last 24 hours' spend as a multiple of a usual day (the 7 days before). */
  spend_spike: { threshold: 3, min: 1.5, max: 100, window: null },
  /** Hours a submission to the marketplace has waited for a decision. */
  approval_waiting: { threshold: 24, min: 1, max: 720, window: null },
  /** Minutes the sandbox has not been ready to run code. */
  sandbox_down: { threshold: 10, min: 1, max: 1440, window: null },
  /** Model calls that failed, per model. */
  model_failing: { threshold: 5, min: 1, max: 1000, window: 15 },
} as const satisfies Record<string, RuleShape>;
export type Rule = keyof typeof RULES;
const RULE_IDS = Object.keys(RULES) as Rule[];

/** A failure rate says nothing until there are this many runs to take it of. */
export const RUNS_NEEDED = 10;
/** A spike is not told of below this much in a day (one unit of the currency prices are in). */
export const SPEND_FLOOR_MICROS = 1_000_000;
/** How many times a webhook is tried, and how long after each failure the next try is. */
export const ATTEMPTS = 5;
const BACKOFF_MINUTES = [1, 5, 30, 120];
/** An alert resolves once what it is about has not been so for this long: a few checks in a row. */
export const CLEAR_MINUTES = 3;
/** The same thing so again within this long of resolving is the same alert, opened again and not told of twice. */
export const REOPEN_MINUTES = 60;
/** Spending is summed over eight days, so it is asked about once an hour and not every minute. */
export const SPEND_EVERY_MINUTES = 60;
/**
 * Refusals that are not the organization's policy saying no: while a plan is being made
 * nothing is changed, by design (runtime/planning.ts). An approval the person declined or
 * let pass is not counted either: that is an "approval" step, never a "policy" one.
 */
const NOT_REFUSALS = ["plan-mode", "plan-not-shown"];

interface RuleSetting {
  rule: Rule;
  enabled: boolean;
  threshold: number;
  window: number | null;
}

/** One thing a rule says is so right now. `subject` tells two of the same rule apart. */
interface Firing {
  subject: string;
  label: string;
  detail: Record<string, string | number | null>;
}

const iso = (at: Date) => at.toISOString();

export class Alerts {
  private readonly net: Net;
  private readonly sandbox: Sandbox | null;

  constructor(
    private readonly db: Db,
    private readonly config: Pick<Config, "secretKey" | "publicUrl">,
    options: { sandbox?: Sandbox | null; net?: Net } = {},
  ) {
    this.sandbox = options.sandbox ?? null;
    this.net = options.net ?? publicNet;
  }

  get canSeal(): boolean {
    return Boolean(this.config.secretKey);
  }
  /** Seals a webhook's secret with the server's key, which no page is ever given. */
  seal(text: string): string {
    return sealText(this.config.secretKey, text);
  }
  get hasSandbox(): boolean {
    return this.sandbox !== null;
  }

  /** Every rule as it stands for an organization: what was set, or how it comes. */
  async rules(db: Queryable, orgId: string): Promise<RuleSetting[]> {
    const set = await db.query<{
      rule: string;
      enabled: boolean;
      threshold: string | number;
      window_minutes: number | null;
    }>("select rule, enabled, threshold, window_minutes from alert_rules where org_id = $1", [
      orgId,
    ]);
    return RULE_IDS.map((rule) => {
      const own = set.find((row) => row.rule === rule);
      const shape: RuleShape = RULES[rule];
      return {
        rule,
        enabled: own?.enabled ?? true,
        threshold: own ? Number(own.threshold) : shape.threshold,
        window: shape.window === null ? null : (own?.window_minutes ?? shape.window),
      };
    });
  }

  /**
   * Asks every rule of every organization, opens what is newly so, resolves what no
   * longer is, then sends what is waiting to be sent. Safe to run in several processes at
   * once: an alert is opened by whichever insert wins, and only that one tells anyone.
   */
  async tick(now = new Date()): Promise<void> {
    await this.markSandbox(now);
    const orgs = await this.db.query<{ id: string; name: string }>(
      "select id, name from organizations",
    );
    for (const org of orgs) {
      for (const setting of await this.rules(this.db, org.id)) {
        let firing: Firing[];
        try {
          if (
            setting.rule === "spend_spike" &&
            setting.enabled &&
            !(await this.due(`spend:${org.id}`, SPEND_EVERY_MINUTES, now))
          )
            continue;
          firing = setting.enabled ? await this.ask(org.id, setting, now) : [];
        } catch (error) {
          // A rule that could not be asked says nothing: what is open stays open.
          console.error(`alert rule ${setting.rule} could not be checked:`, error);
          continue;
        }
        for (const one of firing) await this.open(org, setting.rule, one, now);
        await this.resolveOthers(
          org,
          setting.rule,
          firing.map((one) => one.subject),
          now,
          // Switched off, there is nothing to wait for.
          !setting.enabled,
        );
      }
    }
    await this.deliver(now);
    // What was sent, or given up on, is kept a month; a resolved alert, three.
    await this.db.query(
      "delete from alert_deliveries where status <> 'pending' and created_at < $1::timestamptz - interval '30 days'",
      [iso(now)],
    );
    await this.db.query(
      "delete from alerts where state = 'resolved' and resolved_at < $1::timestamptz - interval '90 days'",
      [iso(now)],
    );
  }

  /**
   * Whether the sandbox is ready is written down where every process reads it: since when
   * it has been away is the same after a restart, and for two servers at once.
   */
  private async markSandbox(now: Date): Promise<void> {
    if (!this.sandbox) return;
    const health = await this.sandbox.health().catch(() => null);
    if (health?.ready) await this.db.query("delete from alert_marks where key = 'sandbox_down'");
    else
      await this.db.query(
        "insert into alert_marks (key, since) values ('sandbox_down', $1) on conflict (key) do nothing",
        [iso(now)],
      );
  }

  /** True once in every `minutes` for a key, whichever process asks first. */
  private async due(key: string, minutes: number, now: Date): Promise<boolean> {
    const mine = await this.db.query(
      `insert into alert_marks (key, since) values ($1, $2)
       on conflict (key) do update set since = excluded.since
         where alert_marks.since <= $2::timestamptz - ($3 || ' minutes')::interval
       returning key`,
      [key, iso(now), String(minutes)],
    );
    return mine.length > 0;
  }

  /** A rule changed is asked about at once, not at its next turn. */
  async askSoon(db: Queryable, orgId: string): Promise<void> {
    await db.query("delete from alert_marks where key = $1", [`spend:${orgId}`]);
  }

  /**
   * For something another part of the server finds out for itself (the activity log's
   * chain not holding, say): opens an alert for it, or brings the open one up to date.
   * It is told of once, like any other, and stays until `clear` is called for it. Such a
   * rule has no setting and is not one the timer asks about.
   */
  async raise(
    orgId: string,
    rule: string,
    subject: string,
    detail: Record<string, string | number | null> = {},
    label = "",
    now = new Date(),
  ): Promise<void> {
    if ((RULE_IDS as string[]).includes(rule))
      throw new Error(`${rule} is asked about by the timer and cannot be raised by hand`);
    const org = await this.orgOf(orgId);
    if (org) await this.open(org, rule, { subject, label, detail }, now);
  }

  /** What `raise` said is no longer so. Without a subject, everything of that rule. */
  async clear(orgId: string, rule: string, subject?: string, now = new Date()): Promise<void> {
    if ((RULE_IDS as string[]).includes(rule))
      throw new Error(`${rule} is asked about by the timer and cannot be cleared by hand`);
    const org = await this.orgOf(orgId);
    if (!org) return;
    await this.db.tx(async (tx) => {
      const gone = await tx.query<{ id: string }>(
        `update alerts set state = 'resolved', resolved_at = $3, clear_since = null
          where org_id = $1 and rule = $2 and state <> 'resolved' and ($4::text is null or subject = $4)
          returning id`,
        [orgId, rule, iso(now), subject ?? null],
      );
      for (const row of gone) await this.queue(tx, org, row.id, "alert.resolved", now);
    });
  }

  private async orgOf(orgId: string) {
    return (
      await this.db.query<{ id: string; name: string }>(
        "select id, name from organizations where id = $1",
        [orgId],
      )
    )[0];
  }

  private async ask(orgId: string, setting: RuleSetting, now: Date): Promise<Firing[]> {
    const at = iso(now);
    const window = String(setting.window ?? 0);
    const within =
      "t.org_id = $1 and t.started_at <= $2::timestamptz and t.started_at > $2::timestamptz - ($3 || ' minutes')::interval";
    switch (setting.rule) {
      case "run_failures": {
        const row = (
          await this.db.query<{ runs: number; errors: number }>(
            `select count(*)::int as runs, (count(*) filter (where t.status = 'error'))::int as errors
               from traces t where ${within}`,
            [orgId, at, window],
          )
        )[0];
        const runs = row?.runs ?? 0;
        const errors = row?.errors ?? 0;
        if (runs < RUNS_NEEDED || errors * 100 < setting.threshold * runs) return [];
        return [
          {
            subject: "",
            label: "",
            detail: {
              runs,
              errors,
              percent: Math.round((errors * 100) / runs),
              window: setting.window,
            },
          },
        ];
      }
      case "blocked_actions": {
        // The gateway writes one "policy" step for every call it judges, with the rule
        // that decided it. Only those that said no count here.
        const refused =
          "s.kind = 'policy' and s.status = 'blocked' and not (coalesce(s.attributes->>'policyId', '') = any($5::text[]))";
        const people = await this.db.query<{
          id: string;
          name: string;
          email: string;
          n: number;
        }>(
          `select u.id, u.name, u.email, count(*)::int as n
             from spans s join traces t on t.id = s.trace_id join users u on u.id = t.user_id
            where ${within} and ${refused}
            group by u.id, u.name, u.email having count(*) >= $4::numeric`,
          [orgId, at, window, setting.threshold, NOT_REFUSALS],
        );
        // An agent refused for several people is the agent's doing, not any one person's.
        const agents = await this.db.query<{ id: string; name: string; n: number; people: number }>(
          `select a.id, ${shownSql("a")} as name, count(*)::int as n, count(distinct t.user_id)::int as people
             from spans s join traces t on t.id = s.trace_id join agents a on a.id = t.agent_id
            where ${within} and ${refused}
            group by a.id having count(*) >= $4::numeric and count(distinct t.user_id) >= 2`,
          [orgId, at, window, setting.threshold, NOT_REFUSALS],
        );
        return [
          ...people.map((row) => ({
            subject: `user:${row.id}`,
            label: row.name || row.email,
            detail: {
              count: row.n,
              window: setting.window,
              who: "person",
              name: row.name,
              email: row.email,
            },
          })),
          ...agents.map((row) => ({
            subject: `agent:${row.id}`,
            label: row.name,
            detail: {
              count: row.n,
              window: setting.window,
              who: "agent",
              agentId: row.id,
              people: row.people,
            },
          })),
        ];
      }
      case "spend_spike": {
        const row = (
          await this.db.query<{ today: string; before: string; days: number }>(
            `select coalesce(sum(t.cost_micros) filter (where t.started_at > $2::timestamptz - interval '24 hours'), 0) as today,
                    coalesce(sum(t.cost_micros) filter (where t.started_at <= $2::timestamptz - interval '24 hours'), 0) as before,
                    (count(distinct date_trunc('day', t.started_at)) filter (where t.started_at <= $2::timestamptz - interval '24 hours' and t.cost_micros > 0))::int as days
               from traces t
              where t.org_id = $1 and t.started_at <= $2::timestamptz and t.started_at > $2::timestamptz - interval '8 days'`,
            [orgId, at],
          )
        )[0];
        const today = Number(row?.today ?? 0);
        const usual = Number(row?.before ?? 0) / 7;
        // With fewer than three days of spending behind it, there is no usual day yet.
        if ((row?.days ?? 0) < 3 || usual <= 0) return [];
        if (today < SPEND_FLOOR_MICROS || today < setting.threshold * usual) return [];
        return [
          {
            subject: "",
            label: "",
            detail: {
              todayMicros: today,
              usualMicros: Math.round(usual),
              times: Math.round((today / usual) * 10) / 10,
            },
          },
        ];
      }
      case "approval_waiting": {
        const rows = await this.db.query<{
          kind: string;
          id: string;
          name: string;
          submitted: Date | string;
        }>(
          `select l.kind, l.item_id as id, i.name, l.submitted_at as submitted
             from listings l join (
               select 'agent' as kind, id, name from agents where deleted_at is null
               union all select 'skill', id, name from skills where deleted_at is null
               union all select 'knowledge', id, name from knowledge_bases where deleted_at is null
             ) i on i.kind = l.kind and i.id = l.item_id
            where l.org_id = $1 and l.state = 'pending'
              and l.submitted_at <= $2::timestamptz - ($3 || ' hours')::interval`,
          [orgId, at, String(setting.threshold)],
        );
        return rows.map((row) => ({
          subject: `${row.kind}:${row.id}`,
          label: row.name,
          detail: {
            kind: row.kind,
            hours: Math.floor((now.getTime() - new Date(row.submitted).getTime()) / 3_600_000),
          },
        }));
      }
      case "sandbox_down": {
        const mark = (
          await this.db.query<{ since: Date | string }>(
            "select since from alert_marks where key = 'sandbox_down'",
          )
        )[0];
        const since = mark ? new Date(mark.since) : null;
        if (!since || now.getTime() - since.getTime() < setting.threshold * 60_000) return [];
        return [
          {
            subject: "",
            label: "",
            detail: { minutes: Math.floor((now.getTime() - since.getTime()) / 60_000) },
          },
        ];
      }
      case "model_failing": {
        const rows = await this.db.query<{ model: string | null; errors: number; calls: number }>(
          `select s.attributes->>'model' as model, (count(*) filter (where s.status = 'error'))::int as errors,
                  count(*)::int as calls
             from spans s join traces t on t.id = s.trace_id
            where ${within} and s.kind = 'llm'
            group by 1 having count(*) filter (where s.status = 'error') >= $4::numeric`,
          [orgId, at, window, setting.threshold],
        );
        return rows.map((row) => ({
          subject: row.model ?? "",
          label: row.model ?? "",
          detail: { errors: row.errors, calls: row.calls, window: setting.window },
        }));
      }
    }
  }

  private async open(
    org: { id: string; name: string },
    rule: string,
    firing: Firing,
    now: Date,
  ): Promise<void> {
    await this.db.tx(async (tx) => {
      const detail = JSON.stringify(firing.detail);
      const known = await tx.query(
        `update alerts set seen_at = $4, detail = $5::jsonb, label = $6, clear_since = null
          where org_id = $1 and rule = $2 and subject = $3 and state <> 'resolved' returning id`,
        [org.id, rule, firing.subject, iso(now), detail, firing.label],
      );
      if (known.length > 0) return;
      // So again soon after it stopped: the same alert, opened again as it was left. Nobody
      // is told a second time of something that comes and goes.
      const again = await tx.query(
        `update alerts set state = case when acknowledged_at is null then 'open' else 'acknowledged' end,
                resolved_at = null, clear_since = null, seen_at = $4, detail = $5::jsonb, label = $6
          where id = (select id from alerts
                       where org_id = $1 and rule = $2 and subject = $3 and state = 'resolved'
                         and resolved_at > $4::timestamptz - ($7 || ' minutes')::interval
                       order by resolved_at desc limit 1 for update skip locked)
            and state = 'resolved' returning id`,
        [org.id, rule, firing.subject, iso(now), detail, firing.label, String(REOPEN_MINUTES)],
      );
      if (again.length > 0) return;
      const id = newId();
      // The index allows one alert that is not resolved for each rule and subject: of two
      // processes asking at once, one opens it and the other finds it open.
      const fresh = await tx.query(
        `insert into alerts (id, org_id, rule, subject, label, detail, opened_at, seen_at)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7, $7)
         on conflict (org_id, rule, subject) where state <> 'resolved' do nothing returning id`,
        [id, org.id, rule, firing.subject, firing.label, detail, iso(now)],
      );
      if (fresh.length === 0) return;
      const admins = await tx.query<{ user_id: string }>(
        "select user_id from memberships where org_id = $1 and status = 'active' and role in ('owner', 'admin')",
        [org.id],
      );
      await notify(
        tx,
        { orgId: org.id, userIds: admins.map((row) => row.user_id) },
        "alert",
        { rule, name: firing.label || null },
        "admin/alerts",
      );
      await this.queue(tx, org, id, "alert.opened", now);
    });
  }

  private async resolveOthers(
    org: { id: string; name: string },
    rule: Rule,
    still: string[],
    now: Date,
    atOnce = false,
  ): Promise<void> {
    await this.db.tx(async (tx) => {
      // Not so right now is noted, and resolved only when it has stayed that way: a rate
      // that dips under its threshold for one minute has not gone away.
      await tx.query(
        `update alerts set clear_since = $3
          where org_id = $1 and rule = $2 and state <> 'resolved' and clear_since is null
            and not (subject = any($4::text[]))`,
        [org.id, rule, iso(now), still],
      );
      const gone = await tx.query<{ id: string }>(
        `update alerts set state = 'resolved', resolved_at = $3, clear_since = null
          where org_id = $1 and rule = $2 and state <> 'resolved' and not (subject = any($4::text[]))
            and ($5 or clear_since <= $3::timestamptz - ($6 || ' minutes')::interval)
          returning id`,
        [org.id, rule, iso(now), still, atOnce, String(CLEAR_MINUTES)],
      );
      for (const row of gone) await this.queue(tx, org, row.id, "alert.resolved", now);
    });
  }

  /** Writes down what is to be sent, as it is now, if the organization has a webhook. */
  private async queue(
    tx: Queryable,
    org: { id: string; name: string },
    alertId: string,
    event: "alert.opened" | "alert.resolved",
    now: Date,
  ): Promise<void> {
    const hook = await tx.query("select 1 from alert_webhooks where org_id = $1", [org.id]);
    if (hook.length === 0) return;
    const alert = (
      await tx.query<{
        rule: string;
        subject: string;
        label: string;
        detail: Record<string, unknown>;
        opened_at: Date | string;
        resolved_at: Date | string | null;
        state: string;
      }>(
        "select rule, subject, label, detail, opened_at, resolved_at, state from alerts where id = $1",
        [alertId],
      )
    )[0];
    if (!alert) return;
    const about = alert.subject.startsWith("user:");
    const { email: _email, ...detail } = alert.detail;
    const body = JSON.stringify({
      event,
      id: alertId,
      rule: alert.rule,
      state: alert.state,
      // A person is named and told apart by their id here. Their address stays in Muster.
      subject: about ? String(alert.detail.name ?? "") : alert.label,
      subjectId: alert.subject,
      detail,
      openedAt: new Date(alert.opened_at).toISOString(),
      resolvedAt: alert.resolved_at ? new Date(alert.resolved_at).toISOString() : null,
      organization: org.name,
      url: `${this.config.publicUrl}/#/admin/alerts`,
    });
    await tx.query(
      `insert into alert_deliveries (id, org_id, alert_id, event, body, next_at, created_at)
       values ($1, $2, $3, $4, $5, $6, $6)`,
      [newId(), org.id, alertId, event, body, iso(now)],
    );
  }

  /**
   * One POST, signed. The signature is the HMAC-SHA256 of "<timestamp>.<body>" under the
   * organization's secret, so the receiver knows it came from here and when. The address
   * is held to the same rules as anything an agent fetches: public, and never forwarded.
   */
  private async send(
    hook: { url: string; secret: string },
    id: string,
    body: string,
    now: Date,
  ): Promise<{ ok: boolean; said: string }> {
    const stamp = String(Math.floor(now.getTime() / 1000));
    const signature = createHmac("sha256", hook.secret).update(`${stamp}.${body}`).digest("hex");
    try {
      const answer = await this.net.request(hook.url, {
        method: "POST",
        body,
        contentType: "application/json",
        noRedirect: true,
        headers: {
          "user-agent": "Muster-Alerts/1",
          "x-muster-delivery": id,
          "x-muster-timestamp": stamp,
          "x-muster-signature": `sha256=${signature}`,
        },
      });
      const ok = answer.status >= 200 && answer.status < 300;
      return { ok, said: ok ? String(answer.status) : `HTTP ${answer.status}` };
    } catch (error) {
      return {
        ok: false,
        said: error instanceof NetError ? error.message : "The address could not be reached.",
      };
    }
  }

  private async hookOf(orgId: string): Promise<{ url: string; secret: string } | null> {
    const row = (
      await this.db.query<{ url: string; secret_sealed: string }>(
        "select url, secret_sealed from alert_webhooks where org_id = $1",
        [orgId],
      )
    )[0];
    const secret = row ? openText(this.config.secretKey, row.secret_sealed) : null;
    return row && secret ? { url: row.url, secret } : null;
  }

  /** Sends what is due. Each is claimed before it is sent, so two processes never send one twice. */
  private async deliver(now: Date): Promise<void> {
    const due = await this.db.query<{ id: string; org_id: string; body: string; attempts: number }>(
      `update alert_deliveries d set attempts = d.attempts + 1,
              next_at = $1::timestamptz + (case d.attempts ${BACKOFF_MINUTES.map((m, i) => `when ${i} then ${m}`).join(" ")} else 1440 end || ' minutes')::interval
        where d.id in (select id from alert_deliveries where status = 'pending' and next_at <= $1::timestamptz
                        order by next_at limit 5 for update skip locked)
        returning d.id, d.org_id, d.body, d.attempts`,
      [iso(now)],
    );
    for (const one of due) {
      const hook = await this.hookOf(one.org_id);
      const result = hook
        ? await this.send(hook, one.id, one.body, now)
        : { ok: false, said: "The webhook was removed, or its secret can no longer be opened." };
      const status = result.ok ? "sent" : !hook || one.attempts >= ATTEMPTS ? "failed" : "pending";
      await this.db.query(
        "update alert_deliveries set status = $2, said = $3, done_at = case when $2 = 'pending' then null else $4::timestamptz end where id = $1",
        [one.id, status, result.said.slice(0, 300), iso(now)],
      );
    }
  }

  /** One made-up alert, sent now and not kept: whether the address takes what is sent. */
  async test(orgId: string, orgName: string, now = new Date()) {
    const hook = await this.hookOf(orgId);
    if (!hook) return { ok: false, said: "No webhook is set." };
    const body = JSON.stringify({
      event: "test",
      id: newId(),
      rule: "run_failures",
      state: "open",
      subject: "",
      subjectId: "",
      detail: { runs: 40, errors: 12, percent: 30, window: 60 },
      openedAt: now.toISOString(),
      resolvedAt: null,
      organization: orgName,
      url: `${this.config.publicUrl}/#/admin/alerts`,
    });
    return this.send(hook, newId(), body, now);
  }
}

const RuleBody = z.strictObject({
  enabled: z.boolean(),
  threshold: z.number().finite(),
  window: z
    .number()
    .int()
    .refine((value) => (WINDOWS as readonly number[]).includes(value))
    .nullable()
    .optional(),
});

export function registerAlerts(app: Hono<Env>, kit: AppKit, db: Db, alerts: Alerts): void {
  const { need, actorOf, clientIp, inTx } = kit;
  const org = (c: Ctx) => c.get("session").org.id;

  app.get("/api/alerts", async (c) => {
    const denied = need(c, "settings.read");
    if (denied) return denied;
    const resolved = c.req.query("state") === "resolved";
    const rows = await db.query(
      `select a.id, a.rule, a.subject, a.label, a.detail, a.state, a.opened_at as "openedAt", a.seen_at as "seenAt",
              a.acknowledged_at as "acknowledgedAt", a.resolved_at as "resolvedAt",
              (select u.email from users u where u.id = a.acknowledged_by) as "acknowledgedBy"
         from alerts a
        where a.org_id = $1 and ${resolved ? "a.state = 'resolved'" : "a.state <> 'resolved'"}
        order by ${resolved ? "a.resolved_at desc" : "(a.state = 'open') desc, a.opened_at desc"} limit 100`,
      [org(c)],
    );
    return c.json(rows);
  });

  // What the sidebar shows: alerts nobody has acknowledged yet.
  app.get("/api/alerts/count", async (c) => {
    const denied = need(c, "settings.read");
    if (denied) return denied;
    const open = (
      await db.query<{ n: number }>(
        "select count(*)::int as n from alerts where org_id = $1 and state = 'open'",
        [org(c)],
      )
    )[0]?.n;
    return c.json({ open: open ?? 0 });
  });

  // Acknowledging says someone has it in hand: it stops counting on the sidebar and stays
  // listed until what it is about is no longer so. Nobody resolves an alert by hand, since
  // one resolved while still true would only open again a minute later.
  app.post("/api/alerts/:id/acknowledge", async (c) => {
    const denied = need(c, "settings.manage");
    if (denied) return denied;
    const id = c.req.param("id");
    if (!isId(id)) return fail(c, "not_found");
    return inTx(c, async (tx) => {
      const changed = await tx.query<{ rule: string; label: string }>(
        `update alerts set state = 'acknowledged', acknowledged_by = $3, acknowledged_at = now()
          where id = $1 and org_id = $2 and state = 'open' returning rule, label`,
        [id, org(c), c.get("session").user.id],
      );
      const row = changed[0];
      // Already acknowledged, or resolved by itself meanwhile: the page shows what is so now.
      if (!row) {
        const there = await tx.query("select 1 from alerts where id = $1 and org_id = $2", [
          id,
          org(c),
        ]);
        if (there.length === 0) throw new Refusal("not_found");
        return c.json({ ok: true, changed: false });
      }
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "alert.acknowledged",
        target: { type: "alert", id, label: row.label || row.rule },
        detail: { rule: row.rule },
        ip: clientIp(c),
      });
      return c.json({ ok: true, changed: true });
    });
  });

  const deliveryOf = async (orgId: string) => {
    const hook = (
      await db.query<{ url: string; updatedAt: string }>(
        `select url, updated_at as "updatedAt" from alert_webhooks where org_id = $1`,
        [orgId],
      )
    )[0];
    const last = (
      await db.query(
        `select status, said, attempts, event, coalesce(done_at, created_at) as at
           from alert_deliveries where org_id = $1 order by created_at desc limit 1`,
        [orgId],
      )
    )[0];
    return { url: hook?.url ?? null, canSeal: alerts.canSeal, last: last ?? null };
  };

  app.get("/api/alerts/rules", async (c) => {
    const denied = need(c, "settings.read");
    if (denied) return denied;
    const rules = (await alerts.rules(db, org(c))).map((rule) => ({
      ...rule,
      comes: { threshold: RULES[rule.rule].threshold, window: RULES[rule.rule].window },
      min: RULES[rule.rule].min,
      max: RULES[rule.rule].max,
      // A rule about something this server does not have can be set but never says anything.
      available: rule.rule !== "sandbox_down" || alerts.hasSandbox,
    }));
    return c.json({ rules, windows: WINDOWS, delivery: await deliveryOf(org(c)) });
  });

  app.put("/api/alerts/rules/:rule", async (c) => {
    const denied = need(c, "settings.manage");
    if (denied) return denied;
    const rule = c.req.param("rule") as Rule;
    const parsed = RuleBody.safeParse(await c.req.json().catch(() => null));
    if (!RULE_IDS.includes(rule)) return fail(c, "not_found");
    const shape: RuleShape = RULES[rule];
    if (
      !parsed.success ||
      parsed.data.threshold < shape.min ||
      parsed.data.threshold > shape.max ||
      (shape.window !== null && parsed.data.window == null)
    )
      return fail(c, "invalid_alert_rule");
    const { enabled, threshold } = parsed.data;
    const window = shape.window === null ? null : (parsed.data.window ?? shape.window);
    return inTx(c, async (tx) => {
      const before = (await alerts.rules(tx, org(c))).find((one) => one.rule === rule);
      await tx.query(
        `insert into alert_rules (org_id, rule, enabled, threshold, window_minutes, updated_by)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (org_id, rule) do update set enabled = excluded.enabled, threshold = excluded.threshold,
           window_minutes = excluded.window_minutes, updated_by = excluded.updated_by, updated_at = now()`,
        [org(c), rule, enabled, threshold, window, c.get("session").user.id],
      );
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "alerts.rule_changed",
        target: { type: "alert_rule", id: rule, label: rule },
        detail: { from: before, to: { rule, enabled, threshold, window } },
        ip: clientIp(c),
      });
      await alerts.askSoon(tx, org(c));
      return c.json({ ok: true });
    });
  });

  app.put("/api/alerts/webhook", async (c) => {
    const denied = need(c, "settings.manage");
    if (denied) return denied;
    const parsed = z
      .strictObject({ url: z.string().trim().min(1).max(500), newSecret: z.boolean().optional() })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, "invalid_alert_webhook");
    if (!alerts.canSeal) return fail(c, "connector_unsealed");
    let url: URL;
    try {
      url = checkUrl(parsed.data.url);
    } catch {
      return fail(c, "invalid_alert_webhook");
    }
    if (url.protocol !== "https:") return fail(c, "invalid_alert_webhook");
    return inTx(c, async (tx) => {
      const had = (
        await tx.query<{ url: string }>("select url from alert_webhooks where org_id = $1", [
          org(c),
        ])
      )[0];
      // A secret is made here, shown once and kept sealed. A new address gets a new one:
      // the old receiver must not be able to sign for the new.
      const fresh = !had || parsed.data.newSecret || new URL(had.url).origin !== url.origin;
      const secret = fresh ? `whsec_${randomBytes(24).toString("base64url")}` : null;
      if (secret)
        await tx.query(
          `insert into alert_webhooks (org_id, url, secret_sealed, updated_by) values ($1, $2, $3, $4)
           on conflict (org_id) do update set url = excluded.url, secret_sealed = excluded.secret_sealed,
             updated_by = excluded.updated_by, updated_at = now()`,
          [org(c), url.toString(), alerts.seal(secret), c.get("session").user.id],
        );
      else
        await tx.query(
          "update alert_webhooks set url = $2, updated_by = $3, updated_at = now() where org_id = $1",
          [org(c), url.toString(), c.get("session").user.id],
        );
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "alerts.webhook_changed",
        // Where alerts go is on the record; the secret never is.
        detail: { host: url.host, from: had ? new URL(had.url).host : null, newSecret: fresh },
        ip: clientIp(c),
      });
      return c.json({ ok: true, secret });
    });
  });

  app.delete("/api/alerts/webhook", async (c) => {
    const denied = need(c, "settings.manage");
    if (denied) return denied;
    return inTx(c, async (tx) => {
      const gone = await tx.query<{ url: string }>(
        "delete from alert_webhooks where org_id = $1 returning url",
        [org(c)],
      );
      if (!gone[0]) throw new Refusal("not_found");
      // Nothing still waiting is sent to an address that was taken away.
      await tx.query("delete from alert_deliveries where org_id = $1 and status = 'pending'", [
        org(c),
      ]);
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "alerts.webhook_removed",
        detail: { host: new URL(gone[0].url).host },
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    });
  });

  app.post("/api/alerts/webhook/test", async (c) => {
    const denied = need(c, "settings.manage");
    if (denied) return denied;
    const result = await alerts.test(org(c), c.get("session").org.name);
    await recordEvent(db, {
      orgId: org(c),
      actor: actorOf(c),
      action: "alerts.webhook_tested",
      detail: { ok: result.ok, said: result.said },
      ip: clientIp(c),
    });
    return c.json(result);
  });
}

/** See schema.ts, migration 40. */
export const ALERTS_SCHEMA = [
  // What an organization changed about a rule. A rule with no row is as it comes.
  `create table alert_rules (
    org_id uuid not null references organizations(id) on delete cascade,
    rule text not null,
    enabled boolean not null default true,
    threshold numeric not null,
    window_minutes integer,
    updated_by uuid references users(id) on delete set null,
    updated_at timestamptz not null default now(),
    primary key (org_id, rule)
  )`,
  `create table alerts (
    id uuid primary key,
    org_id uuid not null references organizations(id) on delete cascade,
    rule text not null,
    subject text not null default '',
    label text not null default '',
    detail jsonb not null default '{}'::jsonb,
    state text not null default 'open' check (state in ('open', 'acknowledged', 'resolved')),
    opened_at timestamptz not null default now(),
    seen_at timestamptz not null default now(),
    acknowledged_by uuid references users(id) on delete set null,
    acknowledged_at timestamptz,
    resolved_at timestamptz
  )`,
  // One alert that is not resolved for each rule and subject, whoever asks.
  `create unique index alerts_open on alerts (org_id, rule, subject) where state <> 'resolved'`,
  `create index alerts_org on alerts (org_id, state, opened_at desc)`,
  `create table alert_webhooks (
    org_id uuid primary key references organizations(id) on delete cascade,
    url text not null,
    secret_sealed text not null,
    updated_by uuid references users(id) on delete set null,
    updated_at timestamptz not null default now()
  )`,
  `create table alert_deliveries (
    id uuid primary key,
    org_id uuid not null references organizations(id) on delete cascade,
    alert_id uuid not null references alerts(id) on delete cascade,
    event text not null,
    body text not null,
    status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
    attempts integer not null default 0,
    said text not null default '',
    next_at timestamptz not null,
    created_at timestamptz not null default now(),
    done_at timestamptz
  )`,
  `create index alert_deliveries_due on alert_deliveries (next_at) where status = 'pending'`,
];

/**
 * A later step, see schema.ts. Since when an alert has not been so (it resolves after a
 * few minutes of that), marks every process reads (since when the sandbox is away, when
 * spending was last summed), and what the rules' questions are answered from.
 */
export const ALERTS_FIXES_SCHEMA = [
  `alter table alerts add column if not exists clear_since timestamptz`,
  `create index if not exists alerts_recent on alerts (org_id, rule, subject, resolved_at desc) where state = 'resolved'`,
  `create table if not exists alert_marks (
    key text primary key,
    since timestamptz not null
  )`,
  // Runs in a stretch of time, with how each ended and what it cost, without reading the runs.
  `create index if not exists traces_org_started_cost on traces (org_id, started_at) include (status, cost_micros)`,
  // The few steps the rules count, found by their run.
  `create index if not exists spans_policy_blocked on spans (trace_id) where kind = 'policy' and status = 'blocked'`,
  `create index if not exists spans_llm_error on spans (trace_id) where kind = 'llm' and status = 'error'`,
];
