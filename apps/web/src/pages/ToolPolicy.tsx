import { useState } from "react";
import { Loading, Notice, useAction, useLoad } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Hint } from "@/components/ui/hint";
import { Label, NativeSelect, Textarea } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { useI18n } from "@/i18n";
import { api, type Me } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  type Effect,
  effectShown,
  GROUPS,
  hostsOf,
  limited,
  type Rule,
  type Scope,
} from "./toolRules";

interface Page {
  tools: { key: string; group: string; level?: string; name?: string }[];
  rules: Rule[];
  departments: { id: string; name: string }[];
  scopes: { everyone: Scope | null; agents: { id: string; name: string; scope: Scope | null }[] };
  bases: { id: string; name: string }[];
  connectors: { key: string; name: string }[];
}
const OPEN: Scope = { files: true, mail: true, web: "all", knowledge: "all", connectors: "all" };

/** The organization's tool policy: a rule a tool, and what each agent may reach (MUS-26). */
export function ToolPolicy({ me }: { me: Me }) {
  const { t } = useI18n();
  const p = t.system.policy;
  const can = me.permissions.includes("settings.manage");
  const { data, error, reload } = useLoad(() => api<Page>("/api/policies/tools"));
  const { run, busy, error: failed } = useAction();
  /** Whose rules are on view: everyone's, or one department's own. */
  const [department, setDepartment] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string; scope: Scope | null } | null>(
    null,
  );
  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <Loading />;
  const set = (tool: string, effect: Effect | "inherit") =>
    run(async () => {
      await api("/api/policies/tools", {
        method: "PUT",
        body: { tool, departmentId: department || null, effect },
      });
      await reload();
    });
  const choices: (Effect | "inherit")[] = department
    ? ["inherit", "allow", "ask", "off"]
    : ["allow", "ask", "off"];
  return (
    <div className="grid gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            {p.title}
            <Hint>{p.hint}</Hint>
          </CardTitle>
          <CardDescription>{p.lead}</CardDescription>
          {data.departments.length > 0 && (
            <CardAction>
              <NativeSelect
                aria-label={p.forWhom}
                value={department}
                onChange={(event) => setDepartment(event.target.value)}
              >
                <option value="">{p.everyone}</option>
                {data.departments.map((one) => (
                  <option key={one.id} value={one.id}>
                    {one.name}
                  </option>
                ))}
              </NativeSelect>
            </CardAction>
          )}
        </CardHeader>
        {failed && <Notice tone="bad">{failed}</Notice>}
        {/* Two columns of groups where there is room: the list is long and each row short. */}
        <div className="gap-0 lg:columns-2 lg:[column-rule:1px_solid_var(--color-border)]">
          {GROUPS.filter((group) => data.tools.some((tool) => tool.group === group)).map(
            (group) => (
              <div key={group} className="break-inside-avoid">
                <Table>
                  <TableBody>
                    <TableRow className="hover:bg-transparent">
                      <TableCell
                        colSpan={2}
                        className="bg-foreground/3 py-1.5 text-xs font-medium text-muted-foreground"
                      >
                        {p.groups[group]}
                      </TableCell>
                    </TableRow>
                    {data.tools
                      .filter((tool) => tool.group === group)
                      .map((tool) => {
                        const shown = effectShown(data.rules, tool.key, department || null);
                        return (
                          <TableRow key={tool.key}>
                            <TableCell className="whitespace-normal">
                              {tool.name ?? t.app.toolName[tool.key] ?? tool.key}
                            </TableCell>
                            <TableCell className="w-px text-right">
                              <div
                                role="radiogroup"
                                aria-label={tool.name ?? t.app.toolName[tool.key] ?? tool.key}
                                className="inline-flex rounded-md bg-foreground/6 p-0.5"
                              >
                                {choices.map((choice) => (
                                  // biome-ignore lint/a11y/useSemanticElements: a segmented control, one button a choice
                                  <button
                                    type="button"
                                    role="radio"
                                    key={choice}
                                    aria-checked={shown === choice}
                                    disabled={!can || busy}
                                    onClick={() => shown !== choice && void set(tool.key, choice)}
                                    className={cn(
                                      "h-6 rounded px-2 text-xs whitespace-nowrap",
                                      shown === choice
                                        ? cn(
                                            "bg-background font-medium shadow-xs",
                                            choice === "off" && "text-destructive",
                                          )
                                        : "text-muted-foreground",
                                    )}
                                  >
                                    {p.effects[choice]}
                                  </button>
                                ))}
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                  </TableBody>
                </Table>
              </div>
            ),
          )}
        </div>
      </Card>
      <Card className="self-start overflow-hidden">
        <CardHeader>
          <CardTitle>{p.reachTitle}</CardTitle>
          <CardDescription>{p.reachLead}</CardDescription>
        </CardHeader>
        <Table>
          <TableBody>
            {[
              { id: "everyone", name: p.everyAgent, scope: data.scopes.everyone },
              ...data.scopes.agents,
            ].map((agent) => (
              <TableRow key={agent.id}>
                <TableCell className={cn(agent.id === "everyone" && "font-medium")}>
                  {agent.name}
                </TableCell>
                <TableCell className="whitespace-normal text-right">
                  {agent.scope ? (
                    limited(agent.scope).map((what) => (
                      <Badge key={what} variant="warn" className="ml-1">
                        {p.limits[what]}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {agent.id === "everyone" ? p.everything : p.asEveryAgent}
                    </span>
                  )}
                </TableCell>
                <TableCell className="w-px">
                  {can && (
                    <Button size="sm" variant="outline" onClick={() => setEditing(agent)}>
                      {p.edit}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      {editing && (
        <ScopeDialog
          agent={editing}
          page={data}
          onClose={(changed) => {
            setEditing(null);
            if (changed) void reload();
          }}
        />
      )}
    </div>
  );
}

function ScopeDialog({
  agent,
  page,
  onClose,
}: {
  agent: { id: string; name: string; scope: Scope | null };
  page: Page;
  onClose(changed: boolean): void;
}) {
  const { t } = useI18n();
  const p = t.system.policy;
  const { run, busy, error } = useAction();
  const [scope, setScope] = useState<Scope>(agent.scope ?? OPEN);
  const [sites, setSites] = useState(scope.web === "all" ? "" : scope.web.join("\n"));
  const save = (value: Scope | null) =>
    run(async () => {
      await api(`/api/policies/scopes/${agent.id}`, { method: "PUT", body: { scope: value } });
      onClose(true);
    });
  /** One of the two lists that are "all" or a pick. */
  const pick = (
    field: "knowledge" | "connectors",
    label: string,
    options: { id: string; name: string }[],
  ) =>
    options.length > 0 && (
      <fieldset className="grid gap-1.5">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={scope[field] !== "all"}
            onChange={(event) => setScope({ ...scope, [field]: event.target.checked ? [] : "all" })}
          />
          {label}
        </label>
        {scope[field] !== "all" && (
          <div className="grid gap-1 pl-6">
            {options.map((option) => {
              const chosen = scope[field] as string[];
              return (
                <label key={option.id} className="flex items-center gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    checked={chosen.includes(option.id)}
                    onChange={(event) =>
                      setScope({
                        ...scope,
                        [field]: event.target.checked
                          ? [...chosen, option.id]
                          : chosen.filter((id) => id !== option.id),
                      })
                    }
                  />
                  {option.name}
                </label>
              );
            })}
          </div>
        )}
      </fieldset>
    );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose(false)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{p.reachOf(agent.name)}</DialogTitle>
          <DialogDescription>{p.reachHint}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          {(["files", "mail"] as const).map((field) => (
            <label key={field} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={scope[field]}
                onChange={(event) => setScope({ ...scope, [field]: event.target.checked })}
              />
              {p.may[field]}
            </label>
          ))}
          <fieldset className="grid gap-1.5">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={scope.web !== "all"}
                onChange={(event) =>
                  setScope({ ...scope, web: event.target.checked ? hostsOf(sites) : "all" })
                }
              />
              {p.onlySites}
              <Hint>{p.sitesHint}</Hint>
            </label>
            {scope.web !== "all" && (
              <div className="grid gap-1 pl-6">
                <Label className="sr-only">{p.onlySites}</Label>
                <Textarea
                  rows={3}
                  className="font-mono text-[13px]"
                  placeholder="example.com"
                  value={sites}
                  onChange={(event) => {
                    setSites(event.target.value);
                    setScope({ ...scope, web: hostsOf(event.target.value) });
                  }}
                />
              </div>
            )}
          </fieldset>
          {pick("knowledge", p.onlyBases, page.bases)}
          {pick(
            "connectors",
            p.onlyConnectors,
            page.connectors.map((connector) => ({ id: connector.key, name: connector.name })),
          )}
          {error && <Notice tone="bad">{error}</Notice>}
        </div>
        <DialogFooter>
          {agent.scope && (
            <Button variant="ghost" disabled={busy} onClick={() => void save(null)}>
              {p.noLimits}
            </Button>
          )}
          <Button disabled={busy} onClick={() => void save(scope)}>
            {t.common.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
