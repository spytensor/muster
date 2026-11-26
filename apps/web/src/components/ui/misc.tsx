import type * as React from "react";
import { cn } from "@/lib/utils";

function Separator({ className, ...props }: React.ComponentProps<"hr">) {
  return <hr className={cn("h-px w-full shrink-0 border-0 bg-border", className)} {...props} />;
}
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("animate-pulse rounded-md bg-accent", className)} {...props} />;
}
export { Separator, Skeleton };
