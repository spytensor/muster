// Added by Muster. Not an upstream file.
//
// agent-core imported four small helpers from OpenClaw's model-transport package
// (@openclaw/ai, about 34,000 lines and four provider SDKs). Muster does not bring
// that package in: it supplies its own model transports. These are those four
// helpers, copied unchanged from OpenClaw v2026.9.8 so the loop keeps its behaviour:
//
//   createEmptyTransportUsage            packages/ai/src/transports/transport-stream-shared.ts
//   isCompactionReplayCheckpoint,
//   stripCompactionReplayCheckpoint,
//   replaceCompactionReplayOwnerContent  packages/ai/src/transports/provider-compaction-replay.ts
//   isResponsesOutputLimitToolCallError  packages/ai/src/providers/openai-responses-terminal-usage.ts
//
// MIT License, Copyright (c) 2026 OpenClaw Foundation. See ../../LICENSE.
import type { AssistantMessage, ProviderReplayState, Usage } from "@openclaw/llm-core";
import { isProviderRefusalAssistantError } from "@openclaw/llm-core/diagnostics";

export function createEmptyTransportUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Whether provider replay state is a prefix-bound server compaction checkpoint. */
export function isCompactionReplayCheckpoint(replay: unknown): replay is ProviderReplayState {
  const type =
    replay && typeof replay === "object" ? (replay as { type?: unknown }).type : undefined;
  return (
    type === "anthropic-compaction" ||
    type === "openai-responses-compaction" ||
    type === "openai-responses-retained-compaction"
  );
}

/** Strip prefix-bound checkpoints after local history rewrites. */
export function stripCompactionReplayCheckpoint(message: AssistantMessage): AssistantMessage {
  if (!isCompactionReplayCheckpoint(message.providerReplay)) {
    return message;
  }
  const replaySafeMessage = { ...message };
  delete replaySafeMessage.providerReplay;
  return replaySafeMessage;
}

/** Reindex a prefix-bound checkpoint after known content removals. */
export function replaceCompactionReplayOwnerContent(
  message: AssistantMessage,
  content: AssistantMessage["content"],
): AssistantMessage {
  const next = { ...message, content };
  const replay = message.providerReplay;
  if (!isCompactionReplayCheckpoint(replay)) {
    return next;
  }
  if (replay.type === "openai-responses-retained-compaction") {
    // This checkpoint is anchored to retained user turns, not assistant content indexes.
    return next;
  }
  const replayIndex = replay.replayIndex ?? 0;
  if (
    (content.length === 0 && message.content.length > 0) ||
    replayIndex > message.content.length
  ) {
    return stripCompactionReplayCheckpoint(next);
  }
  let sourceIndex = 0;
  let nextReplayIndex = 0;
  const unambiguous = content.every((block) => {
    const index = message.content.indexOf(block, sourceIndex);
    sourceIndex = index + 1;
    nextReplayIndex += index >= 0 && index < replayIndex ? 1 : 0;
    return index >= 0;
  });
  if (!unambiguous) {
    return stripCompactionReplayCheckpoint(next);
  }
  return nextReplayIndex === replayIndex
    ? next
    : { ...next, providerReplay: { ...replay, replayIndex: nextReplayIndex } };
}

/** A known output ceiling can resume sampling after admitted tools have settled. */
export function isResponsesOutputLimitToolCallError(
  message: Pick<AssistantMessage, "stopReason" | "errorCode" | "diagnostics">,
): boolean {
  return (
    message.stopReason === "error" &&
    message.errorCode === "incomplete_tool_call" &&
    !isProviderRefusalAssistantError(message) &&
    message.diagnostics?.some(
      ({ type, details }) =>
        type === "openai_responses_terminal" &&
        details?.eventType === "response.incomplete" &&
        details.stopReason === "length" &&
        details.incompleteReason === "max_output_tokens",
    ) === true
  );
}
