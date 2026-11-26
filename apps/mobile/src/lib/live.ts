import type { Approval, LiveEvent, Message, PlanItem, Step } from "./types.ts";

/** What is known about a conversation's current run. */
export interface Live {
  running: boolean;
  text: string;
  steps: Step[];
  plan: PlanItem[];
  approval: Approval | null;
}
export const idle: Live = { running: false, text: "", steps: [], plan: [], approval: null };

export interface Applied {
  live: Live;
  /** No run is going, so what the screen holds may be out of date: fetch the conversation again. */
  reload: boolean;
  /** The reply finished: its stored message (with its steps and plan) and the conversation's title. */
  finished: { message: Message; title: string } | null;
}

/** Applies one live event to what is known. Pure: the caller does the fetching and storing. */
export function applyEvent(live: Live, event: LiveEvent): Applied {
  const same = { reload: false, finished: null };
  switch (event.type) {
    case "state":
      // The server's word on whether a run is going is final.
      return {
        live: {
          running: event.running,
          text: event.text,
          steps: event.steps ?? [],
          plan: event.plan ?? [],
          approval: event.approval,
        },
        reload: !event.running,
        finished: null,
      };
    case "text":
      return { ...same, live: { ...live, running: true, text: live.text + event.delta } };
    case "step":
      return {
        ...same,
        live: {
          ...live,
          running: true,
          steps: live.steps.some((step) => step.id === event.step.id)
            ? live.steps.map((step) => (step.id === event.step.id ? event.step : step))
            : [...live.steps, event.step],
        },
      };
    case "plan":
      return { ...same, live: { ...live, running: true, plan: event.plan } };
    case "approval":
      return { ...same, live: { ...live, approval: event.approval } };
    case "done":
      return {
        live: idle,
        reload: false,
        finished: { message: event.message, title: event.title },
      };
    default:
      return { ...same, live };
  }
}

/** True for a whole message row; a bare `{id, seq}` is not one and must never reach the screen. */
const whole = (message: Message) =>
  (message.role === "user" || message.role === "assistant") && typeof message.content === "string";

/** Messages by id, later copies replacing earlier ones, in the order they were written. */
export function mergeMessages(messages: Message[], ...more: Message[]): Message[] {
  const byId = new Map(messages.filter(whole).map((message) => [message.id, message]));
  for (const message of more) if (whole(message)) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

export const doneOf = (plan: PlanItem[]) => plan.filter((item) => item.status === "done").length;

/** A duration in milliseconds, as "850 ms", "4.2 s" or "1 min 20 s". */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

/** Which day group a time belongs to, relative to now, by the device's calendar days. */
export function dayGroup(iso: string, now: Date = new Date()): "today" | "yesterday" | "earlier" {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const at = new Date(iso).getTime();
  if (at >= midnight) return "today";
  if (at >= midnight - 86_400_000) return "yesterday";
  return "earlier";
}
