import {
  type AssistantMessage,
  type Context,
  createAssistantMessageEventStream,
  type StreamFn,
} from "@openclaw/llm-core";
import { newId } from "@muster/protocol";
import { describe, expect, it } from "vitest";
import {
  type Sandbox,
  type SandboxAsked,
  SandboxError,
  type SandboxFlight,
  type SandboxRun,
  type SandboxSpace,
} from "./sandbox.js";
import { RECLAIM_EVERY_MS, SandboxReclaim } from "./sandboxAdmin.js";
import { type Harness, harness, toldTo } from "./test-support.js";

type Call = { name: string; args: Record<string, unknown> };
const json = async <T>(response: Response) => (await response.json()) as T;
const DAY = 24 * 3600 * 1000;
const MB = 1024 * 1024;

/** A model that makes the calls it is given, one a turn, then says a word. */
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

/**
 * The sandbox service as an administrator's page uses it: workspaces the test puts
 * there, runs it says are in flight, and what was asked of it.
 */
function fakeSandbox(
  answer: (asked: SandboxAsked, space: string) => Promise<Partial<SandboxRun>> = async () => ({}),
) {
  const spaces: SandboxSpace[] = [];
  const flights: SandboxFlight[] = [];
  const released: string[] = [];
  const stopped: string[] = [];
  /** What stopping a run does to it, set by a test whose run is waiting to be stopped. */
  const ends = new Map<string, () => void>();
  const sandbox: Sandbox = {
    health: async () => ({ ready: true, isolation: "gvisor", reason: "", running: flights.length }),
    put: async () => {},
    get: async () => new Uint8Array(),
    run: async (space, one) => ({
      exit: 0,
      timedOut: false,
      seconds: 2,
      stdout: "",
      stderr: "",
      cut: 0,
      changed: [],
      deleted: [],
      skipped: [],
      files: [],
      wall: 0.75,
      cpus: 2,
      bytesOut: 0,
      net: [],
      ...(await answer(one, space)),
    }),
    forget: async () => {},
    status: async () => ({
      ready: true,
      isolation: "gvisor",
      reason: "",
      running: flights.filter((one) => one.state === "running").length,
      runtime: "runsc",
      image: "muster-sandbox:abc",
      waiting: 0,
      slots: 3,
      built: "2026-11-20T08:00:00.000Z",
      spaces: { count: spaces.length, bytes: spaces.reduce((sum, one) => sum + one.bytes, 0) },
      disk: { free: 50 * 1024 * MB, total: 100 * 1024 * MB },
      limits: {
        seconds: 60,
        maxSeconds: 300,
        cpus: 2,
        memory: "2g",
        spaceBytes: 256 * MB,
        diskBytes: 20 * 1024 * MB,
        idleDays: 90,
      },
    }),
    running: async () => flights,
    spaces: async () => spaces.map((one) => ({ ...one })),
    stop: async (space) => {
      stopped.push(space);
      const end = ends.get(space);
      end?.();
      return end ? 1 : 0;
    },
    release: async (space) => {
      const at = spaces.findIndex((one) => one.space === space);
      if (at >= 0 && spaces[at]?.busy)
        throw new SandboxError("in_use", "Something is running in that workspace.");
      if (at >= 0) spaces.splice(at, 1);
      released.push(space);
    },
  };
  const put = (space: string, days: number, bytes = 1000, more: Partial<SandboxSpace> = {}) =>
    spaces.push({
      space,
      files: 3,
      bytes,
      used: Date.now() - days * DAY - 60_000,
      busy: false,
      ...more,
    });
  return { sandbox, spaces, flights, released, stopped, ends, put };
}

const run = (code = "print(1)"): Call => ({ name: "code.run", args: { why: "Work it out", code } });

