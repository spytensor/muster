import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type StreamFn,
} from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { harness } from "./test-support.js";

const json = async <T = unknown>(response: Response): Promise<T> => (await response.json()) as T;

/** A model that answers anything in a word and says each asking cost half a thousandth of a dollar. */
function plain() {
  let asked = 0;
  const streamFn: StreamFn = (model) => {
    asked += 1;
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: 'root = Stack([a])\na = Text("Noted.")' }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 1000,
        output: 20,
        cacheRead: 400,
        cacheWrite: 0,
        totalTokens: 1020,
        cost: { input: 0.0003, output: 0.0001, cacheRead: 0.0001, cacheWrite: 0, total: 0.0005 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
    });
    return stream;
  };
  return { streamFn, asked: () => asked };
}

describe("a summary made while a reply is written (MUS-51)", () => {
  it("is a call of the run like any other: on its record, in its cost, and in what the person used", async () => {
    const model = plain();
    // A small model: a few long messages are more than it holds.
    const h = await harness({ MUSTER_MODEL_CONTEXT_WINDOW: "16000" }, { streamFn: model.streamFn });
    const owner = (await h.signIn("owner@acme.test")).cookie as string;
    const { agents } = await json<{ agents: { id: string }[] }>(
      await h.api(owner, "GET", "/api/app/agents"),
    );
    const conversation = (
      await json<{ id: string }>(
        await h.api(owner, "POST", "/api/app/conversations", { agentId: agents[0]?.id }),
      )
    ).id;
    const long = (n: number) =>
      `Part ${n} of the minutes. ${"The team went through the list item by item and agreed what to do next. ".repeat(160)}`;
    let summaries = 0;
    for (let n = 1; n <= 8 && summaries === 0; n++) {
      await h.api(owner, "POST", `/api/app/conversations/${conversation}/messages`, {
        content: long(n),
      });
      await h.runs.settled(conversation);
      summaries = Number(
        (
          await h.db.query<{ n: string }>(
            "select count(*) as n from spans where kind = 'llm' and name = 'summary'",
          )
        )[0]?.n ?? 0,
      );
    }
    expect(summaries).toBe(1);
    // The summary is a call of that run: with its tokens, what was read from the cache, and its cost.
    const [span] = await h.db.query<{
      trace_id: string;
      prompt_tokens: number;
      completion_tokens: number;
      cached_tokens: number;
      cost_micros: string;
    }>(
      "select trace_id, prompt_tokens, completion_tokens, cached_tokens, cost_micros from spans where name = 'summary'",
    );
    expect(span).toMatchObject({ prompt_tokens: 1000, completion_tokens: 20, cached_tokens: 400 });
    expect(Number(span?.cost_micros)).toBe(500);
    // And the run's own totals hold it beside the answer: two askings, not one.
    const [trace] = await h.db.query<{
      prompt_tokens: number;
      cached_tokens: number;
      cost_micros: string;
    }>("select prompt_tokens, cached_tokens, cost_micros from traces where id = $1", [
      span?.trace_id,
    ]);
    expect(trace).toMatchObject({ prompt_tokens: 2000, cached_tokens: 800 });
    expect(Number(trace?.cost_micros)).toBe(1000);
    // What the person is shown as used is every asking there was, the summary among them.
    const usage = await json<{ totals: { costMicros: number; inputTokens: number } }>(
      await h.api(owner, "GET", "/api/app/usage?range=7d"),
    );
    expect(usage.totals.costMicros).toBe(model.asked() * 500);
    expect(usage.totals.inputTokens).toBe(model.asked() * 1000);
  });
});
