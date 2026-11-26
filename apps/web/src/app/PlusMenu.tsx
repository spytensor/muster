import { CheckIcon, PaperclipIcon, PlusIcon, Settings2Icon } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useI18n } from "@/i18n";
import { api } from "@/lib/api";
import { desktop } from "@/lib/desktop";
import type { Attachments } from "./attach";

export interface Connector {
  id: "microsoft";
  available: boolean;
  /** Switched off for the whole company by an administrator. */
  off?: boolean;
  /** `sends`: what this connection may send for the person, when they press Send on a draft. */
  connected: {
    account: string;
    since: string;
    sends?: { mail: boolean; teams: boolean };
  } | null;
}

/** Microsoft's mark, as people know it. */
export function MicrosoftMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 21 21" className={className ?? "size-4 shrink-0"}>
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}

/** Opens the service's consent page for this person: a new tab in a browser, the system's browser in the desktop app. */
export async function connectMicrosoft(): Promise<void> {
  // A browser lets a page open a tab only while it is handling the click, so the tab is
  // opened now and sent to the consent page once its address is known.
  const tab = desktop ? null : window.open("", "_blank");
  try {
    const { url } = await api<{ url: string }>("/api/app/connectors/microsoft/start", {
      method: "POST",
    });
    if (desktop) window.open(url, "_blank", "noopener");
    else if (tab) {
      tab.opener = null;
      tab.location.replace(url);
    } else location.assign(url);
  } catch (error) {
    tab?.close();
    throw error;
  }
}

/**
 * What a person can bring to a message, from the message box itself: files, and the
 * services their agents may read. The project has its own place beside this button. Managing those
 * services is in Settings; reaching them is here, where the work is.
 */
export function PlusMenu({
  attach,
  disabled,
  onManage,
}: {
  attach: Attachments;
  disabled?: boolean;
  onManage(): void;
}) {
  const { t } = useI18n();
  const m = t.app.plus;
  const input = useRef<HTMLInputElement>(null);
  const [connectors, setConnectors] = useState<Connector[] | null>(null);
  const connected = (connectors ?? []).filter((connector) => connector.connected);
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          if (event.target.files) attach.add(event.target.files);
          event.target.value = "";
        }}
      />
      <DropdownMenu
        onOpenChange={(open) => {
          // What is connected is read each time the menu opens: it may have changed in another tab.
          if (open)
            api<Connector[]>("/api/app/connectors").then(setConnectors, () => setConnectors([]));
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8 shrink-0 rounded-full"
            disabled={disabled}
            title={m.open}
          >
            <PlusIcon className="size-4" />
            <span className="sr-only">{m.open}</span>
          </Button>
        </DropdownMenuTrigger>
        {/* Below the box where there is room, so it never covers what the person was reading. */}
        <DropdownMenuContent align="start" side="bottom" sideOffset={8} className="w-72">
          <DropdownMenuItem onSelect={() => input.current?.click()}>
            <PaperclipIcon />
            <span className="flex-1">{m.files}</span>
            <span className="text-xs text-muted-foreground">{m.filesHint}</span>
          </DropdownMenuItem>
          {/* A connection is asked for by the work that needs it (the mail card's "Connect
              Microsoft 365"): only those already connected are listed here (Q-5). */}
          <DropdownMenuSeparator />
          {connected.length > 0 && (
            <p className="px-2 pt-1 pb-0.5 text-[11px] tracking-wide text-muted-foreground uppercase">
              {m.connectors}
            </p>
          )}
          {connected.map((connector) => (
            <DropdownMenuItem key={connector.id} onSelect={onManage}>
              <MicrosoftMark />
              <span className="grid min-w-0 flex-1">
                <span>{t.prefs.connections.microsoft.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {connector.connected?.account}
                </span>
              </span>
              <CheckIcon className="size-3.5 text-ok" />
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem onSelect={onManage}>
            <Settings2Icon />
            {m.manage}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
