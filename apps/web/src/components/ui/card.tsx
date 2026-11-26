import type * as React from "react";
import { cn } from "@/lib/utils";
import { Lead } from "./hint";

function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "flex flex-col gap-3 rounded-xl border bg-card py-4 text-card-foreground shadow-xs dense:gap-2 dense:py-3",
        className,
      )}
      {...props}
    />
  );
}
function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-0.5 px-5 has-data-[slot=card-action]:grid-cols-[1fr_auto]",
        // In the console a header is one row: the name, what it is beside it, actions at the far end.
        "dense:flex dense:min-h-7 dense:flex-wrap dense:items-center dense:gap-x-2.5 dense:gap-y-1 dense:px-3.5",
        className,
      )}
      {...props}
    />
  );
}
function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn(
        "text-[15px] leading-snug font-semibold dense:shrink-0 dense:text-sm",
        className,
      )}
      {...props}
    />
  );
}
/**
 * What a card is, in a line at most. Plain words longer than a line show their first
 * sentence, with the whole behind a mark (`Lead`): a page is not where things are explained
 * at length (docs/features/README.md, "How much a page says").
 */
function CardDescription({ className, children, ...props }: React.ComponentProps<"div">) {
  const classes = cn(
    "text-[13px] leading-snug text-muted-foreground dense:min-w-0 dense:flex-1",
    className,
  );
  if (typeof children === "string")
    return (
      <div data-slot="card-description" className="min-w-0 dense:flex-1" {...props}>
        <Lead as="div" className={cn(classes, "dense:truncate")}>
          {children}
        </Lead>
      </div>
    );
  return (
    <div data-slot="card-description" className={classes} {...props}>
      {children}
    </div>
  );
}
function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end dense:ml-auto dense:flex dense:shrink-0 dense:items-center dense:gap-1.5 dense:self-center",
        className,
      )}
      {...props}
    />
  );
}
function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("px-5 dense:px-3.5", className)} {...props} />;
}
function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center px-5 dense:px-3.5", className)}
      {...props}
    />
  );
}

export { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle };
