import { randomUUID } from "node:crypto";
import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type StreamFn,
  type ToolCall,
} from "@openclaw/llm-core";
import type { ModelConfig } from "../config.js";

/**
 * Muster's model transports. The agent loop (vendored from OpenClaw) asks for a reply
 * through a `StreamFn`; these two functions answer it by calling an Anthropic Messages
 * endpoint or any endpoint that speaks OpenAI chat completions. They replace OpenClaw's
 * own transport package, which is not vendored (see vendor/openclaw/UPSTREAM.md).
 *
 * A StreamFn never throws: a failure is reported as an `error` event carrying an
 * assistant message whose stopReason is "error" or "aborted".
 */

/**
 * The most a model may write in one go when a deployment does not say. A file an agent
 * makes is written in one go, as the arguments of one call: at 4,096 a workbook of several
 * sheets was cut off before it was finished and nothing was made (seen 2026-11-15).
 */
export const MAX_OUTPUT_TOKENS = 16_000;
/**
 * How long the model may say nothing at all before the call is given up. A model writing
 * a long document keeps sending; one that has stalled sends nothing, and the person is
 * not left watching a spinner. A whole call may take long, so only silence is timed
 * closely.
 */
const SILENCE_SECONDS = 90;
/**
 * Before its first word a model may take longer: one a company hosts itself reads a long
 * context first. Both are a deployment's to set (`MUSTER_MODEL_FIRST_WORD_SECONDS`,
 * `MUSTER_MODEL_SILENCE_SECONDS`): a fast hosted model can be given up on sooner.
 */
const FIRST_WORD_SECONDS = 180;
const REQUEST_TIMEOUT_MS = 15 * 60_000;
/** Said when the model went silent. The run reads this to tell the person. */
export const MODEL_SILENT = "The model stopped answering.";

/** The description of the configured model in the loop's own terms. */
export function describeModel(config: ModelConfig): Model {
  return {
    id: config.id,
    name: config.id,
    api: config.api === "anthropic" ? "anthropic-messages" : "openai-completions",
    provider: "muster",
    baseUrl: config.baseUrl,
    reasoning: false,
    input: config.vision ? ["text", "image"] : ["text"],
    cost: {
      input: config.inputPrice,
      output: config.outputPrice,
      cacheRead: config.cachedInputPrice ?? config.inputPrice,
      cacheWrite: config.cacheWritePrice ?? config.inputPrice,
    },
    contextWindow: config.contextWindow ?? 128_000,
    maxTokens: config.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
  };
}

/**
 * The configured model, with its second model behind it when one is set: a call the first
 * could not answer at all (unreachable, an error, silence before its first word) is put to
 * the second. A call the first began to answer is never put to the second: what was said
 * was said.
 */
export function createModelFn(config: ModelConfig, fetchImpl: typeof fetch = fetch): StreamFn {
  const first = createStreamFn(config, fetchImpl);
  if (!config.fallback) return first;
  const second = createStreamFn(config.fallback, fetchImpl);
  const secondModel = describeModel(config.fallback);
  // The second model is not shown what it cannot see.
  const blind = !config.fallback.vision;
  return (model, context, options) => {
    const out = createAssistantMessageEventStream();
    void (async () => {
      // Held back until the first model says something: if nothing follows but a failure
      // of the service, the second model starts the reply.
      let held: AssistantMessageEvent[] = [];
      let said = false;
      for await (const event of await first(model, context, options)) {
        if (!said && event.type === "error") {
          const why = event.error.errorMessage ?? "";
          if (!options?.signal?.aborted && SERVICE_FAILED.test(why)) {
            const shown = blind
              ? { ...context, messages: withoutImages(context.messages) }
              : context;
            for await (const again of await second(secondModel, shown, options)) out.push(again);
            out.end();
            return;
          }
        }
        // The opening of a reply, or of a piece of text with nothing in it yet, says nothing.
        if (!said && (event.type === "start" || event.type === "text_start")) {
          held.push(event);
          continue;
        }
        for (const earlier of held) out.push(earlier);
        held = [];
        said = true;
        out.push(event);
      }
      out.end();
    })();
    return out;
  };
}

