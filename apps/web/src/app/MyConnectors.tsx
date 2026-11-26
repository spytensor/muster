import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { useConfirm } from "@/components/confirm";
import {
  McpConnection,
  type McpConnector,
  McpSummary,
  McpTools,
  toolOffered,
} from "@/components/mcp";
import { MoreMenu } from "@/components/more";
import { Notice, useAction, useLoad } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import { api } from "@/lib/api";
import { Lead } from "@/components/ui/hint";

const BASE = "/api/app/my-connectors";

/**
 * A person's own MCP servers: added by them, with their own credential, for their own
 * agents. Shown only where the company lets people have them, or where the person still
 * has some from when it did, so they can be taken away.
 */
export function MyConnectors() {
  const { t } = useI18n();
  const m = t.mcp;
  const { data, reload } = useLoad(() =>
    api<{ allowed: boolean; canSeal: boolean; connectors: McpConnector[] }>(BASE),
  );
  const [open, setOpen] = useState<{ stage: "connection" | "tools"; id: string | null } | null>(
    null,
  );
  const { busy, error, run } = useAction();
  const { confirm, dialog } = useConfirm();
  // Not offered here and nothing kept: there is nothing to say.
  if (!data || (!data.allowed && data.connectors.length === 0)) return null;
  const now = open?.id ? data.connectors.find((one) => one.id === open.id) : undefined;
  const remove = async (connector: McpConnector) => {
    if (!(await confirm(t.common.remove, m.mine.deleteConfirm(connector.name)))) return;
    await run(async () => {
      await api(`${BASE}/${connector.id}`, { method: "DELETE" });
      await reload();
    });
  };
  return (
    <section className="glass mt-3 grid gap-3 rounded-xl p-4">
      <div className="flex items-start gap-3">
        <div className="grid min-w-0 flex-1 gap-0.5">
          <h4 className="text-sm font-semibold">{m.mine.title}</h4>
          <Lead className="text-[13px] text-muted-foreground">{m.mine.lead}</Lead>
        </div>
        {data.allowed && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setOpen({ stage: "connection", id: null })}
          >
            <PlusIcon />
            {m.add}
          </Button>
        )}
      </div>
      {!data.allowed && <Notice>{m.mine.stopped}</Notice>}
      {error && <Notice tone="bad">{error}</Notice>}
      {data.connectors.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">{m.mine.none}</p>
      ) : (
        <ul className="grid divide-y rounded-lg border">
          {data.connectors.map((connector) => (
            <li key={connector.id} className="flex items-center gap-3 px-3 py-2.5">
              <div className="grid min-w-0 flex-1 gap-1">
                <span className="truncate text-sm font-medium">{connector.name}</span>
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {connector.baseUrl}
                </span>
                <McpSummary connector={connector} />
                <span className="text-xs text-muted-foreground">
                  {m.mine.toolsOn(
                    connector.tools.filter(toolOffered).length,
                    connector.tools.length,
                  )}
                  {connector.tools.some(toolOffered) && connector.agents === 0
                    ? ` · ${m.mine.thenAgent}`
                    : ""}
                </span>
              </div>
              {data.allowed && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setOpen({ stage: "tools", id: connector.id })}
                >
                  {m.tools}
                </Button>
              )}
              <MoreMenu
                label={t.common.more}
                items={[
                  ...(data.allowed
                    ? [
                        {
                          label: m.edit,
                          onSelect: () => setOpen({ stage: "connection", id: connector.id }),
                        },
                      ]
                    : []),
                  {
                    label: t.common.remove,
                    destructive: true,
                    onSelect: () => void remove(connector),
                  },
                ]}
              />
            </li>
          ))}
        </ul>
      )}
      {open?.stage === "connection" && (!open.id || now) && (
        <McpConnection
          base={BASE}
          own
          connector={now ?? null}
          departments={[]}
          canSeal={data.canSeal}
          onClose={(saved, isNew) => {
            // A server just added is read next: nothing of it reaches agents until then.
            setOpen(saved && isNew ? { stage: "tools", id: saved } : null);
            if (saved) void reload();
          }}
        />
      )}
      {open?.stage === "tools" && now && (
        <McpTools
          base={BASE}
          own
          connector={now}
          canManage={data.allowed}
          reload={reload}
          onClose={() => setOpen(null)}
        />
      )}
      {dialog}
    </section>
  );
}
