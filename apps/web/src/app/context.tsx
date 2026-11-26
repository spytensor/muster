import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import { Notice, useAction } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { ContextParts, ConversationContext } from "./api";

/**
 * How full the model's window is in this conversation, by part, and what the person can do
 * about it (docs/design/context-panel.md). In Muster a reply's own work (files read,
 * commands' output) stays within that reply: the next starts from the instructions and
 * the conversation. So it says both: what the last asking held, and where the next begins.
 */

/** The parts in the order they are drawn, each with its colour in both themes. */
const PARTS = [
  { key: "instructions", color: "#4f7df0" },
  { key: "tools", color: "#e8743b" },
  { key: "skills", color: "#14a37f" },
  { key: "project", color: "#c9a227" },
  { key: "memory", color: "#a874e8" },
  { key: "conversation", color: "#38b6d8" },
  { key: "work", color: "#e05a7a" },
] as const;
type Part = (typeof PARTS)[number]["key"];

const OPEN_KEY = "muster.context.open";

/** Tokens as people read them: 812, 12.4K, 1.2M. */
export const tokens = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`
      : String(Math.round(n));

/**
 * The parts scaled so they add up to what the provider counted: the run's estimates come
 * from the text, the provider's total is the true one. Without a count, the estimates.
 */
export function scaled(parts: ContextParts, counted: number) {
  const sum = PARTS.reduce((total, part) => total + parts[part.key], 0);
  const factor = counted > 0 && sum > 0 ? counted / sum : 1;
  return {
    used: counted > 0 ? counted : sum,
    estimated: !(counted > 0),
    of: (part: Part) => Math.round(parts[part] * factor),
  };
}

export function ContextSection({
  context,
  conversationId,
  running,
  messages,
  fresh = messages,
  summarisedAt,
  onCompacted,
}: {
  context: ConversationContext;
  conversationId: string;
  /** A reply is being written: the conversation cannot be compacted meanwhile. */
  running: boolean;
  /** How many messages the conversation has. */
  messages: number;
  /** How many of them came after the last compaction; all of them when there was none. */
  fresh?: number;
  /** When the conversation was last compacted, if it was. */
  summarisedAt: string | null;
  onCompacted(): void;
}) {
  const { t, ago } = useI18n();
  const c = t.app.code;
  const [open, setOpen] = useState(() => localStorage.getItem(OPEN_KEY) !== "closed");
  const { busy, error, run } = useAction();
  const toggle = () => {
    localStorage.setItem(OPEN_KEY, open ? "closed" : "open");
    setOpen(!open);
  };
  const room = context.window;
  const parts = context.parts ?? null;
  const measure = parts ? scaled(parts, context.tokens) : null;
  const used = measure?.used ?? context.tokens;
  const share = room > 0 && used > 0 ? Math.min(100, (used / room) * 100) : 0;
  const compactAt = context.compactAt ?? room;
  const kept = Math.max(0, room - compactAt);
  const free = Math.max(0, compactAt - used);
  // Where the next reply begins: what is sent every time, and the conversation as it will be.
  const next =
    measure && parts
      ? measure.of("instructions") +
        measure.of("tools") +
        measure.of("skills") +
        measure.of("project") +
        measure.of("memory") +
        (context.nextConversation ?? measure.of("conversation"))
      : null;
  // One way for every row: under 1% with one decimal, otherwise whole; nothing is "0%".
  const percent = (n: number) => {
    if (room <= 0 || n <= 0) return "–";
    const share = (n / room) * 100;
    return share < 1 ? `${share.toFixed(1)}%` : `${Math.round(share)}%`;
  };
  const countOf = (part: Part) =>
    part === "tools"
      ? parts?.toolCount
      : part === "skills"
        ? parts?.skillCount
        : part === "memory"
          ? parts?.memoryCount
          : undefined;
  const short = messages < 6;
  // Compacted already, and not two messages since: there is nothing new to summarise.
  const nothingNew = !short && summarisedAt !== null && fresh < 2;
  const compact = () =>
    run(async () => {
      await api(`/api/app/conversations/${conversationId}/compact`, { method: "POST" });
      onCompacted();
    });

  return (
    <section aria-label={c.context} className="border-b py-2.5">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-2 pb-1 text-[13px]"
        aria-expanded={open}
        onClick={toggle}
      >
        <span className="font-medium">{c.context}</span>
        <ChevronRightIcon
          className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-90")}
        />
        <span className="flex-1" />
        {used > 0 && (
          <span className="num text-xs text-muted-foreground">
            {c.contextUsed(Math.round(share))}
          </span>
        )}
      </button>
      {used === 0 ? (
        <p className="px-2 pb-1 text-xs text-muted-foreground">{c.contextNone}</p>
      ) : (
        <div className="grid gap-2 px-2">
          <div className="flex items-baseline justify-between text-xs">
            <span className="num text-muted-foreground">
              {c.contextOf(tokens(used), tokens(room))}
              {measure?.estimated && ` · ${c.estimated}`}
            </span>
          </div>
          {/* The bar: each part in its colour, then what is kept for the answer, then free. */}
          <div
            className="flex h-2 w-full overflow-hidden rounded-full bg-foreground/[0.07]"
            role="img"
            aria-label={c.contextOf(tokens(used), tokens(room))}
          >
            {measure ? (
              PARTS.map((part) => (
                <span
                  key={part.key}
                  className="h-full"
                  style={{
                    width: `${(measure.of(part.key) / room) * 100}%`,
                    backgroundColor: part.color,
                  }}
                />
              ))
            ) : (
              <span className="h-full bg-primary" style={{ width: `${share}%` }} />
            )}
            <span className="flex-1" />
            <span
              className="h-full bg-foreground/20"
              style={{ width: `${(kept / room) * 100}%` }}
              title={c.keptForAnswer}
            />
          </div>
          {open && measure && (
            <ul className="grid gap-0.5 text-[13px]">
              {PARTS.map((part) => {
                const n = measure.of(part.key);
                const count = countOf(part.key);
                return (
                  <li
                    key={part.key}
                    className="grid grid-cols-[0.75rem_minmax(0,1fr)_auto_3.25rem] items-center gap-2"
                  >
                    <span
                      aria-hidden
                      className="size-2.5 rounded-[3px]"
                      style={{ backgroundColor: part.color }}
                    />
                    <span className="truncate text-muted-foreground" title={c.partLead[part.key]}>
                      {c.part[part.key]}
                      {count !== undefined && count > 0 && (
                        <span className="text-muted-foreground/70"> · {count}</span>
                      )}
                    </span>
                    <span className="num text-right">{tokens(n)}</span>
                    <span className="num text-right text-muted-foreground">{percent(n)}</span>
                  </li>
                );
              })}
              <li className="mt-1 grid grid-cols-[0.75rem_minmax(0,1fr)_auto_3.25rem] items-center gap-2">
                <span aria-hidden className="size-2.5 rounded-[3px] bg-foreground/20" />
                <span className="truncate text-muted-foreground" title={c.keptForAnswerLead}>
                  {c.keptForAnswer}
                </span>
                <span className="num text-right">{tokens(kept)}</span>
                <span className="num text-right text-muted-foreground">{percent(kept)}</span>
              </li>
              <li className="grid grid-cols-[0.75rem_minmax(0,1fr)_auto_3.25rem] items-center gap-2">
                <span aria-hidden className="size-2.5 rounded-[3px] border border-foreground/20" />
                <span className="truncate text-muted-foreground">{c.free}</span>
                <span className="num text-right">{tokens(free)}</span>
                <span className="num text-right text-muted-foreground">{percent(free)}</span>
              </li>
            </ul>
          )}
          {open && (
            <div className="grid gap-1 text-xs text-muted-foreground">
              <p>
                {used >= compactAt ? c.overCompaction : c.untilCompaction(tokens(compactAt - used))}
              </p>
              {next !== null && <p>{c.nextStarts(tokens(next))}</p>}
              {summarisedAt && <p>{c.compactedAt(ago(summarisedAt))}</p>}
            </div>
          )}
          {open && (
            <div className="grid gap-1.5 pt-1">
              <Button
                size="sm"
                variant="outline"
                className="w-fit"
                disabled={busy || running || short || nothingNew}
                onClick={() => void compact()}
              >
                {busy ? c.compacting : c.compact}
              </Button>
              <p className="text-xs text-muted-foreground">
                {running
                  ? c.compactWhileRunning
                  : short
                    ? c.compactShort
                    : nothingNew
                      ? c.compactNothingNew
                      : c.compactLead}
              </p>
              {error && <Notice tone="bad">{error}</Notice>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
