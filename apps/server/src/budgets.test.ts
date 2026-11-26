import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type StreamFn,
} from "@openclaw/llm-core";
import { newId } from "@muster/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { type Harness, harness } from "./test-support.js";

const json = async <T = unknown>(response: Response): Promise<T> => (await response.json()) as T;
const DOLLAR = 1_000_000;

interface Page {
  month: string;
  canManage: boolean;
  priced: boolean;
  company: { limitMicros: number | null; spentMicros: number };
  everyone: { limitMicros: number | null };
  departments: { id: string; name: string; limitMicros: number | null; spentMicros: number }[];
  people: { email: string; limitMicros: number | null; spentMicros: number }[];
}

describe("the month's budgets", () => {
  let h: Harness;
  let owner: string;
  let mo: string;
  let billing: string;
  let ids: Record<string, string>;
  let orgId: string;
  let agentId: string;
  let sales: string;
  /** What each asking of the stand-in model costs, in dollars, and whether it goes on to a step. */
  let turns: { cost: number; goesOn: boolean }[] = [];
  let asked = 0;
  const streamFn: StreamFn = (model) => {
    const turn = turns[asked++] ?? { cost: 0, goesOn: false };
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      content: turn.goesOn
        ? [{ type: "toolCall", id: `call-${asked}`, name: "files.read", arguments: { name: "x" } }]
        : [{ type: "text", text: 'root = Stack([a])\na = Text("Done.")' }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 100,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 120,
        cost: { input: turn.cost, output: 0, cacheRead: 0, cacheWrite: 0, total: turn.cost },
      },
      stopReason: turn.goesOn ? "toolUse" : "stop",
      timestamp: Date.now(),
    };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: turn.goesOn ? "toolUse" : "stop", message });
      stream.end();
    });
    return stream;
  };

  /** A run on record that cost this much, for this person, some days ago. */
  const spend = (email: string, dollars: number, daysAgo = 0) =>
    h.db.query(
      `insert into traces (id, org_id, agent_id, agent_version, user_id, conversation_id, venue, status,
                           started_at, duration_ms, cost_micros, max_action)
       values ($1, $2, $3, 'v', $4, $5, 'cloud', 'ok', now() - ($6 || ' days')::interval, 1, $7, 'A0')`,
      [newId(), orgId, agentId, ids[email], newId(), String(daysAgo), Math.round(dollars * DOLLAR)],
    );
  const set = (scope: string, monthlyMicros: number | null, targetId: string | null = null) =>
    h.api(owner, "PUT", "/api/budgets", { scope, targetId, monthlyMicros });
  const say = async (as: string) => {
    const conversation = (
      await json<{ id: string }>(await h.api(as, "POST", "/api/app/conversations", { agentId }))
    ).id;
    const response = await h.api(as, "POST", `/api/app/conversations/${conversation}/messages`, {
      content: "Hello",
    });
    if (response.status === 200) await h.runs.settled(conversation);
    return { response, conversation };
  };
  const refusal = async (as: string) =>
    (await json<{ error?: { code: string } }>((await say(as)).response)).error?.code ?? null;
  const notices = async (as: string) =>
    (
      await json<{ notices: { kind: string; detail: Record<string, string | null> }[] }>(
        await h.api(as, "GET", "/api/app/notices"),
      )
    ).notices.filter((notice) => notice.kind.startsWith("budget_"));
  const page = async (as = owner) => json<Page>(await h.api(as, "GET", "/api/budgets"));

  beforeAll(async () => {
    h = await harness({}, { streamFn });
    owner = (await h.signIn("owner@acme.test")).cookie as string;
    for (const [email, role] of [
      ["mo@acme.test", "member"],
      ["bill@acme.test", "billing"],
    ])
      await h.api(owner, "POST", "/api/invitations", { email, role });
    mo = (await h.signIn("mo@acme.test")).cookie as string;
    billing = (await h.signIn("bill@acme.test")).cookie as string;
    const users = await h.db.query<{ id: string; email: string }>("select id, email from users");
    ids = Object.fromEntries(users.map((user) => [user.email, user.id]));
    orgId = (await h.db.query<{ id: string }>("select id from organizations"))[0]?.id as string;
    const { agents } = await json<{ agents: { id: string; name: string }[] }>(
      await h.api(owner, "GET", "/api/app/agents"),
    );
    agentId = agents.find((agent) => agent.name === "Writer")?.id as string;
    sales = (
      await json<{ id: string }>(await h.api(owner, "POST", "/api/departments", { name: "Sales" }))
    ).id;
    await h.api(owner, "PATCH", `/api/members/${ids["mo@acme.test"]}`, { departmentId: sales });
  });

  it("are set by an administrator, seen by whoever sees costs, and on the record", async () => {
    expect((await h.api(mo, "GET", "/api/budgets")).status).toBe(403);
    expect((await h.api(billing, "GET", "/api/budgets")).status).toBe(200);
    expect((await page(billing)).canManage).toBe(false);
    for (const who of [mo, billing])
      expect(
        (await h.api(who, "PUT", "/api/budgets", { scope: "company", monthlyMicros: DOLLAR }))
          .status,
      ).toBe(403);
    // A limit is a whole sum above nothing, for someone there is.
    for (const body of [
      { scope: "company", monthlyMicros: 0 },
      { scope: "company", monthlyMicros: 1.5 },
      { scope: "company", monthlyMicros: -5 },
      { scope: "company", targetId: sales, monthlyMicros: DOLLAR },
      { scope: "department", monthlyMicros: DOLLAR },
      { scope: "team", monthlyMicros: DOLLAR },
    ])
      expect((await h.api(owner, "PUT", "/api/budgets", body)).status).toBe(400);
    expect((await set("department", DOLLAR, newId())).status).toBe(404);
    expect((await set("person", DOLLAR, newId())).status).toBe(404);
    expect((await set("company", 50 * DOLLAR)).status).toBe(200);
    expect((await set("company", 80 * DOLLAR)).status).toBe(200);
    expect(await page()).toMatchObject({
      canManage: true,
      priced: true,
      company: { limitMicros: 80 * DOLLAR, spentMicros: 0 },
      everyone: { limitMicros: null },
      departments: [{ name: "Sales", limitMicros: null, spentMicros: 0 }],
    });
    expect((await page()).month).toMatch(/^20\d\d-\d\d$/);
    const events = await h.db.query<{ action: string; detail: { before: number | null } }>(
      "select action, detail from admin_events where action like 'budget.%' order by time",
    );
    expect(events.map((event) => [event.action, event.detail.before])).toEqual([
      ["budget.set", null],
      ["budget.set", 50 * DOLLAR],
    ]);
    expect((await set("company", null)).status).toBe(200);
    expect((await page()).company.limitMicros).toBeNull();
  });

  it("tell a person once when their limit is near, and refuse a run at it", async () => {
    await set("everyone", 10 * DOLLAR);
    await spend("mo@acme.test", 7.9);
    turns = [{ cost: 0, goesOn: false }];
    asked = 0;
    expect(await refusal(mo)).toBeNull();
    expect(await notices(mo)).toEqual([]);
    // Past four fifths: told, and told once however many runs follow.
    await spend("mo@acme.test", 0.2);
    await h.runs.budgets.tell(orgId, ids["mo@acme.test"] as string);
    await h.runs.budgets.tell(orgId, ids["mo@acme.test"] as string);
    expect(await notices(mo)).toMatchObject([
      { kind: "budget_near", detail: { scope: "person", limit: String(10 * DOLLAR) } },
    ]);
    expect(await refusal(mo)).toBeNull();
    // At the limit nothing new starts, and the refusal says whose limit it is.
    await spend("mo@acme.test", 1.9);
    asked = 0;
    expect(await refusal(mo)).toBe("budget_person");
    expect(asked).toBe(0);
    await new Promise((done) => setTimeout(done, 50));
    expect((await notices(mo)).map((notice) => notice.kind)).toEqual([
      "budget_reached",
      "budget_near",
    ]);
    // Somebody else's own spending is their own.
    expect(await refusal(owner)).toBeNull();
    expect(await notices(owner)).toEqual([]);
    // The person sees where they stand.
    const mine = await json<{
      month: { scope: string; limitMicros: number; spentMicros: number }[];
    }>(await h.api(mo, "GET", "/api/app/usage"));
    expect(mine.month).toEqual([
      { scope: "person", share: 1, limitMicros: 10 * DOLLAR, spentMicros: 10 * DOLLAR },
    ]);
  });

  it("let a limit of a person's own stand in place of everyone's, and a raised one tell again", async () => {
    expect((await set("person", 20 * DOLLAR, ids["mo@acme.test"])).status).toBe(200);
    expect(await refusal(mo)).toBeNull();
    expect((await page()).people.find((one) => one.email === "mo@acme.test")).toMatchObject({
      limitMicros: 20 * DOLLAR,
      spentMicros: 10 * DOLLAR,
    });
    await spend("mo@acme.test", 6.5);
    await h.runs.budgets.tell(orgId, ids["mo@acme.test"] as string);
    expect((await notices(mo)).map((notice) => notice.kind)).toEqual([
      "budget_near",
      "budget_reached",
      "budget_near",
    ]);
    await set("person", null, ids["mo@acme.test"]);
    await set("everyone", null);
    expect(await refusal(mo)).toBeNull();
  });

  it("hold for a department and for the company, and tell the administrators", async () => {
    // Mo has spent 16.5 this month, all of it in Sales.
    await set("department", 16 * DOLLAR, sales);
    expect(await refusal(mo)).toBe("budget_department");
    expect(await refusal(owner)).toBeNull();
    await new Promise((done) => setTimeout(done, 50));
    expect(await notices(owner)).toMatchObject([
      { kind: "budget_reached", detail: { scope: "department", name: "Sales" } },
    ]);
    expect(await notices(mo)).toHaveLength(3);
    expect((await page()).departments[0]).toMatchObject({
      limitMicros: 16 * DOLLAR,
      spentMicros: 16.5 * DOLLAR,
    });
    // The company's is the widest: it is the one named when both are reached.
    await set("company", 16 * DOLLAR);
    expect(await refusal(mo)).toBe("budget_company");
    expect(await refusal(owner)).toBe("budget_company");
    await set("company", null);
    await set("department", null, sales);
  });

  it("count a calendar month and nothing before it", async () => {
    await set("everyone", 5 * DOLLAR);
    // Forty days ago is always another month.
    await spend("owner@acme.test", 400, 40);
    expect(await refusal(owner)).toBeNull();
    expect((await page()).people.find((one) => one.email === "owner@acme.test")).toMatchObject({
      spentMicros: 0,
    });
    await set("everyone", null);
  });

  it("stop a run that is going at the limit, after the call that reached it", async () => {
    await set("person", 2 * DOLLAR, ids["owner@acme.test"]);
    turns = [
      { cost: 1.5, goesOn: true },
      { cost: 1, goesOn: true },
      { cost: 1, goesOn: false },
    ];
    asked = 0;
    const { response, conversation } = await say(owner);
    expect(response.status).toBe(200);
    // The second asking reached the limit; the third was never made.
    expect(asked).toBe(2);
    const view = await json<{ messages: { status: string; ending: string | null }[] }>(
      await h.api(owner, "GET", `/api/app/conversations/${conversation}`),
    );
    expect(view.messages.at(-1)).toMatchObject({ status: "stopped", ending: "budget_person" });
    expect(await refusal(owner)).toBe("budget_person");
    // A reply that ends as it reaches the limit is left whole.
    await set("person", 10 * DOLLAR, ids["owner@acme.test"]);
    turns = [{ cost: 50, goesOn: false }];
    asked = 0;
    const whole = await say(owner);
    const after = await json<{ messages: { status: string; ending: string | null }[] }>(
      await h.api(owner, "GET", `/api/app/conversations/${whole.conversation}`),
    );
    expect(after.messages.at(-1)).toMatchObject({ status: "complete", ending: null });
    expect(await refusal(owner)).toBe("budget_person");
    await set("person", null, ids["owner@acme.test"]);
  });

  it("stop two runs at once each after its own next call", async () => {
    await set("company", 3 * DOLLAR);
    await h.db.query("delete from traces");
    turns = Array.from({ length: 12 }, () => ({ cost: 1, goesOn: true }));
    asked = 0;
    const [a, b] = await Promise.all([say(owner), say(mo)]);
    expect([a.response.status, b.response.status]).toEqual([200, 200]);
    const spent = (await page()).company.spentMicros;
    // Both stopped: the limit is passed by no more than what the calls under way cost.
    expect(spent).toBeGreaterThanOrEqual(3 * DOLLAR);
    expect(spent).toBeLessThanOrEqual(6 * DOLLAR);
    expect(asked).toBeLessThan(12);
    expect(await refusal(mo)).toBe("budget_company");
    await set("company", null);
  });

  it("say when nothing is counted because the model has no price", async () => {
    const free = await harness({ MUSTER_MODEL_INPUT_PRICE: "0", MUSTER_MODEL_OUTPUT_PRICE: "0" });
    const cookie = (await free.signIn("owner@acme.test")).cookie as string;
    expect(await json<Page>(await free.api(cookie, "GET", "/api/budgets"))).toMatchObject({
      priced: false,
    });
  });
});
