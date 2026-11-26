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
  kind: "github";
  baseUrl: string;
  /** The last four characters of the key: the key itself is never sent back. */
  keyTail: string;
  login: string;
  updatedAt: string;
}
interface Repo {
  name: string;
  branch: string;
  departments: string[];
  /** Branches besides the main one that work may start from. */
  branches: string[];
  /** Whether work may change what defines the repository's CI. */
  workflows: boolean;
}
export type NamedRepo = Omit<Repo, "branch">;
const asNamed = (repos: readonly Repo[]): NamedRepo[] =>
  repos.map(({ name, departments, branches, workflows }) => ({
    name,
    departments,
    branches,
    workflows,
  }));
type Problem = { ok: false; problem: { message: string } };
const GITHUB = "https://api.github.com";

/** Which repositories are named, and for whom, after one is ticked or its department chosen. */
export function chosen(
  repos: readonly NamedRepo[],
  name: string,
  to: { on: boolean } | { department: string } | { branches: string } | { workflows: boolean },
): NamedRepo[] {
  const others = repos.filter((repo) => repo.name !== name);
  // Newly named: for everyone, from its main branch only, and its CI is not to be changed.
  const was = repos.find((repo) => repo.name === name) ?? {
    name,
    departments: [],
    branches: [],
    workflows: false,
  };
  if ("on" in to) return to.on ? [...others, was] : others;
  const now: NamedRepo =
    "department" in to
      ? { ...was, departments: to.department ? [to.department] : [] }
      : "branches" in to
        ? {
            ...was,
            branches: to.branches
              .split(/[\s,]+/)
              .map((branch) => branch.trim())
              .filter(Boolean)
              .slice(0, 10),
          }
        : { ...was, workflows: to.workflows };
  return [...others, now].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The company's code host: a key, set once, and the repositories agents may work on.
 * Work on them is done in the server's sandbox and sent only when its person says so.
 */
export function CodeHostCard({ canManage }: { canManage: boolean }) {
  const { t } = useI18n();
  const k = t.codeHost;
  const { data, error, reload } = useLoad(() =>
    api<{ canSeal: boolean; canRun: boolean; host: Connected | null; repos: Repo[] }>(
      "/api/code-host",
    ),
  );
  const departments = useLoad(() => api<{ id: string; name: string }[]>("/api/departments"));
  const had = data?.host ?? null;
  const [baseUrl, setBaseUrl] = useState("");
  const [key, setKey] = useState("");
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  /** What the key reaches, once asked for; and which of it is named. */
  const [reach, setReach] = useState<{ name: string; branch: string }[] | null>(null);
  const [named, setNamed] = useState<NamedRepo[]>([]);
  const action = useAction();
  const { confirm, dialog } = useConfirm();
  const enterprise = had && had.baseUrl !== GITHUB ? had.baseUrl : "";
  useEffect(() => {
    setBaseUrl(enterprise);
    setKey("");
    setReach(null);
  }, [enterprise]);
  useEffect(() => {
    setNamed(asNamed(data?.repos ?? []));
  }, [data?.repos]);
  const save = () =>
    action.run(async () => {
      setSaid(null);
      const answer = await api<{ ok: true; login: string } | Problem>("/api/code-host", {
        method: "PUT",
        body: {
          ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
          ...(key.trim() ? { key: key.trim() } : {}),
        },
      });
      setSaid(
        answer.ok
          ? { ok: true, text: k.reached(answer.login) }
          : { ok: false, text: answer.problem.message },
      );
      if (answer.ok) await reload();
    });
  const choose = () =>
    action.run(async () => {
      setSaid(null);
      const answer = await api<
        { ok: true; repositories: { name: string; branch: string }[] } | Problem
      >("/api/code-host/repositories");
      if (answer.ok) setReach(answer.repositories);
      else setSaid({ ok: false, text: answer.problem.message });
    });
  const keep = () =>
    action.run(async () => {
      const answer = await api<{ ok: true } | Problem>("/api/code-host/repos", {
        method: "PUT",
        body: { repos: named },
      });
      if (!answer.ok) return setSaid({ ok: false, text: answer.problem.message });
      setReach(null);
      await reload();
    });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {k.title}
          {had && <Badge variant="ok">{k.named(data?.repos.length ?? 0)}</Badge>}
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
            {data && !data.canRun && <Notice>{k.noSandbox}</Notice>}
            {canManage && (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor="code-host-key">{k.key}</Label>
                  <Input
                    id="code-host-key"
                    type="password"
                    autoComplete="off"
                    className="font-mono text-[13px]"
                    placeholder={had ? `•••• ${had.keyTail}` : ""}
                    value={key}
                    disabled={action.busy}
                    onChange={(event) => setKey(event.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="code-host-url">{k.address}</Label>
                  <Input
                    id="code-host-url"
                    type="url"
                    className="font-mono text-[13px]"
                    placeholder={GITHUB}
                    value={baseUrl}
                    disabled={action.busy}
                    onChange={(event) => setBaseUrl(event.target.value)}
                  />
                </div>
              </>
            )}
            {said && <Notice tone={said.ok ? undefined : "bad"}>{said.text}</Notice>}
            {canManage && (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  disabled={action.busy || (!key.trim() && (!had || baseUrl.trim() === enterprise))}
                  onClick={() => void save()}
                >
                  {had ? t.common.save : k.connect}
                </Button>
                {had && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={action.busy}
                    onClick={() =>
                      void (async () => {
                        if (!(await confirm(k.remove, k.removeConfirm))) return;
                        await action.run(async () => {
                          await api("/api/code-host", { method: "DELETE" });
                          setSaid(null);
                          await reload();
                        });
                      })()
                    }
                  >
                    {k.remove}
                  </Button>
                )}
              </div>
            )}
            {had && (
              <div className="grid gap-2 border-t pt-3">
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-[13px] font-medium">{k.repos}</span>
                  {canManage && !reach && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={action.busy}
                      onClick={() => void choose()}
                    >
                      {k.choose}
                    </Button>
                  )}
                </div>
                {!reach &&
                  ((data?.repos.length ?? 0) === 0 ? (
                    <p className="text-[13px] text-muted-foreground">{k.none}</p>
                  ) : (
                    <ul className="grid gap-1 text-[13px]">
                      {data?.repos.map((repo) => (
                        <li key={repo.name} className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate font-mono text-xs">
                            {repo.name}
                          </span>
                          {repo.workflows && (
                            <Badge variant="warn" className="shrink-0">
                              {k.workflows}
                            </Badge>
                          )}
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {repo.departments.length === 0
                              ? k.everyone
                              : repo.departments
                                  .map(
                                    (id) =>
                                      departments.data?.find((one) => one.id === id)?.name ?? "…",
                                  )
                                  .join(", ")}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ))}
                {reach && (
                  <>
                    <ul className="grid max-h-64 gap-1 overflow-y-auto text-[13px]">
                      {reach.length === 0 && (
                        <li className="text-muted-foreground">{k.reachNone}</li>
                      )}
                      {reach.map((repo) => {
                        const on = named.find(
                          (one) => one.name.toLowerCase() === repo.name.toLowerCase(),
                        );
                        return (
                          <li key={repo.name} className="flex flex-wrap items-center gap-2">
                            <label className="flex min-w-0 flex-1 items-center gap-2">
                              <input
                                type="checkbox"
                                checked={Boolean(on)}
                                onChange={(event) =>
                                  setNamed(
                                    chosen(named, on?.name ?? repo.name, {
                                      on: event.target.checked,
                                    }),
                                  )
                                }
                              />
                              <span className="min-w-0 truncate font-mono text-xs">
                                {repo.name}
                              </span>
                            </label>
                            {on && (
                              <select
                                aria-label={k.forWhom}
                                className="h-7 shrink-0 rounded-md border bg-transparent px-1.5 text-xs"
                                value={on.departments[0] ?? ""}
                                onChange={(event) =>
                                  setNamed(
                                    chosen(named, on.name, { department: event.target.value }),
                                  )
                                }
                              >
                                <option value="">{k.everyone}</option>
                                {departments.data?.map((department) => (
                                  <option key={department.id} value={department.id}>
                                    {department.name}
                                  </option>
                                ))}
                              </select>
                            )}
                            {on && (
                              <div className="flex basis-full items-center gap-3 pl-6">
                                <Input
                                  aria-label={k.branches}
                                  placeholder={k.branches}
                                  className="h-7 flex-1 font-mono text-xs"
                                  defaultValue={on.branches.join(", ")}
                                  onBlur={(event) =>
                                    setNamed(
                                      chosen(named, on.name, { branches: event.target.value }),
                                    )
                                  }
                                />
                                <label className="flex shrink-0 items-center gap-1.5 text-xs">
                                  <input
                                    type="checkbox"
                                    checked={on.workflows}
                                    onChange={(event) =>
                                      setNamed(
                                        chosen(named, on.name, { workflows: event.target.checked }),
                                      )
                                    }
                                  />
                                  {k.workflows}
                                </label>
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                    <div className="flex gap-2">
                      <Button size="sm" disabled={action.busy} onClick={() => void keep()}>
                        {t.common.save}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={action.busy}
                        onClick={() => {
                          setReach(null);
                          setNamed(asNamed(data?.repos ?? []));
                        }}
                      >
                        {t.common.cancel}
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
      {dialog}
    </Card>
  );
}
