import { createHmac } from "node:crypto";
import { newId } from "@muster/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { Alerts, ATTEMPTS, CLEAR_MINUTES } from "./alerts.js";
import type { Net } from "./runtime/net.js";
import type { Sandbox, SandboxHealth } from "./sandbox.js";
import { type Harness, harness } from "./test-support.js";

/**
 * Alert rules against a clock the test holds: each fires once while what it watches is
 * so, never twice, and resolves by itself once that has stayed away. What is sent to a
 * webhook is signed, and is tried a bounded number of times.
 */

let h: Harness;
let owner: string;
let orgId: string;
let ownerId: string;
let agentId: string;
const NOW = new Date("2026-11-20T12:00:00Z");
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const json = async <T = Record<string, unknown>>(response: Response) =>
  (await response.json()) as T;

interface Sent {
  url: string;
  body: string;
  headers: Record<string, string>;
}
let sent: Sent[];
let answer: number | Error;
const net: Net = {
  async request(url, init = {}) {
    sent.push({ url, body: init.body ?? "", headers: init.headers ?? {} });
    if (answer instanceof Error) throw answer;
    return { status: answer, contentType: "", text: "", truncated: false, url };
  },
};
let ready: boolean;
const sandbox = {
  health: async () => ({ ready }) as SandboxHealth,
} as unknown as Sandbox;

interface AlertRow {
  id: string;
  rule: string;
  subject: string;
  label: string;
  state: string;
  detail: Record<string, unknown>;
}
const alertsNow = async (state = "open") =>
  json<AlertRow[]>(await h.api(owner, "GET", `/api/alerts?state=${state}`));

/** One run that started `ago` minutes before NOW, with what it cost and how it ended. */
async function run(
  ago: number,
  status: "ok" | "error" | "blocked" = "ok",
  options: {
    userId?: string;
    costMicros?: number;
    /** One step inside it: its kind, how it ended, and what is written beside it. */
    span?: [string, string, Record<string, string>?];
  } = {},
) {
  const id = newId();
  await h.db.query(
    `insert into traces (id, org_id, agent_id, agent_version, user_id, conversation_id, venue, status, started_at, duration_ms, cost_micros, max_action)
     values ($1, $2, $3, '1', $4, $5, 'cloud', $6, $7, 100, $8, 'A0')`,
    [
      id,
      orgId,
      agentId,
      options.userId ?? ownerId,
      newId(),
      status,
      later(-ago).toISOString(),
      options.costMicros ?? 0,
    ],
  );
  if (options.span)
    await h.db.query(
      `insert into spans (id, trace_id, org_id, seq, kind, name, status, start_offset_ms, duration_ms, attributes)
       values ($1, $2, $3, 0, $4, 'x', $5, 0, 10, $6::jsonb)`,
      [newId(), id, orgId, options.span[0], options.span[1], JSON.stringify(options.span[2] ?? {})],
    );
  return id;
}
/** A call the organization's policy refused, as the gateway records it. */
const refused = (ago: number, userId?: string) =>
  run(ago, "blocked", {
    userId,
    span: ["policy", "blocked", { policyId: "no-policy-for-a4", effect: "deny" }],
  });
const notices = async () =>
  (
    await json<{ notices: { kind: string; detail: Record<string, string>; link: string }[] }>(
      await h.api(owner, "GET", "/api/app/notices"),
    )
  ).notices.filter((notice) => notice.kind === "alert");
/** Asks now, and again once what is no longer so has stayed away long enough to resolve. */
const settle = async (minute: number) => {
  await h.alerts.tick(later(minute));
  await h.alerts.tick(later(minute + CLEAR_MINUTES));
};

beforeEach(async () => {
  sent = [];
  answer = 200;
  ready = true;
  h = await harness({}, { net, sandbox });
  owner = (await h.signIn("owner@acme.test")).cookie as string;
  const me = (
    await h.db.query<{ org_id: string; user_id: string }>(
      "select org_id, user_id from memberships limit 1",
    )
  )[0] as { org_id: string; user_id: string };
  orgId = me.org_id;
  ownerId = me.user_id;
  agentId = newId();
  await h.db.query(
    `insert into agents (id, org_id, name, source, risk, state, version, model)
     values ($1, $2, 'Researcher', 'org', 'R1', 'published', '1', 'test-model')`,
    [agentId, orgId],
  );
});