async function world(
  calls: (Call | null)[] = [],
  fake = fakeSandbox(),
  env: Record<string, string> = {},
) {
  const model = scripted(calls);
  const h: Harness = await harness(env, { streamFn: model.streamFn, sandbox: fake.sandbox });
  const owner = (await h.signIn("owner@acme.test")).cookie as string;
  await h.api(owner, "POST", "/api/invitations", { email: "mo@acme.test", role: "member" });
  const mo = (await h.signIn("mo@acme.test")).cookie as string;
  const id = async (email: string) =>
    (await h.db.query<{ id: string }>("select id from users where email = $1", [email]))[0]
      ?.id as string;
  const org = (
    await h.db.query<{ org: string }>(
      "select m.org_id as org from memberships m join users u on u.id = m.user_id where u.email = 'owner@acme.test'",
    )
  )[0]?.org as string;
  const converse = async (as: string) => {
    const { agents } = await json<{ agents: { id: string; name: string }[] }>(
      await h.api(as, "GET", "/api/app/agents"),
    );
    return (
      await json<{ id: string }>(
        await h.api(as, "POST", "/api/app/conversations", {
          agentId: agents.find((agent) => agent.name === "Writer")?.id,
        }),
      )
    ).id;
  };
  const say = async (as: string, conversation: string, content = "Go") => {
    await h.api(as, "POST", `/api/app/conversations/${conversation}/messages`, { content });
    await h.runs.settled(conversation);
  };
  const result = (turn: number) =>
    ((model.seen[turn] as Context).messages.at(-1) as { content: { text: string }[] }).content[0]
      ?.text as string;
  const audit = async () => JSON.stringify(await json(await h.api(owner, "GET", "/api/audit")));
  const reclaim = new SandboxReclaim(h.db, fake.sandbox);
  /** A piece of work on a repository in a conversation, as far along as the test says. */
  const work = async (conversation: string, user: string, state: string) =>
    h.db.query(
      `insert into cloud_work (conversation_id, org_id, user_id, repository, folder, base_branch, base_sha, base_tree, base, state)
       values ($1, $2, $3, 'acme/app', 'app', 'main', 'abc1234', 'tree', '{}'::jsonb, $4)`,
      [conversation, org, user, state],
    );
  return { h, fake, owner, mo, id, org, model, converse, say, result, audit, reclaim, work };
}

/** A conversation in another organization, with a workspace of its own. */
async function elsewhere(h: Harness): Promise<string> {
  const [org, user, agent, conversation] = [newId(), newId(), newId(), newId()];
  await h.db.query("insert into organizations (id, name) values ($1, 'Other')", [org]);
  await h.db.query("insert into users (id, email, name) values ($1, 'x@other.test', 'X')", [user]);
  await h.db.query(
    `insert into agents (id, org_id, name, source, risk, state, version, model)
     values ($1, $2, 'Theirs', 'org', 'R1', 'published', '1', 'm')`,
    [agent, org],
  );
  await h.db.query(
    "insert into conversations (id, org_id, user_id, agent_id, title) values ($1, $2, $3, $4, 'Their secret work')",
    [conversation, org, user, agent],
  );
  return conversation;
}

