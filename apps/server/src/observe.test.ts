import { beforeAll, describe, expect, it } from "vitest";
import { seedTraces } from "./dev/seed-traces.js";
import { type Harness, harness } from "./test-support.js";

let h: Harness;
let owner: string;
let auditor: string;
let member: string;

const json = async <T = Record<string, unknown>>(response: Response) =>
  (await response.json()) as T;
interface TraceRow {
  id: string;
  status: string;
  durationMs: number;
  maxAction: string;
  venue: string;
  agentId: string;
  agentName: string;
  input: string;
  costMicros: number;
  annotations: number;
  conversationId: string;
}
const traces = async (query = "", as = owner) =>
  json<{ rows: TraceRow[]; summary: Record<string, number> }>(
    await h.api(
      as,
      "GET",
      `/api/traces?limit=100${query.includes("range=") ? "" : "&range=90d"}${query}`,
    ),
  );

beforeAll(async () => {
  h = await harness();
  owner = (await h.signIn("owner@acme.test")).cookie as string;
  for (const [email, role] of [
    ["auditor@acme.test", "auditor"],
    ["member@acme.test", "member"],
  ]) {
    await h.api(owner, "POST", "/api/invitations", { email, role });
  }
  auditor = (await h.signIn("auditor@acme.test")).cookie as string;
  member = (await h.signIn("member@acme.test")).cookie as string;
  const { org_id } = (
    await h.db.query<{ org_id: string }>("select org_id from memberships limit 1")
  )[0] as { org_id: string };
  const people = await h.db.query<{ id: string; email: string }>("select id, email from users");
  await h.db.tx((tx) =>
    seedTraces(tx, org_id, people, Date.now(), { id: "test-model", inputPrice: 1, outputPrice: 4 }),
  );
});

describe("the trace list", () => {
  it("returns runs newest first with a summary of everything that matches", async () => {
    const { rows, summary } = await traces();
    expect(rows.length).toBe(100);
    expect(summary.total).toBeGreaterThan(200);
    const times = rows.map((r) => (r as unknown as { startedAt: string }).startedAt);
    expect([...times].sort().reverse()).toEqual(times);
    expect(summary.p95).toBeGreaterThanOrEqual(summary.p50 as number);
    expect(summary.errors).toBeGreaterThan(0);
  });

  it("filters by status, action level, venue and agent, and the summary follows the filter", async () => {
    const blocked = await traces("&status=blocked");
    expect(blocked.rows.length).toBeGreaterThan(0);
    expect(new Set(blocked.rows.map((r) => r.status))).toEqual(new Set(["blocked"]));
    expect(blocked.summary.total).toBe(blocked.summary.blocked);

    const two = await traces("&status=error,blocked");
    expect(new Set(two.rows.map((r) => r.status))).toEqual(new Set(["error", "blocked"]));
    expect((await traces("&status=awaiting_approval")).summary.total).toBe(0);

    // Only agents that hold web.send can reach A3, and no tool reaches A4.
    const a3 = await traces("&level=A3");
    expect(new Set(a3.rows.map((r) => r.maxAction))).toEqual(new Set(["A3"]));
    expect(new Set(a3.rows.map((r) => r.agentName))).toEqual(
      new Set(["Messenger", "Release announcer", "Social posting"]),
    );
    expect((await traces("&level=A4")).summary.total).toBe(0);

    // Every run so far happens in the cloud workspace.
    const cloud = await traces("&venue=cloud");
    expect(cloud.summary.total).toBe((await traces()).summary.total);
    expect((await traces("&venue=device")).summary.total).toBe(0);

    const agentId = a3.rows[0]?.agentId as string;
    const byAgent = await traces(`&agent=${agentId}`);
    expect(new Set(byAgent.rows.map((r) => r.agentId))).toEqual(new Set([agentId]));
  });

  it("searches text, and treats wildcard characters as plain text", async () => {
    const found = await traces("&q=supplier agreement");
    expect(found.rows.length).toBeGreaterThan(0);
    expect(found.rows.every((r) => r.input.toLowerCase().includes("supplier agreement"))).toBe(
      true,
    );
    expect((await traces("&q=%25")).summary.total).toBe(0);
    expect((await traces("&q=_")).summary.total).toBe(0);
  });

  it("sorts and pages", async () => {
    const slow = await traces("&sort=duration&dir=desc");
    const durations = slow.rows.map((r) => r.durationMs);
    expect([...durations].sort((a, b) => b - a)).toEqual(durations);
    const first = await json<{ rows: TraceRow[] }>(
      await h.api(owner, "GET", "/api/traces?range=90d&limit=5"),
    );
    const second = await json<{ rows: TraceRow[] }>(
      await h.api(owner, "GET", "/api/traces?range=90d&limit=5&offset=5"),
    );
    expect(first.rows.map((r) => r.id)).not.toEqual(second.rows.map((r) => r.id));
    expect(new Set([...first.rows, ...second.rows].map((r) => r.id)).size).toBe(10);
  });

  it("respects the time range", async () => {
    const day = await traces("&range=24h");
    const month = await traces("&range=30d");
    expect(day.summary.total).toBeLessThan(month.summary.total as number);
  });

  it("rejects filters it does not understand", async () => {
    for (const bad of [
      "status=weird",
      "range=1y",
      "level=A9",
      "agent=nope",
      "sort=name",
      "limit=1000",
    ]) {
      expect((await h.api(owner, "GET", `/api/traces?${bad}`)).status, bad).toBe(400);
    }
  });

  it("is closed to people who may not read traces", async () => {
    expect((await h.api(member, "GET", "/api/traces")).status).toBe(403);
    expect((await h.api(null, "GET", "/api/traces")).status).toBe(401);
    expect((await h.api(auditor, "GET", "/api/traces")).status).toBe(200);
  });
});

