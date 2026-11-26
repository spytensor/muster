import { cn } from "@/lib/utils";
import { lockedPage } from "./page";

/**
 * The one frame a page someone else wrote is shown in, wherever it is shown. Its
 * `sandbox` is empty: no script runs, no form is sent, nothing opens, and the page has
 * no origin, so it cannot read this app's cookies or storage or call its API. With the
 * policy `lockedPage` puts first, it also loads nothing from anywhere.
 */
export function LockedFrame({
  html,
  className,
  still,
}: {
  html: string;
  className?: string;
  /** A picture of the page, not the page: nothing in it can be reached. */
  still?: boolean;
}) {
  return (
    <iframe
      title="page"
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={lockedPage(html)}
      {...(still ? { inert: true, tabIndex: -1 } : {})}
      className={cn("bg-white", className)}
    />
  );
}
