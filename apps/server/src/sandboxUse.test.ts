import {
  type AssistantMessage,
  type Context,
  createAssistantMessageEventStream,
  type StreamFn,
} from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import type { LiveEvent, Step } from "./runtime/runs.js";
import type { Sandbox, SandboxAsked, SandboxRun } from "./sandbox.js";
import { DEFAULT_HOSTS, hostEntry, LOST_AFTER, sweepSandboxRuns } from "./sandboxUse.js";
import { type Harness, harness } from "./test-support.js";

type Call = { name: string; args: Record<string, unknown> };
const json = async <T>(response: Response) => (await response.json()) as T;

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

/** A sandbox that runs nothing: it keeps what it was asked and answers as the test says. */
function fakeSandbox(
  answer: (
    asked: SandboxAsked,
    signal: AbortSignal | undefined,
    said: ((stream: "out" | "err", text: string) => void) | undefined,
  ) => Promise<Partial<SandboxRun>> | Partial<SandboxRun> = () => ({}),
) {
  const asked: SandboxAsked[] = [];
  const sandbox: Sandbox = {
    health: async () => ({ ready: true, isolation: "gvisor", reason: "", running: 0 }),
    put: async () => {},
    get: async () => new Uint8Array(),
    run: async (_space, one, signal, said) => {
      asked.push(one);
      return {
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
        bytesOut: 1200,
        net: [],
        ...(await answer(one, signal, said)),
      };
    },
    forget: async () => {},
  };
  return { sandbox, asked };
}

const run = (code = "print(1)"): Call => ({ name: "code.run", args: { why: "Work it out", code } });

async function start(
  calls: (Call | null)[],
  fake: ReturnType<typeof fakeSandbox>,
  env: Record<string, string> = {},
) {
  const model = scripted(calls);
  const h: Harness = await harness(env, { streamFn: model.streamFn, sandbox: fake.sandbox });
  const owner = (await h.signIn("owner@acme.test")).cookie as string;
  await h.api(owner, "POST", "/api/invitations", { email: "mo@acme.test", role: "member" });
  const mo = (await h.signIn("mo@acme.test")).cookie as string;
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
  /** What the model was told the last call came to. */
  const result = (turn: number) =>
    ((model.seen[turn] as Context).messages.at(-1) as { content: { text: string }[] }).content[0]
      ?.text as string;
  return { h, owner, mo, model, converse, say, result };
}

