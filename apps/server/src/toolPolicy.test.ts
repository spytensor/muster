import {
  type AssistantMessage,
  type Context,
  createAssistantMessageEventStream,
  type StreamFn,
} from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { type Harness, harness } from "./test-support.js";
import {
  basesInScope,
  covers,
  decide,
  decideFor,
  groupOf,
  OFF_REASON,
  OPEN,
  outsideScope,
  type Scope,
} from "./toolPolicy.js";
import { type Net, onHosts } from "./runtime/net.js";

const json = async <T = unknown>(response: Response): Promise<T> => (await response.json()) as T;
type Call = { name: string; args: Record<string, unknown> };

/** A model that makes the calls it is given, one a turn; null ends a reply with a word. */
function scripted(calls: (Call | null)[]) {
  const seen: Context[] = [];
  let at = 0;
  const streamFn: StreamFn = (model, context) => {
    seen.push({
      systemPrompt: context.systemPrompt,
      messages: structuredClone(context.messages),
      tools: context.tools?.map((tool) => ({ ...tool, execute: undefined })) as Context["tools"],
    });
    const call = calls[at++];
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      content: call
        ? [{ type: "toolCall", id: `call-${at}`, name: call.name, arguments: call.args }]
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
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: call ? "toolUse" : "stop",
      timestamp: Date.now(),
    };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: call ? "toolUse" : "stop", message });
      stream.end();
    });
    return stream;
  };
  return { streamFn, seen };
}

const names = (context: Context | undefined) => (context?.tools ?? []).map((tool) => tool.name);
const WRITE: Call = { name: "docs.write", args: { title: "Notes", content: "Buy milk." } };

/** A deployment with its owner, the Assistant, and the ways a test talks to it. */
async function world(calls: (Call | null)[], net?: Net) {
  const model = scripted(calls);
  const h: Harness = await harness({}, { streamFn: model.streamFn, ...(net ? { net } : {}) });
  const owner = (await h.signIn("owner@acme.test")).cookie as string;
  const { agents } = await json<{ agents: { id: string; name: string }[] }>(
    await h.api(owner, "GET", "/api/app/agents"),
  );
  const agentId = (name: string) => agents.find((agent) => agent.name === name)?.id as string;
  const begin = async (as: string, agent = "Assistant") =>
    (
      await json<{ id: string }>(
        await h.api(as, "POST", "/api/app/conversations", { agentId: agentId(agent) }),
      )
    ).id;
  const say = async (as: string, conversation: string, content = "Write it down.") => {
    await h.api(as, "POST", `/api/app/conversations/${conversation}/messages`, { content });
    await h.runs.settled(conversation);
  };
  const rule = (tool: string, effect: string, departmentId: string | null = null) =>
    h.api(owner, "PUT", "/api/policies/tools", { tool, departmentId, effect });
  const scope = (agent: string, value: Scope | null) =>
    h.api(owner, "PUT", `/api/policies/scopes/${agent}`, { scope: value });
  const documents = async (as: string) =>
    (await json<{ title: string }[]>(await h.api(as, "GET", "/api/app/documents"))).map(
      (document) => document.title,
    );
  /** What the agent was told came of its last call. */
  const told = () => JSON.stringify(model.seen.at(-1)?.messages.at(-1));
  /** The policy checks on the record of a conversation's latest reply. */
  const checks = async (conversation: string) => {
    const detail = await json<{ messages: { traceId?: string }[] }>(
      await h.api(owner, "GET", `/api/app/conversations/${conversation}`),
    );
    const traceId = detail.messages.at(-1)?.traceId as string;
    const recorded = await json<{
      trace: { status: string };
      spans: { kind: string; status: string; attributes: Record<string, unknown> }[];
    }>(await h.api(owner, "GET", `/api/traces/${traceId}`));
    return {
      status: recorded.trace.status,
      policies: recorded.spans
        .filter((span) => span.kind === "policy")
        .map((span) => span.attributes.policyId),
    };
  };
  return { h, model, owner, agentId, begin, say, rule, scope, documents, told, checks };
}

