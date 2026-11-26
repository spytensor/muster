import { MoreHorizontalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface MoreItem {
  label: string;
  onSelect(): void;
  /** Deletes, removes or ends something. Shown apart, at the bottom, in the colour for that. */
  destructive?: boolean;
}

/**
 * The "…" menu. Where an action that deletes, removes or ends something lives: never as a
 * button or an icon in plain sight, where a slip of the hand reaches it. What it opens
 * still asks before it acts.
 */
export function MoreMenu({
  label,
  items,
  className,
}: {
  /** What the menu is for, said to a screen reader: "More for Engineering". */
  label: string;
  items: MoreItem[];
  className?: string;
}) {
  const plain = items.filter((item) => !item.destructive);
  const risky = items.filter((item) => item.destructive);
  if (items.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-7 shrink-0", className)}
          aria-label={label}
          title={label}
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontalIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        {plain.map((item) => (
          <DropdownMenuItem key={item.label} onSelect={item.onSelect}>
            {item.label}
          </DropdownMenuItem>
        ))}
        {plain.length > 0 && risky.length > 0 && <DropdownMenuSeparator />}
        {risky.map((item) => (
          <DropdownMenuItem key={item.label} variant="destructive" onSelect={item.onSelect}>
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
