import { type FormAction, type FormSpec, formsIn, readAction } from "@muster/ui-schema";
import type { Message } from "./types";

/** Where a form stands in its conversation, and what the phone lets the person do with it. No drawing here. */

export type AnswerForm = (answer: {
  messageId: string;
  form: string;
  values: Record<string, string>;
}) => Promise<boolean>;

/** What a form needs to know about the reply it is in. Absent: the reply is still arriving, or shown where it cannot be answered. */
export interface FormPlace {
  messageId: string;
  status: Message["status"];
  /** The reply was cut off at the longest a reply can be: stored as complete, but not finished. */
  cut: boolean;
  /** Nothing has been said after this reply. */
  last: boolean;
  /** The agent that wrote the reply. */
  agent: string;
  /** The working forms of the reply as it is stored: what the server would answer. */
  forms: Map<string, FormSpec>;
  /** The message that answered a form of this reply, when one did. */
  answered: { action: FormAction; at: string } | null;
  answer?: AnswerForm;
}

/** Where a reply stands in its conversation, for the forms and choices in it. */
export function formPlace(
  message: Message,
  messages: Message[],
  agent: string,
  answer?: AnswerForm,
): FormPlace {
  let answered: FormPlace["answered"] = null;
  for (const other of messages) {
    if (other.role !== "user" || other.seq <= message.seq) continue;
    const action = readAction(other.action);
    if (action?.messageId === message.id) answered = { action, at: other.createdAt };
  }
  return {
    messageId: message.id,
    status: message.status,
    cut: message.ending === "length",
    last: messages.at(-1)?.id === message.id,
    // An invited agent's form says that agent's name, not the conversation's.
    agent: message.agentName ?? agent,
    forms:
      message.status === "complete" && message.ending !== "length"
        ? formsIn(message.content)
        : new Map(),
    answered,
    ...(answer ? { answer } : {}),
  };
}

/** A form's state in the conversation, which decides whether its fields can be used. */
export type FormState = "arriving" | "live" | "answered" | "closed" | "unfinished";
export function formState(
  streaming: boolean,
  place: FormPlace | null,
  form: string | undefined,
): FormState {
  if (streaming) return "arriving";
  if (!place) return "closed";
  if (place.status === "running") return "arriving";
  if (place.status !== "complete" || place.cut) return "unfinished";
  if (form && place.answered?.action.form === form) return "answered";
  return place.last ? "live" : "closed";
}

/** Digits typed for a day, set out as YYYY-MM-DD as they arrive. */
export const asDay = (typed: string) => {
  const digits = typed.replace(/\D/g, "").slice(0, 8);
  return [digits.slice(0, 4), digits.slice(4, 6), digits.slice(6, 8)].filter(Boolean).join("-");
};

/** What a number field may hold, for the words beside it. Null: anything. */
export function rangeOf(field: {
  min?: number;
  max?: number;
}): "between" | "atLeast" | "atMost" | null {
  return field.min !== undefined && field.max !== undefined
    ? "between"
    : field.min !== undefined
      ? "atLeast"
      : field.max !== undefined
        ? "atMost"
        : null;
}