describe("the organization's tool policy: what the rules say", () => {
  it("takes a department's word before everyone's, and a tool's own rule before its connector's", () => {
    const sales = "d-sales";
    expect(decide([], "docs.write")).toBe("allow");
    expect(decide([{ tool: "docs.write", departmentId: null, effect: "off" }], "docs.write")).toBe(
      "off",
    );
    expect(
      decide(
        [
          { tool: "docs.write", departmentId: null, effect: "off" },
          { tool: "docs.write", departmentId: sales, effect: "ask" },
        ],
        "docs.write",
      ),
    ).toBe("ask");
    // A connector's rule covers its tools; one of them may be said otherwise.
    const crm = [
      { tool: "company.crm.*", departmentId: null, effect: "off" as const },
      { tool: "company.crm.find", departmentId: null, effect: "allow" as const },
    ];
    expect(decide(crm, "company.crm.delete")).toBe("off");
    expect(decide(crm, "company.crm.find")).toBe("allow");
    expect(decide(crm, "company.crmx.find")).toBe("allow");
    // A department's rule on the connector outweighs everyone's rule on the tool.
    expect(
      decide(
        [...crm, { tool: "company.crm.*", departmentId: sales, effect: "ask" }],
        "company.crm.find",
      ),
    ).toBe("ask");
    // A tool on the person's computer stands in for the tools it needs: it is held to
    // their rules as well as its own, and to the most any of them is left.
    const off = (tool: string) => ({ tool, departmentId: null, effect: "off" as const });
    expect(decideFor([off("files.read")], "local.read")).toBe("off");
    expect(decideFor([off("files.read")], "local.search")).toBe("off");
    // Listing a folder stands in for listing or reading: one of the two is left.
    expect(decideFor([off("files.read")], "local.list")).toBe("allow");
    expect(decideFor([off("files.read"), off("files.list")], "local.list")).toBe("off");
    expect(
      decideFor(
        [off("files.read"), { tool: "files.list", departmentId: null, effect: "ask" }],
        "local.list",
      ),
    ).toBe("ask");
    expect(decideFor([off("files.create"), off("docs.write")], "local.exec")).toBe("off");
    expect(decideFor([off("local.exec")], "local.exec")).toBe("off");
    expect(decideFor([off("files.read")], "files.list")).toBe("allow");
    expect(covers("company.crm.*", "company.crm.find")).toBe(true);
    expect(covers("company.crm.*", "company.crm2.find")).toBe(false);
    expect(groupOf("m365.mail")).toBe("mail");
    expect(groupOf("m365.files")).toBe("files");
    expect(groupOf("local.exec")).toBe("code");
    expect(groupOf("company.crm.find")).toBe("connectors");
  });

  it("holds an agent to what it may reach: files, mail, sites, knowledge bases, connector tools", () => {
    expect(outsideScope(OPEN, "files.read", { name: "a" })).toBeNull();
    expect(outsideScope({ ...OPEN, files: false }, "files.read", {})).toContain("files");
    expect(outsideScope({ ...OPEN, files: false }, "m365.files", {})).toContain("files");
    // Making a file is not reading the person's.
    expect(outsideScope({ ...OPEN, files: false }, "files.create", {})).toBeNull();
    expect(outsideScope({ ...OPEN, mail: false }, "m365.calendar", {})).toContain("mail");
    expect(outsideScope({ ...OPEN, mail: false }, "files.read", {})).toBeNull();
    const sites: Scope = { ...OPEN, web: ["example.com"] };
    expect(outsideScope(sites, "web.fetch", { url: "https://example.com/a" })).toBeNull();
    expect(outsideScope(sites, "web.fetch", { url: "https://docs.example.com/a" })).toBeNull();
    expect(outsideScope(sites, "web.fetch", { url: "https://notexample.com/a" })).toContain(
      "notexample.com",
    );
    expect(outsideScope(sites, "web.send", { url: "https://evil.test/hook" })).toContain("evil");
    expect(outsideScope(sites, "web.fetch", { url: "not an address" })).not.toBeNull();
    // A search brings back any site: an agent held to a list does not search.
    expect(outsideScope(sites, "web.search", { query: "x" })).toContain("may not search");
    expect(outsideScope(OPEN, "web.search", { query: "x" })).toBeNull();
    // Every way of reading the person's files is a way of reading them: their folders on
    // their own computer, a command there, and code run over files put in the sandbox.
    const blind: Scope = { ...OPEN, files: false };
    for (const tool of [
      "local.read",
      "local.search",
      "local.find",
      "local.list",
      "local.exec",
      "local.job",
    ])
      expect(outsideScope(blind, tool, {})).toContain("files");
    expect(outsideScope(blind, "local.write", {})).toBeNull();
    expect(outsideScope(blind, "code.run", { code: "print(1)", files: ["a.csv"] })).toContain(
      "sandbox",
    );
    expect(outsideScope(blind, "code.run", { code: "print(1)", files: [] })).toBeNull();
    expect(outsideScope(blind, "code.run", { code: "print(1)" })).toBeNull();
    expect(outsideScope(OPEN, "code.run", { code: "x", files: ["a.csv"] })).toBeNull();
    expect(onHosts(["example.com"], "https://docs.example.com/a")).toBe(true);
    expect(onHosts(["example.com"], "https://example.com.evil.test/a")).toBe(false);
    expect(onHosts(["example.com"], "not an address")).toBe(false);
    const some: Scope = { ...OPEN, knowledge: ["b1"] };
    expect(outsideScope(some, "knowledge.search", {}, ["b1", "b2"])).toBeNull();
    expect(outsideScope(some, "knowledge.search", {}, ["b2"])).toContain("knowledge");
    expect(basesInScope(some, ["b1", "b2"])).toEqual(["b1"]);
    expect(basesInScope(OPEN, ["b1", "b2"])).toEqual(["b1", "b2"]);
    const tools: Scope = { ...OPEN, connectors: ["company.crm.find", "company.erp.*"] };
    expect(outsideScope(tools, "company.crm.find", {})).toBeNull();
    expect(outsideScope(tools, "company.erp.anything", {})).toBeNull();
    expect(outsideScope(tools, "company.crm.delete", {})).toContain("connector");
  });
});

