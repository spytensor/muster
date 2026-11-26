import { KeyRoundIcon, PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { useConfirm } from "@/components/confirm";
import { McpConnection, type McpConnector, McpSummary, McpTools } from "@/components/mcp";
import { MoreMenu } from "@/components/more";
import { Dot, Empty, Loading, Notice, useAction, useLoad } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input, Label, NativeSelect } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useI18n } from "@/i18n";
import { api } from "@/lib/api";
import { Lead } from "@/components/ui/hint";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
interface Action {
  name: string;
  summary: string;
  method: (typeof METHODS)[number];
  path: string;
}
/** One written here, with its actions, or an MCP server with the tools it lists. */
export interface CompanyConnector extends McpConnector {
  actions: Action[];
}
/** An MCP server a person set up for their own agents. */
interface Own {
  id: string;
  name: string;
  baseUrl: string;
  owner: string;
  updatedAt: string;
  toolsOn: number;
}
interface Department {
  id: string;
  name: string;
}

/** Setting up one system: where it is, how Muster signs in to it, and what agents may do there. */
function Editor({
  connector,
  departments,
  canSeal,
  onClose,
}: {
  connector: CompanyConnector | null;
  departments: Department[];
  canSeal: boolean;
  onClose(changed: boolean): void;
}) {
  const { t } = useI18n();
  const k = t.connections.company;
  const [name, setName] = useState(connector?.name ?? "");
  const [description, setDescription] = useState(connector?.description ?? "");
  const [baseUrl, setBaseUrl] = useState(connector?.baseUrl ?? "https://");
  const [authName, setAuthName] = useState(connector?.authName ?? "Authorization");
  // Never sent back by the server: what is typed here replaces what is kept.
  const [credential, setCredential] = useState("");
  const [actions, setActions] = useState<Action[]>(
    connector?.actions ?? [{ name: "", summary: "", method: "GET", path: "/" }],
  );
  const [open, setOpen] = useState<string[]>(connector?.departments ?? []);
  const [enabled, setEnabled] = useState(connector?.enabled ?? true);
  const { error, busy, run } = useAction();
  const change = (index: number, patch: Partial<Action>) =>
    setActions((now) => now.map((action, i) => (i === index ? { ...action, ...patch } : action)));
  const ready =
    name.trim() &&
    /^https:\/\/.+/.test(baseUrl.trim()) &&
    actions.length > 0 &&
    actions.every(
      (action) =>
        /^[a-z][a-z0-9_]{1,30}$/.test(action.name) &&
        action.summary.trim() &&
        action.path.startsWith("/"),
    );
  const save = () =>
    run(async () => {
      await api(connector ? `/api/company-connectors/${connector.id}` : "/api/company-connectors", {
        method: connector ? "PATCH" : "POST",
        body: {
          name,
          description,
          baseUrl: baseUrl.trim(),
          authName: authName.trim() || "Authorization",
          ...(credential ? { credential } : {}),
          actions,
          departments: open,
          enabled,
        },
      });
      onClose(true);
    });
  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose(false)}>
      <DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{connector ? k.edit : k.new}</DialogTitle>
          <DialogDescription>{k.editorLead}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-[14rem_1fr]">
            <Label className="grid gap-1.5">
              {k.name}
              <Input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
            </Label>
            <Label className="grid gap-1.5">
              {k.what}
              <Input
                value={description}
                maxLength={300}
                placeholder={k.whatHint}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Label>
          </div>
          <Label className="grid gap-1.5">
            {k.address}
            <Input
              className="font-mono text-[13px]"
              value={baseUrl}
              maxLength={300}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
            <Lead as="span" className="text-xs font-normal text-muted-foreground">
              {k.addressHint}
            </Lead>
          </Label>
          <div className="grid gap-3 sm:grid-cols-[14rem_1fr]">
            <Label className="grid gap-1.5">
              {k.header}
              <Input
                className="font-mono text-[13px]"
                value={authName}
                maxLength={64}
                onChange={(e) => setAuthName(e.target.value)}
              />
            </Label>
            <Label className="grid gap-1.5">
              {k.credential}
              <Input
                type="password"
                autoComplete="off"
                className="font-mono text-[13px]"
                value={credential}
                disabled={!canSeal}
                placeholder={connector?.hasCredential ? k.credentialKept : k.credentialHint}
                onChange={(e) => setCredential(e.target.value)}
              />
            </Label>
          </div>
          <Lead className="-mt-2 text-xs text-muted-foreground">
            {canSeal ? k.credentialLead : k.noKey}
          </Lead>
          <div className="grid gap-1.5">
            <span className="text-[13px] font-medium">{k.actions}</span>
            <Lead as="span" className="text-xs text-muted-foreground">
              {k.actionsLead}
            </Lead>
            {actions.map((action, index) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place
                key={index}
                className="grid items-center gap-1.5 sm:grid-cols-[9rem_6.5rem_1fr_1.4fr_auto]"
              >
                <Input
                  className="font-mono text-[13px]"
                  value={action.name}
                  placeholder={k.actionName}
                  aria-label={k.actionName}
                  maxLength={31}
                  onChange={(e) => change(index, { name: e.target.value.toLowerCase() })}
                />
                <NativeSelect
                  value={action.method}
                  aria-label={k.method}
                  onChange={(e) => change(index, { method: e.target.value as Action["method"] })}
                >
                  {METHODS.map((method) => (
                    <option key={method}>{method}</option>
                  ))}
                </NativeSelect>
                <Input
                  className="font-mono text-[13px]"
                  value={action.path}
                  placeholder="/tickets/{id}"
                  aria-label={k.path}
                  maxLength={300}
                  onChange={(e) => change(index, { path: e.target.value })}
                />
                <Input
                  value={action.summary}
                  placeholder={k.actionSummary}
                  aria-label={k.actionSummary}
                  maxLength={200}
                  onChange={(e) => change(index, { summary: e.target.value })}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  disabled={actions.length === 1}
                  aria-label={t.common.remove}
                  onClick={() => setActions((now) => now.filter((_, i) => i !== index))}
                >
                  <XIcon className="size-3.5" />
                </Button>
              </div>
            ))}
            {actions.length < 20 && (
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setActions((now) => [
                      ...now,
                      { name: "", summary: "", method: "GET", path: "/" },
                    ])
                  }
                >
                  <PlusIcon />
                  {k.addAction}
                </Button>
              </div>
            )}
          </div>
          <fieldset className="grid gap-1.5">
            <legend className="pb-1.5 text-[13px] font-medium">{k.who}</legend>
            <div className="flex flex-wrap gap-1.5">
              {departments.map((department) => (
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
              {open.length === 0 ? k.everyone : k.onlyThese}
            </span>
          </fieldset>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-(--brand)"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            {k.enabled}
          </label>
          {error && <Notice tone="bad">{error}</Notice>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(false)}>
            {t.common.cancel}
          </Button>
          <Button disabled={!ready || busy} onClick={() => void save()}>
            {t.common.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The company's own systems that agents can reach: set up once by an administrator, with
 * the company's credential, for the departments they name.
 */
export function CompanyConnectors({ canManage }: { canManage: boolean }) {
  const { t, ago, dateTime } = useI18n();
  const k = t.connections.company;
  const m = t.mcp;
  const { data, error, reload } = useLoad(() =>
    api<{ canSeal: boolean; connectors: CompanyConnector[]; own: boolean; people: Own[] }>(
      "/api/company-connectors",
    ),
  );
  const departments = useLoad(() => api<Department[]>("/api/departments"));
  const [editing, setEditing] = useState<CompanyConnector | "new" | null>(null);
  // An MCP server: its connection being set up, or its tools being read. By id, so the
  // dialog always shows the connector as it was last read.
  const [mcp, setMcp] = useState<{ stage: "connection" | "tools"; id: string | null } | null>(null);
  const action = useAction();
  const { confirm, dialog } = useConfirm();
  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <Loading />;
  const nameOf = (id: string) => departments.data?.find((d) => d.id === id)?.name ?? "…";
  const mcpNow = mcp?.id ? data.connectors.find((one) => one.id === mcp.id) : undefined;
  const allowOwn = async () => {
    if (data.own && !(await confirm(m.own.allow, m.own.stopConfirm))) return;
    await action.run(async () => {
      await api("/api/company-connectors/own", { method: "PUT", body: { allowed: !data.own } });
      await reload();
    });
  };
  const removeOwn = async (one: Own) => {
    if (!(await confirm(t.common.delete, m.own.deleteConfirm(one.name, one.owner)))) return;
    await action.run(async () => {
      await api(`/api/company-connectors/${one.id}`, { method: "DELETE" });
      await reload();
    });
  };
  const check = (connector: CompanyConnector) =>
    action.run(async () => {
      await api(`/api/company-connectors/mcp/${connector.id}/check`, { method: "POST" });
      await reload();
    });
  const remove = async (connector: CompanyConnector) => {
    if (!(await confirm(t.common.delete, k.deleteConfirm(connector.name, connector.agents))))
      return;
    await action.run(async () => {
      await api(`/api/company-connectors/${connector.id}`, { method: "DELETE" });
      await reload();
    });
  };
  return (
    <Card className="overflow-hidden pb-0 dense:pb-0">
      <CardHeader>
        <div className="flex w-full min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <CardTitle>{k.title}</CardTitle>
            <CardDescription>{k.lead}</CardDescription>
          </div>
          {canManage && (
            <div className="flex shrink-0 flex-wrap justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setMcp({ stage: "connection", id: null })}
              >
                <PlusIcon />
                {m.add}
              </Button>
              <Button size="sm" onClick={() => setEditing("new")}>
                <PlusIcon />
                {k.new}
              </Button>
            </div>
          )}
        </div>
      </CardHeader>
      {action.error && (
        <div className="px-3.5">
          <Notice tone="bad">{action.error}</Notice>
        </div>
      )}
      {data.connectors.length === 0 ? (
        <Empty>{k.none}</Empty>
      ) : (
        <Table pinLast>
          <TableHeader>
            <TableRow>
              <TableHead>{k.columns.system}</TableHead>
              <TableHead>{k.columns.actions}</TableHead>
              <TableHead>{k.columns.who}</TableHead>
              <TableHead>{k.columns.used}</TableHead>
              <TableHead>{k.columns.changed}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.connectors.map((connector) => (
              <TableRow key={connector.id}>
                <TableCell>
                  <div className="grid gap-0.5">
                    <span className="flex items-center gap-2 font-medium">
                      {connector.name}
                      {connector.kind === "mcp" && <Badge variant="outline">{m.badge}</Badge>}
                      {connector.enabled ? (
                        <Badge variant="ok">
                          <Dot />
                          {k.on}
                        </Badge>
                      ) : (
                        <Badge variant="muted">{k.off}</Badge>
                      )}
                    </span>
                    <span className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
                      {connector.baseUrl}
                      {connector.hasCredential && (
                        <KeyRoundIcon className="size-3" aria-label={k.hasCredential} />
                      )}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  {connector.kind === "mcp" && <McpSummary connector={connector} />}
                  <div className="flex max-w-80 flex-wrap gap-1">
                    {connector.actions.map((item) => (
                      <span
                        key={item.name}
                        title={`${item.method} ${item.path} — ${item.summary}`}
                        className="rounded-md border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]"
                      >
                        {item.name}
                        {item.method !== "GET" && <span className="text-warn"> · {k.asks}</span>}
                      </span>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="text-[13px]">
                  {connector.departments.length === 0
                    ? k.everyoneShort
                    : connector.departments.map(nameOf).join(", ")}
                </TableCell>
                <TableCell className="num">{k.agents(connector.agents)}</TableCell>
                <TableCell title={dateTime(connector.updatedAt)}>
                  {ago(connector.updatedAt)}
                </TableCell>
                <TableCell className="text-right">
                  {connector.kind === "mcp" && !canManage && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setMcp({ stage: "tools", id: connector.id })}
                    >
                      {m.tools}
                    </Button>
                  )}
                  {canManage && (
                    <MoreMenu
                      label={t.common.more}
                      items={[
                        ...(connector.kind === "mcp"
                          ? [
                              {
                                label: m.tools,
                                onSelect: () => setMcp({ stage: "tools", id: connector.id }),
                              },
                              {
                                label: m.edit,
                                onSelect: () => setMcp({ stage: "connection", id: connector.id }),
                              },
                              { label: m.checkAgain, onSelect: () => void check(connector) },
                            ]
                          : [{ label: k.edit, onSelect: () => setEditing(connector) }]),
                        {
                          label: t.common.delete,
                          destructive: true,
                          onSelect: () => void remove(connector),
                        },
                      ]}
                    />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <div className="grid gap-2 border-t px-3.5 py-1.5">
        <div className="flex min-h-7 items-center gap-2.5">
          <span className="shrink-0 text-[13px] font-medium">{m.own.title}</span>
          <Lead as="span" className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {m.own.lead}
          </Lead>
          <label className="flex shrink-0 items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              className="size-4 accent-(--brand)"
              checked={data.own}
              disabled={!canManage || action.busy}
              onChange={() => void allowOwn()}
            />
            {m.own.allow}
          </label>
        </div>
        {data.people.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">{data.own ? m.own.none : m.own.off}</p>
        ) : (
          <Table pinLast>
            <TableHeader>
              <TableRow>
                <TableHead>{m.own.columns.owner}</TableHead>
                <TableHead>{m.own.columns.server}</TableHead>
                <TableHead>{m.own.columns.tools}</TableHead>
                <TableHead>{k.columns.changed}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.people.map((one) => (
                <TableRow key={one.id}>
                  <TableCell className="text-[13px]">{one.owner}</TableCell>
                  <TableCell>
                    <div className="grid gap-0.5">
                      <span className="font-medium">{one.name}</span>
                      <span className="font-mono text-xs text-muted-foreground">{one.baseUrl}</span>
                    </div>
                  </TableCell>
                  <TableCell className="num">{one.toolsOn}</TableCell>
                  <TableCell title={dateTime(one.updatedAt)}>{ago(one.updatedAt)}</TableCell>
                  <TableCell className="text-right">
                    {canManage && (
                      <MoreMenu
                        label={t.common.more}
                        items={[
                          {
                            label: t.common.delete,
                            destructive: true,
                            onSelect: () => void removeOwn(one),
                          },
                        ]}
                      />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      {mcp?.stage === "connection" && (!mcp.id || mcpNow) && (
        <McpConnection
          base="/api/company-connectors/mcp"
          own={false}
          connector={mcpNow ?? null}
          departments={departments.data ?? []}
          canSeal={data.canSeal}
          onClose={(saved, isNew) => {
            // A server just added is read next: nothing of it reaches agents until then.
            setMcp(saved && isNew ? { stage: "tools", id: saved } : null);
            if (saved) void reload();
          }}
        />
      )}
      {mcp?.stage === "tools" && mcpNow && (
        <McpTools
          base="/api/company-connectors/mcp"
          own={false}
          connector={mcpNow}
          canManage={canManage}
          reload={reload}
          onClose={() => setMcp(null)}
        />
      )}
      {editing && (
        <Editor
          connector={editing === "new" ? null : editing}
          departments={departments.data ?? []}
          canSeal={data.canSeal}
          onClose={(changed) => {
            setEditing(null);
            if (changed) void reload();
          }}
        />
      )}
      {dialog}
    </Card>
  );
}
