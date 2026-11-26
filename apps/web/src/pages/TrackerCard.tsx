import { useEffect, useState } from "react";
import { useConfirm } from "@/components/confirm";
import { Notice, useAction, useLoad } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { useI18n } from "@/i18n";
import { api } from "@/lib/api";

interface Connected {
  kind: "plane";
  baseUrl: string;
  workspace: string;
  /** The last four characters of the key, or nothing: the key itself is never sent back. */
  keyTail: string;
  updatedAt: string;
  /** How many projects are linked to it. */
  projects: number;
}
type Answer = { ok: true; projects: number } | { ok: false; problem: { message: string } };

/**
 * Which of the tracker's projects a project here may be linked to. The company's key
 * reaches all of them; a project's owner is offered only those ticked here.
 */
function Linkable({ canManage, at }: { canManage: boolean; at: string }) {
  const { t } = useI18n();
  const k = t.tracker;
  const [found, setFound] = useState<{ id: string; identifier: string; name: string }[]>();
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [kept, setKept] = useState<Set<string>>(new Set());
  const [problem, setProblem] = useState<string>();
  const action = useAction();
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked again when the connection is another
  useEffect(() => {
    setFound(undefined);
    setProblem(undefined);
    api<{
      ok: boolean;
      projects?: { id: string; identifier: string; name: string; allowed: boolean }[];
      problem?: { message: string };
    }>("/api/tracker/projects").then(
      (answer) => {
        if (!answer.ok) return setProblem(answer.problem?.message ?? "");
        const projects = answer.projects ?? [];
        const allowed = new Set(projects.filter((one) => one.allowed).map((one) => one.id));
        setFound(projects);
        setTicked(allowed);
        setKept(allowed);
      },
      (refused: Error) => setProblem(refused.message),
    );
  }, [at]);
  const changed = ticked.size !== kept.size || [...ticked].some((id) => !kept.has(id));
  return (
    <div className="grid gap-1.5 border-t pt-3">
      <Label>{k.linkable}</Label>
      {(problem ?? action.error) && <Notice tone="bad">{problem ?? action.error}</Notice>}
      {found === undefined && problem === undefined && (
        <p className="text-[13px] text-muted-foreground">…</p>
      )}
      {found?.map((one) => (
        <label key={one.id} className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            disabled={!canManage || action.busy}
            checked={ticked.has(one.id)}
            onChange={(event) => {
              const next = new Set(ticked);
              if (event.currentTarget.checked) next.add(one.id);
              else next.delete(one.id);
              setTicked(next);
            }}
          />
          <span className="num font-medium">{one.identifier}</span>
          <span className="min-w-0 truncate text-muted-foreground">{one.name}</span>
        </label>
      ))}
      {canManage && changed && (
        <div>
          <Button
            size="sm"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await api("/api/tracker/projects", {
                  method: "PUT",
                  body: { allowed: [...ticked] },
                });
                setKept(new Set(ticked));
              })
            }
          >
            {t.common.save}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The company's task tracker: where it is, its workspace and a key, set once. Project
 * owners then link their projects to it from the project's own page.
 */
export function TrackerCard({ canManage }: { canManage: boolean }) {
  const { t } = useI18n();
  const k = t.tracker;
  const { data, error, reload } = useLoad(() =>
    api<{ canSeal: boolean; tracker: Connected | null }>("/api/tracker"),
  );
  const had = data?.tracker ?? null;
  const [baseUrl, setBaseUrl] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [key, setKey] = useState("");
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const action = useAction();
  const { confirm, dialog } = useConfirm();
  useEffect(() => {
    setBaseUrl(had?.baseUrl ?? "");
    setWorkspace(had?.workspace ?? "");
    setKey("");
  }, [had?.baseUrl, had?.workspace]);
  const tell = (answer: Answer) =>
    setSaid(
      answer.ok
        ? { ok: true, text: k.reached(answer.projects) }
        : { ok: false, text: answer.problem.message },
    );
  const changed =
    baseUrl.trim() !== (had?.baseUrl ?? "") || workspace.trim() !== (had?.workspace ?? "") || key;
  const save = () =>
    action.run(async () => {
      setSaid(null);
      const answer = await api<Answer>("/api/tracker", {
        method: "PUT",
        body: {
          baseUrl: baseUrl.trim(),
          workspace: workspace.trim(),
          ...(key.trim() ? { key: key.trim() } : {}),
        },
      });
      tell(answer);
      if (answer.ok) await reload();
    });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {k.title}
          {had && <Badge variant="ok">{k.linked(had.projects)}</Badge>}
        </CardTitle>
        <CardDescription>{k.lead}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {error && <Notice tone="bad">{error}</Notice>}
        {action.error && <Notice tone="bad">{action.error}</Notice>}
        {data && !data.canSeal && !had ? (
          <Notice>{k.noSeal}</Notice>
        ) : (
          <>
            <div className="grid gap-2 md:grid-cols-3">
              <div className="grid gap-1.5">
                <Label htmlFor="tracker-url">{k.address}</Label>
                <Input
                  id="tracker-url"
                  type="url"
                  className="font-mono text-[13px]"
                  placeholder="https://plane.example.com"
                  value={baseUrl}
                  disabled={!canManage || action.busy}
                  onChange={(event) => setBaseUrl(event.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="tracker-workspace">{k.workspace}</Label>
                <Input
                  id="tracker-workspace"
                  className="font-mono text-[13px]"
                  value={workspace}
                  disabled={!canManage || action.busy}
                  onChange={(event) => setWorkspace(event.target.value)}
                />
              </div>
              {canManage && (
                <div className="grid gap-1.5">
                  <Label htmlFor="tracker-key">{k.key}</Label>
                  <Input
                    id="tracker-key"
                    type="password"
                    autoComplete="off"
                    className="font-mono text-[13px]"
                    placeholder={had ? `•••• ${had.keyTail}` : ""}
                    value={key}
                    disabled={action.busy}
                    onChange={(event) => setKey(event.target.value)}
                  />
                </div>
              )}
            </div>
            {said && <Notice tone={said.ok ? undefined : "bad"}>{said.text}</Notice>}
            {canManage && (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  disabled={
                    action.busy ||
                    !changed ||
                    !baseUrl.trim() ||
                    !workspace.trim() ||
                    (!had && !key)
                  }
                  onClick={() => void save()}
                >
                  {had ? t.common.save : k.connect}
                </Button>
                {had && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(async () =>
                          tell(await api<Answer>("/api/tracker/test", { method: "POST" })),
                        )
                      }
                    >
                      {k.test}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={action.busy}
                      onClick={() =>
                        void (async () => {
                          if (!(await confirm(k.remove, k.removeConfirm(had.projects)))) return;
                          await action.run(async () => {
                            await api("/api/tracker", { method: "DELETE" });
                            setSaid(null);
                            await reload();
                          });
                        })()
                      }
                    >
                      {k.remove}
                    </Button>
                  </>
                )}
              </div>
            )}
          </>
        )}
        {had && <Linkable canManage={canManage} at={`${had.baseUrl}/${had.workspace}`} />}
      </CardContent>
      {dialog}
    </Card>
  );
}