describe("the organization's tool policy: a tool switched off", () => {
  it("is not offered to a conversation begun afterwards", async () => {
    const w = await world([null, null]);
    const before = await w.begin(w.owner);
    await w.say(w.owner, before, "Hello");
    expect(names(w.model.seen[0])).toContain("docs.write");
    expect((await w.rule("docs.write", "off")).status).toBe(200);
    const after = await w.begin(w.owner);
    await w.say(w.owner, after, "Hello");
    expect(names(w.model.seen[1])).not.toContain("docs.write");
    expect(names(w.model.seen[1])).toContain("docs.read");
  });

  it("is refused at the gateway in a conversation that was already going, whose tools and instructions do not change", async () => {
    const w = await world([
      WRITE,
      null,
      { ...WRITE, args: { title: "Later", content: "x" } },
      null,
      null,
    ]);
    const conversation = await w.begin(w.owner);
    await w.say(w.owner, conversation);
    expect(await w.documents(w.owner)).toEqual(["Notes"]);
    const first = w.model.seen[0] as Context;

    expect((await w.rule("docs.write", "off")).status).toBe(200);
    await w.say(w.owner, conversation, "And this.");
    const later = w.model.seen[2] as Context;
    // What the model is sent is what it was sent before, to the letter.
    expect(JSON.stringify(later.tools)).toBe(JSON.stringify(first.tools));
    expect(later.systemPrompt).toBe(first.systemPrompt);
    expect(names(later)).toContain("docs.write");
    // The call was refused, the agent was told why, and nothing was written.
    expect(w.told()).toContain(OFF_REASON.slice(0, 40));
    expect(await w.documents(w.owner)).toEqual(["Notes"]);
    expect(await w.checks(conversation)).toEqual({ status: "blocked", policies: ["org-tool-off"] });

    // Switched on again, the same conversation writes again; its tools are still the same.
    expect((await w.rule("docs.write", "allow")).status).toBe(200);
    await w.say(w.owner, conversation, "Once more.");
    expect(JSON.stringify(w.model.seen.at(-1)?.tools)).toBe(JSON.stringify(first.tools));
  });

  it("asks the person every time when the rule is to ask, whatever their own mode says", async () => {
    const w = await world([WRITE, null]);
    expect((await w.rule("docs.write", "ask")).status).toBe(200);
    const conversation = await w.begin(w.owner);
    // The person lets agents do everything without asking: this is still asked.
    await w.h.api(w.owner, "PATCH", `/api/app/conversations/${conversation}`, { mode: "full" });
    await w.h.api(w.owner, "POST", `/api/app/conversations/${conversation}/messages`, {
      content: "Write it down.",
    });
    let approval: { id: string; tool: string } | undefined;
    for (let i = 0; i < 400 && !approval; i++) {
      approval = (
        await json<{ id: string; status: string; tool: string }[]>(
          await w.h.api(w.owner, "GET", "/api/app/approvals"),
        )
      ).find((item) => item.status === "pending");
      if (!approval) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(approval?.tool).toBe("docs.write");
    expect(await w.documents(w.owner)).toEqual([]);
    await w.h.api(w.owner, "POST", `/api/app/approvals/${approval?.id}`, { decision: "approve" });
    await w.h.runs.settled(conversation);
    expect(await w.documents(w.owner)).toEqual(["Notes"]);
    expect((await w.checks(conversation)).policies).toEqual(["confirm-org-policy"]);
  });

  it("goes by the person's department where it has a rule of its own", async () => {
    const w = await world([WRITE, null, WRITE, null]);
    await w.h.api(w.owner, "POST", "/api/invitations", { email: "mo@acme.test", role: "member" });
    const mo = (await w.h.signIn("mo@acme.test")).cookie as string;
    const sales = (
      await json<{ id: string }>(
        await w.h.api(w.owner, "POST", "/api/departments", { name: "Sales" }),
      )
    ).id;
    const members = await w.h.db.query<{ id: string }>(
      "select id from users where email = 'mo@acme.test'",
    );
    await w.h.api(w.owner, "PATCH", `/api/members/${members[0]?.id}`, { departmentId: sales });
    // Off for everyone, allowed for Sales.
    expect((await w.rule("docs.write", "off")).status).toBe(200);
    expect((await w.rule("docs.write", "allow", sales)).status).toBe(200);

    const theirs = await w.begin(mo);
    await w.say(mo, theirs);
    expect(names(w.model.seen[0])).toContain("docs.write");
    expect(await w.documents(mo)).toEqual(["Notes"]);

    const mine = await w.begin(w.owner);
    await w.say(w.owner, mine);
    expect(names(w.model.seen[2])).not.toContain("docs.write");
    expect(await w.documents(w.owner)).toEqual([]);

    // Taking the department's own word away leaves it with everyone's.
    expect((await w.rule("docs.write", "inherit", sales)).status).toBe(200);
    const page = await json<{
      rules: { tool: string; departmentId: string | null; effect: string }[];
    }>(await w.h.api(w.owner, "GET", "/api/policies/tools"));
    expect(page.rules).toEqual([{ tool: "docs.write", departmentId: null, effect: "off" }]);
  });
});

describe("the organization's tool policy: what an agent may reach", () => {
  it("refuses a site off its list and the person's files where it may not read them, for that agent only", async () => {
    const w = await world([
      { name: "web.fetch", args: { url: "https://elsewhere.test/page" } },
      null,
      { name: "files.list", args: {} },
      null,
      { name: "files.list", args: {} },
      null,
    ]);
    expect(
      (await w.scope(w.agentId("Assistant"), { ...OPEN, files: false, web: ["Example.com"] }))
        .status,
    ).toBe(200);
    const conversation = await w.begin(w.owner);
    // The person names the address, so nothing but the scope stands in its way.
    await w.say(w.owner, conversation, "Read https://elsewhere.test/page");
    expect(w.told()).toContain("only these sites: example.com");
    expect(await w.checks(conversation)).toEqual({ status: "blocked", policies: ["agent-scope"] });
    await w.say(w.owner, conversation, "List my files.");
    expect(w.told()).toContain("does not let this agent read the person's files");
    // The tool is still what it was offered: a scope is the gateway's, not the list's.
    expect(names(w.model.seen.at(-1))).toContain("files.list");

    // Another agent is not held to it.
    const other = await w.begin(w.owner, "Writer");
    await w.say(w.owner, other, "List my files.");
    expect(w.told()).not.toContain("does not let this agent");
  });

  it("falls back on the scope for every agent, and an agent's own stands in place of it", async () => {
    const w = await world([
      { name: "files.list", args: {} },
      null,
      { name: "files.list", args: {} },
      null,
    ]);
    expect((await w.scope("everyone", { ...OPEN, files: false })).status).toBe(200);
    const held = await w.begin(w.owner, "Writer");
    await w.say(w.owner, held, "List my files.");
    expect(w.told()).toContain("does not let this agent read the person's files");
    expect((await w.scope(w.agentId("Writer"), OPEN)).status).toBe(200);
    await w.say(w.owner, held, "List my files.");
    expect(w.told()).not.toContain("does not let this agent");
    // Taken away again, it is back to everyone's.
    expect((await w.scope(w.agentId("Writer"), null)).status).toBe(200);
    const page = await json<{
      scopes: { everyone: Scope | null; agents: { name: string; scope: Scope | null }[] };
    }>(await w.h.api(w.owner, "GET", "/api/policies/tools"));
    expect(page.scopes.everyone).toMatchObject({ files: false });
    expect(page.scopes.agents.find((agent) => agent.name === "Writer")?.scope).toBeNull();
  });
});

describe("the organization's tool policy: who may set it", () => {
  it("is for those who may change settings; an auditor reads; every change is on the record with what it was", async () => {
    const w = await world([]);
    await w.h.api(w.owner, "POST", "/api/invitations", { email: "aud@acme.test", role: "auditor" });
    await w.h.api(w.owner, "POST", "/api/invitations", { email: "mo@acme.test", role: "member" });
    const auditor = (await w.h.signIn("aud@acme.test")).cookie as string;
    const mo = (await w.h.signIn("mo@acme.test")).cookie as string;
    const put = (as: string, body: unknown) => w.h.api(as, "PUT", "/api/policies/tools", body);
    const rule = { tool: "web.send", departmentId: null, effect: "off" };
    expect((await w.h.api(mo, "GET", "/api/policies/tools")).status).toBe(403);
    expect((await put(mo, rule)).status).toBe(403);
    expect((await w.h.api(auditor, "GET", "/api/policies/tools")).status).toBe(200);
    expect((await put(auditor, rule)).status).toBe(403);
    expect(
      (await w.h.api(auditor, "PUT", "/api/policies/scopes/everyone", { scope: OPEN })).status,
    ).toBe(403);

    // What is not a rule is refused.
    for (const bad of [
      { ...rule, tool: "no.such.tool" },
      { ...rule, tool: "company.nothing.*" },
      { ...rule, effect: "maybe" },
      { ...rule, effect: "inherit" },
      { ...rule, departmentId: "01900000-0000-7000-8000-000000000000" },
    ])
      expect((await put(w.owner, bad)).status).toBe(400);
    expect(
      (
        await w.h.api(w.owner, "PUT", "/api/policies/scopes/everyone", {
          scope: { ...OPEN, web: ["https://example.com/path"] },
        })
      ).status,
    ).toBe(400);

    expect(await json(await put(w.owner, rule))).toEqual({ ok: true, changed: true });
    expect(await json(await put(w.owner, rule))).toEqual({ ok: true, changed: false });
    expect(await json(await put(w.owner, { ...rule, effect: "ask" }))).toMatchObject({
      changed: true,
    });
    await w.h.api(w.owner, "PUT", "/api/policies/scopes/everyone", {
      scope: { ...OPEN, mail: false },
    });
    const events = (
      await json<{ action: string; detail: Record<string, unknown>; targetLabel: string }[]>(
        await w.h.api(w.owner, "GET", "/api/audit"),
      )
    ).filter((event) => event.action.startsWith("policy."));
    expect(events.map((event) => [event.action, event.detail.before, event.detail.after])).toEqual([
      ["policy.scope_changed", null, { ...OPEN, mail: false }],
      ["policy.tool_changed", "off", "ask"],
      ["policy.tool_changed", "allow", "off"],
    ]);

    const page = await json<{ tools: { key: string; group: string }[] }>(
      await w.h.api(auditor, "GET", "/api/policies/tools"),
    );
    expect(page.tools.find((tool) => tool.key === "web.send")?.group).toBe("web");
    expect(page.tools.map((tool) => tool.key)).not.toContain("plan.set");
  });
});

describe("the organization's tool policy: what review found", () => {
  it("does not let a page forward an agent off its list of sites", async () => {
    const asked: { url: string; onlyHosts?: readonly string[] }[] = [];
    // A stand-in for the network: the first site answers from somewhere else.
    const net: Net = {
      async request(url, init = {}) {
        asked.push({ url, ...(init.onlyHosts ? { onlyHosts: init.onlyHosts } : {}) });
        return {
          status: 200,
          contentType: "text/plain",
          text: "the salaries",
          truncated: false,
          url: url.includes("/go") ? "https://elsewhere.test/landed" : url,
        };
      },
    };
    const w = await world(
      [
        { name: "web.fetch", args: { url: "https://example.com/go" } },
        null,
        { name: "web.fetch", args: { url: "https://example.com/page" } },
        null,
      ],
      net,
    );
    await w.scope(w.agentId("Assistant"), { ...OPEN, web: ["example.com"] });
    const conversation = await w.begin(w.owner);
    await w.say(w.owner, conversation, "Read https://example.com/go");
    // The network was told the list, so that every hop is held to it; and where it ended
    // was looked at as well.
    expect(asked[0]).toEqual({ url: "https://example.com/go", onlyHosts: ["example.com"] });
    expect(w.told()).toContain("forwards to a site the organization does not let this agent reach");
    expect(w.told()).not.toContain("the salaries");
    await w.say(w.owner, conversation, "Read https://example.com/page");
    expect(w.told()).toContain("the salaries");
  });

  it("hides, when a conversation begins, exactly what the rules say is off for each tool it would be offered", async () => {
    const w = await world([null, null]);
    const sales = (
      await json<{ id: string }>(
        await w.h.api(w.owner, "POST", "/api/departments", { name: "Sales" }),
      )
    ).id;
    const me = await w.h.db.query<{ id: string }>(
      "select id from users where email = 'owner@acme.test'",
    );
    await w.h.api(w.owner, "PATCH", `/api/members/${me[0]?.id}`, { departmentId: sales });
    // Off for everyone; the person's department asks instead: it is offered.
    await w.rule("docs.write", "off");
    await w.rule("docs.write", "ask", sales);
    // Allowed for everyone; off for the department: it is not.
    await w.rule("files.read", "off", sales);
    const conversation = await w.begin(w.owner);
    await w.say(w.owner, conversation, "Hello");
    const offered = names(w.model.seen[0]);
    expect(offered).toContain("docs.write");
    expect(offered).not.toContain("files.read");
    // What comes with reading files goes with it only where it has a rule of its own: the
    // names hidden are the names that were asked about, and they are kept.
    const kept = await w.h.db.query<{ off: string[] }>(
      "select tools_off as off from conversations where id = $1",
      [conversation],
    );
    expect(kept[0]?.off).toEqual(["files.read"]);
    // Switched on again later, this conversation still is not offered it.
    await w.rule("files.read", "inherit", sales);
    await w.say(w.owner, conversation, "Again");
    expect(JSON.stringify(w.model.seen[1]?.tools)).toBe(JSON.stringify(w.model.seen[0]?.tools));
  });

  it("leaves a conversation from before the policy with the tools it had: nothing is hidden, and the gateway refuses", async () => {
    const w = await world([null, WRITE, null]);
    const conversation = await w.begin(w.owner);
    await w.say(w.owner, conversation, "Hello");
    const first = w.model.seen[0] as Context;
    // As a deployment finds it: a conversation that has a reply and nothing written of what it was offered.
    await w.h.db.query("update conversations set tools_off = null where id = $1", [conversation]);
    await w.rule("docs.write", "off");
    await w.say(w.owner, conversation);
    const later = w.model.seen[1] as Context;
    expect(JSON.stringify(later.tools)).toBe(JSON.stringify(first.tools));
    expect(later.systemPrompt).toBe(first.systemPrompt);
    expect(w.told()).toContain(OFF_REASON.slice(0, 40));
    expect(await w.documents(w.owner)).toEqual([]);
    expect(
      (
        await w.h.db.query<{ off: string[] }>(
          "select tools_off as off from conversations where id = $1",
          [conversation],
        )
      )[0]?.off,
    ).toEqual([]);
  });

  it("asks about the knowledge bases of the agent that calls, and narrows that agent's own search", async () => {
    const pass = {
      name: "agent.ask",
      args: { agent: "Travel desk", task: "What is the hotel limit?", why: "it has the policy" },
    };
    const search = { name: "knowledge.search", args: { question: "hotel limit per night" } };
    const w = await world([pass, search, null, null, pass, search, null, null]);
    const base = await json<{ id: string }>(
      await w.h.api(w.owner, "POST", "/api/app/knowledge", { name: "Travel policy" }),
    );
    const file = await json<{ id: string }>(
      await w.h.upload(w.owner, "Travel policy.md", "The hotel limit is 900 per night."),
    );
    await w.h.api(w.owner, "POST", `/api/app/knowledge/${base.id}/items`, { fileId: file.id });
    const desk = await json<{ id: string }>(
      await w.h.api(w.owner, "POST", "/api/app/agents", {
        name: "Travel desk",
        description: "Knows the travel policy.",
        instructions: "Answer travel questions.",
        tools: [],
        knowledge: [base.id],
      }),
    );
    const found = () => JSON.stringify(w.model.seen.map((context) => context.messages));

    // The first agent carries no knowledge base and is held to none; the one it passes to
    // is held to the base it carries. Its search is its own, and goes through.
    await w.scope(w.agentId("Assistant"), { ...OPEN, knowledge: [] });
    await w.scope(desk.id, { ...OPEN, knowledge: [base.id] });
    const allowed = await w.begin(w.owner);
    await w.say(w.owner, allowed, "Ask the travel desk about hotels.");
    expect(found()).toContain("900 per night");
    expect(found()).not.toContain("does not let this agent use the knowledge bases");

    // The other way round: the first agent may use any, the one it passes to none.
    await w.scope(w.agentId("Assistant"), OPEN);
    await w.scope(desk.id, { ...OPEN, knowledge: [] });
    const before = w.model.seen.length;
    const refused = await w.begin(w.owner);
    await w.say(w.owner, refused, "Ask the travel desk about hotels.");
    const later = JSON.stringify(w.model.seen.slice(before).map((context) => context.messages));
    expect(later).toContain("does not let this agent use the knowledge bases");
    expect(later).not.toContain("900 per night");
  });

  it("takes two first settings of the same rule at once, and refuses a call when the policy cannot be read", async () => {
    const w = await world([WRITE, null]);
    const both = await Promise.all([
      w.rule("web.send", "off"),
      w.rule("web.send", "ask"),
      w.scope("everyone", { ...OPEN, mail: false }),
      w.scope("everyone", { ...OPEN, files: false }),
    ]);
    expect(both.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    const rows = await w.h.db.query("select 1 from tool_rules where tool = 'web.send'");
    expect(rows).toHaveLength(1);
    expect(await w.h.db.query("select 1 from agent_scopes")).toHaveLength(1);
    await w.scope("everyone", null);

    // The rules cannot be read: the call is refused, the reply still ends as a reply.
    const conversation = await w.begin(w.owner);
    await w.h.db.query("alter table tool_rules rename to tool_rules_gone");
    await w.say(w.owner, conversation);
    await w.h.db.query("alter table tool_rules_gone rename to tool_rules");
    expect(w.told()).toContain("could not be read just now");
    expect(await w.documents(w.owner)).toEqual([]);
    expect((await w.checks(conversation)).policies).toEqual(["agent-scope"]);
  });
});
