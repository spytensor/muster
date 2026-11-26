import { LoaderIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { Notice, useAction } from "@/components/shared";
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
import { Input, Label, NativeSelect } from "@/components/ui/input";
import { useI18n } from "@/i18n";
import { api } from "@/lib/api";
import { Lead } from "@/components/ui/hint";

/** One tool of an MCP server, as Muster keeps it. The words are the server's own. */
export interface McpTool {
  name: string;
  slug: string;
  title: string;
  description: string;
  schema: Record<string, unknown>;
  hash: string;
  reads: boolean;
  refused?: "schema" | "shape";
  on: boolean;
  level: "ask" | "reads";
  approved: string | null;
  changed: boolean;
}
export type McpReason =
  | "unreachable"
  | "timeout"
  | "address"
  | "credential"
  | "not_mcp"
  | "protocol";
export interface McpConnector {
  id: string;
  name: string;
  description: string;
  baseUrl: string;
  authName: string;
  hasCredential: boolean;
  departments: string[];
  enabled: boolean;
  updatedAt: string;
  agents: number;
  kind: "http" | "mcp";
  tools: McpTool[];
  server: { name: string; version: string } | null;
  more: boolean;
  checkedAt: string | null;
  checkFailed: { reason: McpReason; said: string } | null;
}
type Answer =
  | { connected: true; id: string }
  | { connected: false; reason: McpReason; said: string };

/** Whether agents are given this tool now: switched on, and still what was switched on. */
export const toolOffered = (tool: McpTool) =>
  tool.on && !tool.refused && tool.approved !== null && tool.approved === tool.hash;
export const MCP_TOOLS_ON = 30;

/** Why a server could not be talked to, in the person's words, with what the server said beside it. */
export function McpFailure({ reason, said }: { reason: McpReason; said: string }) {
  const { t } = useI18n();
  const m = t.mcp;
  return (
    <Notice tone="bad">
      <span className="grid gap-1">
        <span>
          {m.failed} {m.reasons[reason] ?? m.reasons.protocol}
        </span>
        {said && (
          <span className="text-xs">
            {m.serverSaid} <span className="font-mono break-all">{said}</span>
          </span>
        )}
      </span>
    </Notice>
  );
}

/**
 * Where an MCP server is and how Muster signs in to it. Saving asks the server first:
 * one that does not answer is not kept, and the reason is shown here.
 *
 * `base` is where it is kept: the company's connectors, or the person's own.
 */
export function McpConnection({
  base,
  own,
  connector,
  departments,
  canSeal,
  onClose,
}: {
  base: string;
  own: boolean;
  connector: McpConnector | null;
  departments: { id: string; name: string }[];
  canSeal: boolean;
  /** Closed. With an id: it was saved, and a new one's tools are shown next. */
  onClose(saved: string | null, isNew: boolean): void;
}) {
  const { t } = useI18n();
  const m = t.mcp;
  const k = t.connections.company;
  const [name, setName] = useState(connector?.name ?? "");
  const [description, setDescription] = useState(connector?.description ?? "");
  const [url, setUrl] = useState(connector?.baseUrl ?? "https://");
  const [authName, setAuthName] = useState(connector?.authName ?? "Authorization");
  // Never sent back by the server: what is typed here replaces what is kept.
  const [credential, setCredential] = useState("");
  const [open, setOpen] = useState<string[]>(connector?.departments ?? []);
  const [enabled, setEnabled] = useState(connector?.enabled ?? true);
  const [failure, setFailure] = useState<{ reason: McpReason; said: string } | null>(null);
  const { error, busy, run } = useAction();
  const ready = name.trim() && /^https:\/\/[^/?#]+/.test(url.trim()) && !/[?#]/.test(url);
  const save = () =>
    run(async () => {
      setFailure(null);
      const answer = await api<Answer>(connector ? `${base}/${connector.id}` : base, {
        method: connector ? "PATCH" : "POST",
        body: {
          name,
          description,
          url: url.trim(),
          authName: authName.trim() || "Authorization",
          ...(credential ? { credential } : {}),
          ...(own ? {} : { departments: open }),
          enabled,
        },
      });
      if (answer.connected) onClose(answer.id, !connector);
      else setFailure(answer);
    });
  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && !busy && onClose(null, false)}>
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{connector ? m.edit : m.add}</DialogTitle>
          <DialogDescription>{connector ? m.editLead : m.addLead}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-[14rem_1fr]">
            <Label className="grid gap-1.5">
              {m.name}
              <Input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
            </Label>
            <Label className="grid gap-1.5">
              {m.what}
              <Input
                value={description}
                maxLength={300}
                placeholder={m.whatHint}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Label>
          </div>
          <Label className="grid gap-1.5">
            {m.address}
            <Input
              className="font-mono text-[13px]"
              value={url}
              maxLength={300}
              onChange={(e) => setUrl(e.target.value)}
            />
            <Lead as="span" className="text-xs font-normal text-muted-foreground">
              {m.addressHint}
            </Lead>
          </Label>
          <div className="grid gap-3 sm:grid-cols-[14rem_1fr]">
            <Label className="grid gap-1.5">
              {m.header}
              <Input
                className="font-mono text-[13px]"
                value={authName}
                maxLength={64}
                onChange={(e) => setAuthName(e.target.value)}
              />
            </Label>
            <Label className="grid gap-1.5">
              {m.credential}
              <Input
                type="password"
                autoComplete="off"
                className="font-mono text-[13px]"
                value={credential}
                disabled={!canSeal}
                placeholder={connector?.hasCredential ? m.credentialKept : m.credentialHint}
                onChange={(e) => setCredential(e.target.value)}
              />
            </Label>
          </div>
          <Lead className="-mt-2 text-xs text-muted-foreground">
            {`${canSeal ? m.credentialLead : k.noKey} ${m.limits}`}
          </Lead>
          {!own && (
            <fieldset className="grid gap-1.5">
              <legend className="pb-1.5 text-sm font-medium">{k.who}</legend>
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
          )}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-(--brand)"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            {k.enabled}
          </label>
          {failure && <McpFailure {...failure} />}
          {error && <Notice tone="bad">{error}</Notice>}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onClose(null, false)}>
            {t.common.cancel}
          </Button>
          <Button disabled={!ready || busy} onClick={() => void save()}>
            {busy && <LoaderIcon className="animate-spin" />}
            {busy ? m.connecting : connector ? t.common.save : m.connect}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The tools a server lists, each to be read and switched on or left off. Agents are given
 * a tool in exactly the words shown here; when the server changes one, it is switched off
 * and marked until somebody reads it again.
 */
export function McpTools({
  base,
  own,
  connector,
  canManage,
  reload,
  onClose,
}: {
  base: string;
  own: boolean;
  connector: McpConnector;
  canManage: boolean;
  /** Reads the connector again after a check: the dialog shows what it is given. */
  reload(): Promise<unknown>;
  onClose(): void;
}) {
  const { t, ago } = useI18n();
  const m = t.mcp;
  // What the person has decided here and not yet saved, by tool name.
  const [decided, setDecided] = useState<Record<string, { on: boolean; level: "ask" | "reads" }>>(
    {},
  );
  const [shown, setShown] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ reason: McpReason; said: string } | null>(null);
  const [news, setNews] = useState<string | null>(null);
  const saving = useAction();
  const checking = useAction();
  const now = (tool: McpTool) =>
    decided[tool.name] ?? { on: toolOffered(tool), level: own ? "ask" : tool.level };
  const count = connector.tools.filter((tool) => now(tool).on).length;
  const changed = connector.tools.filter((tool) => tool.changed && !now(tool).on).length;
  const dirty = Object.keys(decided).length > 0;
  const decide = (tool: McpTool, patch: Partial<{ on: boolean; level: "ask" | "reads" }>) =>
    setDecided((was) => ({ ...was, [tool.name]: { ...now(tool), ...patch } }));
  const check = () =>
    checking.run(async () => {
      setFailure(null);
      setNews(null);
      const answer = await api<
        | { connected: true; added: number; removed: number; changed: number }
        | { connected: false; reason: McpReason; said: string }
      >(`${base}/${connector.id}/check`, { method: "POST" });
      // What was read before the check may not be what is there now: decisions start over.
      setDecided({});
      await reload();
      if (answer.connected) setNews(m.checkedNow(answer.added, answer.removed, answer.changed));
      else setFailure(answer);
    });
  const save = () =>
    saving.run(async () => {
      try {
        await api(`${base}/${connector.id}`, {
          method: "PATCH",
          body: {
            tools: connector.tools
              .filter((tool) => decided[tool.name])
              .map((tool) => ({ name: tool.name, hash: tool.hash, ...now(tool) })),
          },
        });
      } catch (error) {
        // Most likely the server changed a tool meanwhile: show what is there now.
        await reload();
        setDecided({});
        throw error;
      }
      await reload();
      onClose();
    });
  const busy = saving.busy || checking.busy;
  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && !busy && onClose()}>
      <DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{m.toolsTitle(connector.name)}</DialogTitle>
          <DialogDescription>{own ? m.toolsLeadOwn : m.toolsLead}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="font-mono">{connector.baseUrl}</span>
            {connector.server?.name && (
              <span>{m.server(connector.server.name, connector.server.version)}</span>
            )}
            {connector.checkedAt && <span>{m.checked(ago(connector.checkedAt))}</span>}
            {canManage && (
              <Button
                variant="outline"
                size="sm"
                className="ml-auto"
                disabled={busy}
                onClick={() => void check()}
              >
                {checking.busy ? <LoaderIcon className="animate-spin" /> : <RefreshCwIcon />}
                {checking.busy ? m.checking : m.checkAgain}
              </Button>
            )}
          </div>
          {failure ? (
            <McpFailure {...failure} />
          ) : (
            connector.checkFailed && (
              <Notice>
                {m.checkFailed} {m.reasons[connector.checkFailed.reason] ?? ""}
              </Notice>
            )
          )}
          {news && <Notice tone="ok">{news}</Notice>}
          {changed > 0 && <Notice>{m.changedNotice(changed)}</Notice>}
          {connector.more && <Notice>{m.more}</Notice>}
          {checking.error && <Notice tone="bad">{checking.error}</Notice>}
          {connector.tools.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{m.none}</p>
          ) : (
            <ul className="grid divide-y rounded-lg border">
              {connector.tools.map((tool) => {
                const state = now(tool);
                return (
                  <li key={tool.name} className="grid gap-1.5 px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
                        <input
                          type="checkbox"
                          className="size-4 shrink-0 accent-(--brand)"
                          aria-label={`${m.on}: ${tool.name}`}
                          checked={state.on}
                          disabled={!canManage || Boolean(tool.refused) || busy}
                          onChange={(event) => decide(tool, { on: event.target.checked })}
                        />
                        <span className="min-w-0 truncate font-mono text-[13px] font-medium">
                          {tool.name}
                        </span>
                        {tool.title && (
                          <span className="truncate text-[13px] text-muted-foreground">
                            {tool.title}
                          </span>
                        )}
                      </label>
                      {tool.changed && !state.on && <Badge variant="warn">{m.changed}</Badge>}
                      {tool.reads && <Badge variant="muted">{m.saysReads}</Badge>}
                      {!own && (
                        <NativeSelect
                          className="h-7 w-auto text-xs"
                          aria-label={`${m.level}: ${tool.name}`}
                          value={state.level}
                          disabled={!canManage || !state.on || busy}
                          onChange={(event) =>
                            decide(tool, { level: event.target.value as "ask" | "reads" })
                          }
                        >
                          <option value="ask">{m.ask}</option>
                          <option value="reads">{m.onlyReads}</option>
                        </NativeSelect>
                      )}
                    </div>
                    <p className="pl-6 text-[13px] break-words whitespace-pre-wrap text-muted-foreground">
                      {tool.description || m.noDescription}
                    </p>
                    {tool.refused && (
                      <p className="pl-6 text-xs text-warn">
                        {tool.refused === "shape" ? m.refusedShape : m.refused}
                      </p>
                    )}
                    {!own && state.on && state.level === "reads" && (
                      <p className="pl-6 text-xs text-warn">{m.onlyReadsHint}</p>
                    )}
                    <div className="pl-6">
                      <button
                        type="button"
                        className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                        aria-expanded={shown === tool.name}
                        onClick={() => setShown(shown === tool.name ? null : tool.name)}
                      >
                        {m.takes}
                      </button>
                      {shown === tool.name && (
                        <pre className="mt-1.5 max-h-52 overflow-auto rounded-md border bg-muted/40 px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
                          {JSON.stringify(tool.schema, null, 2)}
                        </pre>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {saving.error && <Notice tone="bad">{saving.error}</Notice>}
        </div>
        <DialogFooter className="items-center">
          <span
            className={`mr-auto text-xs ${count > MCP_TOOLS_ON ? "text-destructive" : "text-muted-foreground"}`}
          >
            {m.count(count)}
          </span>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {dirty ? t.common.cancel : m.close}
          </Button>
          {canManage && (
            <Button disabled={!dirty || busy || count > MCP_TOOLS_ON} onClick={() => void save()}>
              {t.common.save}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A connector's tools in a few marks, for a row of a table: what is on, and what needs a look. */
export function McpSummary({ connector }: { connector: McpConnector }) {
  const { t } = useI18n();
  const m = t.mcp;
  const on = connector.tools.filter(toolOffered);
  const changed = connector.tools.filter((tool) => tool.changed && !toolOffered(tool)).length;
  return (
    <div className="flex max-w-80 flex-wrap items-center gap-1">
      {on.length === 0 && <span className="text-[13px] text-muted-foreground">{m.noneOn}</span>}
      {on.slice(0, 8).map((tool) => (
        <span
          key={tool.name}
          title={tool.description}
          className="rounded-md border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]"
        >
          {tool.name}
          {tool.level === "ask" && <span className="text-warn"> · {m.asks}</span>}
        </span>
      ))}
      {on.length > 8 && <span className="text-xs text-muted-foreground">+{on.length - 8}</span>}
      {changed > 0 && <Badge variant="warn">{m.changedShort(changed)}</Badge>}
      {connector.checkFailed && <Badge variant="destructive">{m.notReached}</Badge>}
    </div>
  );
}
