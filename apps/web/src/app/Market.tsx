import { Building2Icon, CheckIcon, PlugIcon, PlusIcon, SearchIcon, UsersIcon } from "lucide-react";
import { useState } from "react";
import { useConfirm } from "@/components/confirm";
import { MoreMenu } from "@/components/more";
import { Loading, Notice, useAction, useLoad } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Lead } from "@/components/ui/hint";
import { Input, Label, Textarea } from "@/components/ui/input";
import { useI18n } from "@/i18n";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "./AgentAvatar";

type Kind = "agent" | "skill" | "knowledge";
interface Offered {
  kind: Kind;
  id: string;
  name: string;
  description: string;
  risk: string | null;
  mine: boolean;
  by: { name: string; email: string } | null;
  adds: number;
  added: boolean;
  given: boolean;
  /** Comes with Muster or was made by the company for everyone: there from the start. */
  builtIn?: boolean;
  departments: string[];
}
interface Mine {
  kind: Kind;
  id: string;
  name: string;
  ready: boolean;
  state: "pending" | "published" | "returned" | "withdrawn" | "changed" | null;
  reason: string;
}
interface System {
  id: string;
  name: string;
  description: string;
  actions: { name: string; summary: string; reads: boolean }[];
}
const SHELVES = ["all", "agent", "skill", "knowledge", "connector"] as const;
type Shelf = (typeof SHELVES)[number];

