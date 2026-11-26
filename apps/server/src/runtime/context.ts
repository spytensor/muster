import { type AgentMessage, estimateTokens } from "@openclaw/agent-core";

/**
 * What one asking of the model was made of, by part, as the work pane's overview shows it
 * (`docs/design/context-panel.md`). Estimates from the text: the provider's own count of
 * the whole is the true total, and the page scales these to it.
 */
export interface ContextParts {
  /** Muster's rules, the agent's own instructions, the reply format. */
  instructions: number;
  /** The definitions of the tools the agent could call. */
  tools: number;
  toolCount: number;
  /** The skills picked for this message. */
  skills: number;
  skillCount: number;
  /** The project's instructions and notes, and what the attached repositories say of themselves. */
  project: number;
  /** What the person asked to be remembered. */
  memory: number;
  memoryCount: number;
  /** The earlier messages, and the summary standing in for the earliest of them. */
  conversation: number;
  /** This reply's own work: its calls, what they brought back, what it said along the way. */
  work: number;
}

/** About how many tokens a text is: the measure the compactor uses for what is sent every time. */
const sized = (text: string) => Math.ceil(text.length / 3);

/** Which part of the instructions a piece of them is, by how it begins. */
export function partOf(piece: string): "skills" | "memory" | "project" | "instructions" {
  if (/^(A skill applies|These skills apply)/.test(piece)) return "skills";
  if (/^What the person has asked to be remembered/.test(piece)) return "memory";
  if (
    /^(This conversation is part of the person's project|The project's notes|The project's steps|The project's latest update|The project's key documents|What the attached folders are|The repository ")/.test(
      piece,
    ) ||
    /^<repository-/.test(piece)
  )
    return "project";
  return "instructions";
}

/** A note Muster puts among the messages: the summary of an earlier part, or a word to the agent. */
const fromMuster = (message: AgentMessage) => {
  const content = (message as { content?: unknown }).content;
  const first = Array.isArray(content) ? (content[0] as { text?: unknown })?.text : content;
  return typeof first === "string" && first.startsWith("[From Muster");
};
export const summaryNote = (message: AgentMessage) => {
  const content = (message as { content?: unknown }).content;
  const first = Array.isArray(content) ? (content[0] as { text?: unknown })?.text : content;
  return (
    typeof first === "string" &&
    first.includes("The earlier part of this conversation was summarised")
  );
};

export function measureContext(given: {
  /** The pieces the instructions were joined from. */
  promptParts: readonly string[];
  /**
   * What was said with the person's message instead of in the instructions (runs.ts,
   * `turnParts`): it is counted as what it is, and not as the person's words.
   */
  turnParts?: readonly string[];
  /** The tools the model was offered: name, description and parameters each. */
  tools: readonly { name: string; description?: string; parameters?: unknown }[];
  skillCount: number;
  memoryCount: number;
  /** What the model was shown, after compaction. */
  shown: readonly AgentMessage[];
  /** The conversation's earlier messages, as the run began with them. */
  history: ReadonlySet<AgentMessage>;
}): ContextParts {
  const parts: ContextParts = {
    instructions: 0,
    tools: 0,
    toolCount: given.tools.length,
    skills: 0,
    skillCount: given.skillCount,
    project: 0,
    memory: 0,
    memoryCount: given.memoryCount,
    conversation: 0,
    work: 0,
  };
  for (const piece of given.promptParts) if (piece) parts[partOf(piece)] += sized(piece);
  let withMessage = 0;
  for (const piece of given.turnParts ?? []) {
    if (!piece) continue;
    parts[partOf(piece)] += sized(piece);
    withMessage += sized(piece);
  }
  parts.tools = given.tools.reduce(
    (total, tool) =>
      total +
      sized(`${tool.name}${tool.description ?? ""}${JSON.stringify(tool.parameters ?? {})}`),
    0,
  );
  for (const message of given.shown) {
    const tokens = estimateTokens(message as AgentMessage);
    // The earlier messages, the summary of the earliest, and the person's own words in this
    // reply are the conversation; the rest is this reply's work.
    if (
      given.history.has(message) ||
      summaryNote(message) ||
      (message.role === "user" && !fromMuster(message))
    )
      parts.conversation += tokens;
    else parts.work += tokens;
  }
  // It travelled inside the person's message, and was counted above as theirs.
  parts.conversation = Math.max(0, parts.conversation - withMessage);
  return parts;
}
