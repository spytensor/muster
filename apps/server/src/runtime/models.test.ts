import type { AssistantMessage, AssistantMessageEvent, Context } from "@openclaw/llm-core";
import { describe, expect, it, vi } from "vitest";
import type { ModelConfig } from "../config.js";
import { createModelFn, describeModel, MODEL_SILENT } from "./models.js";

const base = {
  id: "m-1",
  baseUrl: "https://model.test",
  apiKey: "k",
  inputPrice: 2,
  outputPrice: 10,
};
const openai: ModelConfig = { ...base, api: "openai", vision: false };
const anthropic: ModelConfig = { ...base, api: "anthropic", vision: false };

/** A fetch that answers with a server-sent-events body, split into awkward chunks, and records the request. */
function fakeFetch(events: string[], init: { status?: number; body?: string } = {}) {
  const seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] =
    [];
  const fetchImpl = (async (url: string, request: RequestInit) => {
    seen.push({
      url,
      headers: request.headers as Record<string, string>,
      body: JSON.parse(String(request.body)),
    });
    if (init.status) return new Response(init.body ?? "", { status: init.status });
    const text = events.map((event) => `data: ${event}\n\n`).join("");
    // Cut mid-event and mid-character to prove the reader reassembles them.
    const bytes = new TextEncoder().encode(text);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < bytes.length; at += 7) controller.enqueue(bytes.slice(at, at + 7));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

async function run(
  config: ModelConfig,
  fetchImpl: typeof fetch,
  context: Context,
  signal?: AbortSignal,
) {
  const events: AssistantMessageEvent[] = [];
  const stream = await createModelFn(config, fetchImpl)(describeModel(config), context, {
    signal,
  });
  for await (const event of stream) events.push(event);
  const last = events.at(-1) as AssistantMessageEvent;
  const message = (
    last.type === "done" ? last.message : last.type === "error" ? last.error : undefined
  ) as AssistantMessage;
  return { events, message };
}

const context: Context = {
  systemPrompt: "Be brief.",
  messages: [
    { role: "user", content: "What is in my notes?", timestamp: 1 },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Let me look." },
        { type: "toolCall", id: "c1", name: "docs.read", arguments: { title: "Notes" } },
      ],
      api: "x",
      provider: "x",
      model: "x",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "docs.read",
      content: [{ type: "text", text: "Buy milk — 你好" }],
      isError: false,
      timestamp: 3,
    },
  ],
  tools: [
    {
      name: "docs.read",
      description: "Read a document.",
      parameters: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
      } as never,
    },
  ],
};

