import { HandIcon, ShieldCheckIcon, ShieldOffIcon } from "lucide-react";
import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

/** How much a person lets agents do in a conversation without asking them first. */
export type Mode = "ask" | "auto" | "full";
export const MODES: Mode[] = ["ask", "auto", "full"];
const ICON = { ask: HandIcon, auto: ShieldCheckIcon, full: ShieldOffIcon };
const MODE_KEY = "muster.mode";
/** The mode new conversations start in, as the person last chose. */
export const preferredMode = (): Mode => {
  const kept = localStorage.getItem(MODE_KEY);
  return MODES.includes(kept as Mode) ? (kept as Mode) : "ask";
};
export const preferMode = (mode: Mode) => localStorage.setItem(MODE_KEY, mode);

/**
 * The mode of this conversation, beside the + in the message box: what it is, and the
 * way to change it. Every mode is the person's to choose.
 *
 * Opened, it is three icons in a row and one line under them for the one pointed at or
 * chosen (the owner, 2026-11-22, beside another product's picker: "我们的太多文字描述了").
 * A paragraph for each mode and a note under all three were read by nobody.
 */
export function ModeChip({
  mode,
  onChoose,
  busy = false,
}: {
  mode: Mode;
  onChoose(mode: Mode): void;
  /** A choice is being kept: no second one is taken until it is, so two cannot cross. */
  busy?: boolean;
}) {
  const { t } = useI18n();
  const m = t.app.modes;
  const Icon = ICON[mode];
  // The mode pointed at; its name and line are shown in place of the chosen one's.
  const [over, setOver] = useState<Mode | null>(null);
  const shown = over ?? mode;
  return (
    <DropdownMenu onOpenChange={() => setOver(null)}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={m.title}
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[13px] hover:bg-foreground/8",
            mode === "full" ? "text-warn" : "text-muted-foreground",
          )}
        >
          <Icon className="size-3.5 shrink-0" />
          {m.name[mode]}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" sideOffset={8} className="w-72 p-3">
        <p className="pb-2 text-xs text-muted-foreground">{m.title}</p>
        <div className="flex gap-0.5 rounded-lg bg-foreground/5 p-0.5">
          {MODES.map((option) => {
            const Option = ICON[option];
            return (
              <DropdownMenuItem
                key={option}
                role="menuitemradio"
                aria-checked={option === mode}
                aria-label={m.name[option]}
                disabled={busy}
                // The icons stand in a row: left and right move along it, as up and down do.
                onKeyDown={(event) => {
                  const to =
                    event.key === "ArrowRight"
                      ? event.currentTarget.nextElementSibling
                      : event.key === "ArrowLeft"
                        ? event.currentTarget.previousElementSibling
                        : null;
                  if (to instanceof HTMLElement) {
                    event.preventDefault();
                    to.focus();
                  }
                }}
                // The list stays open: the line under it says what was just chosen.
                onSelect={(event) => {
                  event.preventDefault();
                  onChoose(option);
                }}
                onFocus={() => setOver(option)}
                onPointerEnter={() => setOver(option)}
                onPointerLeave={() => setOver(null)}
                className={cn(
                  "h-8 flex-1 justify-center rounded-md",
                  option === mode && "bg-background shadow-sm",
                )}
              >
                <Option
                  className={cn("size-4", option === "full" && option === mode && "!text-warn")}
                />
              </DropdownMenuItem>
            );
          })}
        </div>
        <p className={cn("pt-3 text-sm font-medium", shown === "full" && "text-warn")}>
          {m.name[shown]}
        </p>
        <p className="pt-0.5 text-xs text-muted-foreground">{m.lead[shown]}</p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
