import { ChevronRightIcon, GitBranchIcon, GitPullRequestIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Notice, useAction } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { useI18n } from "@/i18n";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export interface CloudWorkShown {
  repository: string;
  folder: string;
  baseBranch: string;
  state: "open" | "proposed" | "sending" | "sent";
  proposal: { title: string; body: string } | null;
  branch: string | null;
  pr: { number: number; url: string } | null;
  files: { path: string; status: "added" | "modified" | "deleted" }[];
  /** The changed files that decide what the repository's CI runs. */
  ci: string[];
  /** A mark for exactly these changes: what is sent is what was shown, or nothing is. */
  fingerprint: string;
  /** Why the work cannot be sent as it stands, when it cannot. */
  held: string | null;
}
type Sent = { ok: true; anew: boolean } | { ok: false; problem: string };

const MARK = { added: "A", modified: "M", deleted: "D" } as const;
/** Which lines of a diff were added and which taken out. */
export const lineKind = (line: string): "add" | "cut" | "at" | "same" =>
  line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")
    ? "at"
    : line.startsWith("+")
      ? "add"
      : line.startsWith("-")
        ? "cut"
        : "same";
/** An address this page links to: https only, whatever it was handed. */
export const httpsOnly = (url: string): string | null => {
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
};
/** What goes with the press: the person's own title and words only where they changed them. */
export function edited(
  proposal: { title: string; body: string },
  now: { title: string; body: string },
): { title?: string; body?: string } {
  return {
    ...(now.title.trim() !== proposal.title ? { title: now.title.trim() } : {}),
    ...(now.body.trim() !== proposal.body ? { body: now.body.trim() } : {}),
  };
}

/**
 * A conversation's work on one of the company's repositories, done in the server's
 * sandbox: what changed, and, when the agent has proposed it, the pull request as it will
 * read and the one press that sends it. Nothing leaves before that press. Shown above
 * the message box only in a conversation that has such work.
 */