describe("the OpenAI-compatible transport", () => {
  const chunk = (delta: unknown, extra: object = {}) =>
    JSON.stringify({ choices: [{ delta, ...extra }] });

  it("sends the conversation in the endpoint's shape", async () => {
    const { fetchImpl, seen } = fakeFetch([chunk({ content: "ok" }), "[DONE]"]);
    await run(openai, fetchImpl, context);
    expect(seen[0]?.url).toBe("https://model.test/chat/completions");
    expect(seen[0]?.headers.authorization).toBe("Bearer k");
    expect(seen[0]?.body).toMatchObject({
      model: "m-1",
      stream: true,
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "What is in my notes?" },
        {
          role: "assistant",
          content: "Let me look.",
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "docs__read", arguments: '{"title":"Notes"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: "Buy milk — 你好" },
      ],
      tools: [{ type: "function", function: { name: "docs__read" } }],
    });
  });

  it("turns streamed text into text events and a final message with usage and cost", async () => {
    const { fetchImpl } = fakeFetch([
      chunk({ content: "Buy " }),
      chunk({ content: "milk — 你好" }),
      chunk({}, { finish_reason: "stop" }),
      JSON.stringify({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 500 } }),
      "[DONE]",
    ]);
    const { events, message } = await run(openai, fetchImpl, context);
    expect(events.map((e) => e.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
      "done",
    ]);
    expect(message.content).toEqual([{ type: "text", text: "Buy milk — 你好" }]);
    expect(message.stopReason).toBe("stop");
    // 1000 tokens in at $2 per million, 500 out at $10 per million.
    expect(message.usage).toMatchObject({
      input: 1000,
      output: 500,
      totalTokens: 1500,
      cost: { input: 0.002, output: 0.005, total: 0.007 },
    });
  });

  it("counts what the service read from its cache as part of the prompt, at its own price", async () => {
    // OpenAI's name for it, then DeepSeek's. 1000 in, of which 800 were read from the cache
    // at $0.5 per million; the other 200 at $2; 500 out at $10.
    for (const usage of [
      {
        prompt_tokens: 1000,
        completion_tokens: 500,
        prompt_tokens_details: { cached_tokens: 800 },
      },
      { prompt_tokens: 1000, completion_tokens: 500, prompt_cache_hit_tokens: 800 },
    ]) {
      const { fetchImpl } = fakeFetch([
        chunk({ content: "ok" }),
        JSON.stringify({ choices: [], usage }),
        "[DONE]",
      ]);
      const { message } = await run({ ...openai, cachedInputPrice: 0.5 }, fetchImpl, context);
      expect(message.usage).toMatchObject({
        input: 1000,
        output: 500,
        cacheRead: 800,
        cacheWrite: 0,
        totalTokens: 1500,
      });
      expect(message.usage.cost.input).toBeCloseTo(0.0004);
      expect(message.usage.cost.cacheRead).toBeCloseTo(0.0004);
      expect(message.usage.cost.total).toBeCloseTo(0.0058);
    }
    // No price of its own for the cache: what was read from it costs what the rest does.
    const { fetchImpl } = fakeFetch([
      JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 1000, completion_tokens: 500, prompt_cache_hit_tokens: 800 },
      }),
      "[DONE]",
    ]);
    const { message } = await run(openai, fetchImpl, context);
    expect(message.usage.cacheRead).toBe(800);
    expect(message.usage.cost.total).toBeCloseTo(0.007);
    expect(describeModel({ ...openai, cachedInputPrice: 0.5 }).cost).toMatchObject({
      input: 2,
      cacheRead: 0.5,
      cacheWrite: 2,
    });
  });

  it("assembles tool calls that arrive in pieces, and maps their names back", async () => {
    const { fetchImpl } = fakeFetch([
      chunk({
        tool_calls: [{ index: 0, id: "a", function: { name: "docs__read", arguments: '{"ti' } }],
      }),
      chunk({
        tool_calls: [{ index: 1, id: "b", function: { name: "web__fetch", arguments: "" } }],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'tle":"Notes"}' } }] }),
      chunk({
        tool_calls: [{ index: 1, function: { arguments: '{"url":"https://example.com"}' } }],
      }),
      chunk({}, { finish_reason: "tool_calls" }),
      "[DONE]",
    ]);
    const { message } = await run(openai, fetchImpl, context);
    expect(message.stopReason).toBe("toolUse");
    expect(message.content).toEqual([
      { type: "toolCall", id: "a", name: "docs.read", arguments: { title: "Notes" } },
      { type: "toolCall", id: "b", name: "web.fetch", arguments: { url: "https://example.com" } },
    ]);
  });

  it("gives a tool call with unreadable arguments an empty object rather than failing the reply", async () => {
    const { fetchImpl } = fakeFetch([
      chunk({
        tool_calls: [
          { index: 0, id: "a", function: { name: "docs__read", arguments: "{not json" } },
        ],
      }),
      "[DONE]",
    ]);
    expect((await run(openai, fetchImpl, context)).message.content).toEqual([
      { type: "toolCall", id: "a", name: "docs.read", arguments: {} },
    ]);
  });

  it("never shows the key a service quotes back, and does not follow an answer to another address", async () => {
    const { fetchImpl } = fakeFetch([], {
      status: 401,
      body: '{"error":"invalid key k-secret-123"}',
    });
    let asked: RequestInit | undefined;
    const watching = ((url: string, request: RequestInit) => {
      asked = request;
      return fetchImpl(url, request);
    }) as typeof fetch;
    for (const config of [
      { ...openai, apiKey: "k-secret-123" },
      { ...anthropic, apiKey: "k-secret-123" },
    ]) {
      const { message } = await run(config, watching, context);
      expect(message.stopReason).toBe("error");
      expect(message.errorMessage).toContain("invalid key");
      expect(JSON.stringify(message)).not.toContain("k-secret-123");
      expect(asked?.redirect).toBe("error");
    }
  });

  it("reports a refused request as an error event, not an exception", async () => {
    const { fetchImpl } = fakeFetch([], { status: 401, body: '{"error":"bad key"}' });
    const { events, message } = await run(openai, fetchImpl, context);
    expect(events.at(-1)?.type).toBe("error");
    expect(message).toMatchObject({ stopReason: "error" });
    expect(message.errorMessage).toContain("401");
  });

  it("reports a stop as aborted", async () => {
    const controller = new AbortController();
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_, reject) =>
        init.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      )) as unknown as typeof fetch;
    const pending = run(openai, fetchImpl, context, controller.signal);
    controller.abort();
    expect((await pending).message).toMatchObject({ stopReason: "aborted" });
  });

  it("marks a reply cut off by the length limit", async () => {
    const { fetchImpl } = fakeFetch([
      chunk({ content: "long" }),
      chunk({}, { finish_reason: "length" }),
      "[DONE]",
    ]);
    expect((await run(openai, fetchImpl, context)).message.stopReason).toBe("length");
  });
});

