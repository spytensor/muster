import {
  type AssistantMessage,
  type Context,
  createAssistantMessageEventStream,
  type StreamFn,
} from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { riskOf, withCompanions } from "./runtime/catalog.js";
import { createSandbox, type Sandbox, SandboxError, type SandboxRun } from "./sandbox.js";
import { type Harness, harness, toldTo } from "./test-support.js";

type Call = { name: string; args: Record<string, unknown> };

/** A model that makes the calls it is given, one a turn, then says a word. */
function scripted(calls: (Call | null)[]) {
  const seen: Context[] = [];
  let at = 0;
  const streamFn: StreamFn = (model, context) => {
    seen.push({
      systemPrompt: toldTo(context),
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

/** A sandbox that keeps files in memory and answers a run as it is told to. */
function fakeSandbox(
  answer: (code: string, files: Map<string, Uint8Array>) => Partial<SandboxRun>,
) {
  const spaces = new Map<string, Map<string, Uint8Array>>();
  const ran: { space: string; language: string; code: string; seconds?: number }[] = [];
  let ready = true;
  const of = (space: string) =>
    spaces.get(space) ?? (spaces.set(space, new Map()).get(space) as Map<string, Uint8Array>);
  const sandbox: Sandbox = {
    health: async () => ({ ready, isolation: ready ? "gvisor" : null, reason: "", running: 0 }),
    put: async (space, name, bytes) => void of(space).set(name, bytes),
    get: async (space, name) => {
      const bytes = of(space).get(name);
      if (!bytes) throw new SandboxError("no_file", `There is no "${name}" in the workspace.`);
      return bytes;
    },
    run: async (space, asked) => {
      ran.push({ space, ...asked });
      return {
        exit: 0,
        timedOut: false,
        seconds: 0.4,
        stdout: "",
        stderr: "",
        cut: 0,
        changed: [],
        deleted: [],
        skipped: [],
        files: [],
        ...answer(asked.code, of(space)),
      };
    },
    forget: async (space) => void spaces.delete(space),
  };
  return { sandbox, spaces, ran, down: () => (ready = false) };
}

const json = async <T>(response: Response) => (await response.json()) as T;
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82,
]);

async function start(calls: (Call | null)[], fake: ReturnType<typeof fakeSandbox> | null) {
  const model = scripted(calls);
  const h: Harness = await harness(
    {},
    { streamFn: model.streamFn, ...(fake ? { sandbox: fake.sandbox } : {}) },
  );
  const owner = (await h.signIn("owner@acme.test")).cookie as string;
  const { agents } = await json<{ agents: { id: string; name: string }[] }>(
    await h.api(owner, "GET", "/api/app/agents"),
  );
  const converse = async (name: string) =>
    (
      await json<{ id: string }>(
        await h.api(owner, "POST", "/api/app/conversations", {
          agentId: agents.find((agent) => agent.name === name)?.id,
        }),
      )
    ).id;
  const say = async (conversation: string, content: string) => {
    await h.api(owner, "POST", `/api/app/conversations/${conversation}/messages`, { content });
    await h.runs.settled(conversation);
  };
  const result = (turn: number) =>
    ((model.seen[turn] as Context).messages.at(-1) as { content: { text: string }[] }).content[0]
      ?.text as string;
  const offered = (turn = 0) =>
    ((model.seen[turn] as Context).tools ?? []).map((tool) => tool.name);
  return { h, owner, model, converse, say, result, offered };
}

describe("running code in a sandbox", () => {
  it("puts the named files in, runs the code, and saves what the agent asks to keep", async () => {
    const fake = fakeSandbox((_code, files) => {
      files.set("chart.png", PNG);
      return {
        stdout: "north 120\nsouth 80\n",
        changed: [{ name: "chart.png", size: PNG.length }],
      };
    });
    const t = await start(
      [
        {
          name: "code.run",
          args: {
            why: "Totals by region",
            code: "import pandas as pd\nprint(pd.read_csv('sales.csv').groupby('region').sum())",
            files: ["sales.csv"],
            keep: ["chart.png"],
            seconds: 20,
          },
        },
      ],
      fake,
    );
    await t.h.upload(t.owner, "sales.csv", "region,sales\nnorth,120\nsouth,80\n");
    const conversation = await t.converse("Assistant");
    await t.say(conversation, "Total the sales by region and chart them");

    expect(t.offered()).toContain("code.run");
    expect(t.model.seen[0]?.systemPrompt).toContain("code.run");
    // The workspace is the conversation's, and holds the file the agent named.
    expect(fake.ran).toMatchObject([{ space: conversation, language: "python", seconds: 20 }]);
    expect(new TextDecoder().decode(fake.spaces.get(conversation)?.get("sales.csv"))).toContain(
      "north,120",
    );
    const said = t.result(1);
    expect(said).toContain("It ended well");
    expect(said).toContain("north 120");
    expect(said).toContain("Saved to the person's files, and shown with your reply: chart.png");

    const mine = await json<
      { id: string; name: string; kind: string; source: string; conversationId: string }[]
    >(await t.h.api(t.owner, "GET", "/api/app/files"));
    const chart = mine.find((file) => file.name === "chart.png");
    expect(chart).toMatchObject({ kind: "image", source: "agent", conversationId: conversation });
    const view = await json<{
      messages: { steps: { tool: string; detail: string; status: string; file?: string }[] }[];
    }>(await t.h.api(t.owner, "GET", `/api/app/conversations/${conversation}`));
    // The person sees what the step was for, not the code; and which file it made.
    expect(view.messages[1]?.steps).toMatchObject([
      { tool: "code.run", detail: "Totals by region", status: "ok", file: chart?.id },
    ]);
  });

  it("tells the agent how a run ended when it did not end well, and saves nothing from it", async () => {
    const outcomes: Partial<SandboxRun>[] = [
      { exit: 1, stderr: "Traceback\nKeyError: 'regoin'\n" },
      { exit: -1, timedOut: true, stdout: "half\n" },
      { exit: -9 },
    ];
    const fake = fakeSandbox((_code, files) => {
      files.set("out.csv", new TextEncoder().encode("a\n1\n"));
      return outcomes.shift() as Partial<SandboxRun>;
    });
    const call = { name: "code.run", args: { why: "Try", code: "x", keep: ["out.csv"] } };
    const t = await start([call, call, call], fake);
    const conversation = await t.converse("Assistant");
    await t.say(conversation, "go");
    expect(t.result(1)).toContain("It failed (exit 1)");
    expect(t.result(1)).toContain("KeyError: 'regoin'");
    expect(t.result(1)).toContain("Not saved: out.csv (the run did not end well)");
    expect(t.result(2)).toContain("ran past its time");
    expect(t.result(3)).toContain("more memory");
    expect(await json<unknown[]>(await t.h.api(t.owner, "GET", "/api/app/files"))).toEqual([]);
    // Each of them is a step that failed, said so on its row.
    const view = await json<{ messages: { steps: { tool: string; status: string }[] }[] }>(
      await t.h.api(t.owner, "GET", `/api/app/conversations/${conversation}`),
    );
    expect(view.messages[1]?.steps.map((step) => step.status)).toEqual(["error", "error", "error"]);
  });

  it("says which file could not be kept, and why, without failing the step", async () => {
    const fake = fakeSandbox((_code, files) => {
      files.set("tool.exe", new Uint8Array([77, 90, 1, 2]));
      return { changed: [{ name: "tool.exe", size: 4 }] };
    });
    const t = await start(
      [{ name: "code.run", args: { why: "Make", code: "x", keep: ["tool.exe", "missing.png"] } }],
      fake,
    );
    await t.say(await t.converse("Assistant"), "go");
    expect(t.result(1)).toContain("tool.exe (not a kind of file that is kept here)");
    expect(t.result(1)).toContain('missing.png (There is no "missing.png" in the workspace.)');
  });

  it("replaces what an earlier run in the same conversation kept, and no other file of that name", async () => {
    const fake = fakeSandbox((_code, files) => {
      files.set("out/report.md", new TextEncoder().encode("# From a run"));
      files.set("chart.png", PNG);
      return {};
    });
    const keep = {
      name: "code.run",
      args: { why: "Keep", code: "x", keep: ["chart.png", "out/report.md"] },
    };
    const t = await start(
      [
        // First conversation: a document made from a recipe, then a run that keeps a file of the same name.
        { name: "files.create", args: { name: "report.md", text: "# Made from a recipe" } },
        keep,
        null,
        // The second conversation, then the first again.
        keep,
        null,
        keep,
      ],
      fake,
    );
    const first = await t.converse("Assistant");
    await t.say(first, "make it");
    const names = async () =>
      (
        await json<{ id: string; name: string; version: number }[]>(
          await t.h.api(t.owner, "GET", "/api/app/files"),
        )
      )
        .map((file) => file.name)
        .sort();
    // The recipe's document is still there beside the run's: neither took the other's place.
    expect(await names()).toEqual(["chart.png", "report.md", "report.md"]);
    expect(t.result(2)).toContain(
      "Saved to the person's files, and shown with your reply: chart.png, report.md",
    );

    // Another conversation keeps the same names: the first conversation's files stay.
    await t.say(await t.converse("Assistant"), "again, elsewhere");
    expect(await names()).toEqual([
      "chart.png",
      "chart.png",
      "report.md",
      "report.md",
      "report.md",
    ]);
    // The first conversation runs again: what its earlier run kept is replaced, nothing else.
    await t.say(first, "once more");
    expect(await names()).toEqual([
      "chart.png",
      "chart.png",
      "report.md",
      "report.md",
      "report.md",
    ]);
    // The document made from a recipe is still the one that can be changed in place.
    const mine = await json<{ name: string; version: number; conversationId: string }[]>(
      await t.h.api(t.owner, "GET", "/api/app/files"),
    );
    expect(mine.filter((file) => file.conversationId === first)).toHaveLength(3);
  });

  it("refuses two files to keep under one name", async () => {
    const fake = fakeSandbox(() => ({}));
    const t = await start(
      [{ name: "code.run", args: { why: "x", code: "x", keep: ["a/out.png", "b/out.png"] } }],
      fake,
    );
    await t.say(await t.converse("Assistant"), "go");
    expect(t.result(1)).toContain("Two of the files to keep have the same name");
    expect(fake.ran).toEqual([]);
  });

  it("refuses a file that is not the person's, and what is asked for wrongly", async () => {
    const fake = fakeSandbox(() => ({}));
    const t = await start(
      [
        { name: "code.run", args: { why: "x", code: "x", files: ["nobody's.csv"] } },
        { name: "code.run", args: { why: "x", code: "   " } },
        {
          name: "code.run",
          args: { why: "x", code: "x", files: Array.from({ length: 11 }, (_, i) => `f${i}`) },
        },
      ],
      fake,
    );
    await t.say(await t.converse("Assistant"), "go");
    expect(t.result(1)).toContain('There is no file named "nobody\'s.csv"');
    expect(t.result(2)).toContain("code is the program to run");
    expect(t.result(3)).toContain("At most 10 files");
    expect(fake.ran).toEqual([]);
  });

  it("is not offered where the server has no sandbox, or the sandbox is not ready", async () => {
    const none = await start([], null);
    await none.say(await none.converse("Assistant"), "hello");
    expect(none.offered()).not.toContain("code.run");
    expect(none.model.seen[0]?.systemPrompt).not.toContain("code.run");

    const fake = fakeSandbox(() => ({}));
    fake.down();
    const down = await start([], fake);
    await down.say(await down.converse("Assistant"), "hello");
    expect(down.offered()).not.toContain("code.run");
  });

  it("is how an uploaded Office file is changed: the agent is told so, and so is the refusal to change it in place", async () => {
    const fake = fakeSandbox(() => ({}));
    const t = await start(
      [{ name: "files.change", args: { name: "Contract.docx", note: "x", sections: [] } }],
      fake,
    );
    // An upload, not a file made here: a few bytes that begin as a Word file does.
    await t.h.upload(
      t.owner,
      "Contract.docx",
      new Uint8Array([0x50, 0x4b, 3, 4, 20, 0, 0, 0, 8, 0]),
    );
    await t.say(await t.converse("Assistant"), "Change clause 3");
    expect(t.model.seen[0]?.systemPrompt).toContain("can be changed as it is, with code.run");
    expect(t.model.seen[0]?.systemPrompt).toContain("never under the old name");
    expect(t.result(1)).toContain("was uploaded by the person");
    expect(t.result(1)).toContain("python-docx, openpyxl or python-pptx");
  });

  it("comes with making files, to agents that may make them and to no others", async () => {
    expect(withCompanions(["files.create"])).toContain("code.run");
    expect(withCompanions(["files.read", "web.fetch"])).not.toContain("code.run");
    // It reaches no further than making a file does.
    expect(riskOf(withCompanions(["files.create"]))).toBe(riskOf(["files.create"]));
    const fake = fakeSandbox(() => ({}));
    const t = await start([], fake);
    // The Messenger sends things out and makes no files: it runs no code either.
    await t.say(await t.converse("Messenger"), "hello");
    expect(t.offered()).not.toContain("code.run");
  });
});

describe("the sandbox's address", () => {
  const base = {
    MUSTER_DEV: "1",
    MUSTER_PUBLIC_URL: "http://localhost:7400",
    MUSTER_BOOTSTRAP_OWNER_EMAIL: "o@a.test",
  };
  it("is a setting; without it there is no sandbox", () => {
    expect(createSandbox(loadConfig(base))).toBeNull();
    expect(loadConfig({ ...base, MUSTER_SANDBOX_URL: "http://sandbox:7420" }).sandbox).toEqual({
      url: "http://sandbox:7420",
    });
    expect(() => loadConfig({ ...base, MUSTER_SANDBOX_URL: "sandbox:7420" })).toThrow(
      /MUSTER_SANDBOX_URL/,
    );
  });

  it("says the sandbox is not ready when it cannot be reached", async () => {
    const sandbox = createSandbox(
      loadConfig({ ...base, MUSTER_SANDBOX_URL: "http://127.0.0.1:9" }),
    );
    expect(await sandbox?.health()).toMatchObject({ ready: false });
    await expect(
      sandbox?.run("s", { language: "python", code: "x", seconds: 1 }),
    ).rejects.toBeInstanceOf(SandboxError);
  });
});