export function CloudWork({
  conversationId,
  running,
}: {
  conversationId: string;
  running: boolean;
}) {
  const { t } = useI18n();
  const k = t.app.cloud;
  const [work, setWork] = useState<CloudWorkShown | null>(null);
  const [open, setOpen] = useState(false);
  const [whole, setWhole] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [shown, setShown] = useState<{ path: string; diff: string | null } | null>(null);
  const [said, setSaid] = useState<{ bad: boolean; text: string } | null>(null);
  const action = useAction();
  const load = useCallback(async () => {
    const answer = await api<{ work: CloudWorkShown | null }>(
      `/api/app/conversations/${conversationId}/repo`,
    ).catch(() => ({ work: null }));
    setWork(answer.work);
  }, [conversationId]);
  // When the conversation opens and each time a reply ends: that is when the work changes.
  useEffect(() => {
    if (!running) void load();
  }, [load, running]);
  // What the agent wrote is where the person starts from, each time it proposes.
  const proposedTitle = work?.proposal?.title ?? "";
  const proposedBody = work?.proposal?.body ?? "";
  useEffect(() => {
    setTitle(proposedTitle);
    setBody(proposedBody);
    setWhole(false);
  }, [proposedTitle, proposedBody]);
  if (!work) return null;
  const proposal = work.state === "proposed" ? work.proposal : null;
  const link = work.pr ? httpsOnly(work.pr.url) : null;
  const look = async (path: string) => {
    if (shown?.path === path) return setShown(null);
    const answer = await api<{ diff: string | null }>(
      `/api/app/conversations/${conversationId}/repo/diff?path=${encodeURIComponent(path)}`,
    ).catch(() => ({ diff: null }));
    setShown({ path, diff: answer.diff });
  };
  const send = () =>
    action.run(async () => {
      if (!proposal) return;
      setSaid(null);
      try {
        const answer = await api<Sent>(`/api/app/conversations/${conversationId}/repo/send`, {
          method: "POST",
          body: { fingerprint: work.fingerprint, ...edited(proposal, { title, body }) },
        });
        if (!answer.ok) setSaid({ bad: true, text: answer.problem });
        else if (answer.anew) setSaid({ bad: false, text: k.anew });
      } finally {
        await load();
      }
    });
  return (
    <div className={cn("rounded-xl border text-[13px]", proposal && "border-brand/50")}>
      <div className="flex min-w-0 items-center gap-2 px-3 py-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRightIcon
            className={cn("size-4 shrink-0 text-muted-foreground", open && "rotate-90")}
          />
          <GitBranchIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">
            <span className="font-medium">{work.repository}</span>
            <span className="text-muted-foreground">
              {" "}
              · {k.from(work.baseBranch)} · {k.changed(work.files.length)}
            </span>
          </span>
        </button>
        {work.pr && link && (
          <a
            className="flex shrink-0 items-center gap-1 text-muted-foreground hover:underline"
            href={link}
            target="_blank"
            rel="noreferrer"
          >
            <GitPullRequestIcon className="size-4" />
            {k.pr(work.pr.number)}
          </a>
        )}
      </div>
      {/* Never only in the list: a change to what CI runs is said where it cannot be missed. */}
      {work.ci.length > 0 && (
        <p className="border-t px-3 py-1.5 text-warn">
          {k.ci} <span className="font-mono text-xs">{work.ci.slice(0, 6).join(", ")}</span>
          {work.ci.length > 6 && " …"}
        </p>
      )}
      {proposal && (
        <div className="grid gap-2 border-t px-3 py-2">
          <Input
            aria-label={k.title}
            value={title}
            maxLength={120}
            disabled={action.busy}
            onChange={(event) => setTitle(event.target.value)}
          />
          <Textarea
            aria-label={k.body}
            className={cn("font-mono text-xs", !whole && "max-h-24")}
            rows={whole ? Math.min(24, Math.max(4, body.split("\n").length + 1)) : 4}
            value={body}
            maxLength={10_000}
            disabled={action.busy}
            onChange={(event) => setBody(event.target.value)}
          />
          <div className="flex items-center gap-2">
            {!whole && body.split("\n").length > 4 && (
              <button
                type="button"
                className="text-xs text-muted-foreground hover:underline"
                onClick={() => setWhole(true)}
              >
                {k.showAll}
              </button>
            )}
            <span className="flex-1" />
            <Button
              variant="ghost"
              size="sm"
              className="h-7"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  await api(`/api/app/conversations/${conversationId}/repo/dismiss`, {
                    method: "POST",
                  });
                  await load();
                })
              }
            >
              {k.notNow}
            </Button>
            <Button
              size="sm"
              className="h-7"
              // Not while a reply is still being written: what is shown may be about to change.
              disabled={action.busy || running || Boolean(work.held) || !title.trim()}
              onClick={() => void send()}
            >
              {work.pr ? k.sendMore : k.send}
            </Button>
          </div>
        </div>
      )}
      {(said || action.error || work.held) && (
        <div className="border-t px-3 py-2">
          <Notice tone={said && !said.bad && !action.error ? undefined : "bad"}>
            {action.error ?? said?.text ?? work.held}
          </Notice>
        </div>
      )}
      {open && (
        <ul className="max-h-72 overflow-y-auto border-t py-1">
          {work.files.length === 0 && <li className="px-3 py-1 text-muted-foreground">{k.none}</li>}
          {work.files.map((file) => (
            <li key={file.path}>
              <button
                type="button"
                onClick={() => void look(file.path)}
                className="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-accent/40"
              >
                <span className="w-3 shrink-0 font-mono text-xs text-muted-foreground">
                  {MARK[file.status]}
                </span>
                <span className="min-w-0 truncate font-mono text-xs">{file.path}</span>
              </button>
              {shown?.path === file.path &&
                (shown.diff === null ? (
                  <p className="px-8 py-1 text-xs text-muted-foreground">{k.noDiff}</p>
                ) : (
                  <pre className="overflow-x-auto bg-foreground/3 px-3 py-2 font-mono text-xs leading-5">
                    {shown.diff
                      .split("\n")
                      .slice(2)
                      .map((line, at) => {
                        const kind = lineKind(line);
                        return (
                          <div
                            // biome-ignore lint/suspicious/noArrayIndexKey: the lines of one diff, never reordered
                            key={at}
                            className={cn(
                              kind === "add" && "bg-ok/10 text-ok",
                              kind === "cut" && "bg-destructive/10 text-destructive",
                              kind === "at" && "text-muted-foreground",
                            )}
                          >
                            {line || " "}
                          </div>
                        );
                      })}
                  </pre>
                ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