describe("the Anthropic transport", () => {
  const e = (event: object) => JSON.stringify(event);

  it("sends the conversation in the endpoint's shape, tool results inside a user turn", async () => {
    const { fetchImpl, seen } = fakeFetch([e({ type: "message_stop" })]);
    await run(anthropic, fetchImpl, context);
    expect(seen[0]?.url).toBe("https://model.test/v1/messages");
    expect(seen[0]?.headers["x-api-key"]).toBe("k");
    expect(seen[0]?.body).toMatchObject({
      model: "m-1",
      // Marked as the end of a part that stays the same, so that the service keeps it.
      system: [{ type: "text", text: "Be brief.", cache_control: { type: "ephemeral" } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "What is in my notes?" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me look." },
            { type: "tool_use", id: "c1", name: "docs__read", input: { title: "Notes" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "c1",
              content: "Buy milk — 你好",
              is_error: false,
              // The last thing said: the next asking begins with all of this one.
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
      tools: [
        {
          name: "docs__read",
          input_schema: { type: "object" },
          cache_control: { type: "ephemeral" },
        },
      ],
    });
  });

  it("turns streamed text and a tool call into events and a final message", async () => {
    const { fetchImpl } = fakeFetch([
      e({ type: "message_start", message: { usage: { input_tokens: 200 } } }),
      e({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      e({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Checking" } }),
      e({ type: "content_block_stop", index: 0 }),
      e({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "t1", name: "docs__write" },
      }),
      e({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"title":"A",' },
      }),
      e({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '"content":"B"}' },
      }),
      e({ type: "content_block_stop", index: 1 }),
      e({
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 40 },
      }),
      e({ type: "message_stop" }),
    ]);
    const { events, message } = await run(anthropic, fetchImpl, context);
    expect(events.map((x) => x.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "toolcall_start",
      "toolcall_end",
      "done",
    ]);
    expect(message.content).toEqual([
      { type: "text", text: "Checking" },
      { type: "toolCall", id: "t1", name: "docs.write", arguments: { title: "A", content: "B" } },
    ]);
    expect(message.stopReason).toBe("toolUse");
    expect(message.usage).toMatchObject({ input: 200, output: 40 });
  });

  it("reports an error the endpoint sends mid-stream", async () => {
    const { fetchImpl } = fakeFetch([
      e({ type: "message_start", message: {} }),
      e({ type: "error", error: { message: "overloaded" } }),
    ]);
    expect((await run(anthropic, fetchImpl, context)).message).toMatchObject({
      stopReason: "error",
      errorMessage: "overloaded",
    });
  });
});

describe("a message with an image", () => {
  const context: Context = {
    systemPrompt: "s",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          { type: "image", data: "QUJD", mimeType: "image/png" },
        ],
        timestamp: 0,
      },
    ],
  };

  it("goes to an OpenAI-style endpoint as text plus a data address", async () => {
    const { fetchImpl, seen } = fakeFetch(["[DONE]"]);
    await run({ ...openai, vision: true }, fetchImpl, context);
    expect(((seen[0]?.body.messages ?? []) as unknown[]).at(-1)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "What is this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
      ],
    });
  });

  it("goes to an Anthropic endpoint as an image block before the text", async () => {
    const { fetchImpl, seen } = fakeFetch([JSON.stringify({ type: "message_stop" })]);
    await run({ ...anthropic, vision: true }, fetchImpl, context);
    expect(((seen[0]?.body.messages ?? []) as unknown[]).at(-1)).toEqual({
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
        { type: "text", text: "What is this?", cache_control: { type: "ephemeral" } },
      ],
    });
  });

  it("adds what an Anthropic endpoint read from and wrote to its cache to the prompt", async () => {
    // That service counts the three apart: 50 new, 900 read, 250 written make a prompt of 1200.
    const { fetchImpl } = fakeFetch([
      JSON.stringify({
        type: "message_start",
        message: {
          usage: {
            input_tokens: 50,
            cache_read_input_tokens: 900,
            cache_creation_input_tokens: 250,
          },
        },
      }),
      JSON.stringify({ type: "message_delta", delta: {}, usage: { output_tokens: 10 } }),
      JSON.stringify({ type: "message_stop" }),
    ]);
    const { message } = await run(
      { ...anthropic, cachedInputPrice: 0.2, cacheWritePrice: 2.5 },
      fetchImpl,
      context,
    );
    expect(message.usage).toMatchObject({
      input: 1200,
      output: 10,
      cacheRead: 900,
      cacheWrite: 250,
    });
    // 50 at $2, 900 at $0.2, 250 at $2.5, 10 out at $10, per million.
    expect(message.usage.cost.total).toBeCloseTo((50 * 2 + 900 * 0.2 + 250 * 2.5 + 10 * 10) / 1e6);
  });

  it("says a model can take images only when it is configured to", () => {
    expect(describeModel(openai).input).toEqual(["text"]);
    expect(describeModel({ ...openai, vision: true }).input).toEqual(["text", "image"]);
  });
});