/**
 * Failures of the service, which another model may not have: unreachable, silent, cut
 * off, busy (408, 429) or broken (5xx). A request the first model refused (too long, not
 * allowed, a wrong key or name) is not put to another model: it would be refused there
 * too, or should not leave the first.
 */
const SERVICE_FAILED =
  /Could not reach the model endpoint|stopped answering|was cut off|endpoint answered (?:408|429|5\d\d)/;

/** The conversation as a model that cannot see is given it: every image left out. */
function withoutImages(messages: Context["messages"]): Context["messages"] {
  return messages.map((message) =>
    Array.isArray(message.content)
      ? ({
          ...message,
          // Said in its place, so the model does not speak of a picture it was not shown.
          content: message.content.map((block) =>
            block.type === "image"
              ? {
                  type: "text",
                  text: "[An image was here. You cannot see images; say so if it matters.]",
                }
              : block,
          ),
        } as (typeof messages)[number])
      : message,
  );
}

export function createStreamFn(config: ModelConfig, fetchImpl: typeof fetch = fetch): StreamFn {
  const transport = config.api === "anthropic" ? anthropicMessages : openAiChatCompletions;
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    // What earlier tries of this same call spent, added to what the last one reports.
    let spent = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    // Tries given up before the service reported their prompt's size.
    let owed = 0;
    const heard = (options as Hearing | undefined)?.onThinking;
    // Started anew for each attempt: see below.
    let silent = new AbortController();
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const silenceMs = (config.silenceSeconds ?? SILENCE_SECONDS) * 1000;
    const firstWordMs = (config.firstWordSeconds ?? FIRST_WORD_SECONDS) * 1000;
    const beat = (wait = silenceMs) => {
      clearTimeout(quiet);
      quiet = setTimeout(() => silent.abort(), wait);
    };
    const whole = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signalNow = () =>
      AbortSignal.any([...(options?.signal ? [options.signal] : []), whole, silent.signal]);
    const emit: Emit = {
      start: () => stream.push({ type: "start", partial: message }),
      textStart(index) {
        message.content[index] = { type: "text", text: "" };
        stream.push({ type: "text_start", contentIndex: index, partial: message });
      },
      textDelta(index, delta) {
        const block = message.content[index];
        if (block?.type !== "text" || !delta) return;
        block.text += delta;
        stream.push({ type: "text_delta", contentIndex: index, delta, partial: message });
      },
      textEnd(index) {
        const block = message.content[index];
        if (block?.type === "text")
          stream.push({
            type: "text_end",
            contentIndex: index,
            content: block.text,
            partial: message,
          });
      },
      toolStart(index, id, name) {
        message.content[index] = { type: "toolCall", id, name, arguments: {} };
        stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
      },
      toolEnd(index, json) {
        const block = message.content[index];
        if (block?.type !== "toolCall") return;
        block.arguments = parseArguments(json);
        stream.push({
          type: "toolcall_end",
          contentIndex: index,
          toolCall: block,
          partial: message,
        });
      },
      usage(tokensIn, tokensOut, cached = 0, written = 0) {
        // A call asked again after thinking its allowance away is still one call to the
        // person: what the earlier tries cost is part of what it cost.
        const input = tokensIn * (1 + owed) + spent.input;
        const output = tokensOut + spent.output;
        // `input` is the whole prompt, as it always was here (what a context holds and what
        // an allowance counts). What of it the service read from its cache, and what it
        // wrote there, are parts of it, never more than it, and are priced as such. A try
        // whose prompt was only owed is counted at the full price: nothing said otherwise.
        const cacheRead = Math.min(input, Math.max(0, cached) + spent.cacheRead);
        const cacheWrite = Math.min(input - cacheRead, Math.max(0, written) + spent.cacheWrite);
        const cost = {
          input: ((input - cacheRead - cacheWrite) * config.inputPrice) / 1e6,
          output: (output * config.outputPrice) / 1e6,
          cacheRead: (cacheRead * (config.cachedInputPrice ?? config.inputPrice)) / 1e6,
          cacheWrite: (cacheWrite * (config.cacheWritePrice ?? config.inputPrice)) / 1e6,
        };
        message.usage = {
          input,
          output,
          cacheRead,
          cacheWrite,
          totalTokens: input + output,
          cost: { ...cost, total: cost.input + cost.output + cost.cacheRead + cost.cacheWrite },
        };
      },
    };

    void (async () => {
      try {
        emit.start();
        let reason: "stop" | "length";
        // How hard the model is told to think, once it has thought a whole allowance away.
        let effort: Effort | undefined;
        for (let attempt = 1; ; attempt++) {
          beat(firstWordMs);
          try {
            const ended = await transport({
              config,
              context,
              signal: signalNow(),
              emit,
              fetchImpl,
              beat,
              ...(effort ? { effort } : {}),
              ...(heard ? { thinking: heard } : {}),
            });
            // A model that thinks before it answers can spend everything it may write on
            // thinking and say nothing: no word, no call. That is not a reply too long to
            // finish, and "continue" would only think it away again. It is asked again and
            // told not to think. (Told to think less, the model this was found with thought
            // just as long: 2026-11-16, 32,000 of 32,000 tokens both times.)
            const nothingSaid = message.content.filter(Boolean).length === 0;
            if (
              (ended === "thought" || (ended === "length" && nothingSaid)) &&
              effort === undefined &&
              // Already told not to think: asking again would ask the same thing.
              config.reasoningEffort !== "none" &&
              config.api === "openai"
            ) {
              // A try given up before the service said what it cost is owed its prompt:
              // counted as the next try's, which is sent the same one.
              if (ended === "thought" && message.usage.input === 0) owed += 1;
              spent = {
                input: message.usage.input,
                output: message.usage.output,
                cacheRead: message.usage.cacheRead,
                cacheWrite: message.usage.cacheWrite,
              };
              effort = "none";
              attempt = 0;
              continue;
            }
            reason = ended === "thought" ? "length" : ended;
            break;
          } catch (error) {
            // An endpoint that does not know the setting refuses it (400) before it says
            // anything: what stands is the cut-off reply it gave before, not a failure it
            // did not have. Any other failure of the second try is a failure: a service
            // that fell over, a reply that broke off mid-way, the whole call out of time.
            if (
              effort &&
              message.content.filter(Boolean).length === 0 &&
              error instanceof Error &&
              /^The model endpoint answered 400\b/.test(error.message)
            ) {
              reason = "length";
              break;
            }
            if (!silent.signal.aborted || options?.signal?.aborted) throw error;
            // Silence before a single word: nothing has been said or done, so asking again
            // changes nothing. Once, and then the person is told.
            if (attempt === 1 && message.content.filter(Boolean).length === 0) {
              silent = new AbortController();
              continue;
            }
            throw new Error(MODEL_SILENT);
          }
        }
        // Drop holes left by a provider that skipped an index.
        message.content = message.content.filter(Boolean);
        const calledTools = message.content.some((block) => block.type === "toolCall");
        message.stopReason = calledTools ? "toolUse" : reason;
        stream.push({
          type: "done",
          reason: message.stopReason as "stop" | "length" | "toolUse",
          message,
        });
      } catch (error) {
        const aborted = options?.signal?.aborted === true;
        // The whole call ran out of time: said as what it is, not as an unknown fault.
        const cause = !aborted && whole.aborted ? new Error(MODEL_SILENT) : error;
        message.content = message.content.filter(Boolean);
        message.stopReason = aborted ? "aborted" : "error";
        message.errorMessage = aborted
          ? "Stopped."
          : cause instanceof Error
            ? cause.message
            : String(cause);
        stream.push({ type: "error", reason: message.stopReason, error: message });
      } finally {
        clearTimeout(quiet);
        stream.end();
      }
    })();
    return stream;
  };
}

