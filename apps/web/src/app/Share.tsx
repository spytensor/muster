import { Building2Icon, SearchIcon, UserIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Avatar, Loading, Notice, useAction, useLoad } from "@/components/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "@/i18n";
import { api } from "@/lib/api";
import { Lead } from "@/components/ui/hint";

export type ItemKind = "agent" | "skill" | "knowledge" | "file";
interface Shared {
  toKind: "user" | "department";
  toId: string;
  name: string | null;
  email: string | null;
  /** For a file: whether they may change it, or only read it. */
  canChange?: boolean;
}
interface Person {
  id: string;
  name: string;
  email: string;
  departmentName: string | null;
}

/**
 * Who something a person made is shared with, and the place to share it with a colleague
 * or a department or to take that back. What the receiver gets is said plainly: the thing
 * itself, working with their own data, never its owner's.
 */
export function ShareDialog({
  kind,
  id,
  name,
  onClose,
}: {
  kind: ItemKind;
  id: string;
  name: string;
  onClose(changed: boolean): void;
}) {
  const { t } = useI18n();
  const s = t.app.share;
  const base = `/api/app/items/${kind}/${id}/shares`;
  const shares = useLoad(() => api<Shared[]>(base), [base]);
  const departments = useLoad(() => api<{ id: string; name: string }[]>("/api/app/departments"));
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Person[]>([]);
  const [changed, setChanged] = useState(false);
  const action = useAction();

  // Colleagues are looked up as the name is typed, a moment after the last key.
  useEffect(() => {
    const q = query.trim();
    if (!q) return setFound([]);
    let stale = false;
    const timer = setTimeout(() => {
      void api<Person[]>(`/api/app/people?q=${encodeURIComponent(q)}`).then(
        (people) => !stale && setFound(people),
        () => !stale && setFound([]),
      );
    }, 200);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query]);

  const has = (toKind: string, toId: string) =>
    shares.data?.some((share) => share.toKind === toKind && share.toId === toId) ?? false;
  // A file is shared to be read, or to be changed too. Asked before it is given.
  const [mayChange, setMayChange] = useState(false);
  const give = (toKind: "user" | "department", toId: string, canChange = mayChange) =>
    action.run(async () => {
      await api(base, {
        method: "PUT",
        body: { toKind, toId, ...(kind === "file" ? { canChange } : {}) },
      });
      setChanged(true);
      setQuery("");
      await shares.reload();
    });
  const take = (share: Shared) =>
    action.run(async () => {
      await api(`${base}/${share.toKind}/${share.toId}`, { method: "DELETE" });
      setChanged(true);
      await shares.reload();
    });
  const open = departments.data?.filter((department) => !has("department", department.id)) ?? [];

  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose(changed)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{s.title(name)}</DialogTitle>
          <DialogDescription>{s.lead[kind]}</DialogDescription>
        </DialogHeader>
        {action.error && <Notice tone="bad">{action.error}</Notice>}
        {kind === "file" && (
          <div className="flex items-center gap-2 text-sm">
            <Lead as="span" className="text-muted-foreground">
              {s.theyMay}
            </Lead>
            <div className="flex rounded-lg border p-0.5">
              {([false, true] as const).map((value) => (
                <button
                  type="button"
                  key={String(value)}
                  aria-pressed={mayChange === value}
                  onClick={() => setMayChange(value)}
                  className={
                    mayChange === value
                      ? "rounded-md bg-foreground/10 px-2.5 py-0.5 text-[13px] font-medium"
                      : "rounded-md px-2.5 py-0.5 text-[13px] text-muted-foreground hover:text-foreground"
                  }
                >
                  {value ? s.change : s.read}
                </button>
              ))}
            </div>
          </div>
        )}
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
                    disabled={action.busy || has("user", person.id)}
                    className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-accent disabled:opacity-50"
                    onClick={() => void give("user", person.id)}
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
                      {has("user", person.id) ? s.already : s.add}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!query.trim() && open.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">{s.departments}</span>
              {open.map((department) => (
                <button
                  key={department.id}
                  type="button"
                  disabled={action.busy}
                  className="flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs hover:bg-accent"
                  onClick={() => void give("department", department.id)}
                >
                  <Building2Icon className="size-3" />
                  {department.name}
                </button>
              ))}
            </div>
          )}
        </div>
        <section className="grid gap-1.5">
          <h3 className="section-title px-0">{s.with}</h3>
          {!shares.data ? (
            shares.error ? (
              <Notice tone="bad">{shares.error}</Notice>
            ) : (
              <Loading />
            )
          ) : shares.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">{s.none}</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {shares.data.map((share) => (
                <li
                  key={`${share.toKind}:${share.toId}`}
                  className="flex items-center gap-2.5 px-3 py-1.5"
                >
                  {share.toKind === "user" ? (
                    <UserIcon className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <Building2Icon className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="grid min-w-0 flex-1">
                    <span className="truncate text-sm">{share.name || share.email || s.gone}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {share.toKind === "user" ? share.email : s.everyoneIn}
                    </span>
                  </span>
                  {kind === "file" && (
                    <button
                      type="button"
                      disabled={action.busy}
                      title={s.switch}
                      className="rounded-full border px-2 py-0.5 text-xs hover:bg-accent"
                      onClick={() => void give(share.toKind, share.toId, !share.canChange)}
                    >
                      {share.canChange ? s.change : s.read}
                    </button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    disabled={action.busy}
                    title={s.stop}
                    aria-label={s.stop}
                    onClick={() => void take(share)}
                  >
                    <XIcon className="size-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <Lead className="text-xs text-muted-foreground">
          {kind === "file" ? s.fileTheirs : s.theirs}
        </Lead>
      </DialogContent>
    </Dialog>
  );
}