describe("the failure-rate rule", () => {
  it("opens one alert, tells the administrators once, and resolves when the runs get better", async () => {
    for (let i = 0; i < 9; i++) await run(10, i < 3 ? "error" : "ok");
    await h.alerts.tick(NOW);
    // Nine runs are too few to take a rate of.
    expect(await alertsNow()).toEqual([]);

    await run(5, "ok");
    await h.alerts.tick(NOW);
    const [alert] = await alertsNow();
    expect(alert).toMatchObject({
      rule: "run_failures",
      state: "open",
      detail: { runs: 10, errors: 3, percent: 30, window: 60 },
    });
    expect(await notices()).toMatchObject([
      { detail: { rule: "run_failures" }, link: "admin/alerts" },
    ]);

    // Still so a minute later, and asked twice at once: one alert, one notice.
    await Promise.all([h.alerts.tick(later(1)), h.alerts.tick(later(1))]);
    expect(await alertsNow()).toHaveLength(1);
    expect(await notices()).toHaveLength(1);
    expect(
      await json<{ open: number }>(await h.api(owner, "GET", "/api/alerts/count")),
    ).toMatchObject({ open: 1 });

    // An hour on, those runs are outside the window. One check that finds it clear is
    // not enough; a few minutes of it are.
    await h.alerts.tick(later(61));
    expect(await alertsNow()).toHaveLength(1);
    await h.alerts.tick(later(62));
    expect(await alertsNow()).toHaveLength(1);
    await h.alerts.tick(later(61 + CLEAR_MINUTES));
    expect(await alertsNow()).toEqual([]);
    expect(await alertsNow("resolved")).toMatchObject([{ id: alert?.id, state: "resolved" }]);
  });

  it("is not resolved by a dip: so again before the minutes are up, it simply stays", async () => {
    for (let i = 0; i < 10; i++) await run(10, "error");
    await h.alerts.tick(NOW);
    const [alert] = await alertsNow();
    await h.alerts.tick(later(51));
    for (let i = 0; i < 10; i++) await run(-52, "error");
    await h.alerts.tick(later(53));
    // Clear again long after: the minutes count from the last time it was so.
    await h.alerts.tick(later(53 + CLEAR_MINUTES));
    expect(await alertsNow()).toMatchObject([{ id: alert?.id, state: "open" }]);
    expect(await notices()).toHaveLength(1);
  });

  it("coming back within the hour opens the same alert again and tells nobody twice", async () => {
    answer = 200;
    await h.api(owner, "PUT", "/api/alerts/webhook", { url: "https://hooks.example.com/in" });
    for (let i = 0; i < 10; i++) await run(10, "error");
    await h.alerts.tick(NOW);
    const [alert] = await alertsNow();
    await h.api(owner, "POST", `/api/alerts/${alert?.id}/acknowledge`);
    await settle(61);
    expect(await alertsNow()).toEqual([]);
    const sentBefore = sent.length;
    expect(sentBefore).toBe(2);

    for (let i = 0; i < 10; i++) await run(-70, "error");
    await h.alerts.tick(later(71));
    // The one that resolved, as it was left: acknowledged, and not counted as new.
    expect(await alertsNow()).toMatchObject([{ id: alert?.id, state: "acknowledged" }]);
    expect(await alertsNow("resolved")).toEqual([]);
    expect(await notices()).toHaveLength(1);
    await h.alerts.tick(later(72));
    expect(sent).toHaveLength(sentBefore);

    // Long after it last resolved, the same trouble is a new alert and a new notice.
    await settle(140);
    for (let i = 0; i < 10; i++) await run(-300, "error");
    await h.alerts.tick(later(301));
    const [next] = await alertsNow();
    expect(next?.id).not.toBe(alert?.id);
    expect(next?.state).toBe("open");
    expect(await notices()).toHaveLength(2);
  });

  it("stays quiet below the threshold, and follows a threshold the administrator sets", async () => {
    for (let i = 0; i < 20; i++) await run(10, i < 3 ? "error" : "ok");
    await h.alerts.tick(NOW);
    expect(await alertsNow()).toEqual([]);

    const changed = await h.api(owner, "PUT", "/api/alerts/rules/run_failures", {
      enabled: true,
      threshold: 10,
      window: 60,
    });
    expect(changed.status).toBe(200);
    await h.alerts.tick(NOW);
    expect(await alertsNow()).toMatchObject([{ rule: "run_failures" }]);

    // Switched off, it says nothing and what it had open is resolved at once.
    await h.api(owner, "PUT", "/api/alerts/rules/run_failures", {
      enabled: false,
      threshold: 10,
      window: 60,
    });
    await h.alerts.tick(later(1));
    expect(await alertsNow()).toEqual([]);
    const events = await h.db.query<{ action: string }>(
      "select action from admin_events where action = 'alerts.rule_changed'",
    );
    expect(events).toHaveLength(2);
  });
});