describe("the hosts code may reach", () => {
  it("are the package indexes until an administrator says otherwise, and go with every run", async () => {
    const fake = fakeSandbox();
    const t = await start([run(), null, run(), null, run(), null], fake);
    const read = async () =>
      json<{ hosts: string[]; own: boolean; canManage: boolean; defaults: string[] }>(
        await t.h.api(t.owner, "GET", "/api/sandbox/hosts"),
      );
    expect(await read()).toMatchObject({
      hosts: DEFAULT_HOSTS,
      own: false,
      canManage: true,
      defaults: DEFAULT_HOSTS,
    });
    const conversation = await t.converse(t.owner);
    await t.say(t.owner, conversation);
    expect(fake.asked[0]?.hosts).toEqual(DEFAULT_HOSTS);

    // Changed by who may change settings, tidied, and on record.
    const put = (as: string, list: unknown) =>
      t.h.api(as, "PUT", "/api/sandbox/hosts", { hosts: list });
    expect((await put(t.mo, ["pypi.org"])).status).toBe(403);
    expect((await t.h.api(t.mo, "GET", "/api/sandbox/hosts")).status).toBe(403);
    for (const bad of [
      ["10.0.0.1"],
      ["pypi.org:443"],
      ["https://pypi.org"],
      ["localhost"],
      "pypi.org",
    ]) {
      const refused = await put(t.owner, bad);
      expect(refused.status).toBe(400);
      expect((await json<{ error: { code: string } }>(refused)).error.code).toBe(
        "invalid_sandbox_host",
      );
    }
    expect(await json(await put(t.owner, ["PyPI.org", "pypi.org", "*.Corp.Example"]))).toEqual({
      hosts: ["pypi.org", "*.corp.example"],
      own: true,
    });
    await t.say(t.owner, conversation);
    expect(fake.asked[1]?.hosts).toEqual(["pypi.org", "*.corp.example"]);
    const events = JSON.stringify(await json(await t.h.api(t.owner, "GET", "/api/audit")));
    expect(events).toContain("sandbox.hosts_changed");

    // None at all: a run reaches nothing.
    expect((await put(t.owner, [])).status).toBe(200);
    await t.say(t.owner, conversation);
    expect(fake.asked[2]?.hosts).toEqual([]);
    expect((await read()).own).toBe(true);
  });

  it("are names and nothing else", () => {
    expect(hostEntry(" Files.PythonHosted.org. ")).toBe("files.pythonhosted.org");
    expect(hostEntry("*.example.com")).toBe("*.example.com");
    for (const not of ["1.2.3.4", "a", "a..b", "-a.com", "a.com/x", "a.com:1", "", "*.*.a.com", 3])
      expect(hostEntry(not)).toBeNull();
  });

  it("tell the agent what was refused, so that it says so and does not look for a way round", async () => {
    const fake = fakeSandbox(() => ({
      exit: 1,
      stderr: "ProxyError: Tunnel connection failed: 403 Forbidden",
      net: [
        {
          host: "evil.example",
          ok: false,
          why: "this host is not on the organization's list",
          times: 2,
          up: 0,
          down: 0,
        },
        { host: "pypi.org", ok: true, times: 3, up: 900, down: 40_000 },
      ],
    }));
    const t = await start([run("import requests"), null], fake);
    const conversation = await t.converse(t.owner);
    await t.say(t.owner, conversation);
    const told = t.result(1);
    expect(told).toContain(
      "Connections refused: evil.example (2 times): this host is not on the organization's list.",
    );
    expect(told).toContain("Do not try another way round");
    expect(told).not.toContain("pypi.org (");
  });

  it("say the same to the model whatever the list holds: the tool and the instructions do not change with it", async () => {
    const fake = fakeSandbox();
    const t = await start([null, null], fake);
    const conversation = await t.converse(t.owner);
    await t.say(t.owner, conversation, "One");
    await t.h.api(t.owner, "PUT", "/api/sandbox/hosts", { hosts: [] });
    await t.say(t.owner, conversation, "Two");
    const [first, second] = t.model.seen as [Context, Context];
    expect(second.systemPrompt).toBe(first.systemPrompt);
    expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
    const tool = (first.tools ?? []).find((one) => one.name === "code.run");
    expect(tool?.description).toContain("only the hosts the organization allows");
    expect(tool?.description).not.toMatch(/pypi\.org|no network and/);
  });
});