interface Emit {
  start(): void;
  textStart(index: number): void;
  textDelta(index: number, delta: string): void;
  textEnd(index: number): void;
  toolStart(index: number, id: string, name: string): void;
  toolEnd(index: number, argumentsJson: string): void;
  /** The whole prompt and the reply, in tokens; and what of the prompt was read from or written to the service's cache. */
  usage(input: number, output: number, cached?: number, written?: number): void;
}
interface TransportInput {
  config: ModelConfig;
  context: Context;
  signal: AbortSignal;
  emit: Emit;
  fetchImpl: typeof fetch;
  /** Called whenever anything arrives from the model, so silence can be told from work. */
  beat(): void;
  /** Set when the call is asked again after the model thought its whole allowance away. */
  effort?: Effort;
  /** Told how many characters the model has thought so far in this call, as they arrive. */
  thinking?(chars: number): void;
}
/**
 * What the one who asks may also pass with a call's options: a way to hear that the model
 * is thinking. Its thinking is not part of the reply, so no event of the reply carries it.
 */
export interface Hearing {
  onThinking?(chars: number): void;
}
/** How hard a model that thinks before answering is told to think. */
type Effort = "none";
/**
 * How a call ended. "thought": given up here because the model had thought away so much of
 * what it may write, with nothing said, that no room was left for an answer.
 */