describe("the Sandbox page", () => {
  it("is read by who may read settings and changed by who may change them, in their own organization only", async () => {
    const t = await world();
    const mine = await t.converse(t.owner);
    const theirs = await elsewhere(t.h);
    t.fake.put(mine, 2, 5000);
    t.fake.put(theirs, 30, 9000);
    t.fake.flights.push({
      space: theirs,
      language: "python",
      state: "running",
      asked: Date.now(),
      started: Date.now(),
      seconds: 60,
      printed: 10,
      connections: 0,
    });
    t.fake.ends.set(theirs, () => {});

    // A member sees none of it and changes none of it.
    for (const [method, path, body] of [
      ["GET", "/api/sandbox/overview"],
      ["GET", "/api/sandbox/running"],
      ["GET", "/api/sandbox/runs"],
      ["GET", "/api/sandbox/workspaces"],
      ["GET", "/api/sandbox/network"],
      ["POST", `/api/sandbox/running/${mine}/stop`],
      ["DELETE", `/api/sandbox/workspaces/${mine}`],
      ["POST", "/api/sandbox/workspaces/release-idle", { days: 0 }],
      ["PUT", "/api/sandbox/settings", { idleDays: 3, totalBytes: null }],
      ["PUT", "/api/sandbox/limits", { kind: "everyone", runs: 1, cpuSeconds: 60 }],
      ["DELETE", "/api/sandbox/limits/everyone"],
    ] as const)
      expect((await t.h.api(t.mo, method, path, body)).status, `${method} ${path}`).toBe(403);

    // An administrator sees their own organization's, and nothing of another's.
    const overview = await json<{
      canManage: boolean;
      configured: boolean;
      state: { ready: boolean; isolation: string; image: string; slots: number; built: string };
      workspaces: { count: number; bytes: number };
      settings: { idleDays: number; totalBytes: number | null };
      limits: { server: { runs: number }; everyone: null; rows: unknown[] };
    }>(await t.h.api(t.owner, "GET", "/api/sandbox/overview"));
    expect(overview).toMatchObject({
      canManage: true,
      configured: true,
      state: { ready: true, isolation: "gvisor", image: "muster-sandbox:abc", slots: 3 },
      workspaces: { count: 1, bytes: 5000 },
      settings: { idleDays: 7, totalBytes: null },
      limits: { everyone: null, rows: [] },
    });
    const listed = JSON.stringify(
      await json(await t.h.api(t.owner, "GET", "/api/sandbox/workspaces")),
    );
    expect(listed).toContain(mine);
    expect(listed).not.toContain(theirs);
    expect(listed).not.toContain("Their secret work");
    const running = JSON.stringify(
      await json(await t.h.api(t.owner, "GET", "/api/sandbox/running")),
    );
    expect(running).not.toContain(theirs);

    // Another organization's run is not stopped and its workspace not released: neither is there.
    expect((await t.h.api(t.owner, "POST", `/api/sandbox/running/${theirs}/stop`)).status).toBe(
      404,
    );
    expect((await t.h.api(t.owner, "DELETE", `/api/sandbox/workspaces/${theirs}`)).status).toBe(
      404,
    );
    expect(
      await json(
        await t.h.api(t.owner, "POST", "/api/sandbox/workspaces/release-idle", { days: 0 }),
      ),
    ).toMatchObject({ released: 1, bytes: 5000 });
    expect(t.fake.stopped).toEqual([]);
    expect(t.fake.released).toEqual([mine]);
    expect(t.fake.spaces.map((one) => one.space)).toEqual([theirs]);
    expect(await t.audit()).toContain("sandbox.workspace_released");
  });

  it("says nothing is there where the server has no sandbox", async () => {
    const h = await harness();
    const owner = (await h.signIn("owner@acme.test")).cookie as string;
    expect(await json(await h.api(owner, "GET", "/api/sandbox/overview"))).toMatchObject({
      configured: false,
      state: null,
      workspaces: { count: 0, bytes: 0 },
      reclaim: { on: false },
    });
    expect(await json(await h.api(owner, "GET", "/api/sandbox/workspaces"))).toEqual({
      available: false,
      workspaces: [],
    });
    expect(await json(await h.api(owner, "GET", "/api/sandbox/running"))).toEqual({
      live: false,
      runs: [],
    });
  });
});

describe("a run in flight", () => {
  it("is listed with who and what, and stopped by an administrator: counted, said to the agent, on record", async () => {
    let begun: () => void = () => {};
    const began = new Promise<void>((resolve) => {
      begun = resolve;
    });
    const fake = fakeSandbox(
      (_asked, space) =>
        new Promise((_resolve, reject) => {
          fake.flights.push({
            space,
            language: "python",
            state: "running",
            asked: Date.now() - 4000,
            started: Date.now() - 3000,
            seconds: 60,
            printed: 120,
            connections: 2,
          });
          fake.ends.set(space, () => {
            fake.flights.length = 0;
            fake.ends.delete(space);
            reject(new SandboxError("ended", "An administrator stopped this run.", 3.2));
          });
          begun();
        }),
    );
    const t = await world([run("while True: pass"), null], fake);
    const conversation = await t.converse(t.mo);
    await t.h.api(t.mo, "POST", `/api/app/conversations/${conversation}/messages`, {
      content: "Go",
    });
    await began;

    const { live, runs } = await json<{
      live: boolean;
      runs: {
        conversation: string;
        person: { email: string };
        agent: string;
        language: string;
        state: string;
        seconds: number;
        printed: number;
        connections: number;
        traceId: string | null;
      }[];
    }>(await t.h.api(t.owner, "GET", "/api/sandbox/running"));
    expect(live).toBe(true);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      conversation,
      person: { email: "mo@acme.test" },
      agent: "Writer",
      language: "python",
      state: "running",
      seconds: 60,
      printed: 120,
      connections: 2,
    });
    // The reply it belongs to, to open its trace.
    expect(runs[0]?.traceId).toMatch(/^[0-9a-f-]{36}$/);

    const stop = await t.h.api(t.owner, "POST", `/api/sandbox/running/${conversation}/stop`);
    expect(await json(stop)).toEqual({ ok: true, ended: 1 });
    await t.h.runs.settled(conversation);
    expect(t.result(1)).toContain("An administrator stopped this run. Tell the person so");
    const line = (
      await t.h.db.query<{ ending: string; seconds: number; language: string; agent: string }>(
        "select ending, seconds, language, agent_id as agent from sandbox_runs where conversation_id = $1",
        [conversation],
      )
    )[0];
    expect(line).toMatchObject({ ending: "stopped", language: "python" });
    expect(Number(line?.seconds)).toBeCloseTo(3.2, 1);
    expect(line?.agent).toBeTruthy();
    const events = await t.audit();
    expect(events).toContain("sandbox.run_stopped");
    expect(events).toContain("mo@acme.test");

    // Over already: there is nothing to stop, and nothing is put on record for it.
    const again = await t.h.api(t.owner, "POST", `/api/sandbox/running/${conversation}/stop`);
    expect(again.status).toBe(409);
    expect((await json<{ error: { code: string } }>(again)).error.code).toBe("sandbox_not_running");
    expect(
      (await t.h.db.query("select 1 from admin_events where action = 'sandbox.run_stopped'"))
        .length,
    ).toBe(1);
  });
});