describe("what running code prints", () => {
  it("is shown on its step while it runs, the last of it, and is gone from the step once it ends", async () => {
    let go: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      go = resolve;
    });
    const fake = fakeSandbox(async (_asked, _signal, said) => {
      said?.("out", "loading rows\n");
      said?.("err", "warning: slow\n");
      said?.("out", "x".repeat(6000));
      await gate;
      return { stdout: "loading rows\ndone\n" };
    });
    const t = await start([run(), null], fake);
    const conversation = await t.converse(t.owner);
    const feed = t.h.runs.subscribe(conversation);
    const steps: Step[] = [];
    const watching = (async () => {
      for await (const event of feed as AsyncIterable<LiveEvent>) {
        if (event.type === "step") steps.push(structuredClone(event.step));
        if (event.type === "done") break;
      }
    })();
    await t.h.api(t.owner, "POST", `/api/app/conversations/${conversation}/messages`, {
      content: "Go",
    });
    for (let i = 0; i < 100 && !steps.some((step) => step.said); i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const live = steps.find((step) => step.said);
    expect(live).toMatchObject({ tool: "code.run", status: "running" });
    // The last of it: no more than a step shows.
    expect(live?.said?.length).toBe(4000);
    expect(live?.said?.endsWith("xxxx")).toBe(true);
    go();
    await t.h.runs.settled(conversation);
    feed.close();
    await watching;
    const ended = steps.filter((step) => step.tool === "code.run").at(-1);
    expect(ended).toMatchObject({ status: "ok" });
    expect(ended?.said).toBeUndefined();
    // The model is told what it always was: all of it, at the end.
    expect(t.result(1)).toContain("Printed:\nloading rows\ndone");
    // And what is kept of the reply holds none of what was only for the wait.
    const kept = await json<{ messages: { steps: Step[] }[] }>(
      await t.h.api(t.owner, "GET", `/api/app/conversations/${conversation}`),
    );
    expect(JSON.stringify(kept.messages.at(-1)?.steps)).not.toContain("loading rows");
  });

  it("stops with the reply: the person stopping ends the run, and what it had used by then is counted", async () => {
    let ended = false;
    const fake = fakeSandbox(
      (_asked, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            ended = true;
            reject(new DOMException("stopped", "AbortError"));
          });
        }),
    );
    const t = await start([run("while True: pass"), null], fake);
    const conversation = await t.converse(t.owner);
    await t.h.api(t.owner, "POST", `/api/app/conversations/${conversation}/messages`, {
      content: "Go",
    });
    for (let i = 0; i < 100 && fake.asked.length === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    await t.h.runs.stop(conversation);
    expect(ended).toBe(true);
    const mine = await json<{ code: { runs: number } }>(
      await t.h.api(t.owner, "GET", "/api/app/usage?range=7d"),
    );
    expect(mine.code.runs).toBe(1);
  });
});

