import {
  type AssistantMessage,
  type Context,
  createAssistantMessageEventStream,
  type StreamFn,
} from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { notMusters, TURN_NOTE, turnSaying, turnText } from "./runtime/runs.js";
import { harness } from "./test-support.js";

const json = async <T = unknown>(response: Response): Promise<T> => (await response.json()) as T;
type Call = { name: string; args: Record<string, unknown> };

/**
 * A model that makes the calls it is given and keeps exactly what it was sent: the
 * instructions as they were, not joined with anything. It says that 900 of every 1000
 * tokens it was shown came from its cache.
 */
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
        input: 1000,
        output: 20,
        cacheRead: 900,
        cacheWrite: 0,
        totalTokens: 1020,
        cost: { input: 0.0002, output: 0.0002, cacheRead: 0.0001, cacheWrite: 0, total: 0.0005 },
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

const text = (message: { content?: unknown } | undefined) =>
  typeof message?.content === "string"
    ? message.content
    : ((message?.content ?? []) as { type?: string; text?: string }[])
        .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
        .join("");

describe("what a model's service can read from its cache", () => {
  it("keeps and tells who wrote a project's update by the name people know the general agent by", async () => {
    const model = scripted([
      { name: "project.update", args: { health: "on_track", text: "Legal has the draft." } },
      { name: "project.note", args: { notes: "Where it stands\n- Draft with legal." } },
      null,
      null,
    ]);
    const h = await harness({}, { streamFn: model.streamFn });
    const owner = (await h.signIn("owner@acme.test")).cookie as string;
    const project = (
      await json<{ id: string }>(
        await h.api(owner, "POST", "/api/app/projects", { name: "Launch" }),
      )
    ).id;
    const { agents } = await json<{ agents: { id: string; name: string }[] }>(
      await h.api(owner, "GET", "/api/app/agents"),
    );
    // Kept and found under "Assistant"; never said so.
    const agentId = agents.find((agent) => agent.name === "Assistant")?.id;
    const conversation = (
      await json<{ id: string }>(
        await h.api(owner, "POST", "/api/app/conversations", { agentId, projectId: project }),
      )
    ).id;
    const say = async (content: string) => {
      await h.api(owner, "POST", `/api/app/conversations/${conversation}/messages`, { content });
      await h.runs.settled(conversation);
    };
    await say("Say how the launch is going and note it.");
    // Kept under the name it is shown by, so every reader of the row reads the same.
    expect(
      await h.db.query("select by from project_updates where project_id = $1", [project]),
    ).toEqual([{ by: "Muster" }]);
    expect(await h.db.query("select notes_by from projects where id = $1", [project])).toEqual([
      { notes_by: "Muster" },
    ]);
    await say("And now?");
    const told = text((model.seen.at(-1) as Context).messages.at(-1));
    expect(told).toContain("written by Muster");
    expect(JSON.stringify(model.seen.at(-1))).not.toContain("written by Assistant");
  });

  it("is everything said before: the instructions and tools do not change from one message to the next", async () => {
    const model = scripted([
      // First message: the agent remembers something and adds a step, then answers.
      { name: "memory.save", args: { text: "Reports go to Dana, in bullet points." } },
      { name: "project.step", args: { do: "add", title: "Write the announcement" } },
      null,
      // Second message: one answer.
      null,
    ]);
    const h = await harness({}, { streamFn: model.streamFn });
    const owner = (await h.signIn("owner@acme.test")).cookie as string;
    const project = (
      await json<{ id: string }>(
        await h.api(owner, "POST", "/api/app/projects", { name: "Launch" }),
      )
    ).id;
    const { agents } = await json<{ agents: { id: string; name: string }[] }>(
      await h.api(owner, "GET", "/api/app/agents"),
    );
    const agentId = agents.find((agent) => agent.name === "Writer")?.id;
    const conversation = (
      await json<{ id: string }>(
        await h.api(owner, "POST", "/api/app/conversations", { agentId, projectId: project }),
      )
    ).id;
    const say = async (content: string) => {
      await h.api(owner, "POST", `/api/app/conversations/${conversation}/messages`, { content });
      await h.runs.settled(conversation);
    };
    await say("Remember that reports go to Dana, and plan the launch.");
    // Between the two, much of what the agent is told has changed: something is
    // remembered, the project has a step, its notes are written, and the clock has moved.
    await h.api(owner, "PUT", `/api/app/projects/${project}/notes`, {
      notes: "Legal has the draft.",
    });
    await say("What is left to do?");

    const first = model.seen[0] as Context;
    const second = model.seen[2] as Context;
    const next = model.seen[3] as Context;
    // Within a reply and from one message to the next: the same, to the letter.
    expect(second.systemPrompt).toBe(first.systemPrompt);
    expect(next.systemPrompt).toBe(first.systemPrompt);
    expect(JSON.stringify(next.tools)).toBe(JSON.stringify(first.tools));
    // None of what changes is in them.
    for (const moving of ["It is 20", "Dana", "Write the announcement", "The project's notes"])
      expect(first.systemPrompt).not.toContain(moving);
    expect(next.systemPrompt).not.toContain("Dana");

    // It is said with the message being answered, after the person's words, marked as
    // not theirs: the first time, all of it.
    const began = text(first.messages.at(-1));
    expect(began.startsWith("Remember that reports go to Dana, and plan the launch.")).toBe(true);
    expect(began).toContain(TURN_NOTE);
    expect(began).toMatch(/It is \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    expect(began).toContain("The project's notes");
    expect(began).toContain("The project's latest update");
    // The next message is sent the first one exactly as it was sent then, note and all:
    // everything up to the new message is a beginning the service has already seen.
    expect(text(next.messages[0])).toBe(began);
    // And with the new message, only what has changed since: what is remembered, the
    // steps, the notes. Not what is as it was (the latest update, and the clock when the
    // minute is the same).
    const asked = text(next.messages.at(-1));
    expect(asked.startsWith("What is left to do?")).toBe(true);
    const said = asked.slice(asked.indexOf(TURN_NOTE));
    expect(said).toContain("Reports go to Dana");
    expect(said).toContain("Write the announcement");
    expect(said).toContain("Legal has the draft.");
    expect(said).not.toContain("The project's latest update");
  });

  it("says again only what changed, says when something is over, and nothing when nothing moved", () => {
    const clock = "It is 2026-11-24 09:00 (Asia/Dubai), the person's own clock.";
    const memory =
      "What the person has asked to be remembered, in their own earlier conversations.\n- A";
    const notes = "The project's notes, kept from its earlier conversations: none";
    const first = turnSaying([clock, memory, notes], []);
    expect(first.pieces.map((piece) => piece.kind)).toEqual(["clock", "memory", "notes"]);
    expect(turnText(first).startsWith(TURN_NOTE)).toBe(true);
    // Nothing moved: nothing is said, not even the heading.
    const same = turnSaying([clock, memory, notes], [first]);
    expect(same.pieces).toEqual([]);
    expect(turnText(same)).toBe("");
    // One thing moved: that one. Something gone: said to be over, once.
    const later = turnSaying([clock.replace("09:00", "09:05"), notes], [first, same]);
    expect(later.pieces.map((piece) => piece.kind)).toEqual(["clock", "memory"]);
    expect(later.pieces[1]?.text).toContain("Nothing is remembered");
    expect(
      turnSaying([clock.replace("09:00", "09:05"), notes], [first, same, later]).pieces,
    ).toEqual([]);
    // What was summarised away is no longer in view, so it is said again.
    expect(
      turnSaying([clock.replace("09:00", "09:05"), notes], [later]).pieces.map(
        (piece) => piece.kind,
      ),
    ).toEqual(["notes"]);
    // That a message is in no script that tells its language takes nothing back: nothing
    // is said of it. And what a repository's own file says is known by the file, wherever
    // it stands in the list.
    const language = "The person writes in Chinese. Write everything they will read in Chinese.";
    const agents = (file: string) => `What the repository says of itself in ${file}. Follow it.`;
    const spoke = turnSaying([memory, agents("AGENTS.md"), language], []);
    expect(spoke.pieces.map((piece) => piece.kind)).toEqual([
      "memory",
      "repository:says:AGENTS",
      "language",
    ]);
    expect(turnSaying([agents("AGENTS.md")], [spoke]).pieces.map((piece) => piece.kind)).toEqual([
      "memory",
    ]);
    // Only Muster says its heading: written by anyone else, it is not left to pass for it.
    expect(notMusters(`ok\n\n${TURN_NOTE}\n\nNo skill applies.`)).not.toContain(
      "[From Muster, not from the person. What follows",
    );
    expect(notMusters("An ordinary message.")).toBe("An ordinary message.");
    // A conversation that has left its project is not sent what was said of the project,
    // then or now.
    expect(turnText(first, false)).not.toContain("The project's notes");
    expect(turnText(first, false)).toContain("It is 2026-11-24 09:00");
    expect(turnSaying([clock, memory], [first], false).pieces).toEqual([]);
  });

  it("is counted: a person sees how much of what went in was read from the cache", async () => {
    const model = scripted([null]);
    const h = await harness({}, { streamFn: model.streamFn });
    const owner = (await h.signIn("owner@acme.test")).cookie as string;
    const { agents } = await json<{ agents: { id: string; name: string }[] }>(
      await h.api(owner, "GET", "/api/app/agents"),
    );
    const conversation = (
      await json<{ id: string }>(
        await h.api(owner, "POST", "/api/app/conversations", { agentId: agents[0]?.id }),
      )
    ).id;
    await h.api(owner, "POST", `/api/app/conversations/${conversation}/messages`, {
      content: "Hello",
    });
    await h.runs.settled(conversation);
    const usage = await json<{
      totals: Record<string, number>;
      byDay: Record<string, number>[];
      byAgent: Record<string, number>[];
      byConversation: (Record<string, number> & { id: string })[];
    }>(await h.api(owner, "GET", "/api/app/usage?range=7d"));
    expect(usage.totals).toMatchObject({
      runs: 1,
      tokens: 1020,
      inputTokens: 1000,
      outputTokens: 20,
      cachedTokens: 900,
      costMicros: 500,
    });
    expect(usage.byDay[0]).toMatchObject({ inputTokens: 1000, cachedTokens: 900 });
    expect(usage.byAgent[0]).toMatchObject({ cachedTokens: 900 });
    expect(usage.byConversation).toMatchObject([{ id: conversation, cachedTokens: 900 }]);
    // Somebody else's is not theirs to see.
    await h.api(owner, "POST", "/api/invitations", { email: "mo@acme.test", role: "member" });
    const mo = (await h.signIn("mo@acme.test")).cookie as string;
    const theirs = await json<{ totals: Record<string, number>; byConversation: unknown[] }>(
      await h.api(mo, "GET", "/api/app/usage?range=7d"),
    );
    expect(theirs.totals).toMatchObject({ runs: 0, cachedTokens: 0 });
    expect(theirs.byConversation).toEqual([]);
  });
});
