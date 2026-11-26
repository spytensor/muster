import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * One block of a page that is made of blocks (a project's page): a name on a bar, what
 * can be done with it at the bar's end, and its rows under a hairline. Every block of
 * such a page is this one, so the page reads as one piece however much is in it.
 */
export function Panel({
  title,
  action,
  children,
  className,
  flush = false,
}: {
  title: ReactNode;
  /** At the end of the bar: a figure, a button or two. */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Its content brings its own padding (a text, a form). */
  flush?: boolean;
}) {
  return (
    <section className={cn("glass-thick min-w-0 overflow-hidden rounded-2xl", className)}>
      <header className="flex h-10 items-center gap-2 border-b border-foreground/8 pr-2 pl-3.5">
        <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold">{title}</h3>
        {action}
      </header>
      <div className={cn("grid min-w-0 grid-cols-1", !flush && "p-1")}>{children}</div>
    </section>
  );
}

/** A small button at the end of a block's bar. */
export const panelAction =
  "flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-foreground/8 hover:text-foreground disabled:opacity-50";

/** A row of a block: an icon, a name, and a fact at its end. */
export const panelRow =
  "flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-accent/40";

/** The row that stands in an empty block: what to put there, in a few words, and it does it. */
export function PanelAdd({ children, onClick }: { children: ReactNode; onClick(): void }) {
  return (
    <button
      type="button"
      className={cn(panelRow, "text-muted-foreground hover:text-foreground")}
      onClick={onClick}
    >
      <span className="grid size-3.5 shrink-0 place-items-center text-base leading-none">+</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}
