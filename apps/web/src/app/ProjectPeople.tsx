import { SearchIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useConfirm } from "@/components/confirm";
import { Avatar, Loading, Notice, useAction, useLoad } from "@/components/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Lead } from "@/components/ui/hint";
import { useI18n } from "@/i18n";
import { api } from "@/lib/api";
import type { Project, ProjectMember } from "./api";

interface Person {
  id: string;
  name: string;
  email: string;
  departmentName: string | null;
}
type Role = "view" | "work";

/**
 * Who is in a project, and for its owner the place to bring a colleague in or take one
 * out. It says what being in it gives: the project's own page, to see or to work in, and
 * never anyone's conversations.
 *
 * It looks and works as the dialog for sharing an agent or a file does (Share.tsx), so
 * that a person who has shared one thing knows how to share the other.
 */
export function ProjectPeople({
  project,
  onClose,
}: {
  project: Project;
  /** `changed` when someone was added, changed or taken out; "left" when the person took themself out. */
  onClose(result: boolean | "left"): void;
}) {
  const { t } = useI18n();
  const s = t.app.project.people;
  const owns = project.role === "owner";
  const base = `/api/app/projects/${project.id}/members`;
  const people = useLoad(() => api<ProjectMember[]>(base), [base]);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Person[]>([]);
  const [role, setRole] = useState<Role>("view");
  const [changed, setChanged] = useState(false);
  const action = useAction();
  const { confirm, dialog } = useConfirm();

  // Colleagues are looked up as the name is typed, a moment after the last key.
  useEffect(() => {
    const q = query.trim();
    if (!q) return setFound([]);
    let stale = false;
    const timer = setTimeout(() => {
      void api<Person[]>(`/api/app/people?q=${encodeURIComponent(q)}`).then(
        (list) => !stale && setFound(list),
        () => !stale && setFound([]),
      );
    }, 200);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query]);

  const has = (id: string) => people.data?.some((one) => one.id === id) ?? false;
  const give = (id: string, as: Role) =>
    action.run(async () => {
      await api(`${base}/${id}`, { method: "PUT", body: { role: as } });
      setChanged(true);
      setQuery("");
      await people.reload();
    });
  const take = (id: string) =>
    action.run(async () => {
      await api(`${base}/${id}`, { method: "DELETE" });
      setChanged(true);
      await people.reload();
    });
  const leave = async (id: string) => {
    if (!(await confirm(s.leave, s.leaveConfirm(project.name)))) return;
    void action.run(async () => {
      await api(`${base}/${id}`, { method: "DELETE" });
      onClose("left");
    });
  };
  const chip = "rounded-full border px-2 py-0.5 text-xs";

  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose(changed)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{s.title(project.name)}</DialogTitle>
          <DialogDescription>{owns ? s.lead : s.leadSeen}</DialogDescription>
        </DialogHeader>
        {action.error && <Notice tone="bad">{action.error}</Notice>}
        {owns && (
          <>
            <div className="grid gap-1">
              <div className="flex items-center gap-2 text-sm">
                <Lead as="span" className="text-muted-foreground">
                  {s.theyMay}
                </Lead>
                <div className="flex rounded-lg border p-0.5">
                  {(["view", "work"] as const).map((value) => (
                    <button
                      type="button"
                      key={value}
                      aria-pressed={role === value}
                      onClick={() => setRole(value)}
                      // What each may do is said to whoever points at it, not printed under it.
                      title={s.roleHint[value]}
                      className={
                        role === value
                          ? "rounded-md bg-foreground/10 px-2.5 py-0.5 text-[13px] font-medium"
                          : "rounded-md px-2.5 py-0.5 text-[13px] text-muted-foreground hover:text-foreground"
                      }
                    >
                      {s.role[value]}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="grid gap-2">
              <label className="flex h-9 items-center gap-2 rounded-lg border bg-background px-3 text-sm focus-within:ring-2 focus-within:ring-ring/40">
                <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
                <input
                  autoFocus
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={s.find}
                  aria-label={s.find}
                  className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
                />
              </label>
              {query.trim() && (
                <ul className="max-h-48 overflow-y-auto rounded-lg border">
                  {found.length === 0 && (
                    <li className="px-3 py-2 text-sm text-muted-foreground">{s.nobody}</li>
                  )}
                  {found.map((person) => (
                    <li key={person.id}>
                      <button
                        type="button"
                        disabled={action.busy || has(person.id)}
                        className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-accent disabled:opacity-50"
                        onClick={() => void give(person.id, role)}
                      >
                        <Avatar
                          name={person.name}
                          email={person.email}
                          className="size-7 text-[11px]"
                        />
                        <span className="grid min-w-0 flex-1">
                          <span className="truncate text-sm font-medium">
                            {person.name || person.email}
                          </span>
                          <span className="truncate text-xs text-muted-foreground">
                            {person.email}
                            {person.departmentName ? ` · ${person.departmentName}` : ""}
                          </span>
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {has(person.id) ? s.already : s.add}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
        <section className="grid gap-1.5">
          <h3 className="section-title px-0">{s.with}</h3>
          {!people.data ? (
            people.error ? (
              <Notice tone="bad">{people.error}</Notice>
            ) : (
              <Loading />
            )
          ) : (
            <ul className="divide-y rounded-lg border">
              {people.data.map((one) => (
                <li key={one.id} className="flex items-center gap-2.5 px-3 py-1.5">
                  <Avatar name={one.name} email={one.email} className="size-7 text-[11px]" />
                  <span className="grid min-w-0 flex-1">
                    <span className="truncate text-sm">
                      {one.name || one.email}
                      {one.me && <span className="text-muted-foreground"> ({s.you})</span>}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {one.active ? one.email : s.left}
                    </span>
                  </span>
                  {owns && one.role !== "owner" ? (
                    <>
                      <button
                        type="button"
                        disabled={action.busy}
                        title={s.switch}
                        className={`${chip} hover:bg-accent`}
                        onClick={() => void give(one.id, one.role === "work" ? "view" : "work")}
                      >
                        {s.role[one.role]}
                      </button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        disabled={action.busy}
                        title={s.remove(one.name || one.email)}
                        aria-label={s.remove(one.name || one.email)}
                        onClick={() => void take(one.id)}
                      >
                        <XIcon className="size-3.5" />
                      </Button>
                    </>
                  ) : (
                    <span className={`${chip} text-muted-foreground`}>{s.role[one.role]}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
        {!owns && (
          <Button
            variant="outline"
            size="sm"
            className="justify-self-start"
            disabled={action.busy || !people.data}
            onClick={() => {
              const me = people.data?.find((one) => one.me);
              if (me) void leave(me.id);
            }}
          >
            {s.leave}
          </Button>
        )}
        {dialog}
      </DialogContent>
    </Dialog>
  );
}