describe("a model that may write less than it was asked to allow", () => {
  it("is asked again with the least any model allows, and from then on", async () => {
    const asked: number[] = [];
    const fetchImpl = (async (_url: string, request: RequestInit) => {
      const body = JSON.parse(String(request.body)) as { max_tokens: number };
      asked.push(body.max_tokens);
      if (body.max_tokens > 8192)
        return new Response(
          JSON.stringify({
            error: { message: "max_tokens is too large: 16000. This model supports at most 8192." },
          }),
          { status: 400 },
        );
      const text = `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello." } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
      return new Response(text, { status: 200 });
    }) as unknown as typeof fetch;
    const small = { ...openai, baseUrl: "https://small.example/v1" };
    const first = await run(small, fetchImpl, context);
    expect(first.message.content).toMatchObject([{ type: "text", text: "Hello." }]);
    await run(small, fetchImpl, context);
    // Refused once, then never asked for more than it allows again.
    expect(asked).toEqual([16000, 4096, 4096]);
  });
});

describe("a model that thinks before it answers", () => {
  // The service's own stream: thinking arrives as `reasoning_content`, never as `content`.
  const sse = (events: unknown[]) =>
    new Response(
      `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
      {
        status: 200,
      },
    );
  const thoughtItAway = () =>
    sse([
      { choices: [{ delta: { reasoning_content: "Let me consider every wheel spoke…" } }] },
      { choices: [{ delta: {}, finish_reason: "length" }] },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 16000 } },
    ]);
  const answered = () =>
    sse([
      { choices: [{ delta: { content: "Here it is." } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 200 } },
    ]);
  const asks = (reply: (effort: unknown, n: number) => Response) => {
    const efforts: unknown[] = [];
    const fetchImpl = (async (_url: string, request: RequestInit) => {
      const body = JSON.parse(String(request.body)) as { reasoning_effort?: string };
      efforts.push(body.reasoning_effort);
      return reply(body.reasoning_effort, efforts.length);
    }) as unknown as typeof fetch;
    return { efforts, fetchImpl };
  };

  it("is asked again, told not to think, when it thought its whole allowance away and said nothing", async () => {
    const { efforts, fetchImpl } = asks((effort) => (effort ? answered() : thoughtItAway()));
    const { message } = await run(openai, fetchImpl, context);
    expect(efforts).toEqual([undefined, "none"]);
    expect(message.stopReason).toBe("stop");
    expect(message.content).toEqual([{ type: "text", text: "Here it is." }]);
    // What the first try spent is part of what the reply cost.
    expect(message.usage).toMatchObject({ input: 200, output: 16200 });
  });

  it("is asked once: if it still says nothing, the reply is said to be cut off", async () => {
    const { efforts, fetchImpl } = asks(() => thoughtItAway());
    const { message } = await run(openai, fetchImpl, context);
    expect(efforts).toEqual([undefined, "none"]);
    expect(message.stopReason).toBe("length");
    expect(message.usage).toMatchObject({ input: 200, output: 32000 });
  });

  it("is not waited on to the end: with half its allowance thought away and nothing said, it is asked again at once", async () => {
    // 16,000 tokens allowed; half of that, at three characters a token, is 24,000 characters.
    const thinking = (chars: number) => ({
      choices: [{ delta: { reasoning_content: "x".repeat(chars) } }],
    });
    let cancelled = false;
    const { efforts, fetchImpl } = asks((effort) => {
      if (effort) return answered();
      const lines = [thinking(20_000), thinking(5000), thinking(5000)].map(
        (event) => `data: ${JSON.stringify(event)}\n\n`,
      );
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            const line = lines.shift();
            if (line) controller.enqueue(new TextEncoder().encode(line));
            else controller.close();
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200 },
      );
    });
    const { message } = await run(openai, fetchImpl, context);
    expect(efforts).toEqual([undefined, "none"]);
    // The request is given up, not read to its end.
    expect(cancelled).toBe(true);
    expect(message.content).toEqual([{ type: "text", text: "Here it is." }]);
    // The thinking that was cut short is counted from what arrived: 25,000 characters. Its
    // prompt, which the service never reported, is counted as the second try's: 100 twice.
    expect(message.usage.output).toBe(200 + Math.ceil(25_000 / 3));
    expect(message.usage.input).toBe(200);
  });

  it("may think as long as it likes once it has begun to answer or to call a tool", async () => {
    const { efforts, fetchImpl } = asks(() =>
      sse([
        { choices: [{ delta: { content: "First, " } }] },
        { choices: [{ delta: { reasoning_content: "x".repeat(60_000) } }] },
        { choices: [{ delta: { content: "done." } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    );
    const { message } = await run(openai, fetchImpl, context);
    expect(efforts).toEqual([undefined]);
    expect(message.content).toEqual([{ type: "text", text: "First, done." }]);
  });

  it("is not asked again when it had begun its answer: that reply is gone on with, not thought anew", async () => {
    const { efforts, fetchImpl } = asks(() =>
      sse([
        { choices: [{ delta: { content: "<!doctype html>" } }] },
        { choices: [{ delta: {}, finish_reason: "length" }] },
      ]),
    );
    const { message } = await run(openai, fetchImpl, context);
    expect(efforts).toEqual([undefined]);
    expect(message.stopReason).toBe("length");
  });

  it("keeps the cut-off reply, not a failure, when the service does not know the setting", async () => {
    const { efforts, fetchImpl } = asks((effort) =>
      effort
        ? new Response(JSON.stringify({ error: { message: "Unrecognized request argument" } }), {
            status: 400,
          })
        : thoughtItAway(),
    );
    const { message } = await run(openai, fetchImpl, context);
    expect(efforts).toEqual([undefined, "none"]);
    expect(message.stopReason).toBe("length");
    expect(message.errorMessage).toBeUndefined();
  });

  it("says a turn made without thinking had none, to a service that asks for the thinking back", async () => {
    type Turn = { role: string; tool_calls?: unknown; reasoning_content?: string };
    const sent: Turn[][] = [];
    const fetchImpl = (async (_url: string, request: RequestInit) => {
      const body = JSON.parse(String(request.body)) as {
        reasoning_effort?: string;
        messages: Turn[];
      };
      sent.push(body.messages);
      if (sent.length === 1) return thoughtItAway();
      return sse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "plain-1", function: { name: "docs__read", arguments: "{}" } },
                ],
              },
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]);
    }) as unknown as typeof fetch;
    const first = await run(openai, fetchImpl, {
      ...context,
      messages: [context.messages[0]],
    } as Context);
    expect(first.message.stopReason).toBe("toolUse");
    // The next call replays that turn: it carries empty thinking; the turn from before does not.
    await run(openai, fetchImpl, {
      ...context,
      messages: [...context.messages, first.message],
    } as Context);
    const replayed = (sent.at(-1) ?? []).filter((turn) => turn.tool_calls);
    expect(replayed.map((turn) => turn.reasoning_content)).toEqual([undefined, ""]);
  });

  it("asks again with empty thinking on every tool turn when the service refuses for want of it", async () => {
    const sent: { tool_calls?: unknown; reasoning_content?: string }[][] = [];
    const fetchImpl = (async (_url: string, request: RequestInit) => {
      const body = JSON.parse(String(request.body)) as { messages: (typeof sent)[number] };
      sent.push(body.messages);
      return sent.length === 1
        ? new Response(
            JSON.stringify({
              error: {
                message:
                  "The `reasoning_content` in the thinking mode must be passed back to the API.",
              },
            }),
            { status: 400 },
          )
        : answered();
    }) as unknown as typeof fetch;
    const { message } = await run(openai, fetchImpl, context);
    expect(message.content).toEqual([{ type: "text", text: "Here it is." }]);
    expect(sent).toHaveLength(2);
    expect((sent[1] ?? []).filter((turn) => turn.tool_calls)[0]?.reasoning_content).toBe("");
    // Remembered: the call after it says so at once, and is asked only once.
    await run(openai, fetchImpl, context);
    expect(sent).toHaveLength(3);
    expect((sent[2] ?? []).filter((turn) => turn.tool_calls)[0]?.reasoning_content).toBe("");
  });

  it("fails, and is not called a cut-off reply, when the second try breaks", async () => {
    // Mid-way through a tool call: a call that was never finished must not be run.
    const broke = asks((effort) =>
      effort
        ? sse([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { index: 0, id: "c9", function: { name: "docs__read", arguments: "{" } },
                    ],
                  },
                },
              ],
            },
          ]).body
          ? new Response(
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        { index: 0, id: "c9", function: { name: "docs__read", arguments: "{" } },
                      ],
                    },
                  },
                ],
              })}\n\n`,
              { status: 200 },
            )
          : thoughtItAway()
        : thoughtItAway(),
    );
    const cut = await run(openai, broke.fetchImpl, context);
    expect(broke.efforts).toEqual([undefined, "none"]);
    expect(cut.message.stopReason).toBe("error");
    expect(cut.events.at(-1)?.type).toBe("error");

    // The service falling over is a failure too, not a refusal of the setting.
    const down = asks((effort) =>
      effort ? new Response("upstream gone", { status: 500 }) : thoughtItAway(),
    );
    const failed = await run(openai, down.fetchImpl, context);
    expect(failed.message.stopReason).toBe("error");
    expect(failed.message.errorMessage).toContain("500");
  });

  it("is not asked again when the deployment has already told it not to think", async () => {
    const { efforts, fetchImpl } = asks(() => thoughtItAway());
    const { message } = await run({ ...openai, reasoningEffort: "none" }, fetchImpl, context);
    expect(efforts).toEqual(["none"]);
    expect(message.stopReason).toBe("length");
  });

  it("tells whoever is waiting how much it has thought, as the thinking arrives", async () => {
    const { fetchImpl } = asks(() =>
      sse([
        { choices: [{ delta: { reasoning_content: "x".repeat(300) } }] },
        { choices: [{ delta: { reasoning_content: "x".repeat(200) } }] },
        { choices: [{ delta: { content: "Done." } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    );
    const heard: number[] = [];
    const stream = await createModelFn(openai, fetchImpl)(describeModel(openai), context, {
      onThinking: (chars: number) => heard.push(chars),
    } as never);
    const types: string[] = [];
    for await (const event of stream) types.push(event.type);
    expect(heard).toEqual([300, 500]);
    // Thinking is not part of the reply: no event of the reply carries it.
    expect(types).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
  });

  it("is told how hard to think on every call when the deployment says so", async () => {
    const { efforts, fetchImpl } = asks(() => answered());
    await run({ ...openai, reasoningEffort: "high" }, fetchImpl, context);
    expect(efforts).toEqual(["high"]);
  });
});

describe("a gateway in front of the model that gave up", () => {
  const hello = `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello." } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
  it("is asked again, and the answer that then comes is the answer", async () => {
    let calls = 0;
    const fetchImpl = (async () =>
      ++calls === 1
        ? new Response("Bad Gateway", { status: 502 })
        : new Response(hello, { status: 200 })) as unknown as typeof fetch;
    const result = await run(
      { ...openai, baseUrl: "https://flaky.example/v1" },
      fetchImpl,
      context,
    );
    expect(result.message.content).toMatchObject([{ type: "text", text: "Hello." }]);
    expect(calls).toBe(2);
  });
  it("is given up on after three tries, and a refusal is not asked again at all", async () => {
    let calls = 0;
    const down = (async () => {
      calls++;
      return new Response("Bad Gateway", { status: 502 });
    }) as unknown as typeof fetch;
    const failed = await run({ ...openai, baseUrl: "https://down.example/v1" }, down, context);
    expect(failed.message.stopReason).toBe("error");
    expect(failed.message.errorMessage).toContain("502");
    expect(calls).toBe(3);
    calls = 0;
    const refuses = (async () => {
      calls++;
      return new Response("{}", { status: 401 });
    }) as unknown as typeof fetch;
    await run({ ...openai, baseUrl: "https://refuses.example/v1" }, refuses, context);
    expect(calls).toBe(1);
  });
});