describe("every run there was", () => {
  it("is listed by person, ending and range, a page at a time, and what it reached is added up by host", async () => {
    let n = 0;
    const fake = fakeSandbox(async () => {
      n += 1;
      return n === 2
        ? { exit: 1, stderr: "boom" }
        : {
            stdout: "x".repeat(40),
            net: [
              { host: "pypi.org", ok: true, times: 2, up: 300, down: 5000 },
              { host: "evil.example", ok: false, why: "not on the list", times: 1, up: 0, down: 0 },
            ],
          };
    });
    const t = await world([run(), null, run(), null, run(), null], fake);
    const mine = await t.converse(t.owner);
    const theirs = await t.converse(t.mo);
    await t.say(t.owner, mine);
    await t.say(t.owner, mine);
    await t.say(t.mo, theirs);
    type Page = {
      total: number;
      page: number;
      size: number;
      people: { id: string; email: string }[];
      rows: {
        ending: string;
        person: { email: string };
        printed: number;
        netUp: number;
        netDown: number;
        reached: number;
        refused: number;
        language: string;
        agent: string;
        traceId: string;
        conversation: string;
      }[];
    };
    const list = async (query = "") =>
      json<Page>(await t.h.api(t.owner, "GET", `/api/sandbox/runs${query}`));
    const all = await list();
    expect(all).toMatchObject({ total: 3, page: 1, size: 50 });
    expect(all.people.map((one) => one.email)).toEqual(["mo@acme.test", "owner@acme.test"]);
    expect(all.rows[0]).toMatchObject({
      ending: "ok",
      person: { email: "mo@acme.test" },
      printed: 40,
      netUp: 300,
      netDown: 5000,
      reached: 2,
      refused: 1,
      language: "python",
      agent: "Writer",
      conversation: theirs,
    });
    expect(all.rows[0]?.traceId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await list("?ending=failed")).rows.map((row) => row.person.email)).toEqual([
      "owner@acme.test",
    ]);
    expect((await list(`?person=${await t.id("mo@acme.test")}&range=24h`)).total).toBe(1);
    expect((await list("?ending=lost")).total).toBe(0);
    expect((await list("?page=2")).rows).toEqual([]);
    for (const bad of ["?ending=nope", "?range=1y", "?person=me", "?page=0"])
      expect((await t.h.api(t.owner, "GET", `/api/sandbox/runs${bad}`)).status, bad).toBe(400);

    const network = await json<{
      hosts: string[];
      reached: { host: string; allowed: number; refused: number; up: number; down: number }[];
    }>(await t.h.api(t.owner, "GET", "/api/sandbox/network?range=7d"));
    expect(network.hosts).toContain("pypi.org");
    expect(network.reached).toEqual([
      { host: "pypi.org", allowed: 4, refused: 0, up: 600, down: 10_000 },
      { host: "evil.example", allowed: 0, refused: 2, up: 0, down: 0 },
    ]);
  });
});