describe("refused actions", () => {
  it("one alert for the person, and one for an agent refused for several people", async () => {
    await h.api(owner, "POST", "/api/invitations", { email: "may@acme.test", role: "member" });
    await h.signIn("may@acme.test");
    const may = (
      await h.db.query<{ id: string }>("select id from users where email = 'may@acme.test'")
    )[0]?.id as string;
    for (let i = 0; i < 4; i++) await refused(10);
    await h.alerts.tick(NOW);
    expect(await alertsNow()).toEqual([]);

    await refused(5);
    await h.alerts.tick(NOW);
    expect(await alertsNow()).toMatchObject([
      { rule: "blocked_actions", subject: `user:${ownerId}`, detail: { count: 5, who: "person" } },
    ]);

    await refused(5, may);
    await h.alerts.tick(later(1));
    const both = await alertsNow();
    expect(both.map((alert) => alert.subject).sort()).toEqual(
      [`agent:${agentId}`, `user:${ownerId}`].sort(),
    );
    expect(both.find((alert) => alert.subject.startsWith("agent:"))).toMatchObject({
      label: "Researcher",
      detail: { count: 6, people: 2 },
    });

    await settle(70);
    expect(await alertsNow()).toEqual([]);
  });

  it("counts only what policy refused: not a plan being made, nor what the person declined", async () => {
    for (let i = 0; i < 6; i++) {
      // Held while a plan is made, and held because the plan was not shown yet.
      await run(10, "blocked", {
        span: ["policy", "blocked", { policyId: i % 2 ? "plan-mode" : "plan-not-shown" }],
      });
      // Asked of the person, who said no, or did not answer in time.
      await run(10, "blocked", {
        span: ["approval", "blocked", { outcome: i % 2 ? "rejected" : "expired" }],
      });
      // The call itself, marked as not carried out whatever the reason was.
      await run(10, "blocked", { span: ["tool", "blocked"] });
      // A call that was asked about is not one that was refused.
      await run(10, "ok", { span: ["policy", "ok", { policyId: "confirm-command" }] });
    }
    await h.alerts.tick(NOW);
    expect(await alertsNow()).toEqual([]);
    for (let i = 0; i < 5; i++) await refused(5);
    await h.alerts.tick(later(1));
    expect(await alertsNow()).toMatchObject([{ rule: "blocked_actions", detail: { count: 5 } }]);
  });
});

