import type { AgentMessage } from "@openclaw/agent-core";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type StreamFn,
} from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { type Compacted, compactor } from "./compact.js";

const model: Model = {
  id: "test",
  name: "test",
  api: "openai-completions",
  provider: "muster",
  baseUrl: "https://model.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  // Room for about 3,000 tokens of conversation: 20,000 less the headroom and the answer.
  contextWindow: 20_000,
  maxTokens: 1000,
};
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const said = (text: string): AgentMessage =>
  ({ role: "user", content: [{ type: "text", text }], timestamp: 1 }) as AgentMessage;
const called = (n: number): AgentMessage =>
  ({
    role: "assistant",
    content: [{ type: "toolCall", id: `c${n}`, name: "files.read", arguments: { name: `f${n}` } }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: "toolUse",
    timestamp: 1,
  }) as AgentMessage;
const gave = (n: number, chars: number): AgentMessage =>
  ({
    role: "toolResult",
    toolCallId: `c${n}`,
    toolName: "files.read",
    content: [{ type: "text", text: `file ${n} ${"x".repeat(chars)}` }],
    isError: false,
    timestamp: 1,
  }) as AgentMessage;
/** A request and `n` steps, each bringing back `chars` characters. */
const work = (n: number, chars: number): AgentMessage[] => [
  said("Find where approvals are decided."),
  ...Array.from({ length: n }, (_, at) => [called(at), gave(at, chars)]).flat(),
];
const text = (message: AgentMessage | undefined) =>
  ((message as { content: { text?: string }[] } | undefined)?.content[0]?.text ?? "") as string;

/** A summariser that answers what it is told to, and counts how often it was asked. */
function summariser(answer: string | null) {
  const asked: string[] = [];
  const streamFn: StreamFn = (described, context) => {
    asked.push(JSON.stringify(context.messages));
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      content: answer === null ? [] : [{ type: "text", text: answer }],
      api: described.api,
      provider: described.provider,
      model: described.id,
      usage: { ...usage, input: 500, output: 50 },
      stopReason: answer === null ? "error" : "stop",
      ...(answer === null ? { errorMessage: "down" } : {}),
      timestamp: 1,
    };
    queueMicrotask(() => {
      if (answer === null) stream.push({ type: "error", reason: "error", error: message });
      else stream.push({ type: "done", reason: "stop", message });
      stream.end();
    });
    return stream;
  };
  return { streamFn, asked };
}
const fit = (answer: string | null = "The person wants to know where approvals are decided.") => {
  const model_ = summariser(answer);
  const done: Compacted[] = [];
  let used = 0;
  const transform = compactor({
    model,
    streamFn: model_.streamFn,
    apiKey: "k",
    fixed: "You are an agent.",
    onCompact: (one) => done.push(one),
    onUsage: (one) => {
      used += one.input + one.output;
    },
  });
  return { transform, done, asked: model_.asked, used: () => used };
};

describe("keeping a conversation within what the model can hold (CHA-273)", () => {
  it("leaves alone what fits", async () => {
    const { transform, done, asked } = fit();
    const messages = work(3, 400);
    expect(await transform(messages)).toEqual(messages);
    expect(done).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("first leaves out what steps taken long ago brought back, and says so in their place", async () => {
    const { transform, done, asked } = fit();
    // Ten steps of 2,000 characters: too much whole, enough once the first four are left out.
    const messages = work(10, 2000);
    const shown = await transform(messages);
    expect(shown).toHaveLength(messages.length);
    expect(text(shown[2])).toMatch(/^\[This result was \d+ characters and was left out/);
    expect(text(shown[8])).toMatch(/^\[This result was/);
    // The last six are whole, and so is every call: what was asked for is still known.
    expect(text(shown[10])).toContain("file 4 xxx");
    expect(shown[1]).toEqual(messages[1]);
    expect(done).toMatchObject([{ how: "trimmed" }]);
    expect(done[0]?.after).toBeLessThan(done[0]?.before ?? 0);
    // Nothing was asked of the model for this, and what is on record is untouched.
    expect(asked).toEqual([]);
    expect(text(messages[2])).toContain("file 0 xxx");
  });

  it("then summarises the earlier part, keeps the latest turns whole, and does not ask twice", async () => {
    const { transform, done, asked, used } = fit();
    const messages = work(10, 9000);
    const shown = await transform(messages);
    expect(done.map((one) => one.how)).toEqual(["summarised"]);
    expect(asked).toHaveLength(1);
    // The summary stands first, marked as Muster's, and is not an instruction.
    expect(text(shown[0])).toContain("[From Muster, not from the person]");
    expect(text(shown[0])).toContain("where approvals are decided");
    // What follows begins with a call and its result: nothing is parted.
    expect(shown[1]?.role).toBe("assistant");
    expect(shown[2]?.role).toBe("toolResult");
    expect(shown.length).toBeLessThan(messages.length);
    expect(text(shown.at(-1))).toContain("file 9 xxx");
    // The summariser was given the person's request and the earlier steps.
    expect(asked[0]).toContain("Find where approvals are decided.");
    // What it used counts against the day.
    expect(used()).toBe(550);
    // The same messages again: the summary made is used, not made again.
    expect(await transform(messages)).toEqual(shown);
    expect(asked).toHaveLength(1);
    // More work: summarised again from the summary on, not from the beginning.
    const more = [...messages, called(10), gave(10, 9000), called(11), gave(11, 9000)];
    await transform(more);
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain("previous-summary");
  });

  it("goes on when the summary cannot be made, and says that a part is left out", async () => {
    const { transform, done } = fit(null);
    const shown = await transform(work(10, 9000));
    expect(done.map((one) => one.how)).toEqual(["summarised"]);
    expect(text(shown[0])).toContain("could not be summarised");
    expect(shown[1]?.role).toBe("assistant");
  });
});
