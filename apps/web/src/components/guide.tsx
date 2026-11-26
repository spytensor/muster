import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export interface GuideText {
  title: string;
  lead: string;
}

/**
 * What a page is for, shown while it has nothing in it: its name for the thing, one line,
 * and what to do first. No more than that (docs/features/README.md, "How much a page
 * says"): the three cards of explanation that stood here were not read.
 */
export function Guide({
  icon: Icon,
  text,
  children,
}: {
  icon: LucideIcon;
  text: GuideText;
  /** What to do first: a button or two. */
  children?: ReactNode;
}) {
  // No card and no bar across the page, at the owner's word (2026-11-24): an empty page
  // says what it is in the middle, small, and offers the one thing to do.
  return (
    <section className="mx-auto grid w-full max-w-sm justify-items-center gap-2 px-4 py-16 text-center">
      <span className="mb-1 grid size-10 place-items-center rounded-full bg-foreground/6 text-muted-foreground">
        <Icon className="size-5" />
      </span>
      <h3 className="text-[15px] font-semibold">{text.title}</h3>
      <p className="text-[13px] text-balance text-muted-foreground">{text.lead}</p>
      {children && <div className="mt-2 flex flex-wrap justify-center gap-2">{children}</div>}
    </section>
  );
}