describe("the other rules", () => {
  it("spend: a day far above a usual one, asked about once an hour", async () => {
    // Two days of history are not a usual day yet.
    await run(60 * 30, "ok", { costMicros: 2_000_000 });
    await run(60 * 54, "ok", { costMicros: 2_000_000 });
    await run(30, "ok", { costMicros: 9_000_000 });
    await h.alerts.tick(NOW);
    expect(await alertsNow()).toEqual([]);

    await run(60 * 78, "ok", { costMicros: 3_000_000 });
    // Not summed again until the hour is up.
    await h.alerts.tick(later(30));
    expect(await alertsNow()).toEqual([]);
    await h.alerts.tick(later(60));
    // 7 over seven days is 1 a day; the last 24 hours are 9.
    expect(await alertsNow()).toMatchObject([
      {
        rule: "spend_spike",
        detail: { todayMicros: 9_000_000, usualMicros: 1_000_000, times: 9 },
      },
    ]);
    await h.alerts.tick(later(60 * 25));
    expect(await alertsNow()).toHaveLength(1);
    await h.alerts.tick(later(60 * 26));
    expect(await alertsNow()).toEqual([]);
  });

  it("spend: a threshold just changed is asked about at once", async () => {
    for (const hours of [30, 54, 78]) await run(60 * hours, "ok", { costMicros: 2_333_333 });
    await run(30, "ok", { costMicros: 2_500_000 });
    await h.alerts.tick(NOW);
    expect(await alertsNow()).toEqual([]);
    await h.api(owner, "PUT", "/api/alerts/rules/spend_spike", { enabled: true, threshold: 2 });
    await h.alerts.tick(later(1));
    expect(await alertsNow()).toMatchObject([{ rule: "spend_spike" }]);
  });

  it("a submission that has waited longer than the hours set", async () => {
    await h.db.query(
      `insert into listings (org_id, kind, item_id, state, submitted_by, submitted_at)
       values ($1, 'agent', $2, 'pending', $3, $4)`,
      [orgId, agentId, ownerId, later(-23 * 60).toISOString()],
    );
    await h.alerts.tick(NOW);
    expect(await alertsNow()).toEqual([]);
    await h.alerts.tick(later(61));
    expect(await alertsNow()).toMatchObject([
      {
        rule: "approval_waiting",
        subject: `agent:${agentId}`,
        label: "Researcher",
        detail: { kind: "agent", hours: 24 },
      },
    ]);
    // Decided: nothing waits any more.
    await h.db.query("update listings set state = 'published' where item_id = $1", [agentId]);
    await settle(62);
    expect(await alertsNow()).toEqual([]);
  });

  it("the sandbox: only after it has been away for the minutes set, whichever process asks", async () => {
    ready = false;
    await h.alerts.tick(NOW);
    await h.alerts.tick(later(9));
    expect(await alertsNow()).toEqual([]);
    // Another server process, or this one after a restart: since when is read, not remembered.
    const other = new Alerts(h.db, h.config, { sandbox, net });
    await other.tick(later(10));
    expect(await alertsNow()).toMatchObject([{ rule: "sandbox_down", detail: { minutes: 10 } }]);
    ready = true;
    await settle(11);
    expect(await alertsNow()).toEqual([]);
    // Away again: the minutes are counted from now, not from the first time.
    ready = false;
    await h.alerts.tick(later(15));
    await h.alerts.tick(later(24));
    expect(await alertsNow()).toEqual([]);
    await h.alerts.tick(later(25));
    expect(await alertsNow()).toMatchObject([{ rule: "sandbox_down", detail: { minutes: 10 } }]);
  });

  it("a model whose calls keep failing, named", async () => {
    for (let i = 0; i < 5; i++)
      await run(5, "error", { span: ["llm", "error", { model: "test-model" }] });
    await run(5, "ok", { span: ["llm", "ok", { model: "other-model" }] });
    await h.alerts.tick(NOW);
    expect(await alertsNow()).toMatchObject([
      { rule: "model_failing", subject: "test-model", detail: { errors: 5, calls: 5, window: 15 } },
    ]);
  });
});