describe("one trace", () => {
  it("returns its spans as a tree with one root, in order", async () => {
    const { rows } = await traces("&level=A3");
    const detail = await json<{
      trace: TraceRow;
      spans: {
        id: string;
        parentId: string | null;
        seq: number;
        kind: string;
        startOffsetMs: number;
        durationMs: number;
      }[];
    }>(await h.api(owner, "GET", `/api/traces/${rows[0]?.id}`));
    const roots = detail.spans.filter((s) => s.parentId === null);
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({
      kind: "agent",
      seq: 0,
      startOffsetMs: 0,
      durationMs: detail.trace.durationMs,
    });
    const ids = new Set(detail.spans.map((s) => s.id));
    expect(detail.spans.every((s) => s.parentId === null || ids.has(s.parentId))).toBe(true);
    expect(detail.spans.map((s) => s.seq)).toEqual(detail.spans.map((_, i) => i));
    expect(detail.spans.some((s) => s.kind === "policy")).toBe(true);
    // No step runs past the end of the run.
    expect(
      detail.spans.every((s) => s.startOffsetMs + s.durationMs <= detail.trace.durationMs),
    ).toBe(true);
  });

  it("adds up: the run's tokens and cost are the sum of its model calls", async () => {
    const { rows } = await traces("&status=ok");
    const detail = await json<{
      trace: { promptTokens: number; completionTokens: number; costMicros: number };
      spans: { kind: string; promptTokens: number; completionTokens: number; costMicros: number }[];
    }>(await h.api(owner, "GET", `/api/traces/${rows[0]?.id}`));
    const llm = detail.spans.filter((s) => s.kind === "llm");
    expect(llm.reduce((n, s) => n + s.promptTokens, 0)).toBe(detail.trace.promptTokens);
    expect(llm.reduce((n, s) => n + s.completionTokens, 0)).toBe(detail.trace.completionTokens);
    expect(llm.reduce((n, s) => n + s.costMicros, 0)).toBe(detail.trace.costMicros);
  });

  it("puts on the record who opened someone else's run, once, and the record can be searched and exported", async () => {
    // A run that is not the reader's own: whose the newest sample run is changes with the
    // hour the test runs at, and opening one's own run is not put on the record.
    const run = (await traces()).rows.find(
      (row) => (row as unknown as { userEmail: string }).userEmail !== "auditor@acme.test",
    ) as TraceRow;
    const opened = () =>
      h.db.query<{ actor_email: string }>(
        "select actor_email from admin_events where action = 'trace.viewed' and target_id = $1",
        [run.id],
      );
    await h.api(auditor, "GET", `/api/traces/${run.id}`);
    await h.api(auditor, "GET", `/api/traces/${run.id}`);
    expect((await opened()).filter((row) => row.actor_email === "auditor@acme.test")).toHaveLength(
      1,
    );

    const found = await json<{ action: string; actorEmail: string }[]>(
      await h.api(owner, "GET", "/api/audit?q=trace.viewed&limit=100"),
    );
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((row) => row.action === "trace.viewed")).toBe(true);
    // A day in the past holds nothing; a day that is not a day is refused.
    expect(await json(await h.api(owner, "GET", "/api/audit?to=2000-01-01"))).toEqual([]);
    expect((await h.api(owner, "GET", "/api/audit?from=yesterday")).status).toBe(400);
    expect((await h.api(owner, "GET", "/api/audit?from=2026-02-30")).status).toBe(400);
    // Words the reader sees find the action behind them: the page sends its name along.
    const byLabel = await json<{ action: string }[]>(
      await h.api(owner, "GET", "/api/audit?q=Opened%20someone&actions=trace.viewed&limit=100"),
    );
    expect(byLabel.some((row) => row.action === "trace.viewed")).toBe(true);

    const file = await h.api(auditor, "GET", "/api/audit/export?q=trace.viewed");
    expect(file.headers.get("content-type")).toContain("text/csv");
    const text = await file.text();
    expect(text).toContain("time,actor,action");
    expect(text).toContain("auditor@acme.test");
    expect(
      await h.db.query("select 1 from admin_events where action = 'audit.exported'"),
    ).toHaveLength(1);
    expect((await h.api(member, "GET", "/api/audit/export")).status).toBe(403);
  });

  it("is not found for an unknown or malformed id", async () => {
    expect(
      (await h.api(owner, "GET", "/api/traces/0198c3a0-0000-7000-8000-000000000000")).status,
    ).toBe(404);
    expect((await h.api(owner, "GET", "/api/traces/nope")).status).toBe(404);
  });
});