describe("a second model behind the first", () => {
  const sse = (text: string) =>
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
  const pair: ModelConfig = {
    ...openai,
    baseUrl: "https://first.example/v1",
    fallback: { ...openai, id: "second-model", baseUrl: "https://second.example/v1" },
  };
  it("is asked when the first cannot answer at all, and its answer is the answer", async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string, request: RequestInit) => {
      asked.push(
        `${new URL(url).host} ${(JSON.parse(String(request.body)) as { model: string }).model}`,
      );
      return url.includes("first.example")
        ? new Response("Bad Gateway", { status: 502 })
        : new Response(sse("From the second."), { status: 200 });
    }) as unknown as typeof fetch;
    const { events, message } = await run(pair, fetchImpl, context);
    expect(message.content).toMatchObject([{ type: "text", text: "From the second." }]);
    expect(message.model).toBe("second-model");
    // One reply was started, not two.
    expect(events.filter((event) => event.type === "start")).toHaveLength(1);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(asked.at(-1)).toBe("second.example second-model");
  });
  it("is not asked what the first model refused", async () => {
    let second = 0;
    const refuses = (async (url: string) => {
      if (url.includes("second.example")) second++;
      return new Response(JSON.stringify({ error: { message: "context too long" } }), {
        status: 400,
      });
    }) as unknown as typeof fetch;
    const { message } = await run(
      { ...pair, baseUrl: "https://first.example/v3" },
      refuses,
      context,
    );
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("400");
    expect(second).toBe(0);
  });
  it("is left alone when the first answers, and when the first broke off after it began", async () => {
    let second = 0;
    const answers = (async (url: string) => {
      if (url.includes("second.example")) second++;
      return new Response(sse("From the first."), { status: 200 });
    }) as unknown as typeof fetch;
    const fine = await run(pair, answers, context);
    expect(fine.message.content).toMatchObject([{ type: "text", text: "From the first." }]);
    // Began to answer, then the stream ended without finishing.
    const breaks = (async (url: string) => {
      if (url.includes("second.example")) second++;
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Half an" } }] })}\n\n`,
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const broke = await run({ ...pair, baseUrl: "https://first.example/v2" }, breaks, context);
    expect(JSON.stringify(broke.message.content)).toContain("Half an");
    expect(second).toBe(0);
  });
});