describe("how a workspace's room comes back", () => {
  it("is released after the organization's number of days without use, and that number is the administrator's", async () => {
    const t = await world();
    const [old, recent] = [await t.converse(t.owner), await t.converse(t.mo)];
    t.fake.put(old, 8, 4000);
    t.fake.put(recent, 2, 6000);
    const first = await t.reclaim.pass();
    expect(first.get(t.org)).toMatchObject({
      workspaces: 2,
      released: 1,
      bytes: 4000,
      idle: 1,
      cap: 0,
      held: false,
    });
    expect(t.fake.released).toEqual([old]);
    const events = await t.audit();
    expect(events).toContain("sandbox.reclaimed");
    expect(events).toContain('"idleDays":7');

    // Changed on the page, within what it may be, and on record.
    const set = (body: unknown) => t.h.api(t.owner, "PUT", "/api/sandbox/settings", body);
    for (const bad of [
      { idleDays: 0, totalBytes: null },
      { idleDays: 91, totalBytes: null },
      { idleDays: 1.5, totalBytes: null },
      { idleDays: 7, totalBytes: 1000 },
      { idleDays: 7 },
      { idleDays: 7, totalBytes: null, more: 1 },
    ]) {
      const refused = await set(bad);
      expect(refused.status).toBe(400);
      expect((await json<{ error: { code: string } }>(refused)).error.code).toBe(
        "invalid_sandbox_settings",
      );
    }
    expect((await set({ idleDays: 1, totalBytes: null })).status).toBe(200);
    expect(await t.audit()).toContain("sandbox.settings_changed");
    const second = await t.reclaim.pass();
    expect(second.get(t.org)).toMatchObject({ released: 1, bytes: 6000 });
    expect(t.fake.spaces).toEqual([]);
    // A pass with nothing to release says so on the page, and writes nothing to the log.
    await t.reclaim.pass();
    expect(
      (await t.h.db.query("select 1 from admin_events where action = 'sandbox.reclaimed'")).length,
    ).toBe(2);
  });

  it("releases the longest idle first when all together are over the organization's cap", async () => {
    const t = await world();
    const ids = [await t.converse(t.owner), await t.converse(t.owner), await t.converse(t.mo)];
    t.fake.put(ids[0] as string, 1, 60 * MB);
    t.fake.put(ids[1] as string, 3, 50 * MB);
    t.fake.put(ids[2] as string, 2, 40 * MB);
    // No cap of its own: nothing goes for size.
    expect((await t.reclaim.pass()).get(t.org)).toMatchObject({ released: 0 });
    await t.h.api(t.owner, "PUT", "/api/sandbox/settings", { idleDays: 30, totalBytes: 64 * MB });
    const pass = await t.reclaim.pass();
    // 150 MB against 64: the one idle three days goes, then the one idle two; 60 is under.
    expect(pass.get(t.org)).toMatchObject({ released: 2, cap: 2, idle: 0, bytes: 90 * MB });
    expect(t.fake.released).toEqual([ids[1], ids[2]]);
    expect(t.fake.spaces.map((one) => one.space)).toEqual([ids[0]]);
  });

  it("never releases a workspace something is running in, or one a reply is being written in", async () => {
    const t = await world();
    const [busy, racing, replying, free] = [
      await t.converse(t.owner),
      await t.converse(t.owner),
      await t.converse(t.owner),
      await t.converse(t.owner),
    ];
    t.fake.put(busy, 30, 1000, { busy: true });
    t.fake.put(racing, 30, 1000);
    t.fake.put(replying, 30, 1000);
    t.fake.put(free, 30, 1000);
    // A run began there after the list was read: the sandbox itself refuses.
    const release = t.fake.sandbox.release as NonNullable<Sandbox["release"]>;
    t.fake.sandbox.release = async (space) => {
      if (space === racing)
        throw new SandboxError("in_use", "Something is running in that workspace.");
      return release(space);
    };
    await t.h.db.query(
      "insert into messages (id, conversation_id, org_id, seq, role, status) values ($1, $2, $3, 1, 'assistant', 'running')",
      [newId(), replying, t.org],
    );
    const pass = await t.reclaim.pass();
    expect(pass.get(t.org)).toMatchObject({ released: 1, running: 3 });
    expect(t.fake.released).toEqual([free]);
    // Nor for an administrator, who is told why.
    for (const one of [busy, racing, replying]) {
      const refused = await t.h.api(t.owner, "DELETE", `/api/sandbox/workspaces/${one}`);
      expect(refused.status).toBe(409);
      expect((await json<{ error: { code: string } }>(refused)).error.code).toBe("sandbox_in_use");
    }
    expect(
      await json(
        await t.h.api(t.owner, "POST", "/api/sandbox/workspaces/release-idle", { days: 1 }),
      ),
    ).toMatchObject({ released: 0, running: 3 });
  });

  it("keeps a workspace whose proposal waits to be sent, and lets go of work that was only open", async () => {
    const t = await world();
    const me = await t.id("owner@acme.test");
    const [proposed, sending, open, sent] = [
      await t.converse(t.owner),
      await t.converse(t.owner),
      await t.converse(t.owner),
      await t.converse(t.owner),
    ];
    for (const [conversation, state] of [
      [proposed, "proposed"],
      [sending, "sending"],
      [open, "open"],
      [sent, "sent"],
    ] as const) {
      t.fake.put(conversation, 40, 1000);
      await t.work(conversation, me, state);
    }
    const listed = await json<{
      workspaces: { conversation: string; repository: string; proposal: boolean }[];
    }>(await t.h.api(t.owner, "GET", "/api/sandbox/workspaces"));
    expect(
      listed.workspaces
        .filter((one) => one.proposal)
        .map((one) => one.conversation)
        .sort(),
    ).toEqual([proposed, sending].sort());
    expect(listed.workspaces.every((one) => one.repository === "acme/app")).toBe(true);

    const pass = await t.reclaim.pass();
    expect(pass.get(t.org)).toMatchObject({ released: 2, proposal: 2 });
    expect(t.fake.released.sort()).toEqual([open, sent].sort());
    // What was proposed is still all there; the others are opened again when wanted.
    expect(
      (
        await t.h.db.query<{ id: string }>(
          "select conversation_id as id from cloud_work order by state",
        )
      )
        .map((row) => row.id)
        .sort(),
    ).toEqual([proposed, sending].sort());
    const refused = await t.h.api(t.owner, "DELETE", `/api/sandbox/workspaces/${proposed}`);
    expect(refused.status).toBe(409);
    expect((await json<{ error: { code: string } }>(refused)).error.code).toBe(
      "sandbox_proposal_waiting",
    );
    expect(t.fake.spaces.map((one) => one.space).sort()).toEqual([proposed, sending].sort());
  });

  it("releases nothing in an organization under a legal hold", async () => {
    const t = await world();
    const conversation = await t.converse(t.owner);
    t.fake.put(conversation, 60, 1000);
    expect(
      (
        await t.h.api(t.owner, "PUT", "/api/retention/hold", {
          on: true,
          reason: "Case 2026-114, counsel's letter",
        })
      ).status,
    ).toBe(200);
    expect((await t.reclaim.pass()).get(t.org)).toMatchObject({ released: 0, held: true });
    expect(t.fake.released).toEqual([]);
    const overview = await json<{ reclaim: { hold: boolean } }>(
      await t.h.api(t.owner, "GET", "/api/sandbox/overview"),
    );
    expect(overview.reclaim.hold).toBe(true);
    // Nor by an administrator's hand.
    const byHand = await t.h.api(t.owner, "DELETE", `/api/sandbox/workspaces/${conversation}`);
    expect(byHand.status).toBe(409);
    const all = await t.h.api(t.owner, "POST", "/api/sandbox/workspaces/release-idle", { days: 0 });
    expect(all.status).toBe(409);
    expect(t.fake.released).toEqual([]);
    await t.h.api(t.owner, "PUT", "/api/retention/hold", { on: false });
    expect((await t.reclaim.pass()).get(t.org)).toMatchObject({ released: 1, held: false });
  });

  it("is looked through once an hour by one server, however many ask, and the page says when", async () => {
    const t = await world();
    const conversation = await t.converse(t.owner);
    t.fake.put(conversation, 10, 2000);
    const other = new SandboxReclaim(t.h.db, t.fake.sandbox);
    const now = new Date();
    const [one, two] = await Promise.all([t.reclaim.tick(now), other.tick(now)]);
    // One of them made the pass; the other saw it was made.
    expect([one, two].filter(Boolean)).toHaveLength(1);
    expect(t.fake.released).toEqual([conversation]);
    expect(await other.tick(new Date(now.getTime() + 20 * 60_000))).toBeNull();
    const overview = await json<{
      reclaim: { on: boolean; lastAt: string; nextAt: string; last: { released: number } };
    }>(await t.h.api(t.owner, "GET", "/api/sandbox/overview"));
    expect(overview.reclaim).toMatchObject({ on: true, last: { released: 1 } });
    expect(
      new Date(overview.reclaim.nextAt).getTime() - new Date(overview.reclaim.lastAt).getTime(),
    ).toBe(RECLAIM_EVERY_MS);
    expect(await other.tick(new Date(now.getTime() + RECLAIM_EVERY_MS))).not.toBeNull();
    // A folder no conversation has is given a day, then goes too.
    const orphan = newId();
    t.fake.put(orphan, 0.5);
    await t.reclaim.pass();
    expect(t.fake.spaces.map((space) => space.space)).toEqual([orphan]);
    (t.fake.spaces[0] as SandboxSpace).used -= 2 * DAY;
    await t.reclaim.pass();
    expect(t.fake.spaces).toEqual([]);
  });

  it("comes back empty by itself, and the agent is told so once, in the run's result and nowhere else", async () => {
    const t = await world([run(), null, run(), null, run(), null]);
    const conversation = await t.converse(t.mo);
    await t.say(t.mo, conversation);
    // Nothing was released: nothing is said.
    expect(t.result(1)).not.toContain("released");
    t.fake.put(conversation, 9, 3000);
    await t.reclaim.pass();
    expect(t.fake.released).toEqual([conversation]);

    await t.say(t.mo, conversation);
    expect(t.result(3)).toContain(
      "Note: this conversation's working folder was released after 9 days without use, and starts empty.",
    );
    await t.say(t.mo, conversation);
    expect(t.result(5)).not.toContain("released");
    // What the agent is told apart from the conversation is the same before and after:
    // nothing of it is in its instructions or its tools.
    const told = t.model.seen.map((context) => toldTo(context));
    expect(told[2]).toBe(told[0]);
    expect(told[4]).toBe(told[0]);
    expect(JSON.stringify(t.model.seen[2]?.tools)).toBe(JSON.stringify(t.model.seen[0]?.tools));
    expect(JSON.stringify(t.model.seen.map((context) => context.tools))).not.toContain("released");

    // Released by an administrator: said as that.
    t.fake.put(conversation, 0, 3000);
    expect(
      (await t.h.api(t.owner, "DELETE", `/api/sandbox/workspaces/${conversation}`)).status,
    ).toBe(200);
    expect(await t.h.runs.sandboxUse.releasedNote(conversation)).toContain(
      "was released by an administrator",
    );
    expect(await t.h.runs.sandboxUse.releasedNote(conversation)).toBeNull();
  });
});