describe("how much code one person may run in a day", () => {
  it("is counted run by run, shown to them and to administrators, and refused past the day's allowance", async () => {
    const fake = fakeSandbox((asked) =>
      asked.code === "slow" ? { timedOut: true, exit: -1, wall: 15 } : {},
    );
    const t = await start([run(), null, run("slow"), null, run(), null, run(), null], fake, {
      MUSTER_SANDBOX_DAILY_RUNS: "3",
    });
    const mine = async (as: string) =>
      (
        await json<{
          code: { runs: number; cpuSeconds: number; limitRuns: number; limitCpuSeconds: number };
        }>(await t.h.api(as, "GET", "/api/app/usage?range=7d"))
      ).code;
    expect(await mine(t.mo)).toEqual({
      runs: 0,
      cpuSeconds: 0,
      limitRuns: 3,
      limitCpuSeconds: 3600,
    });
    const conversation = await t.converse(t.mo);
    await t.say(t.mo, conversation);
    await t.say(t.mo, conversation);
    await t.say(t.mo, conversation);
    expect(await mine(t.mo)).toMatchObject({ runs: 3, cpuSeconds: 33 });
    expect(fake.asked.length).toBe(3);

    // The fourth is not run: the agent is told why, in words to pass on.
    await t.say(t.mo, conversation);
    expect(fake.asked.length).toBe(3);
    expect(t.result(7)).toContain("today's allowance for running code (3 runs)");
    expect(await mine(t.mo)).toMatchObject({ runs: 3 });
    // One person's day is theirs: another still runs.
    expect(await mine(t.owner)).toMatchObject({ runs: 0 });

    // For those who see what agents cost: by person, and in all.
    const page = await json<{
      totals: { runs: number; failed: number; cpuSeconds: number };
      people: { email: string; runs: number; failed: number; cpuSeconds: number }[];
    }>(await t.h.api(t.owner, "GET", "/api/sandbox/usage?range=7d"));
    expect(page.totals).toMatchObject({ runs: 3, failed: 1, cpuSeconds: 33 });
    expect(page.people).toMatchObject([
      { email: "mo@acme.test", runs: 3, failed: 1, cpuSeconds: 33 },
    ]);
    expect((await t.h.api(t.mo, "GET", "/api/sandbox/usage")).status).toBe(403);
    expect((await t.h.api(t.owner, "GET", "/api/sandbox/usage?range=constructor")).status).toBe(
      400,
    );
  });

  it("is held by processor time too, and by nothing where the allowance is taken away", async () => {
    const heavy = fakeSandbox(() => ({ wall: 50 }));
    const t = await start([run(), null, run(), null], heavy, {
      MUSTER_SANDBOX_DAILY_CPU_SECONDS: "60",
    });
    const conversation = await t.converse(t.owner);
    await t.say(t.owner, conversation);
    await t.say(t.owner, conversation);
    expect(heavy.asked.length).toBe(1);
    expect(t.result(3)).toContain("1 minutes of processor time");

    const free = fakeSandbox(() => ({ wall: 50_000 }));
    const u = await start([run(), null, run(), null], free, {
      MUSTER_SANDBOX_DAILY_RUNS: "0",
      MUSTER_SANDBOX_DAILY_CPU_SECONDS: "0",
    });
    const other = await u.converse(u.owner);
    await u.say(u.owner, other);
    await u.say(u.owner, other);
    expect(free.asked.length).toBe(2);
  });

  it("cannot be passed by asking in several conversations at once", async () => {
    let go: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      go = resolve;
    });
    const fake = fakeSandbox(async () => {
      await gate;
      return {};
    });
    const t = await start(
      [run(), run(), run(), run(), null, null, null, null, null, null, null, null],
      fake,
      { MUSTER_SANDBOX_DAILY_RUNS: "2" },
    );
    // Four conversations of one person ask in the same moment; each run is still going
    // when the next asks, so none has ended to be counted.
    const conversations = await Promise.all([1, 2, 3, 4].map(() => t.converse(t.mo)));
    await Promise.all(
      conversations.map((conversation) =>
        t.h.api(t.mo, "POST", `/api/app/conversations/${conversation}/messages`, { content: "Go" }),
      ),
    );
    for (let i = 0; i < 200 && fake.asked.length < 2; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Two were given a place; the other two were told there is none, before anything ran.
    expect(fake.asked.length).toBe(2);
    go();
    await Promise.all(conversations.map((conversation) => t.h.runs.settled(conversation)));
    expect(fake.asked.length).toBe(2);
    const mine = await json<{ code: { runs: number } }>(
      await t.h.api(t.mo, "GET", "/api/app/usage?range=7d"),
    );
    expect(mine.code.runs).toBe(2);
  });

  it("counts by the sandbox's own clock: a run that broke or was ended counts, one that never started does not", async () => {
    const { SandboxError } = await import("./sandbox.js");
    let n = 0;
    const fake = fakeSandbox(() => {
      n += 1;
      // Ended for using too much memory, after 40 seconds: no answer of its own to go by.
      if (n === 1)
        throw new SandboxError(
          "broke",
          "It was ended: it used more memory than a sandbox has.",
          40,
        );
      // Never started: the sandbox was busy.
      if (n === 2) throw new SandboxError("busy", "The sandbox is busy. Try again in a moment.");
      // Ran 10 seconds on two processors, whatever it says of itself.
      return { wall: 10, cpus: 2, ...({ cpu: 0, peakKb: 0 } as object) };
    });
    const t = await start([run(), null, run(), null, run(), null], fake);
    const conversation = await t.converse(t.owner);
    await t.say(t.owner, conversation);
    await t.say(t.owner, conversation);
    await t.say(t.owner, conversation);
    const mine = await json<{ code: { runs: number; cpuSeconds: number } }>(
      await t.h.api(t.owner, "GET", "/api/app/usage?range=7d"),
    );
    // 40 s and 10 s, each on two processors; the busy one is no run at all.
    expect(mine.code).toMatchObject({ runs: 2, cpuSeconds: 100 });
    const page = await json<{ totals: { runs: number; failed: number; cpuSeconds: number } }>(
      await t.h.api(t.owner, "GET", "/api/sandbox/usage?range=7d"),
    );
    expect(page.totals).toMatchObject({ runs: 2, failed: 1, cpuSeconds: 100 });
  });

  it("holds a run's place at the most it can come to while it is going", async () => {
    let go: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      go = resolve;
    });
    const fake = fakeSandbox(async () => {
      await gate;
      return { wall: 3, cpus: 2 };
    });
    const t = await start(
      [{ name: "code.run", args: { why: "x", code: "x", seconds: 120 } }, null],
      fake,
    );
    const conversation = await t.converse(t.owner);
    await t.h.api(t.owner, "POST", `/api/app/conversations/${conversation}/messages`, {
      content: "Go",
    });
    for (let i = 0; i < 100 && fake.asked.length === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const during = await json<{ code: { runs: number; cpuSeconds: number } }>(
      await t.h.api(t.owner, "GET", "/api/app/usage?range=7d"),
    );
    // 120 seconds on two processors, until it is known what it took.
    expect(during.code).toMatchObject({ runs: 1, cpuSeconds: 240 });
    go();
    await t.h.runs.settled(conversation);
    const after = await json<{ code: { runs: number; cpuSeconds: number } }>(
      await t.h.api(t.owner, "GET", "/api/app/usage?range=7d"),
    );
    expect(after.code).toMatchObject({ runs: 1, cpuSeconds: 6 });
  });
  it("closes the line of a run whose server stopped under it, once its time is well past, and only once", async () => {
    const t = await start(
      [null],
      fakeSandbox(async () => ({ wall: 1, cpus: 2 })),
    );
    const [who] = await t.h.db.query<{ org_id: string; user_id: string }>(
      "select m.org_id, m.user_id from memberships m join users u on u.id = m.user_id where u.email = 'owner@acme.test'",
    );
    const at = {
      orgId: who?.org_id as string,
      userId: who?.user_id as string,
      conversationId: null,
    };
    // Two runs that asked for a minute each and were never heard of again; one still going.
    const lost = (await t.h.runs.sandboxUse.reserve(at, 60)) as { id: string };
    const also = (await t.h.runs.sandboxUse.reserve(at, 60)) as { id: string };
    const going = (await t.h.runs.sandboxUse.reserve(at, 300)) as { id: string };
    const lines = async () =>
      Object.fromEntries(
        (
          await t.h.db.query<{ id: string; ending: string; seconds: number; cpu_seconds: number }>(
            "select id, ending, seconds, cpu_seconds from sandbox_runs",
          )
        ).map((line) => [line.id, line]),
      );
    // Within its time and the margin after it, a line is left alone.
    const soon = new Date(Date.now() + (60 + LOST_AFTER - 30) * 1000);
    expect(await sweepSandboxRuns(t.h.db, soon)).toBe(0);
    expect((await lines())[lost.id]).toMatchObject({ ending: "running" });
    // Past it: closed as lost, at the time it asked for on both processors. The one that
    // asked for longer is still within its own time. Two servers asking at once close it once.
    const later = new Date(Date.now() + (60 + LOST_AFTER + 30) * 1000);
    const closed = await Promise.all([
      sweepSandboxRuns(t.h.db, later),
      sweepSandboxRuns(t.h.db, later),
    ]);
    expect(closed[0] + closed[1]).toBe(2);
    const after = await lines();
    expect(after[lost.id]).toMatchObject({ ending: "lost", seconds: 60, cpu_seconds: 120 });
    expect(after[also.id]).toMatchObject({ ending: "lost", seconds: 60, cpu_seconds: 120 });
    expect(after[going.id]).toMatchObject({ ending: "running", cpu_seconds: 600 });
    // A run that ends after all does not write over a line already closed.
    await t.h.runs.sandboxUse.settle(lost.id, { ending: "ok", wall: 2 });
    expect((await lines())[lost.id]).toMatchObject({ ending: "lost", cpu_seconds: 120 });
    // What was lost still counts in the person's day: it may have run all of it.
    expect(await t.h.runs.sandboxUse.today(at.orgId, at.userId)).toMatchObject({
      runs: 3,
      cpuSeconds: 840,
    });
  });
});
