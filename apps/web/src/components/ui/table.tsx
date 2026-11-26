import type * as React from "react";
import { cn } from "@/lib/utils";

function Table({
  className,
  pinLast,
  ...props
}: React.ComponentProps<"table"> & {
  /** Keep the last column, where a row's actions are, in sight when the table is wider than its card. */
  pinLast?: boolean;
}) {
  return (
    <div
      data-slot="table-container"
      data-pin={pinLast ? "" : undefined}
      className="relative w-full overflow-x-auto overscroll-x-contain"
    >
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm dense:text-[13px]", className)}
        {...props}
      />
    </div>
  );
}
function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn(
        // Set apart from what is above and below it: a band of its own with a line on each side.
        "border-y bg-[color-mix(in_oklab,var(--foreground)_5%,var(--card))] [&_tr]:border-b-0",
        className,
      )}
      {...props}
    />
  );
}
function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  );
}
function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted",
        className,
      )}
      {...props}
    />
  );
}
function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-8 px-3 text-left align-middle text-[11px] font-medium tracking-wide whitespace-nowrap text-muted-foreground uppercase first:pl-5 last:pr-5 dense:px-2.5 dense:first:pl-3.5 dense:last:pr-3.5",
        // Where a table asks for it (`pinLast`), the last column stays in sight when the table is wider than its card.
        "in-data-pin:last:sticky in-data-pin:last:right-0 in-data-pin:last:bg-[color-mix(in_oklab,var(--foreground)_5%,var(--card))]",
        className,
      )}
      {...props}
    />
  );
}
function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "px-3 py-2.5 align-middle whitespace-nowrap first:pl-5 last:pr-5 dense:h-[34px] dense:px-2.5 dense:py-1 dense:first:pl-3.5 dense:last:pr-3.5",
        "in-data-pin:last:sticky in-data-pin:last:right-0 in-data-pin:last:bg-card in-data-pin:[tr:hover>&]:last:bg-[color-mix(in_oklab,var(--muted)_50%,var(--card))]",
        className,
      )}
      {...props}
    />
  );
}

export { Table, TableBody, TableCell, TableHead, TableHeader, TableRow };
