import {
  type AssistantMessage,
  type Context,
  createAssistantMessageEventStream,
  type StreamFn,
} from "@openclaw/llm-core";
import { beforeAll, describe, expect, it } from "vitest";
import type { ProjectUpdate } from "./projects.js";
import { type Harness, harness, toldTo } from "./test-support.js";

const json = async <T = unknown>(response: Response): Promise<T> => (await response.json()) as T;
type Call = { name: string; args: Record<string, unknown> };

/** A model that makes the calls it is given, one a turn; null ends a reply with a word. */
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

describe("a project's updates", () => {
  let h: Harness;
  let owner: string;
  let mo: string;
  let id: string;
  const at = () => `/api/app/projects/${id}/updates`;
  const updates = async () => json<ProjectUpdate[]>(await h.api(owner, "GET", at()));
  const health = async () =>
    (
      await json<{ id: string; health: string | null }[]>(
        await h.api(owner, "GET", "/api/app/projects"),
      )
    ).find((one) => one.id === id)?.health;
  beforeAll(async () => {
    h = await harness();
    owner = (await h.signIn("owner@acme.test")).cookie as string;
    await h.api(owner, "POST", "/api/invitations", { email: "mo@acme.test", role: "member" });
    mo = (await h.signIn("mo@acme.test")).cookie as string;
    id = (
      await json<{ id: string }>(
        await h.api(owner, "POST", "/api/app/projects", { name: "Launch" }),
      )
    ).id;
  });

  it("are added one after another, newest first, and the newest says how the project is going", async () => {
    expect(await updates()).toEqual([]);
    expect(await health()).toBeNull();
    const first = await json<ProjectUpdate>(
      await h.api(owner, "POST", at(), {
        health: "on_track",
        text: "  Page drafted.\r\nLegal next.  ",
      }),
    );
    expect(first).toMatchObject({
      health: "on_track",
      text: "Page drafted.\nLegal next.",
      by: null,
    });
    await h.api(owner, "POST", at(), { health: "at_risk", text: "Legal has not answered." });
    expect((await updates()).map((one) => one.health)).toEqual(["at_risk", "on_track"]);
    expect(await health()).toBe("at_risk");
  });

  it("refuse what does not say how it is going", async () => {
    for (const bad of [
      { health: "fine", text: "x" },
      { health: "on_track", text: "   " },
      { health: "on_track", text: "x".repeat(2001) },
      { health: "on_track" },
    ])
      expect((await h.api(owner, "POST", at(), bad)).status).toBe(400);
    expect((await updates()).length).toBe(2);
  });

  it("are nobody else's, and one can be deleted by its owner", async () => {
    const [newest] = await updates();
    expect((await h.api(mo, "GET", at())).status).toBe(404);
    expect((await h.api(mo, "POST", at(), { health: "on_track", text: "Mine" })).status).toBe(404);
    expect((await h.api(mo, "DELETE", `${at()}/${newest?.id}`)).status).toBe(404);
    expect((await h.api(owner, "DELETE", `${at()}/${newest?.id}`)).status).toBe(200);
    // With the newest gone, the one before it says how the project is going.
    expect(await health()).toBe("on_track");
  });
});

describe("a project's updates, written by an agent", () => {
  it("are written when asked for, from what the agent is shown, and shown to the next conversation", async () => {
    const model = scripted([
      {
        name: "project.update",
        args: {
          health: "at_risk",
          text: "Done: the page draft.\nAt risk: legal has not read it.\nNext: book the webinar.",
        },
      },
      null,
      { name: "project.update", args: { health: "splendid", text: "x" } },
      null,
      null,
    ]);
    const h = await harness({}, { streamFn: model.streamFn });
    const owner = (await h.signIn("owner@acme.test")).cookie as string;
    const id = (
      await json<{ id: string }>(
        await h.api(owner, "POST", "/api/app/projects", { name: "Launch" }),
      )
    ).id;
    const { agents } = await json<{ agents: { id: string; name: string }[] }>(
      await h.api(owner, "GET", "/api/app/agents"),
    );
    const agentId = agents.find((agent) => agent.name === "Writer")?.id;
    const talk = async (content: string, projectId?: string) => {
      const conversation = (
        await json<{ id: string }>(
          await h.api(owner, "POST", "/api/app/conversations", {
            agentId,
            ...(projectId ? { projectId } : {}),
          }),
        )
      ).id;
      await h.api(owner, "POST", `/api/app/conversations/${conversation}/messages`, { content });
      await h.runs.settled(conversation);
      return conversation;
    };
    const first = await talk("How is it going?", id);
    expect(model.seen[0]?.systemPrompt).toContain("The project's latest update");
    expect(model.seen[0]?.systemPrompt).toContain("(none yet)");
    expect((model.seen[0]?.tools ?? []).map((tool) => tool.name)).toContain("project.update");
    const kept = await json<ProjectUpdate[]>(
      await h.api(owner, "GET", `/api/app/projects/${id}/updates`),
    );
    expect(kept).toMatchObject([{ health: "at_risk", by: "Writer" }]);
    expect(kept[0]?.text).toContain("legal has not read it");
    // What was written is not in the record of the run: only that something was.
    const view = await json<{ messages: { steps: { tool: string; detail: string }[] }[] }>(
      await h.api(owner, "GET", `/api/app/conversations/${first}`),
    );
    expect(view.messages[1]?.steps).toMatchObject([{ tool: "project.update", detail: "" }]);

    // The next conversation in the project is shown it; a health that is not one is refused.
    await talk("And now?", id);
    expect(model.seen[2]?.systemPrompt).toContain("at risk, written by Writer");
    expect(model.seen[2]?.systemPrompt).toContain("legal has not read it");
    expect(
      (await json<ProjectUpdate[]>(await h.api(owner, "GET", `/api/app/projects/${id}/updates`)))
        .length,
    ).toBe(1);

    // Outside a project there is no such tool.
    await talk("Hello");
    expect((model.seen.at(-1)?.tools ?? []).map((tool) => tool.name)).not.toContain(
      "project.update",
    );
  });
});
