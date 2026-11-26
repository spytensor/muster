import { TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Notice, useAction } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import { api } from "@/lib/api";
import type { Approval } from "./api";
import { countAllowed, timesAllowed } from "./discovery";
import { Markdown } from "./markdown";

/** The facts of an action that is waiting: where it goes and exactly what would be sent. */
export function ApprovalFacts({ approval }: { approval: Approval }) {
  const { t } = useI18n();
  const a = t.app.approval;
  const { summary } = approval;
  return (
    <dl className="grid gap-x-3 gap-y-1 text-[13px] sm:grid-cols-[auto_1fr]">
      <dt className="text-muted-foreground">{a.destination}</dt>
      <dd className="font-mono text-xs break-all">
        {approval.tool === "memory.save"
          ? a.yourMemory
          : approval.tool === "project.note"
            ? a.yourNotes
            : approval.tool === "project.step"
              ? a.yourSteps
              : approval.tool === "project.update"
                ? a.yourUpdates
                : approval.tool === "followup.set"
                  ? a.yourFollowups
                  : summary.destination}
      </dd>
      <dt className="text-muted-foreground">{a.method}</dt>
      <dd>{t.app.toolSummary[approval.tool] ?? approval.tool}</dd>
      <dt className="text-muted-foreground">
        {approval.tool === "local.exec"
          ? a.command
          : approval.tool === "local.edit"
            ? a.changed
            : approval.tool === "local.write"
              ? a.written
              : approval.tool === "memory.save"
                ? a.remembered
                : approval.tool === "project.note"
                  ? a.noted
                  : approval.tool === "project.step"
                    ? a.stepped
                    : approval.tool === "project.update"
                      ? a.updated
                      : approval.tool === "followup.set"
                        ? a.awaited
                        : a.preview}
      </dt>
      <dd>
        {summary.bytes > 0 ? (
          <>
            <pre className="max-h-56 overflow-auto rounded-md bg-muted px-2.5 py-2 font-mono text-xs whitespace-pre-wrap break-all">
              {summary.preview}
            </pre>
            <span className="text-xs text-muted-foreground">{a.bytes(summary.bytes)}</span>
          </>
        ) : (
          <span className="text-muted-foreground">{a.nothingSent}</span>
        )}
      </dd>
    </dl>
  );
}

/** Asks the person to allow or refuse one action. Nothing happens until they choose. */
/**
 * The kinds of action that stop asking when a conversation goes from "Ask first" to "Approve
 * for me" (the gate in apps/server/src/runtime/runs.ts). Sending always asks, so it is not here.
 */
const ASKS_ONLY_FIRST = new Set(["local.write", "local.edit", "local.exec"]);
/** Allowed this many times before, the card offers to stop asking for the kind (Q-3). */
const OFFER_AFTER = 2;

export function ApprovalCard({
  approval,
  agentName,
  onDecided,
  onAskLess,
}: {
  approval: Approval;
  agentName: string;
  onDecided?: () => void;
  /** Moves the conversation from "Ask first" to the next mode; given only where that can be done. */
  onAskLess?: () => Promise<void>;
}) {
  const { t } = useI18n();
  const a = t.app.approval;
  const { busy, error, run } = useAction();
  // How long the action will still wait, counted down on the card.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const left = approval.expiresAt
    ? Math.max(0, Math.ceil((Date.parse(approval.expiresAt) - now) / 60_000))
    : null;
  const decide = (decision: "approve" | "reject", remember = false, askLess = false) =>
    run(async () => {
      await api(`/api/app/approvals/${approval.id}`, {
        method: "POST",
        body: { decision, ...(remember ? { remember } : {}) },
      });
      if (decision === "approve") countAllowed(approval.tool);
      if (askLess) await onAskLess?.();
      onDecided?.();
    });
  // Modes are met here, the third time the same kind of action is allowed: not on a chip
  // before the person knows what it would change. One that asks whatever the mode says why.
  const askLess =
    onAskLess &&
    ASKS_ONLY_FIRST.has(approval.tool) &&
    !approval.summary.why &&
    timesAllowed(approval.tool) >= OFFER_AFTER;
  // Reading a page can be allowed for its whole site, so research does not stop at every link.
  let site = "";
  if (approval.tool === "web.fetch")
    try {
      const asked = new URL(approval.summary.destination);
      // A site is allowed over https only, so the choice is offered only there.
      if (asked.protocol === "https:") site = asked.host;
    } catch {}
  const { summary, tool } = approval;
  const local = tool.startsWith("local.");
  // Where it happens, in a word: the folder, the person's own memory, or the site.
  let where = summary.destination;
  if (tool === "memory.save") where = a.yourMemory;
  else if (tool === "project.note") where = a.yourNotes;
  else if (tool === "project.step") where = a.yourSteps;
  else if (tool === "project.update") where = a.yourUpdates;
  else if (tool === "followup.set") where = a.yourFollowups;
  else if (local) where = a.inFolder(summary.destination);
  else if (site) where = site;
  // What is shown to be judged: all that would be sent or run, or the address when nothing is sent.
  const shown = summary.bytes > 0 ? summary.preview : summary.destination;
  return (
    <section
      aria-label={a.title}
      className="overflow-hidden rounded-xl border bg-foreground/[0.03]"
    >
      <div className="grid gap-2.5 px-3.5 pt-3 pb-3">
        <div className="grid gap-0.5">
          <h3 className="text-sm font-medium">{a.ask[tool] ?? a.askOther}</h3>
          <p className="truncate text-xs text-muted-foreground" title={summary.destination}>
            {agentName} · {where}
            {/* What kind of action it is, where the question does not already say. */}
            {!a.ask[tool] && ` · ${t.app.toolSummary[tool] ?? tool}`}
          </p>
        </div>
        {tool === "project.note" ? (
          // The notes are written in Markdown and read as such, not as their marks.
          <div className="max-h-52 overflow-auto rounded-lg border bg-background/60 px-3 py-2">
            <Markdown text={shown} className="gap-2 text-[13px]" />
          </div>
        ) : (
          <pre className="max-h-52 overflow-auto rounded-lg border bg-background/60 px-3 py-2 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
            {shown}
          </pre>
        )}
        {summary.bytes === 0 && <p className="text-xs text-muted-foreground">{a.nothingSent}</p>}
        {summary.why && (
          // Why this asks whatever the person said agents may do here.
          <p className="flex items-start gap-1.5 text-xs text-warn">
            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
            {summary.why}
          </p>
        )}
        {site && <p className="text-xs text-muted-foreground">{a.siteMeans}</p>}
        {error && <Notice tone="bad">{error}</Notice>}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t px-3.5 py-2">
        <span className="num min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {left !== null && a.waits(left)}
          {left !== null && summary.bytes > 0 && " · "}
          {summary.bytes > 0 && a.bytes(summary.bytes)}
        </span>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decide("reject")}>
          {a.reject}
        </Button>
        {site && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void decide("approve", true)}
          >
            {a.approveSite(site)}
          </Button>
        )}
        {askLess && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            title={a.askLessMeans}
            onClick={() => void decide("approve", false, true)}
          >
            {a.askLess}
          </Button>
        )}
        <Button size="sm" disabled={busy} onClick={() => void decide("approve")}>
          {a.approve}
        </Button>
      </div>
    </section>
  );
}
