import {
  type AssistantMessage,
  type Context,
  createAssistantMessageEventStream,
  type StreamFn,
} from "@openclaw/llm-core";
import { beforeAll, describe, expect, it } from "vitest";
import type { ProjectMember, ProjectUpdate, Step } from "./projects.js";
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

type Listed = {
  id: string;
  name: string;
  role: string;
  owner: { id: string; name: string } | null;
  people: number;
  conversations: number;
};

describe("a project's people", () => {
  let h: Harness;
  const model = scripted([
    // Mo's conversation, working in the project: takes up its first step.
    { name: "project.step", args: { do: "update", step: 1, state: "doing" } },
    null,
    // Vi's, who only sees it: it tries to add a step, and is told it may not.
    { name: "project.step", args: { do: "add", title: "Slipped in" } },
    null,
    // Mo's again, after being taken out of the project.
    null,
  ]);
  let owner: string;
  let mo: string;
  let vi: string;
  let out: string;
  let moId: string;
  let viId: string;
  let outId: string;
  let ownerId: string;
  let id: string;
  const at = (rest = "") => `/api/app/projects/${id}${rest}`;
  const person = async (q: string) =>
    (await json<{ id: string }[]>(await h.api(owner, "GET", `/api/app/people?q=${q}`)))[0]
      ?.id as string;
  const listed = async (as: string) =>
    (await json<Listed[]>(await h.api(as, "GET", "/api/app/projects"))).find(
      (one) => one.id === id,
    );
  const status = async (as: string, method: string, path: string, body?: unknown) =>
    (await h.api(as, method, path, body)).status;

  beforeAll(async () => {
    h = await harness({}, { streamFn: model.streamFn });
    owner = (await h.signIn("owner@acme.test")).cookie as string;
    for (const one of ["mo", "vi", "out"])
      await h.api(owner, "POST", "/api/invitations", { email: `${one}@acme.test`, role: "member" });
    mo = (await h.signIn("mo@acme.test")).cookie as string;
    vi = (await h.signIn("vi@acme.test")).cookie as string;
    out = (await h.signIn("out@acme.test")).cookie as string;
    moId = await person("mo@");
    viId = await person("vi@");
    outId = await person("out@");
    ownerId = (await json<{ id: string }[]>(await h.api(mo, "GET", "/api/app/people?q=owner@")))[0]
      ?.id as string;
    id = (
      await json<{ id: string }>(
        await h.api(owner, "POST", "/api/app/projects", {
          name: "Launch",
          instructions: "Write plainly.",
        }),
      )
    ).id;
    await h.api(owner, "POST", at("/steps"), { title: "Draft the announcement" });
    await h.api(owner, "PUT", at("/notes"), { notes: "- Price is settled" });
  });

  it("are brought in by its owner, to see it or to work in it, and told so", async () => {
    // Nobody but the owner is in it, and nobody else brings anyone in.
    expect(
      (await json<ProjectMember[]>(await h.api(owner, "GET", at("/members")))).map((one) => [
        one.id,
        one.role,
      ]),
    ).toEqual([[ownerId, "owner"]]);
    expect(await status(mo, "GET", at("/members"))).toBe(404);
    expect(await status(mo, "PUT", at(`/members/${moId}`), { role: "work" })).toBe(404);

    expect(await status(owner, "PUT", at(`/members/${moId}`), { role: "work" })).toBe(200);
    expect(await status(owner, "PUT", at(`/members/${viId}`), { role: "view" })).toBe(200);
    // Said twice, it is one row and one notice; not a role, not a colleague, not themself.
    expect(await status(owner, "PUT", at(`/members/${moId}`), { role: "work" })).toBe(200);
    expect(await status(owner, "PUT", at(`/members/${moId}`), { role: "own" })).toBe(400);
    expect(await status(owner, "PUT", at(`/members/${id}`), { role: "view" })).toBe(400);
    expect(await status(owner, "PUT", at(`/members/${ownerId}`), { role: "view" })).toBe(400);

    const people = await json<ProjectMember[]>(await h.api(vi, "GET", at("/members")));
    expect(people.map((one) => [one.email, one.role, one.active])).toEqual([
      ["owner@acme.test", "owner", true],
      ["mo@acme.test", "work", true],
      ["vi@acme.test", "view", true],
    ]);

    // It is in their list, as someone else's; not in the list of one who was not brought in.
    expect(await listed(mo)).toMatchObject({ role: "work", owner: { id: ownerId }, people: 2 });
    expect(await listed(vi)).toMatchObject({ role: "view", people: 2 });
    expect(await listed(owner)).toMatchObject({ role: "owner", owner: null, people: 2 });
    expect(await listed(out)).toBeUndefined();

    const { notices } = await json<{
      notices: { kind: string; detail: Record<string, string>; link: string }[];
    }>(await h.api(mo, "GET", "/api/app/notices"));
    expect(notices.filter((one) => one.kind === "project_added")).toMatchObject([
      { detail: { name: "Launch", role: "work" }, link: `p/${id}` },
    ]);
    const events = await h.db.query<{ action: string }>(
      "select action from admin_events where action like 'project.%' order by seq",
    );
    expect(events.map((one) => one.action)).toEqual([
      "project.member_added",
      "project.member_added",
    ]);
  });

  it("see its steps, updates, notes and key documents; only those working in it change them", async () => {
    const spec = await json<{ id: string }>(await h.upload(owner, "Launch spec.md", "# Spec"));
    const other = await json<{ id: string }>(await h.upload(owner, "Private.md", "secret"));
    expect(await status(owner, "PUT", at(`/docs/${spec.id}`), { kind: "spec" })).toBe(200);

    for (const as of [mo, vi]) {
      expect(
        (await json<Step[]>(await h.api(as, "GET", at("/steps")))).map((s) => s.title),
      ).toEqual(["Draft the announcement"]);
      expect(await status(as, "GET", at("/updates"))).toBe(200);
      expect(
        (await json<{ name: string }[]>(await h.api(as, "GET", at("/docs")))).map((d) => d.name),
      ).toEqual(["Launch spec.md"]);
      // A key document can be opened by the people in the project; the owner's other files cannot.
      expect(await status(as, "GET", `/api/app/files/${spec.id}/content`)).toBe(200);
      expect(await status(as, "GET", `/api/app/files/${other.id}/content`)).toBe(404);
      // And not changed or deleted by them.
      expect(
        (await json<{ canChange: boolean }>(await h.api(as, "GET", `/api/app/files/${spec.id}`)))
          .canChange,
      ).toBe(false);
      expect(await status(as, "DELETE", `/api/app/files/${spec.id}`)).not.toBe(200);
    }
    expect(await status(out, "GET", `/api/app/files/${spec.id}/content`)).toBe(404);
    // It is among the files shared with them, and their agents read it by its name.
    expect(
      (await json<{ id: string; mine: boolean }[]>(await h.api(mo, "GET", "/api/app/files"))).find(
        (file) => file.id === spec.id,
      ),
    ).toMatchObject({ mine: false });
    const orgId = (
      await h.db.query<{ org_id: string }>("select org_id from projects where id = $1", [id])
    )[0]?.org_id as string;
    expect(await h.files.textByName({ orgId, userId: moId }, "Launch spec.md")).toContain("# Spec");
    await expect(h.files.textByName({ orgId, userId: outId }, "Launch spec.md")).rejects.toThrow();
    await expect(h.files.textByName({ orgId, userId: moId }, "Private.md")).rejects.toThrow();

    // Someone who only sees it changes nothing.
    expect(await status(vi, "POST", at("/steps"), { title: "x" })).toBe(403);
    expect(await status(vi, "PUT", at("/notes"), { notes: "x" })).toBe(403);
    expect(await status(vi, "POST", at("/notes/restore"))).toBe(403);
    expect(await status(vi, "POST", at("/updates"), { health: "on_track", text: "x" })).toBe(403);
    expect(await status(vi, "POST", at("/steps/adopt"), { seen: 0 })).toBe(403);
    const first = (await json<Step[]>(await h.api(vi, "GET", at("/steps"))))[0] as Step;
    expect(await status(vi, "PATCH", at(`/steps/${first.id}`), { state: "done" })).toBe(403);
    expect(await status(vi, "DELETE", at(`/steps/${first.id}`))).toBe(403);
    expect(
      (
        await json<{ error: { code: string } }>(
          await h.api(vi, "POST", at("/steps"), { title: "x" }),
        )
      ).error.code,
    ).toBe("project_view_only");

    // Someone working in it keeps its steps and notes and posts updates, under the owner.
    const added = await json<Step>(
      await h.api(mo, "POST", at("/steps"), { title: "Book the room" }),
    );
    expect(added.n).toBe(2);
    expect(await status(mo, "PATCH", at(`/steps/${added.id}`), { state: "done" })).toBe(200);
    expect(await status(mo, "PUT", at("/notes"), { notes: "- Room is booked" })).toBe(200);
    const posted = await json<ProjectUpdate>(
      await h.api(mo, "POST", at("/updates"), {
        health: "at_risk",
        text: "Room booked, copy late.",
      }),
    );
    expect(posted.author).toMatchObject({ id: moId });
    const mine = await json<ProjectUpdate>(
      await h.api(owner, "POST", at("/updates"), { health: "on_track", text: "Copy is in." }),
    );
    expect(mine.author).toMatchObject({ id: ownerId });
    expect(
      (await json<Step[]>(await h.api(owner, "GET", at("/steps")))).map((s) => [s.title, s.state]),
    ).toEqual([
      ["Draft the announcement", "todo"],
      ["Book the room", "done"],
    ]);
    expect((await listed(vi))?.name).toBe("Launch");
    // They take back their own update, not the owner's; the owner takes back any.
    expect(await status(mo, "DELETE", at(`/updates/${mine.id}`))).toBe(404);
    expect(await status(mo, "DELETE", at(`/updates/${posted.id}`))).toBe(200);

    // What stays the owner's: its name and instructions, its key documents, its people, its end.
    for (const as of [mo, vi]) {
      expect(await status(as, "PUT", at(), { name: "Mine now", instructions: "" })).toBe(403);
      expect(await status(as, "PUT", at(`/docs/${spec.id}`), { kind: "other" })).toBe(403);
      expect(await status(as, "DELETE", at(`/docs/${spec.id}`))).toBe(403);
      expect(await status(as, "PUT", at(`/members/${outId}`), { role: "view" })).toBe(403);
      expect(await status(as, "DELETE", at(`/members/${ownerId}`))).toBe(403);
      expect(await status(as, "DELETE", at())).toBe(403);
    }
    expect(await status(mo, "DELETE", at(`/members/${viId}`))).toBe(403);
    // To one who was not brought in, none of it is there.
    for (const path of ["/steps", "/updates", "/docs", "/members"])
      expect(await status(out, "GET", at(path))).toBe(404);
    expect(await status(out, "POST", at("/steps"), { title: "x" })).toBe(404);
    expect(await status(out, "DELETE", at())).toBe(404);
  });

  it("work in conversations of their own, which nobody else in the project sees", async () => {
    const { agents } = await json<{ agents: { id: string; name: string }[] }>(
      await h.api(mo, "GET", "/api/app/agents"),
    );
    const agentId = agents.find((one) => one.name === "Writer")?.id;
    // One who only sees the project starts nothing in it.
    expect(await status(vi, "POST", "/api/app/conversations", { agentId, projectId: id })).toBe(
      403,
    );
    expect(await status(out, "POST", "/api/app/conversations", { agentId, projectId: id })).toBe(
      404,
    );
    const talk = async (as: string, conversation: string) => {
      await h.api(as, "POST", `/api/app/conversations/${conversation}/messages`, { content: "Hi" });
      await h.runs.settled(conversation);
    };
    const conversation = (
      await json<{ id: string }>(
        await h.api(mo, "POST", "/api/app/conversations", { agentId, projectId: id }),
      )
    ).id;
    await talk(mo, conversation);
    const prompt = model.seen[0]?.systemPrompt ?? "";
    expect(prompt).toContain('project "Launch"');
    expect(prompt).toContain("Write plainly.");
    expect(prompt).toContain("Room is booked");
    expect(prompt).toContain("Draft the announcement");
    expect(prompt).toContain('"Launch spec.md"');
    expect((model.seen[0]?.tools ?? []).map((tool) => tool.name)).toContain("project.step");

    // The agent's change is the project's: the owner sees the step taken up, and that
    // someone is on it, with no way into a conversation that is not theirs.
    const mine = (
      await json<(Step & { conversationMine: boolean })[]>(await h.api(mo, "GET", at("/steps")))
    )[0];
    expect(mine).toMatchObject({
      state: "doing",
      conversationId: conversation,
      conversationMine: true,
    });
    const theirs = (
      await json<(Step & { conversationMine: boolean })[]>(await h.api(owner, "GET", at("/steps")))
    )[0];
    expect(theirs).toMatchObject({
      state: "doing",
      conversationId: null,
      conversationTitle: null,
      conversationMine: false,
    });
    expect(theirs).not.toHaveProperty("conversationUserId");
    expect(await status(owner, "GET", `/api/app/conversations/${conversation}`)).toBe(404);
    // Each counts their own conversations in it.
    expect((await listed(mo))?.conversations).toBe(1);
    expect((await listed(owner))?.conversations).toBe(0);

    // Someone made a viewer after they began: their agent reads the project and changes nothing.
    expect(await status(owner, "PUT", at(`/members/${viId}`), { role: "work" })).toBe(200);
    const seeing = (
      await json<{ id: string }>(
        await h.api(vi, "POST", "/api/app/conversations", { agentId, projectId: id }),
      )
    ).id;
    expect(await status(owner, "PUT", at(`/members/${viId}`), { role: "view" })).toBe(200);
    await talk(vi, seeing);
    const read = model.seen.at(-1);
    expect(read?.systemPrompt).toContain("Draft the announcement");
    // It is offered what every agent in a project is (what a model is offered does not
    // change with a person's part in it), and a call is refused when it is made.
    const names = (read?.tools ?? []).map((tool) => tool.name);
    for (const tool of ["project.step", "project.note", "project.update"])
      expect(names).toContain(tool);
    expect(JSON.stringify(read?.messages)).toContain("may only see this project");
    expect(
      (await json<Step[]>(await h.api(owner, "GET", at("/steps")))).map((step) => step.title),
    ).not.toContain("Slipped in");
  });

  it("are taken out by the owner or leave, and then reach nothing of it", async () => {
    const conversations = async (as: string) =>
      json<{ id: string; projectId: string | null }[]>(
        await h.api(as, "GET", "/api/app/conversations"),
      );
    expect((await conversations(mo))[0]?.projectId).toBe(id);
    expect(await status(owner, "DELETE", at(`/members/${moId}`))).toBe(200);
    expect(await status(owner, "DELETE", at(`/members/${moId}`))).toBe(404);
    expect(await listed(mo)).toBeUndefined();
    expect(await status(mo, "GET", at("/steps"))).toBe(404);
    expect(await status(mo, "POST", at("/steps"), { title: "x" })).toBe(404);
    const spec = (await json<{ fileId: string }[]>(await h.api(owner, "GET", at("/docs"))))[0];
    expect(await status(mo, "GET", `/api/app/files/${spec?.fileId}/content`)).toBe(404);

    // Their conversation stays theirs, in no project, and is told nothing of it any more.
    const kept = (await conversations(mo))[0];
    expect(kept?.projectId).toBeNull();
    await h.api(mo, "POST", `/api/app/conversations/${kept?.id}/messages`, { content: "More" });
    await h.runs.settled(kept?.id as string);
    const after = model.seen.at(-1);
    expect(after?.systemPrompt).not.toContain("Launch");
    expect(after?.systemPrompt).not.toContain("Room is booked");
    expect((after?.tools ?? []).map((tool) => tool.name)).not.toContain("project.step");

    // Anyone takes themself out; the owner is not someone to take out.
    expect(await status(vi, "DELETE", at(`/members/${viId}`))).toBe(200);
    expect(await listed(vi)).toBeUndefined();
    expect(await status(owner, "DELETE", at(`/members/${ownerId}`))).toBe(404);
    const events = await h.db.query<{ action: string }>(
      "select action from admin_events where action like 'project.member_%' order by seq",
    );
    expect(events.map((one) => one.action).slice(-2)).toEqual([
      "project.member_removed",
      "project.member_left",
    ]);

    // The project gone, so are its people.
    expect(await status(owner, "PUT", at(`/members/${outId}`), { role: "view" })).toBe(200);
    expect(await status(owner, "DELETE", at())).toBe(200);
    expect(await h.db.query("select 1 from project_members where project_id = $1", [id])).toEqual(
      [],
    );
  });
});
