import { InfoIcon } from "lucide-react";
import { Popover } from "radix-ui";
import { type ReactNode, useState } from "react";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * The longer explanation of something, behind a small mark beside its name. A page says
 * what a thing is in a line at most (docs/features/README.md, "How much a page says");
 * what more there is to know is one press away, for whoever wants it.
 *
 * The mark is not a `button` element: it may stand inside a row that is itself pressed,
 * or inside a label. It takes the press for itself and is reached with Tab, and opened
 * with Enter or Space, like one.
 */
export function Hint({ children, className }: { children: ReactNode; className?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Anchor asChild>
        {/* biome-ignore lint/a11y/useSemanticElements: it may stand inside a button or a label (see above) */}
        <span
          role="button"
          tabIndex={0}
          aria-label={t.common.more}
          aria-expanded={open}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setOpen((was) => !was);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            setOpen((was) => !was);
          }}
          className={cn(
            "inline-grid size-4 shrink-0 cursor-pointer place-items-center rounded-full align-[-2px] text-muted-foreground/70 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
        >
          <InfoIcon className="size-3.5" />
        </span>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          onClick={(event) => event.stopPropagation()}
          className="z-[60] max-w-xs rounded-xl border bg-popover px-3 py-2 text-left text-[13px] leading-relaxed font-normal whitespace-pre-line text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=open]:fade-in-0"
        >
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** How wide a text is, with a Chinese character counted as two Latin ones. */
const width = (text: string) => {
  let wide = 0;
  for (const char of text) wide += /[⺀-鿿豈-﫿＀-￯]/.test(char) ? 2 : 1;
  return wide;
};
/** What a line of explanation may be at most: about sixty Latin characters, or thirty Chinese. */
const LINE = 64;

/**
 * What of an explanation is said on the page, and whether more is kept behind the mark:
 * all of it when it is short, else its first sentence when that is, else its beginning.
 */
export function shortOf(text: string): { line: string; more: boolean } {
  const whole = text.trim();
  if (width(whole) <= LINE) return { line: whole, more: false };
  const end = /[.!?](?=\s|$)|[。！？]/.exec(whole);
  const first = end ? whole.slice(0, end.index + 1) : "";
  return first && first.length < whole.length && width(first) <= LINE
    ? { line: first, more: true }
    : { line: whole, more: true };
}

/**
 * A line of explanation under a name or beside a setting: never more than one line on
 * the page. A longer one shows its first sentence, with the whole of it behind the mark.
 * Anything that is not plain words (a figure, a link) is shown as it is given.
 */
export function Lead({
  children,
  className,
  as: Tag = "p",
}: {
  children: ReactNode;
  className?: string;
  as?: "p" | "span" | "div";
}) {
  if (typeof children !== "string") return <Tag className={className}>{children}</Tag>;
  const { line, more } = shortOf(children);
  if (!more) return <Tag className={className}>{line}</Tag>;
  return (
    <Tag className={cn("flex min-w-0 items-center gap-1", className)}>
      <span className="min-w-0 truncate">{line}</span>
      <Hint>{children}</Hint>
    </Tag>
  );
}