describe("a day's allowance", () => {
  it("is the person's own, else their department's, else everyone's, else the server's settings", async () => {
    const t = await world([], fakeSandbox(), {
      MUSTER_SANDBOX_DAILY_RUNS: "5",
      MUSTER_SANDBOX_DAILY_CPU_SECONDS: "600",
    });
    const mo = await t.id("mo@acme.test");
    const owner = await t.id("owner@acme.test");
    const department = newId();
    await t.h.db.query("insert into departments (id, org_id, name) values ($1, $2, 'Research')", [
      department,
      t.org,
    ]);
    await t.h.db.query("update memberships set department_id = $1 where user_id = $2", [
      department,
      mo,
    ]);
    const use = t.h.runs.sandboxUse;
    const limits = (user: string) => use.limitsFor(t.org, user);
    expect(await limits(mo)).toEqual({ runs: 5, cpuSeconds: 600, from: "server" });

    const set = (body: unknown) => t.h.api(t.owner, "PUT", "/api/sandbox/limits", body);
    expect((await set({ kind: "everyone", runs: 4, cpuSeconds: 480 })).status).toBe(200);
    expect(await limits(mo)).toEqual({ runs: 4, cpuSeconds: 480, from: "everyone" });
    expect((await set({ kind: "department", id: department, runs: 3, cpuSeconds: 0 })).status).toBe(
      200,
    );
    expect(await limits(mo)).toEqual({ runs: 3, cpuSeconds: 0, from: "department" });
    // Someone in no department is held to everyone's.
    expect(await limits(owner)).toMatchObject({ runs: 4, from: "everyone" });
    expect((await set({ kind: "person", id: mo, runs: 1, cpuSeconds: 120 })).status).toBe(200);
    expect(await limits(mo)).toEqual({ runs: 1, cpuSeconds: 120, from: "person" });

    // It is what a run is held to, and what the person is shown.
    const at = { orgId: t.org, userId: mo, conversationId: null };
    expect(await use.reserve(at, 10)).toHaveProperty("id");
    const refused = await use.reserve(at, 10);
    expect(refused).toHaveProperty("refused");
    expect((refused as { refused: string }).refused).toContain("(1 runs)");
    expect(await use.today(t.org, mo)).toMatchObject({ runs: 1, limitRuns: 1 });

    // 0 is no limit, for that person, whatever everyone else has.
    expect((await set({ kind: "person", id: mo, runs: 0, cpuSeconds: 0 })).status).toBe(200);
    expect(await use.reserve(at, 10)).toHaveProperty("id");
    expect(await use.reserve(at, 10)).toHaveProperty("id");

    const overview = await json<{
      limits: {
        server: { runs: number; cpuSeconds: number };
        everyone: { runs: number; cpuSeconds: number };
        rows: { kind: string; id: string; name: string; runs: number; cpuSeconds: number }[];
      };
      departments: { id: string }[];
      people: { email: string }[];
    }>(await t.h.api(t.owner, "GET", "/api/sandbox/overview"));
    expect(overview.limits).toMatchObject({
      server: { runs: 5, cpuSeconds: 600 },
      everyone: { runs: 4, cpuSeconds: 480 },
    });
    expect(overview.limits.rows.map((row) => [row.kind, row.id, row.name, row.runs])).toEqual([
      ["department", department, "Research", 3],
      ["person", mo, "mo", 0],
    ]);
    expect(overview.departments.map((one) => one.id)).toEqual([department]);
    expect(overview.people.map((one) => one.email)).toContain("mo@acme.test");

    // Taken away: the next in line holds again.
    const remove = (path: string) => t.h.api(t.owner, "DELETE", `/api/sandbox/limits/${path}`);
    expect((await remove(`person/${mo}`)).status).toBe(200);
    expect(await limits(mo)).toMatchObject({ runs: 3, from: "department" });
    expect((await remove(`person/${mo}`)).status).toBe(404);
    expect((await remove(`department/${department}`)).status).toBe(200);
    expect((await remove("everyone")).status).toBe(200);
    expect(await limits(mo)).toEqual({ runs: 5, cpuSeconds: 600, from: "server" });
    expect((await remove("everyone")).status).toBe(404);
    const events = await t.audit();
    expect(events).toContain("sandbox.limit_set");
    expect(events).toContain("sandbox.limit_removed");
  });

  it("is set only for who is in the organization, in numbers that mean something", async () => {
    const t = await world();
    const theirs = await elsewhere(t.h);
    const stranger = (
      await t.h.db.query<{ id: string }>("select user_id as id from conversations where id = $1", [
        theirs,
      ])
    )[0]?.id;
    for (const bad of [
      { kind: "person", id: stranger, runs: 1, cpuSeconds: 1 },
      { kind: "department", id: newId(), runs: 1, cpuSeconds: 1 },
      { kind: "person", runs: 1, cpuSeconds: 1 },
      { kind: "everyone", id: newId(), runs: 1, cpuSeconds: 1 },
      { kind: "everyone", runs: -1, cpuSeconds: 1 },
      { kind: "everyone", runs: 1.5, cpuSeconds: 1 },
      { kind: "everyone", runs: 1 },
      { kind: "team", id: newId(), runs: 1, cpuSeconds: 1 },
    ]) {
      const refused = await t.h.api(t.owner, "PUT", "/api/sandbox/limits", bad);
      expect(refused.status, JSON.stringify(bad)).toBe(400);
      expect((await json<{ error: { code: string } }>(refused)).error.code).toBe(
        "invalid_sandbox_limit",
      );
    }
    expect((await t.h.api(t.owner, "DELETE", "/api/sandbox/limits/person/nope")).status).toBe(400);
    expect((await t.h.db.query("select 1 from sandbox_limits")).length).toBe(0);
  });
});
