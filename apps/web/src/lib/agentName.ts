/**
 * The name an agent is shown by. The general agent every organization starts with is kept
 * as "Assistant" where it is stored, and found by that name; to people it is Muster (the
 * owner, 2026-11-24).
 *
 * Which agent is the general one is said by its row, not by its name alone: it is the
 * company's (`source` "platform") and kept under that name, or the server marked it
 * (`general`). A person's own agent named "Assistant" from before the name was refused is
 * theirs and keeps its name.
 *
 * Only a list of agents needs this. Wherever the server names an agent beside something
 * else (who replied, who wants an approval, who a step is with, who wrote a note) it
 * already says the shown name, and the page draws what it is given
 * (`apps/server/src/runtime/catalog.ts`, `shownSql`).
 */
export const GENERAL_AGENT = "Assistant";
export const GENERAL_SHOWN = "Muster";

export interface NamedAgent {
  name: string;
  source?: string | undefined;
  general?: boolean | undefined;
}

export const isGeneral = (agent: NamedAgent | null | undefined): boolean =>
  Boolean(
    agent && (agent.general || (agent.source === "platform" && agent.name === GENERAL_AGENT)),
  );

export function shownAgent(agent: NamedAgent | null | undefined): string {
  return isGeneral(agent) ? GENERAL_SHOWN : (agent?.name ?? "");
}

/** What a search for an agent is matched against: the name it is shown by, and the one it is kept under. */
export const agentWords = (agent: NamedAgent): string => `${shownAgent(agent)} ${agent.name}`;

/** The agent a new conversation, schedule or update starts with when nobody chose one. */
export const generalOf = <T extends NamedAgent>(agents: T[]): T | undefined =>
  agents.find((agent) => isGeneral(agent)) ?? agents.find((agent) => agent.name === GENERAL_AGENT);

/**
 * The label of something in the activity log. A label is kept as it was written, since
 * what is kept is what the log's chain was made over; an agent's, and an approval's
 * ("Assistant · web.send"), are read here by the name the agent is shown by. Only the
 * label is known, so the bare name is taken for the general agent.
 */
export const logLabel = (label: string): string =>
  label === GENERAL_AGENT
    ? GENERAL_SHOWN
    : label.startsWith(`${GENERAL_AGENT} · `)
      ? `${GENERAL_SHOWN}${label.slice(GENERAL_AGENT.length)}`
      : label;
