import { AlertTriangleIcon, CheckIcon, Link2Icon, LoaderIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useConfirm } from "@/components/confirm";
import { Notice, useAction } from "@/components/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useI18n } from "@/i18n";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

interface Standing {
  /** The company has a tracker connected. */
  available: boolean;
  link: { identifier: string; name: string; url: string } | null;
  /** Steps whose ticket is behind. */
  waiting: number;
  failed: string | null;
  /** The project is the person's own: linking and unlinking are theirs. */
  mine: boolean;
}
interface Choice {
  id: string;
  identifier: string;
  name: string;
}

/**
 * Where a project stands with the company's tracker, beside its steps: nothing where
 * there is no tracker, one action for the owner where it is not linked, and one small
 * mark where it is (in step, some waiting, or failing and why).
 */
export function ProjectTracker({
  projectId,
  steps,
  moved,
  onSent,
}: {
  projectId: string;
  /** How many steps the project has, for the offer to send them. */
  steps: number;
  /** Changes whenever a step did: the standing is asked again. */
  moved: string;
  /** Something was sent or brought in: the steps are worth asking for again. */
  onSent(): void;
}) {
  const { t } = useI18n();
  const k = t.app.project.tracker;
  const at = `/api/app/projects/${projectId}/tracker`;
  const [standing, setStanding] = useState<Standing>();
  const [linking, setLinking] = useState(false);
  const { confirm, dialog } = useConfirm();
  const { run, busy, error } = useAction();
  const before = useRef<number | undefined>(undefined);
  // The caller's own function each time it draws: the latest is the one called.
  const sent = useRef(onSent);
  sent.current = onSent;
  const load = useCallback(
    () =>
      api<Standing>(at).then(
        (found) => {
          // What was waiting has gone out, and a ticket has its number now.
          if (before.current !== undefined && found.waiting < before.current) sent.current();
          before.current = found.waiting;
          setStanding(found);
        },
        () => undefined,
      ),
    [at],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: `moved` is why it is asked again
  useEffect(() => {
    void load();
  }, [load, moved]);
  // While linked, the tracker may change a step at any time.
  const linked = Boolean(standing?.link);
  useEffect(() => {
    if (!linked) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void load();
      sent.current();
    }, 30_000);
    return () => clearInterval(timer);
  }, [linked, load]);

  if (!standing?.available) return null;
  if (!standing.link)
    return standing.mine ? (
      <>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setLinking(true)}>
          <Link2Icon />
          {k.link}
        </Button>
        {linking && (
          <LinkDialog
            at={at}
            steps={steps}
            onClose={(done) => {
              setLinking(false);
              if (done) void load();
            }}
          />
        )}
      </>
    ) : null;

  const link = standing.link;
  const says = standing.failed
    ? k.failed
    : standing.waiting > 0
      ? k.waiting(standing.waiting)
      : k.inStep;
  return (
    <div className="ml-auto flex items-center gap-1">
      {error && <Notice tone="bad">{error}</Notice>}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent/50",
              standing.failed && "text-warn",
            )}
            title={standing.failed ?? link.name}
          >
            {standing.failed ? (
              <AlertTriangleIcon className="size-3" />
            ) : standing.waiting > 0 ? (
              <LoaderIcon className="size-3 animate-spin" />
            ) : (
              <CheckIcon className="size-3" />
            )}
            <span className="num font-medium">{link.identifier}</span>
            <span>{says}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => window.open(link.url, "_blank", "noopener")}>
            {k.open(link.name)}
          </DropdownMenuItem>
          {standing.mine && (
            <DropdownMenuItem
              variant="destructive"
              disabled={busy}
              onSelect={() =>
                void (async () => {
                  if (!(await confirm(k.unlink, k.unlinkConfirm(link.name)))) return;
                  await run(async () => {
                    await api(at, { method: "DELETE" });
                    await load();
                    sent.current();
                  });
                })()
              }
            >
              {k.unlink}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog}
    </div>
  );
}

function LinkDialog({
  at,
  steps,
  onClose,
}: {
  at: string;
  steps: number;
  onClose(done: boolean): void;
}) {
  const { t } = useI18n();
  const k = t.app.project.tracker;
  const [choices, setChoices] = useState<Choice[]>();
  const [problem, setProblem] = useState<string>();
  const [chosen, setChosen] = useState("");
  const [send, setSend] = useState(true);
  const { run, busy, error } = useAction();
  useEffect(() => {
    api<{ ok: boolean; projects?: Choice[]; problem?: { message: string } }>(`${at}/projects`).then(
      (found) => {
        if (found.ok) {
          setChoices(found.projects ?? []);
          setChosen(found.projects?.[0]?.id ?? "");
        } else setProblem(found.problem?.message ?? "");
      },
      (refused: Error) => setProblem(refused.message),
    );
  }, [at]);
  const link = () =>
    run(async () => {
      const done = await api<{ ok: boolean; problem?: { message: string } }>(at, {
        method: "PUT",
        body: { project: chosen, send },
      });
      if (done.ok) onClose(true);
      else setProblem(done.problem?.message ?? "");
    });
  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose(false)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{k.title}</DialogTitle>
          <DialogDescription>{k.lead}</DialogDescription>
        </DialogHeader>
        {(problem ?? error) && <Notice tone="bad">{problem ?? error}</Notice>}
        {choices === undefined && problem === undefined ? (
          <p className="text-[13px] text-muted-foreground">…</p>
        ) : (
          choices !== undefined && (
            <div className="grid gap-3">
              <select
                aria-label={k.title}
                className="h-9 rounded-md border bg-transparent px-2 text-sm"
                value={chosen}
                onChange={(event) => setChosen(event.currentTarget.value)}
              >
                {choices.map((one) => (
                  <option key={one.id} value={one.id}>
                    {one.identifier} · {one.name}
                  </option>
                ))}
              </select>
              {steps > 0 && (
                <label className="flex items-center gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    checked={send}
                    onChange={(event) => setSend(event.currentTarget.checked)}
                  />
                  {k.sendExisting(steps)}
                </label>
              )}
            </div>
          )
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(false)}>
            {t.common.cancel}
          </Button>
          <Button disabled={busy || !chosen} onClick={() => void link()}>
            {k.link}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