/** Offering something of one's own: to everyone or to some departments, with a word for the reviewer. */
function Offer({
  item,
  direct,
  onClose,
}: {
  item: Mine;
  /** The person runs the organization: theirs goes straight in. */
  direct: boolean;
  onClose(changed: boolean): void;
}) {
  const { t } = useI18n();
  const m = t.app.market;
  const departments = useLoad(() => api<{ id: string; name: string }[]>("/api/app/departments"));
  const [open, setOpen] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const { error, busy, run } = useAction();
  const send = () =>
    run(async () => {
      await api(`/api/app/market/${item.kind}/${item.id}`, {
        method: "POST",
        body: { departments: open, note },
      });
      onClose(true);
    });
  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose(false)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{m.offerTitle(item.name)}</DialogTitle>
          <DialogDescription>{direct ? m.offerDirect : m.offerLead}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <fieldset className="grid gap-1.5">
            <legend className="pb-1.5 text-sm font-medium">{m.forWhom}</legend>
            <div className="flex flex-wrap gap-1.5">
              {(departments.data ?? []).map((department) => (
                <label
                  key={department.id}
                  className="flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1 text-[13px] has-checked:border-brand has-checked:bg-brand/5"
                >
                  <input
                    type="checkbox"
                    className="size-3.5 accent-(--brand)"
                    checked={open.includes(department.id)}
                    onChange={(event) =>
                      setOpen((now) =>
                        event.target.checked
                          ? [...now, department.id]
                          : now.filter((id) => id !== department.id),
                      )
                    }
                  />
                  {department.name}
                </label>
              ))}
            </div>
            <span className="text-xs text-muted-foreground">
              {open.length === 0 ? m.everyone : m.onlyThese}
            </span>
          </fieldset>
          {!direct && (
            <Label className="grid gap-1.5">
              {m.note}
              <Textarea
                value={note}
                maxLength={500}
                placeholder={m.noteHint}
                onChange={(event) => setNote(event.target.value)}
              />
            </Label>
          )}
          <Lead className="text-xs text-muted-foreground">{m.theirs}</Lead>
          {error && <Notice tone="bad">{error}</Notice>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(false)}>
            {t.common.cancel}
          </Button>
          <Button disabled={busy} onClick={() => void send()}>
            {direct ? m.publish : m.submit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What the company offers its people: add what helps, and offer one's own. */
export function Marketplace() {
  const { t } = useI18n();
  const m = t.app.market;
  const { data, error, reload } = useLoad(() =>
    api<{ items: Offered[]; mine: Mine[]; maySubmit: boolean; decides: boolean }>(
      "/api/app/market",
    ),
  );
  const systems = useLoad(() => api<System[]>("/api/app/company-connectors"));
  const [shelf, setShelf] = useState<Shelf>("all");
  const [query, setQuery] = useState("");
  const [offering, setOffering] = useState<Mine | null>(null);
  const action = useAction();
  const { confirm, dialog } = useConfirm();
  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <Loading />;
  const needle = query.trim().toLowerCase();
  const match = (name: string, description: string) =>
    !needle || `${name} ${description}`.toLowerCase().includes(needle);
  const items = data.items.filter(
    (item) => (shelf === "all" || shelf === item.kind) && match(item.name, item.description),
  );
  const connectors =
    shelf === "all" || shelf === "connector"
      ? (systems.data ?? []).filter((system) => match(system.name, system.description))
      : [];
  const toggle = (item: Offered) =>
    action.run(async () => {
      await api(`/api/app/market/${item.kind}/${item.id}/added`, {
        method: item.added ? "DELETE" : "PUT",
      });
      await reload();
    });
  const withdraw = async (item: Mine) => {
    if (!(await confirm(m.withdraw, m.withdrawConfirm(item.name)))) return;
    await action.run(async () => {
      await api(`/api/app/market/${item.kind}/${item.id}`, { method: "DELETE" });
      await reload();
    });
  };
  const count = (kind: Shelf) =>
    kind === "all"
      ? data.items.length + (systems.data?.length ?? 0)
      : kind === "connector"
        ? (systems.data?.length ?? 0)
        : data.items.filter((item) => item.kind === kind).length;
  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto">
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 px-5 py-4 xl:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex max-w-full overflow-x-auto rounded-lg bg-foreground/6 p-0.5">
              {SHELVES.map((kind) => (
                <button
                  type="button"
                  key={kind}
                  aria-pressed={shelf === kind}
                  onClick={() => setShelf(kind)}
                  className={cn(
                    "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-3 text-[13px]",
                    shelf === kind
                      ? "bg-background font-medium shadow-xs"
                      : "text-muted-foreground",
                  )}
                >
                  {m.shelf[kind]}
                  <span className="num text-[11px] text-muted-foreground">{count(kind)}</span>
                </button>
              ))}
            </div>
            <div className="relative ml-auto w-full sm:w-64">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-8"
                placeholder={m.search}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          </div>
          {action.error && <Notice tone="bad">{action.error}</Notice>}
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2 2xl:grid-cols-3">
            {items.map((item) => {
              return (
                <div
                  key={`${item.kind}:${item.id}`}
                  className="glass-thick grid min-w-0 gap-2 rounded-2xl p-4"
                >
                  <div className="flex flex-wrap items-start gap-3">
                    <AgentAvatar name={item.name} description={item.description} kind={item.kind} />
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <span className="truncate text-sm font-semibold">{item.name}</span>
                      <span className="truncate text-[11px] text-muted-foreground">
                        {m.kind[item.kind]} ·{" "}
                        {item.builtIn ? "Muster" : item.by?.name || item.by?.email || m.company}
                      </span>
                    </span>
                    {item.mine ? (
                      <Badge variant="muted">{m.yours}</Badge>
                    ) : item.builtIn ? (
                      <Badge variant="muted">{m.builtIn}</Badge>
                    ) : item.given ? (
                      <Badge variant="ok">{m.given}</Badge>
                    ) : item.added ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={action.busy}
                        title={m.remove}
                        onClick={() => void toggle(item)}
                      >
                        <CheckIcon />
                        {m.added}
                      </Button>
                    ) : (
                      <Button size="sm" disabled={action.busy} onClick={() => void toggle(item)}>
                        <PlusIcon />
                        {m.add}
                      </Button>
                    )}
                  </div>
                  <p className="line-clamp-2 text-[13px] text-muted-foreground">
                    {(t.app.described[item.description] ?? item.description) || m.noDescription}
                  </p>
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                    {!item.builtIn && (
                      <span className="flex items-center gap-1 rounded-full border px-2 py-0.5">
                        <UsersIcon className="size-3" />
                        {m.adds(item.adds)}
                      </span>
                    )}
                    {item.departments.length > 0 && (
                      <span className="flex items-center gap-1 rounded-full border px-2 py-0.5">
                        <Building2Icon className="size-3" />
                        {item.departments.join(", ")}
                      </span>
                    )}
                    {item.risk && (
                      <span className="rounded-full border px-2 py-0.5">{m.reach[item.risk]}</span>
                    )}
                  </div>
                </div>
              );
            })}
            {connectors.map((system) => (
              <div key={system.id} className="glass-thick grid min-w-0 gap-2 rounded-2xl p-4">
                <div className="flex items-start gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand/12 text-brand-text">
                    <PlugIcon className="size-4" />
                  </span>
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="truncate text-sm font-semibold">{system.name}</span>
                    <span className="truncate text-[11px] text-muted-foreground">
                      {m.kind.connector} · {m.company}
                    </span>
                  </span>
                  <Badge variant="ok">{m.ready}</Badge>
                </div>
                <p className="line-clamp-2 text-[13px] text-muted-foreground">
                  {system.description || m.noDescription}
                </p>
                <div className="flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
                  {system.actions.map((item) => (
                    <span
                      key={item.name}
                      title={item.summary}
                      className="rounded-full border px-2 py-0.5 font-mono"
                    >
                      {item.name}
                      {!item.reads && <span className="font-sans text-warn"> · {m.asks}</span>}
                    </span>
                  ))}
                </div>
                <Lead className="text-[11px] text-muted-foreground">{m.connectorHow}</Lead>
              </div>
            ))}
          </div>
          {items.length === 0 && connectors.length === 0 && (
            <Notice>{needle ? m.noMatch : m.empty}</Notice>
          )}
        </div>
        {/* Offering is for someone who has made something to offer (Q-6). */}
        {data.mine.length > 0 && (
          <aside className="glass-thick grid min-w-0 gap-2 rounded-2xl p-4">
            <h3 className="text-sm font-semibold">{m.mineTitle}</h3>
            <Lead className="text-xs text-muted-foreground">
              {data.decides ? m.mineDirect : data.maySubmit ? m.mineLead : m.mineOff}
            </Lead>
            <ul className="grid gap-1.5">
              {data.mine.map((item) => {
                const listed = item.state === "pending" || item.state === "published";
                return (
                  <li key={`${item.kind}:${item.id}`} className="grid gap-1 rounded-lg border p-2">
                    <div className="flex items-center gap-2">
                      <AgentAvatar name={item.name} kind={item.kind} size="xs" />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                        {item.name}
                      </span>
                      {item.state && item.state !== "withdrawn" ? (
                        <Badge
                          variant={
                            item.state === "published"
                              ? "ok"
                              : item.state === "pending"
                                ? "muted"
                                : "warn"
                          }
                        >
                          {m.state[item.state]}
                        </Badge>
                      ) : null}
                      {listed ? (
                        <MoreMenu
                          label={t.common.more}
                          items={[
                            {
                              label: m.withdraw,
                              destructive: true,
                              onSelect: () => void withdraw(item),
                            },
                          ]}
                        />
                      ) : (
                        (data.maySubmit || data.decides) && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-6 px-2 text-xs"
                            disabled={!item.ready}
                            title={item.ready ? undefined : m.notReady}
                            onClick={() => setOffering(item)}
                          >
                            {item.state ? m.again : data.decides ? m.publish : m.submit}
                          </Button>
                        )
                      )}
                    </div>
                    {(item.state === "returned" || item.state === "withdrawn") && item.reason && (
                      <p className="text-xs text-muted-foreground">
                        {item.state === "returned" ? m.sentBack : m.takenDown}: {item.reason}
                      </p>
                    )}
                    {item.state === "changed" && (
                      <Lead className="text-xs text-muted-foreground">{m.changedLead}</Lead>
                    )}
                  </li>
                );
              })}
            </ul>
          </aside>
        )}
      </div>
      {offering && (
        <Offer
          item={offering}
          direct={data.decides}
          onClose={(changed) => {
            setOffering(null);
            if (changed) void reload();
          }}
        />
      )}
      {dialog}
    </div>
  );
}