describe("what another part of the server raises", () => {
  it("is one alert, told of once, that stays until it is cleared", async () => {
    await h.alerts.raise(orgId, "audit_chain_broken", "", { at: 41 }, "", NOW);
    await h.alerts.raise(orgId, "audit_chain_broken", "", { at: 42 }, "", later(1));
    const [alert] = await alertsNow();
    expect(alert).toMatchObject({ rule: "audit_chain_broken", state: "open", detail: { at: 42 } });
    expect(await alertsNow()).toHaveLength(1);
    expect(await notices()).toMatchObject([{ detail: { rule: "audit_chain_broken" } }]);
    // The timer asks about its own rules and leaves this one alone, however long.
    await settle(60);
    expect(await alertsNow()).toHaveLength(1);

    await h.alerts.clear(orgId, "audit_chain_broken", "", later(70));
    expect(await alertsNow()).toEqual([]);
    // Cleared twice is cleared once.
    await h.alerts.clear(orgId, "audit_chain_broken", "", later(71));
    expect(await alertsNow("resolved")).toHaveLength(1);

    // Raised again soon after: the same alert, and nobody told again.
    await h.alerts.raise(orgId, "audit_chain_broken", "", {}, "", later(80));
    expect(await alertsNow()).toMatchObject([{ id: alert?.id }]);
    expect(await notices()).toHaveLength(1);
  });

  it("tells subjects apart, clears all of a rule at once, and keeps the timer's rules its own", async () => {
    await h.alerts.raise(orgId, "audit_forward_stalled", "siem-a", {}, "A", NOW);
    await h.alerts.raise(orgId, "audit_forward_stalled", "siem-b", {}, "B", NOW);
    expect(await alertsNow()).toHaveLength(2);
    await h.alerts.clear(orgId, "audit_forward_stalled", "siem-a", later(1));
    expect(await alertsNow()).toMatchObject([{ subject: "siem-b", label: "B" }]);
    await h.alerts.clear(orgId, "audit_forward_stalled", undefined, later(2));
    expect(await alertsNow()).toEqual([]);
    await expect(h.alerts.raise(orgId, "run_failures", "")).rejects.toThrow();
    await expect(h.alerts.clear(orgId, "run_failures")).rejects.toThrow();
    // An organization that does not exist has nobody to tell.
    await h.alerts.raise(newId(), "audit_chain_broken", "");
  });
});

describe("acknowledging", () => {
  it("takes it off the count, keeps it listed, is recorded, and is not opened again", async () => {
    for (let i = 0; i < 10; i++) await run(10, "error");
    await h.alerts.tick(NOW);
    const [alert] = await alertsNow();
    const done = await h.api(owner, "POST", `/api/alerts/${alert?.id}/acknowledge`);
    expect(await json(done)).toEqual({ ok: true, changed: true });
    expect(await json(await h.api(owner, "GET", "/api/alerts/count"))).toEqual({ open: 0 });
    await h.alerts.tick(later(1));
    expect(await alertsNow()).toMatchObject([{ id: alert?.id, state: "acknowledged" }]);
    expect(await notices()).toHaveLength(1);
    // A second press changes nothing and records nothing more.
    expect(await json(await h.api(owner, "POST", `/api/alerts/${alert?.id}/acknowledge`))).toEqual({
      ok: true,
      changed: false,
    });
    const events = await h.db.query(
      "select 1 from admin_events where action = 'alert.acknowledged'",
    );
    expect(events).toHaveLength(1);
  });

  it("is for those who may change settings; an auditor reads, a member sees nothing", async () => {
    await h.api(owner, "POST", "/api/invitations", { email: "aud@acme.test", role: "auditor" });
    await h.api(owner, "POST", "/api/invitations", { email: "mem@acme.test", role: "member" });
    const auditor = (await h.signIn("aud@acme.test")).cookie as string;
    const member = (await h.signIn("mem@acme.test")).cookie as string;
    for (let i = 0; i < 10; i++) await run(10, "error");
    await h.alerts.tick(NOW);
    const [alert] = await alertsNow();
    expect((await h.api(auditor, "GET", "/api/alerts")).status).toBe(200);
    expect((await h.api(auditor, "POST", `/api/alerts/${alert?.id}/acknowledge`)).status).toBe(403);
    expect(
      (
        await h.api(auditor, "PUT", "/api/alerts/rules/run_failures", {
          enabled: false,
          threshold: 20,
          window: 60,
        })
      ).status,
    ).toBe(403);
    expect((await h.api(member, "GET", "/api/alerts")).status).toBe(403);
    expect((await h.api(member, "GET", "/api/alerts/count")).status).toBe(403);
    // Only owners and administrators are told.
    const told = await h.db.query("select 1 from notices where kind = 'alert'");
    expect(told).toHaveLength(1);
  });
});

