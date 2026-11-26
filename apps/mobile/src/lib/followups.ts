import type { Message } from "./types";

/**
 * Follow-ups on the phone (CHA-256): what the app needs to show a conversation in which
 * an agent came back by itself, and to tell the server the person's own clock.
 */

/** The person's time zone as the phone has it, sent with every request so "tomorrow at nine" is theirs. */
export function zone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Whether Muster, not the person, wrote this message to bring an agent back. */
export const broughtBack = (message: Pick<Message, "role" | "origin">) =>
  message.role === "user" && message.origin === "followup";

/**
 * What to say on the line where an agent came back: what it was waiting for, and the
 * address when a mail brought it back. The rest of the message is Muster's instructions
 * to the agent and is not shown.
 */
export function cameBack(content: string): { awaited: string; mail: string | null } {
  return {
    awaited: /You were waiting for: (.*?)\. You said you would then: /s.exec(content)?.[1] ?? "",
    mail: /You are back because a mail from (\S+) has arrived/.exec(content)?.[1] ?? null,
  };
}

/** The last thing the person themselves said: what "Try again" sends. Never Muster's own message. */
export const lastOwn = (messages: Message[]) =>
  messages.findLast((message) => message.role === "user" && !broughtBack(message));

/**
 * Whether a block holds words to be read, not code: those wrap, so nothing is off the
 * edge. Code, and a block that names no language, keeps its lines and scrolls sideways.
 */
export const prose = (language?: string | null) =>
  Boolean(language) && /^(text|plain|plaintext|txt|markdown|md)$/i.test((language ?? "").trim());
