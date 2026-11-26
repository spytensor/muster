import { CheckIcon, RotateCcwIcon, SendIcon } from "lucide-react";
import { useState } from "react";
import { Loading, Notice, useAction } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Lead } from "@/components/ui/hint";

/** What someone said about a file: on which part, and whether it has been dealt with. */
export interface FileComment {
  n: number;
  part: string;
  body: string;
  status: "open" | "resolved";
  by: string | null;
  mine: boolean;
  createdAt: string;
  resolvedBy: string | null;
  resolvedVersion: number | null;
}

/**
 * The comments on a file, beside it: what people it is shared among said about a slide,
 * a sheet or a section, and whether each has been dealt with. Anyone who may open the
 * file reads and adds; an agent changing the file sees the open ones and says which its
 * change answers.
 */
export function FileComments({
  fileId,
  comments,
  canChange,
  error,
  onChange,
}: {
  fileId: string;
  comments: FileComment[] | null;
  /** Whether the person may change the file: then any comment is theirs to settle, else only their own. */
  canChange: boolean;
  error: string | null;
  onChange(): void;
}) {
  const { t, ago } = useI18n();
  const c = t.files.comments;
  const action = useAction();
  const [part, setPart] = useState("");
  const [body, setBody] = useState("");
  const [all, setAll] = useState(false);
  const say = () =>
    void action.run(async () => {
      await api(`/api/app/files/${fileId}/comments`, {
        method: "POST",
        body: { part: part.trim(), body: body.trim() },
      });
      setBody("");
      setPart("");
      onChange();
    });
  const settle = (n: number, status: "open" | "resolved") =>
    void action.run(async () => {
      await api(`/api/app/files/${fileId}/comments/${n}`, { method: "PATCH", body: { status } });
      onChange();
    });
  const open = comments?.filter((one) => one.status === "open") ?? [];
  const shown = all ? (comments ?? []) : open;
  return (
    <aside className="flex w-80 shrink-0 flex-col border-l bg-card/60 text-sm">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <span className="text-[13px] font-medium">{c.title}</span>
        <span className="num text-xs text-muted-foreground">{c.open(open.length)}</span>
        {comments && comments.length > open.length && (
          <button
            type="button"
            className="ml-auto text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setAll(!all)}
          >
            {all ? c.onlyOpen : c.all(comments.length)}
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {(error || action.error) && <Notice tone="bad">{error ?? action.error}</Notice>}
        {!comments && !error && <Loading />}
        {comments && shown.length === 0 && (
          <p className="px-3 py-4 text-xs text-muted-foreground">{c.none}</p>
        )}
        {shown.map((one) => (
          <article
            key={one.n}
            className={cn(
              "grid gap-1 border-b px-3 py-2",
              one.status === "resolved" && "opacity-60",
            )}
          >
            <div className="flex items-baseline gap-1.5 text-xs">
              <span className="num text-muted-foreground">#{one.n}</span>
              <span className="min-w-0 truncate font-medium">{one.by ?? c.someone}</span>
              {one.part && (
                <span className="shrink-0 rounded bg-foreground/8 px-1 text-[11px]">
                  {one.part}
                </span>
              )}
              <span className="ml-auto shrink-0 text-muted-foreground">{ago(one.createdAt)}</span>
            </div>
            <p className="text-[13px] leading-snug break-words whitespace-pre-wrap">{one.body}</p>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {one.status === "resolved" ? (
                <>
                  <span className="flex min-w-0 items-center gap-1 text-ok">
                    <CheckIcon className="size-3 shrink-0" />
                    <span className="truncate">
                      {c.resolved(one.resolvedBy ?? c.someone, one.resolvedVersion)}
                    </span>
                  </span>
                  {(canChange || one.mine) && (
                    <button
                      type="button"
                      disabled={action.busy}
                      className="ml-auto flex shrink-0 items-center gap-1 hover:text-foreground"
                      onClick={() => settle(one.n, "open")}
                    >
                      <RotateCcwIcon className="size-3" />
                      {c.reopen}
                    </button>
                  )}
                </>
              ) : canChange || one.mine ? (
                <button
                  type="button"
                  disabled={action.busy}
                  className="ml-auto flex items-center gap-1 hover:text-foreground"
                  onClick={() => settle(one.n, "resolved")}
                >
                  <CheckIcon className="size-3" />
                  {c.resolve}
                </button>
              ) : null}
            </div>
          </article>
        ))}
      </div>
      <form
        className="grid shrink-0 gap-1.5 border-t p-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (body.trim()) say();
        }}
      >
        <input
          aria-label={c.part}
          value={part}
          maxLength={120}
          placeholder={c.part}
          onChange={(event) => setPart(event.target.value)}
          className="h-7 rounded-md border bg-background/60 px-2 text-xs outline-none focus:border-ring"
        />
        <div className="flex items-end gap-1.5">
          <textarea
            aria-label={c.say}
            value={body}
            maxLength={2000}
            rows={2}
            placeholder={c.say}
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && body.trim()) say();
            }}
            className="min-w-0 flex-1 resize-none rounded-md border bg-background/60 px-2 py-1 text-[13px] outline-none focus:border-ring"
          />
          <Button
            type="submit"
            size="icon"
            className="size-7 shrink-0"
            disabled={action.busy || !body.trim()}
          >
            <SendIcon className="size-3.5" />
            <span className="sr-only">{c.send}</span>
          </Button>
        </div>
        <Lead className="text-[11px] text-muted-foreground">{c.hint}</Lead>
      </form>
    </aside>
  );
}