describe("annotations", () => {
  it("lets an administrator annotate a run or one step, shows it, counts it, records it, and removes it", async () => {
    const { rows } = await traces();
    const traceId = rows[0]?.id as string;
    const detail = await json<{ spans: { id: string }[] }>(
      await h.api(owner, "GET", `/api/traces/${traceId}`),
    );
    const spanId = detail.spans[1]?.id as string;

    const onTrace = await json<{ id: string }>(
      await h.api(owner, "POST", `/api/traces/${traceId}/annotations`, {
        label: "correct",
        score: 1,
      }),
    );
    await h.api(owner, "POST", `/api/traces/${traceId}/annotations`, {
      spanId,
      label: "slow",
      note: "Took too long.",
    });

    const after = await json<{
      annotations: {
        id: string;
        label: string;
        spanId: string | null;
        score: number | null;
        authorEmail: string;
        note: string;
      }[];
    }>(await h.api(owner, "GET", `/api/traces/${traceId}`));
    expect(after.annotations).toMatchObject([
      { label: "correct", spanId: null, score: 1, authorEmail: "owner@acme.test" },
      { label: "slow", spanId, score: null, note: "Took too long." },
    ]);
    expect((await traces()).rows.find((r) => r.id === traceId)?.annotations).toBe(2);

    expect((await h.api(owner, "DELETE", `/api/annotations/${onTrace.id}`)).status).toBe(200);
    expect((await h.api(owner, "DELETE", `/api/annotations/${onTrace.id}`)).status).toBe(404);
    const events = await json<{ action: string }[]>(
      await h.api(owner, "GET", "/api/audit?limit=20"),
    );
    expect(events.map((e) => e.action)).toEqual(
      expect.arrayContaining(["trace.annotated", "trace.annotation_removed"]),
    );
  });

  it("refuses bad input, unknown traces, a step from another trace, and the read-only auditor", async () => {
    const { rows } = await traces();
    const [a, b] = [rows[0]?.id as string, rows[1]?.id as string];
    const otherSpan = (
      await json<{ spans: { id: string }[] }>(await h.api(owner, "GET", `/api/traces/${b}`))
    ).spans[0]?.id;
    expect((await h.api(owner, "POST", `/api/traces/${a}/annotations`, { label: "" })).status).toBe(
      400,
    );
    expect(
      (await h.api(owner, "POST", `/api/traces/${a}/annotations`, { label: "x", score: 2 })).status,
    ).toBe(400);
    expect(
      (
        await h.api(owner, "POST", `/api/traces/${a}/annotations`, {
          label: "x",
          spanId: otherSpan,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await h.api(owner, "POST", "/api/traces/0198c3a0-0000-7000-8000-000000000000/annotations", {
          label: "x",
        })
      ).status,
    ).toBe(404);
    expect(
      (await h.api(auditor, "POST", `/api/traces/${a}/annotations`, { label: "x" })).status,
    ).toBe(403);
  });
});

describe("spans, conversations and agents", () => {
  it("lists steps across runs, filtered by kind", async () => {
    const tools = await json<{ rows: { kind: string; traceId: string }[]; total: number }>(
      await h.api(owner, "GET", "/api/spans?range=90d&kind=tool,retriever&limit=100"),
    );
    expect(tools.total).toBeGreaterThan(100);
    expect(new Set(tools.rows.map((r) => r.kind))).toEqual(new Set(["tool", "retriever"]));
    const llm = await json<{ total: number }>(
      await h.api(owner, "GET", "/api/spans?range=90d&kind=llm&status=blocked"),
    );
    const all = await json<{ total: number }>(
      await h.api(owner, "GET", "/api/spans?range=90d&kind=llm"),
    );
    expect(llm.total).toBeLessThan(all.total);
  });

  it("groups runs into conversations and returns a conversation's turns in order", async () => {
    const list = await json<{ id: string; traces: number }[]>(
      await h.api(owner, "GET", "/api/conversations?range=90d"),
    );
    const multi = list.find((c) => c.traces > 1) as { id: string; traces: number };
    expect(multi).toBeTruthy();
    const turns = await json<{ startedAt: string; conversationId: string }[]>(
      await h.api(owner, "GET", `/api/conversations/${multi.id}`),
    );
    expect(turns).toHaveLength(multi.traces);
    expect(new Set(turns.map((t) => t.conversationId))).toEqual(new Set([multi.id]));
    expect([...turns.map((t) => t.startedAt)].sort()).toEqual(turns.map((t) => t.startedAt));
  });

  it("lists agents with their recent activity", async () => {
    const agents = await json<
      { name: string; risk: string; state: string; runs: number; version: string }[]
    >(await h.api(owner, "GET", "/api/agents"));
    expect(agents).toHaveLength(9);
    expect(agents.find((a) => a.name === "Competitor watch")).toMatchObject({
      risk: "R3",
      state: "pending",
      runs: 0,
    });
    expect(agents.every((a) => /^[0-9a-f]{64}$/.test(a.version))).toBe(true);
    expect((await h.api(member, "GET", "/api/agents")).status).toBe(403);
  });
});

describe("saved views", () => {
  it("saves, replaces by name, lists only the person's own, and deletes", async () => {
    const saved = await json<{ id: string }>(
      await h.api(owner, "POST", "/api/views", {
        name: "Blocked",
        filters: { range: "7d", status: "blocked" },
      }),
    );
    const replaced = await json<{ id: string }>(
      await h.api(owner, "POST", "/api/views", {
        name: "Blocked",
        filters: { range: "30d", status: "blocked" },
      }),
    );
    expect(replaced.id).toBe(saved.id);
    expect(await json(await h.api(owner, "GET", "/api/views"))).toEqual([
      { id: saved.id, name: "Blocked", filters: { range: "30d", status: "blocked" } },
    ]);
    expect(await json(await h.api(auditor, "GET", "/api/views"))).toEqual([]);
    expect((await h.api(auditor, "DELETE", `/api/views/${saved.id}`)).status).toBe(404);
    expect(
      (await h.api(owner, "POST", "/api/views", { name: "Bad", filters: { status: "nonsense" } }))
        .status,
    ).toBe(400);
    // A key the trace list does not understand would break a page when the view is applied.
    for (const filters of [
      { range: "7d", kind: "bogus" },
      { range: "7d", sort: "x" },
    ]) {
      expect((await h.api(owner, "POST", "/api/views", { name: "Bad", filters })).status).toBe(400);
    }
    expect((await h.api(owner, "DELETE", `/api/views/${saved.id}`)).status).toBe(200);
    expect(await json(await h.api(owner, "GET", "/api/views"))).toEqual([]);
  });
});

describe("export", () => {
  it("exports what the filters match, records that it happened, and defuses spreadsheet formulas", async () => {
    const { org_id } = (
      await h.db.query<{ org_id: string }>("select org_id from memberships limit 1")
    )[0] as { org_id: string };
    await h.db.query(
      "update traces set input = '=HYPERLINK(\"http://evil.test\")', output = 'a \"quoted\", value' where id = (select id from traces where org_id = $1 and status = 'blocked' order by started_at desc limit 1)",
      [org_id],
    );
    const response = await h.api(owner, "GET", "/api/traces/export.csv?range=90d&status=blocked");
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    const text = await response.text();
    const lines = text.trim().split("\r\n");
    expect(lines[0]).toMatch(/^id,startedAt,status,/);
    expect(lines.length - 1).toBe((await traces("&status=blocked")).summary.total);
    expect(lines.slice(1).every((line) => line.includes(",blocked,"))).toBe(true);
    expect(text).toContain("'=HYPERLINK");
    expect(text).not.toMatch(/,=HYPERLINK/);
    expect(text).toContain('"a ""quoted"", value"');
    const events = await json<{ action: string; detail: { rows: number } }[]>(
      await h.api(owner, "GET", "/api/audit?limit=5"),
    );
    expect(events[0]).toMatchObject({
      action: "traces.exported",
      detail: {
        rows: lines.length - 1,
        truncated: false,
        filters: { range: "90d", status: ["blocked"] },
      },
    });
    expect((await h.api(member, "GET", "/api/traces/export.csv")).status).toBe(403);
  });
});

describe("the dashboard's activity", () => {
  it("agrees with the trace list", async () => {
    const dashboard = await json<{
      activity: {
        totals: Record<string, number>;
        series: { ok: number; error: number; blocked: number; awaiting: number }[];
        byAgent: { runs: number }[];
        byLevel: { key: string }[];
        agents: { total: number; pending: number; byRisk: { key: string; value: number }[] };
        heat: { value: number }[];
      };
    }>(await h.api(owner, "GET", "/api/dashboard?range=30d"));
    const list = await traces("&range=30d");
    const { totals, series, byAgent, byLevel, agents, heat } = dashboard.activity;
    expect(totals.runs).toBe(list.summary.total);
    expect(totals.errors).toBe(list.summary.errors);
    expect(totals.costMicros).toBe(list.summary.costMicros);
    expect(series.reduce((n, d) => n + d.ok + d.error + d.blocked + d.awaiting, 0)).toBe(
      totals.runs,
    );
    expect(byAgent.reduce((n, a) => n + a.runs, 0)).toBe(totals.runs);
    expect(heat.reduce((n, cell) => n + cell.value, 0)).toBe(totals.runs);
    // The sample runs start between 08:00 and 19:59 UTC, whatever zone the database is in.
    const hours = (heat as unknown as { hour: number }[]).map((cell) => cell.hour);
    expect(Math.min(...hours)).toBeGreaterThanOrEqual(8);
    expect(Math.max(...hours)).toBeLessThanOrEqual(20);
    // Only the levels some tool can reach appear.
    expect(byLevel.map((l) => l.key)).toEqual(["A0", "A1", "A3"]);
    expect(agents).toMatchObject({ total: 9, pending: 1 });
    expect(agents.byRisk.reduce((n, r) => n + r.value, 0)).toBe(9);
  });

  it("shows cost to the billing role without opening traces to it", async () => {
    await h.api(owner, "POST", "/api/invitations", { email: "bill@acme.test", role: "billing" });
    const billing = (await h.signIn("bill@acme.test")).cookie as string;
    const dashboard = await json<{ activity: { totals: { costMicros: number } } | null }>(
      await h.api(billing, "GET", "/api/dashboard"),
    );
    // Cost, yes; who is in the organization, no.
    expect((dashboard as unknown as { people: unknown }).people).toBeNull();
    expect(dashboard.activity?.totals.costMicros).toBeGreaterThan(0);
    expect((await h.api(billing, "GET", "/api/traces")).status).toBe(403);
  });
});
