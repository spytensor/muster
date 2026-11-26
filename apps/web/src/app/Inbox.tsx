import { MessageSquareIcon } from "lucide-react";
import { useEffect } from "react";
import { goApp } from "@/App";
import { Loading, Notice, useLoad } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Approval } from "./api";
import { ApprovalCard } from "./approval";
import { type InboxNotice, runsOf } from "./inboxRuns";

/**
 * The inbox: what waits for the person, then what happened while they were away. One
 * list, at the owner's word (2026-11-24): it used to open on a record of every decision
 * ever made, which nobody comes to read. What was decided is in its conversation.
 */
export function Inbox({ onChange }: { onChange(): void }) {
  const { t, ago, dateTime } = useI18n();
  const n = t.app.notices;
  const approvals = useLoad(() => api<Approval[]>("/api/app/approvals"));
  const notices = useLoad(() =>
    api<{ unread: number; notices: InboxNotice[] }>("/api/app/notices"),
  );
  // A request gives up by itself after a while; the list keeps up, so nothing dead is offered.
  const reload = approvals.reload;
  useEffect(() => {
    const timer = setInterval(reload, 15_000);
    return () => clearInterval(timer);
  }, [reload]);
  // Opening the list is having read it.
  const unread = notices.data?.unread ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the list has come with something unread
  useEffect(() => {
    if (unread > 0) void api("/api/app/notices/read", { method: "POST" }).then(onChange);
  }, [unread]);
  const error = approvals.error ?? notices.error;
  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!approvals.data || !notices.data) return <Loading />;
  const waiting = approvals.data.filter((approval) => approval.status === "pending");
  const runs = runsOf(notices.data.notices);
  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid w-full max-w-3xl gap-5 px-5 py-4">
        {waiting.length > 0 && (
          <section className="grid gap-2">
            <h3 className="section-title px-0">
              {t.app.approval.waiting}
              <span className="num ml-2 rounded-full bg-warn px-1.5 text-[11px] font-medium text-white">
                {waiting.length}
              </span>
            </h3>
            {waiting.map((approval) => (
              <div key={approval.id} className="grid content-start gap-1.5">
                <ApprovalCard
                  approval={approval}
                  agentName={approval.agentName ?? ""}
                  onDecided={() => {
                    void approvals.reload();
                    onChange();
                  }}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="justify-self-end"
                  onClick={() => goApp(`c/${approval.conversationId}`)}
                >
                  <MessageSquareIcon />
                  {t.app.approval.open}
                </Button>
              </div>
            ))}
          </section>
        )}
        {runs.length === 0 && waiting.length === 0 && (
          <p className="py-10 text-center text-sm text-muted-foreground">{n.none}</p>
        )}
        {runs.length > 0 && (
          <section className="grid gap-1.5">
            {runs.map(({ notice, times }) => (
              <button
                type="button"
                key={notice.id}
                onClick={() => goApp(notice.link)}
                className={cn(
                  "glass-thick flex items-start gap-3 rounded-xl px-3 py-2 text-left hover:bg-accent/40",
                  !notice.readAt && "border-brand/50",
                )}
              >
                <span
                  className={cn(
                    "mt-1.5 size-1.5 shrink-0 rounded-full",
                    notice.readAt ? "bg-transparent" : "bg-brand",
                  )}
                />
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="text-sm">{(n.text[notice.kind] ?? n.other)(notice.detail)}</span>
                  {/* A follow-up's reason is a word the sentence above has already said in the person's language. */}
                  {notice.detail.reason && notice.kind !== "followup_failed" && (
                    <span className="text-xs text-muted-foreground">{notice.detail.reason}</span>
                  )}
                </span>
                <span
                  className="num shrink-0 text-xs text-muted-foreground"
                  title={dateTime(notice.createdAt)}
                >
                  {times > 1 && `${n.times(times)} · `}
                  {ago(notice.createdAt)}
                </span>
              </button>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