type Ended = "stop" | "length" | "thought";
/** The share of what a model may write that it may spend thinking before it has said anything. */
const THINKING_SHARE = 0.5;
/** Thinking is counted in characters as it arrives; a token is about three of them. */
const CHARS_PER_TOKEN = 3;

/** Tool arguments arrive as JSON text; a model that writes bad JSON gets an empty object, which validation then rejects. */
function parseArguments(json: string): ToolCall["arguments"] {
  if (!json.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as ToolCall["arguments"])
      : {};
  } catch {
    return {};
  }
}

const textOf = (content: string | { type: string; text?: string }[]) =>
  typeof content === "string"
    ? content
    : content
        .flatMap((block) => (block.type === "text" && block.text ? [block.text] : []))
        .join("\n");

/** The images a person's message carries, for a model that can see them. */
const imagesOf = (content: string | { type: string; data?: string; mimeType?: string }[]) =>
  typeof content === "string"
    ? []
    : content.flatMap((block) =>
        block.type === "image" && block.data && block.mimeType
          ? [{ data: block.data, mimeType: block.mimeType }]
          : [],
      );

/** Reads a server-sent-events response and yields each event's data. */
async function* sse(response: Response, beat: () => void): AsyncGenerator<string> {
  if (!response.body) return;
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    beat();
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      const end = buffer.search(/\r?\n\r?\n/);
      if (end < 0) break;
      const event = buffer.slice(0, end);
      buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, "");
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) yield data;
    }
  }
}

const CONNECT_ATTEMPTS = 3;