describe("rules as set", () => {
  it("come with their defaults and refuse what is out of range", async () => {
    const { rules } = await json<{
      rules: { rule: string; enabled: boolean; threshold: number; window: number | null }[];
    }>(await h.api(owner, "GET", "/api/alerts/rules"));
    expect(rules.map((rule) => [rule.rule, rule.enabled, rule.threshold, rule.window])).toEqual([
      ["run_failures", true, 20, 60],
      ["blocked_actions", true, 5, 60],
      ["spend_spike", true, 3, null],
      ["approval_waiting", true, 24, null],
      ["sandbox_down", true, 10, null],
      ["model_failing", true, 5, 15],
    ]);
    const put = (rule: string, body: unknown) =>
      h.api(owner, "PUT", `/api/alerts/rules/${rule}`, body).then((r) => r.status);
    expect(await put("run_failures", { enabled: true, threshold: 0, window: 60 })).toBe(400);
    expect(await put("run_failures", { enabled: true, threshold: 101, window: 60 })).toBe(400);
    expect(await put("run_failures", { enabled: true, threshold: 20, window: 7 })).toBe(400);
    expect(await put("run_failures", { enabled: true, threshold: 20 })).toBe(400);
    expect(await put("nothing", { enabled: true, threshold: 20 })).toBe(404);
    expect(await put("spend_spike", { enabled: true, threshold: 2.5 })).toBe(200);
  });
});