describe("a model that goes silent", () => {
  /** A fetch whose first `silentCalls` answers open and then say nothing, until the call is given up. */
  function stalling(silentCalls: number) {
    let calls = 0;
    const fetchImpl = (async (_url: string, request: RequestInit) => {
      calls += 1;
      if (calls > silentCalls) {
        const text = `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello." } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
        return new Response(text, { status: 200 });
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          request.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls: () => calls };
  }

  it("is asked once more when it had said nothing, and the answer then arrives", async () => {
    vi.useFakeTimers();
    try {
      const { fetchImpl, calls } = stalling(1);
      const pending = run(openai, fetchImpl, context);
      await vi.advanceTimersByTimeAsync(181_000);
      const { message } = await pending;
      expect(calls()).toBe(2);
      expect(message.stopReason).toBe("stop");
      expect(message.content).toMatchObject([{ type: "text", text: "Hello." }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is given up the second time, with a cause that can be told to the person", async () => {
    vi.useFakeTimers();
    try {
      const { fetchImpl, calls } = stalling(5);
      const pending = run(openai, fetchImpl, context);
      await vi.advanceTimersByTimeAsync(181_000);
      await vi.advanceTimersByTimeAsync(181_000);
      const { message } = await pending;
      expect(calls()).toBe(2);
      expect(message.stopReason).toBe("error");
      expect(message.errorMessage).toBe(MODEL_SILENT);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up a model that began and then fell silent after the deployment's own wait", async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const fetchImpl = (async (_url: string, request: RequestInit) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}\n\n`,
                ),
              );
              request.signal?.addEventListener("abort", () => {
                aborted = true;
                controller.error(new Error("aborted"));
              });
            },
          }),
          { status: 200 },
        )) as unknown as typeof fetch;
      const pending = run({ ...openai, silenceSeconds: 10 }, fetchImpl, context);
      await vi.advanceTimersByTimeAsync(9_000);
      expect(aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      const { message } = await pending;
      expect(aborted).toBe(true);
      expect(message.errorMessage).toBe(MODEL_SILENT);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits as long as the deployment says, not the 180 seconds it waits when nothing is said (CHA-187)", async () => {
    vi.useFakeTimers();
    try {
      const { fetchImpl, calls } = stalling(5);
      const pending = run({ ...openai, firstWordSeconds: 20 }, fetchImpl, context);
      // Two waits of 20 seconds, and the person is told: 41 seconds, not six minutes.
      await vi.advanceTimersByTimeAsync(20_500);
      await vi.advanceTimersByTimeAsync(20_500);
      const { message } = await pending;
      expect(calls()).toBe(2);
      expect(message.errorMessage).toBe(MODEL_SILENT);
    } finally {
      vi.useRealTimers();
    }
  });
});