async function post(
  { fetchImpl, signal }: TransportInput,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Response> {
  const send = () =>
    fetchImpl(url, {
      method: "POST",
      signal,
      // The key goes to the address it was given for and nowhere else: an answer that
      // sends the request on to another place is an error, not a place to follow it to.
      redirect: "error",
      headers: { "content-type": "application/json", accept: "text/event-stream", ...headers },
      body: JSON.stringify(body),
    });
  let response: Response | undefined;
  // A request that fails before any answer is tried again: asking a model twice changes nothing
  // on the other side, at worst it is billed twice.
  for (let attempt = 1; !response; attempt++) {
    try {
      response = await send();
      // A gateway in front of the model that gave up (502, 503, 504) has said nothing of
      // the model's: asked again like a request that never got through.
      if (response.status >= 502 && response.status <= 504 && attempt < CONNECT_ATTEMPTS) {
        await response.body?.cancel().catch(() => undefined);
        response = undefined;
        // The wait ends at once when the person stops the run.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, 1500 * attempt);
          function done() {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
          }
          signal.addEventListener("abort", done, { once: true });
        });
        if (signal.aborted) throw new Error("aborted");
      }
    } catch (error) {
      if (signal.aborted) throw error;
      if (attempt === CONNECT_ATTEMPTS)
        throw new Error(
          `Could not reach the model endpoint (${error instanceof Error ? error.message : "no connection"}).`,
        );
    }
  }
  if (!response.ok) {
    // What the service says is shown to the person whose reply failed and kept on the
    // run's record. A service that quotes the key back ("invalid key sk-…") does not get
    // it shown to them: whatever was sent as a secret is struck from what it answered.
    const secrets = Object.entries(headers)
      .filter(([name]) => /^(authorization|x-api-key)$/i.test(name))
      .flatMap(([, value]) => [value, value.replace(/^Bearer\s+/i, "")])
      .filter((value) => value.length >= 6);
    const detail = secrets
      .reduce((text, secret) => text.replaceAll(secret, "…"), await response.text().catch(() => ""))
      .slice(0, 300);
    // A model that may write less than it was asked to allow says so with a 400. Asked
    // again with the least any model allows, and remembered, so that a deployment whose
    // model is smaller than the default keeps working without being told about a setting.
    const asked = (body as { max_tokens?: number }).max_tokens;
    if (
      response.status === 400 &&
      typeof asked === "number" &&
      asked > LEAST_OUTPUT_TOKENS &&
      /max_tokens|max_completion_tokens|maximum[^.]{0,40}tokens|output tokens|context length|too large/i.test(
        detail,
      )
    ) {
      tooMuch.add(url);
      return post({ fetchImpl, signal } as TransportInput, url, headers, {
        ...(body as object),
        max_tokens: LEAST_OUTPUT_TOKENS,
      });
    }
    throw new Error(`The model endpoint answered ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  return response;
}
/** What every model allows. */
const LEAST_OUTPUT_TOKENS = 4096;
/** Endpoints that refused the output limit they were asked for: asked for the least from then on. */
const tooMuch = new Set<string>();
const outputTokens = (config: ModelConfig, url: string) =>
  tooMuch.has(url) ? LEAST_OUTPUT_TOKENS : (config.maxOutputTokens ?? MAX_OUTPUT_TOKENS);

// ---- OpenAI chat completions (and the many endpoints compatible with it) ----

/**
 * Tool calls made by a turn that was told not to think. A service that keeps a model's
 * thinking between calls (found with DeepSeek, 2026-11-16) answers 400, "reasoning_content
 * … must be passed back", when such a turn is replayed to a call that does think: it has
 * no thinking on record for it. Sent back with empty thinking, the turn is accepted.
 */
const unthought = new Set<string>();
const unthink = (id: string) => {
  unthought.add(id);
  // A conversation's calls are replayed for as long as it runs; the oldest go first.
  if (unthought.size > 5000) unthought.delete(unthought.values().next().value as string);
};

async function openAiChatCompletions(input: TransportInput): Promise<Ended> {
  const { config, context, emit } = input;
  const messages: unknown[] = [];
  if (context.systemPrompt) messages.push({ role: "system", content: context.systemPrompt });
  for (const message of context.messages) {
    if (message.role === "user") {
      const images = imagesOf(message.content);
      messages.push({
        role: "user",
        content:
          images.length === 0
            ? textOf(message.content)
            : [
                { type: "text", text: textOf(message.content) },
                ...images.map((image) => ({
                  type: "image_url",
                  image_url: { url: `data:${image.mimeType};base64,${image.data}` },
                })),
              ],
      });
    } else if (message.role === "toolResult")
      messages.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: textOf(message.content) || (message.isError ? "The tool failed." : "Done."),
      });
    else {
      const calls = message.content.filter((block): block is ToolCall => block.type === "toolCall");
      const text = message.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("");
      // A turn with neither text nor calls (a failed or stopped one) has nothing to replay.
      if (!text && calls.length === 0) continue;
      messages.push({
        role: "assistant",
        content: text || null,
        ...(calls.length
          ? {
              tool_calls: calls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              })),
              ...(calls.some((call) => unthought.has(call.id)) ? { reasoning_content: "" } : {}),
            }
          : {}),
      });
    }
  }
  const tools = (context.tools ?? []).map((tool) => ({
    type: "function",
    function: {
      name: wireName(tool.name),
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
  const ask = (asked: unknown[]) =>
    post(
      input,
      `${config.baseUrl}/chat/completions`,
      { authorization: `Bearer ${config.apiKey}` },
      {
        model: config.id,
        messages: withWireNames(asked),
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: outputTokens(config, `${config.baseUrl}/chat/completions`),
        // What the deployment set for every call, unless this call is being asked again.
        ...((input.effort ?? config.reasoningEffort)
          ? { reasoning_effort: input.effort ?? config.reasoningEffort }
          : {}),
        ...(tools.length ? { tools } : {}),
      },
    );
  const response = await ask(messages).catch((error: unknown) => {
    // A service that keeps a model's thinking itself refuses a turn it has none for: one
    // made with thinking off whose mark was lost (the server restarted, the reply was gone
    // on with). Every turn that called a tool then says it had none, and it is asked again.
    if (
      !(error instanceof Error) ||
      !/^The model endpoint answered 400\b/.test(error.message) ||
      !/reasoning_content/.test(error.message)
    )
      throw error;
    return ask(
      messages.map((message) => {
        const turn = message as {
          tool_calls?: { id?: string }[];
          reasoning_content?: string;
        };
        if (!turn.tool_calls || turn.reasoning_content !== undefined) return message;
        // Remembered, so the calls after this one are not refused first and asked twice.
        for (const call of turn.tool_calls) if (call.id) unthink(call.id);
        return { ...turn, reasoning_content: "" };
      }),
    );
  });

  let finish: "stop" | "length" = "stop";
  // A stream that just stops is a cut-off reply, not a finished one.
  let ended = false;
  // Characters of thinking before anything was said.
  let thought = 0;
  // The prompt's size, once the service has said it.
  let promptTokens = 0;
  let cachedTokens = 0;
  // Characters of thinking in the whole call, for the one who is waiting.
  let reasoned = 0;
  let textIndex: number | null = null;
  let next = 0;
  // Tool calls arrive in pieces, keyed by the provider's own index.
  const calls = new Map<number, { index: number; json: string }>();
  for await (const data of sse(response, input.beat)) {
    if (data === "[DONE]") {
      ended = true;
      break;
    }
    const chunk = JSON.parse(data) as {
      choices?: {
        delta?: {
          content?: string | null;
          /** A model's thinking, on the services that show it. It is not part of the reply. */
          reasoning_content?: string | null;
          tool_calls?: {
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }[];
        };
        finish_reason?: string | null;
      }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        /** OpenAI's own name for what was read from its cache. */
        prompt_tokens_details?: { cached_tokens?: number } | null;
        /** DeepSeek's. */
        prompt_cache_hit_tokens?: number;
      } | null;
      error?: { message?: string };
    };
    if (chunk.error)
      throw new Error(chunk.error.message ?? "The model endpoint reported an error.");
    if (chunk.usage) {
      promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
      cachedTokens =
        chunk.usage.prompt_tokens_details?.cached_tokens ??
        chunk.usage.prompt_cache_hit_tokens ??
        cachedTokens;
      emit.usage(chunk.usage.prompt_tokens ?? 0, chunk.usage.completion_tokens ?? 0, cachedTokens);
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.delta?.reasoning_content) {
      reasoned += choice.delta.reasoning_content.length;
      input.thinking?.(reasoned);
    }
    if (choice.delta?.reasoning_content && textIndex === null && calls.size === 0) {
      thought += choice.delta.reasoning_content.length;
      // Half of what it may write is gone and nothing is said: there is no room left for
      // the answer, and waiting for the rest to go the same way only costs the person time.
      // The limit as it stands now: the request may have been accepted only with a lower one.
      const allowed = outputTokens(config, `${config.baseUrl}/chat/completions`);
      if (!input.effort && thought > allowed * THINKING_SHARE * CHARS_PER_TOKEN) {
        // Leaving the loop ends the reading and with it the request. The service is not
        // heard out, so it does not say what this cost: the thinking is counted from what
        // arrived, and the prompt as the service last reported it, if it did.
        emit.usage(promptTokens, Math.ceil(thought / CHARS_PER_TOKEN), cachedTokens);
        return "thought";
      }
    }
    if (choice.delta?.content) {
      if (textIndex === null) {
        textIndex = next++;
        emit.textStart(textIndex);
      }
      emit.textDelta(textIndex, choice.delta.content);
    }
    for (const piece of choice.delta?.tool_calls ?? []) {
      const key = piece.index ?? 0;
      let call = calls.get(key);
      if (!call) {
        call = { index: next++, json: "" };
        calls.set(key, call);
        // A service that names no call is given a name no other call has: a step is found
        // by it, and "call_0" would be every turn's first call.
        const id = piece.id || `call_${randomUUID()}`;
        // Only an id the service gave: one made up here is not unique across conversations.
        if (input.effort === "none" && piece.id) unthink(piece.id);
        emit.toolStart(call.index, id, appName(piece.function?.name ?? ""));
      }
      call.json += piece.function?.arguments ?? "";
    }
    if (choice.finish_reason) ended = true;
    if (choice.finish_reason === "length") finish = "length";
  }
  if (!ended) throw new Error("The model's reply was cut off before it finished.");
  if (textIndex !== null) emit.textEnd(textIndex);
  for (const call of calls.values()) emit.toolEnd(call.index, call.json);
  return finish;
}

// Tool names such as "docs.read" contain a dot, which these APIs do not allow in a function name.
const wireName = (name: string) => name.replace(/\./g, "__");
const appName = (name: string) => name.replace(/__/g, ".");
function withWireNames(messages: unknown[]): unknown[] {
  return messages.map((message) => {
    const m = message as { tool_calls?: { function: { name: string } }[] };
    return m.tool_calls
      ? {
          ...m,
          tool_calls: m.tool_calls.map((call) => ({
            ...call,
            function: { ...call.function, name: wireName(call.function.name) },
          })),
        }
      : message;
  });
}

// ---- Anthropic Messages ----

async function anthropicMessages(input: TransportInput): Promise<"stop" | "length"> {
  const { config, context, emit } = input;
  const messages: { role: "user" | "assistant"; content: unknown[] }[] = [];
  const add = (role: "user" | "assistant", blocks: unknown[]) => {
    if (blocks.length === 0) return;
    const last = messages.at(-1);
    // The API wants roles to alternate; results of several tool calls share one user turn.
    if (last?.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  for (const message of context.messages) {
    if (message.role === "user")
      add("user", [
        ...imagesOf(message.content).map((image) => ({
          type: "image",
          source: { type: "base64", media_type: image.mimeType, data: image.data },
        })),
        { type: "text", text: textOf(message.content) },
      ]);
    else if (message.role === "toolResult")
      add("user", [
        {
          type: "tool_result",
          tool_use_id: message.toolCallId,
          content: textOf(message.content) || "Done.",
          is_error: message.isError,
        },
      ]);
    else {
      add(
        "assistant",
        message.content.flatMap((block): unknown[] =>
          block.type === "text" && block.text
            ? [{ type: "text", text: block.text }]
            : block.type === "toolCall"
              ? [
                  {
                    type: "tool_use",
                    id: block.id,
                    name: wireName(block.name),
                    input: block.arguments,
                  },
                ]
              : [],
        ),
      );
    }
  }
  const tools: Record<string, unknown>[] = (context.tools ?? []).map((tool) => ({
    name: wireName(tool.name),
    description: tool.description,
    input_schema: tool.parameters,
  }));
  // This service keeps nothing unless it is told where a part that stays the same ends.
  // Three marks: after the tools, after the instructions (both the same for the whole
  // conversation), and after the last thing said, so that the next asking, which begins
  // with all of this one, reads it instead of paying for it again.
  const kept = { type: "ephemeral" };
  const lastTool = tools.at(-1);
  if (lastTool) lastTool.cache_control = kept;
  const lastBlock = (messages.at(-1)?.content as Record<string, unknown>[] | undefined)
    ?.filter((block) => block.type !== "text" || block.text)
    .at(-1);
  if (lastBlock) lastBlock.cache_control = kept;
  const response = await post(
    input,
    `${config.baseUrl}/v1/messages`,
    { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" },
    {
      model: config.id,
      max_tokens: outputTokens(config, `${config.baseUrl}/v1/messages`),
      stream: true,
      messages,
      ...(context.systemPrompt
        ? { system: [{ type: "text", text: context.systemPrompt, cache_control: kept }] }
        : {}),
      ...(tools.length ? { tools } : {}),
    },
  );

  let finish: "stop" | "length" = "stop";
  let ended = false;
  let inputTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  const blocks = new Map<number, { kind: "text" | "tool"; json: string }>();
  for await (const data of sse(response, input.beat)) {
    const event = JSON.parse(data) as {
      type: string;
      index?: number;
      message?: {
        usage?: {
          input_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
      };
      content_block?: { type: string; id?: string; name?: string };
      delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
      usage?: { output_tokens?: number };
      error?: { message?: string };
    };
    const index = event.index ?? 0;
    if (event.type === "error")
      throw new Error(event.error?.message ?? "The model endpoint reported an error.");
    if (event.type === "message_start") {
      // This service counts what it read from and wrote to its cache apart from the rest
      // of the prompt. Here the prompt is one number, and those two are parts of it.
      const said = event.message?.usage;
      cacheRead = said?.cache_read_input_tokens ?? 0;
      cacheWrite = said?.cache_creation_input_tokens ?? 0;
      inputTokens = (said?.input_tokens ?? 0) + cacheRead + cacheWrite;
    } else if (event.type === "content_block_start" && event.content_block?.type === "text") {
      blocks.set(index, { kind: "text", json: "" });
      emit.textStart(index);
    } else if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
      blocks.set(index, { kind: "tool", json: "" });
      emit.toolStart(
        index,
        event.content_block.id || `call_${randomUUID()}`,
        appName(event.content_block.name ?? ""),
      );
    } else if (event.type === "content_block_delta") {
      const block = blocks.get(index);
      if (block?.kind === "text" && event.delta?.text) emit.textDelta(index, event.delta.text);
      else if (block?.kind === "tool") block.json += event.delta?.partial_json ?? "";
    } else if (event.type === "content_block_stop") {
      const block = blocks.get(index);
      if (block?.kind === "text") emit.textEnd(index);
      else if (block?.kind === "tool") emit.toolEnd(index, block.json);
    } else if (event.type === "message_delta") {
      if (event.delta?.stop_reason === "max_tokens") finish = "length";
      emit.usage(inputTokens, event.usage?.output_tokens ?? 0, cacheRead, cacheWrite);
    } else if (event.type === "message_stop") ended = true;
  }
  if (!ended) throw new Error("The model's reply was cut off before it finished.");
  return finish;
}