describe("the webhook", () => {
  const hook = "https://hooks.example.com/muster";
  const set = async (url = hook) =>
    json<{ secret: string | null }>(await h.api(owner, "PUT", "/api/alerts/webhook", { url }));

  it("takes only a public https address, and shows its secret once", async () => {
    for (const url of ["http://hooks.example.com/x", "https://127.0.0.1/x", "https://localhost/x"])
      expect((await h.api(owner, "PUT", "/api/alerts/webhook", { url })).status).toBe(400);
    const { secret } = await set();
    expect(secret).toMatch(/^whsec_/);
    // Kept sealed, never as it is, and never given back.
    const kept = (await h.db.query<{ secret_sealed: string }>("select * from alert_webhooks"))[0];
    expect(kept?.secret_sealed).not.toContain(secret);
    const page = await (await h.api(owner, "GET", "/api/alerts/rules")).text();
    expect(page).toContain(hook);
    expect(page).not.toContain(secret);
    // The same place again keeps its secret; another place gets a new one.
    expect((await set(`${hook}?v=2`)).secret).toBeNull();
    expect((await set("https://other.example.com/in")).secret).toMatch(/^whsec_/);
    const events = await h.db.query<{ detail: Record<string, unknown> }>(
      "select detail from admin_events where action = 'alerts.webhook_changed' order by time",
    );
    expect(events).toHaveLength(3);
    expect(JSON.stringify(events)).not.toContain("whsec_");
  });

  it("sends an opened and a resolved alert, each once, signed", async () => {
    const { secret } = await set();
    for (let i = 0; i < 10; i++) await run(10, "error");
    await h.alerts.tick(NOW);
    await h.alerts.tick(later(1));
    expect(sent).toHaveLength(1);
    const first = sent[0] as Sent;
    expect(first.url).toBe(hook);
    expect(JSON.parse(first.body)).toMatchObject({
      event: "alert.opened",
      rule: "run_failures",
      state: "open",
      organization: "Acme",
      detail: { percent: 100 },
      url: "http://muster.test/#/admin/alerts",
    });
    const stamp = first.headers["x-muster-timestamp"] as string;
    expect(stamp).toBe(String(NOW.getTime() / 1000));
    expect(first.headers["x-muster-signature"]).toBe(
      `sha256=${createHmac("sha256", secret as string)
        .update(`${stamp}.${first.body}`)
        .digest("hex")}`,
    );
    await settle(61);
    expect(sent).toHaveLength(2);
    expect(JSON.parse(sent[1]?.body ?? "{}")).toMatchObject({
      event: "alert.resolved",
      state: "resolved",
    });
  });

  it("names a person and gives their id, and never their address", async () => {
    await set();
    await h.db.query("update users set name = 'Olivia Lin' where id = $1", [ownerId]);
    for (let i = 0; i < 5; i++) await refused(5);
    await h.alerts.tick(NOW);
    expect(sent).toHaveLength(1);
    const body = sent[0]?.body ?? "";
    expect(JSON.parse(body)).toMatchObject({
      rule: "blocked_actions",
      subject: "Olivia Lin",
      subjectId: `user:${ownerId}`,
      detail: { count: 5, who: "person" },
    });
    expect(body).not.toContain("owner@acme.test");
    expect(body).not.toContain("email");
    // Someone with no name set is told apart by id alone.
    await h.db.query("update users set name = '' where id = $1", [ownerId]);
    await settle(70);
    for (let i = 0; i < 5; i++) await refused(-200);
    await h.alerts.tick(later(201));
    const again = sent.at(-1)?.body ?? "";
    expect(JSON.parse(again)).toMatchObject({ event: "alert.opened", subject: "" });
    expect(again).not.toContain("owner@acme.test");
    // The page still has the address, to open that person's runs with.
    expect((await alertsNow())[0]?.detail.email).toBe("owner@acme.test");
  });

  it("tries again later when the address fails, and gives up after a set number of tries", async () => {
    await set();
    answer = 500;
    for (let i = 0; i < 10; i++) await run(10, "error");
    await h.alerts.tick(NOW);
    expect(sent).toHaveLength(1);
    // Not again before its time.
    await h.alerts.tick(new Date(NOW.getTime() + 30_000));
    expect(sent).toHaveLength(1);
    // 1, 5, 30 and 120 minutes after each failure; checked every minute until nothing is left.
    for (let minute = 1; minute <= 60 * 48; minute++) {
      const before = sent.length;
      await h.alerts.tick(later(minute));
      if (sent.length === before && minute > 400) break;
    }
    const opened = sent.filter((one) => JSON.parse(one.body).event === "alert.opened");
    expect(opened).toHaveLength(ATTEMPTS);
    const row = (
      await h.db.query<{ status: string; said: string; attempts: number }>(
        "select status, said, attempts from alert_deliveries where event = 'alert.opened'",
      )
    )[0];
    expect(row).toMatchObject({ status: "failed", said: "HTTP 500", attempts: ATTEMPTS });
  });

  it("can be tried from the page and taken away, and nothing waiting is sent afterwards", async () => {
    expect(await json(await h.api(owner, "POST", "/api/alerts/webhook/test"))).toMatchObject({
      ok: false,
    });
    await set();
    expect(await json(await h.api(owner, "POST", "/api/alerts/webhook/test"))).toEqual({
      ok: true,
      said: "200",
    });
    expect(JSON.parse(sent[0]?.body ?? "{}")).toMatchObject({ event: "test" });
    answer = new Error("down");
    for (let i = 0; i < 10; i++) await run(10, "error");
    await h.alerts.tick(NOW);
    expect(sent).toHaveLength(2);
    expect((await h.api(owner, "DELETE", "/api/alerts/webhook")).status).toBe(200);
    await h.alerts.tick(later(2));
    expect(sent).toHaveLength(2);
    expect((await h.api(owner, "DELETE", "/api/alerts/webhook")).status).toBe(404);
  });
});

describe("what the rules read is indexed", () => {
  it("has the indexes the later step adds", async () => {
    const names = (await h.db.query<{ indexname: string }>("select indexname from pg_indexes")).map(
      (row) => row.indexname,
    );
    for (const name of [
      "traces_org_started_cost",
      "spans_policy_blocked",
      "spans_llm_error",
      "alerts_recent",
    ])
      expect(names).toContain(name);
  });
});
