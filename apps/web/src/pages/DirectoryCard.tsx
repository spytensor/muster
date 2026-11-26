import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { useConfirm } from "@/components/confirm";
import { MoreMenu } from "@/components/more";
import { Dot, Notice, useAction, useLoad } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useI18n } from "@/i18n";
import { api } from "@/lib/api";
import { Copyable } from "./Sso";

const KINDS = ["feishu", "lark", "wecom", "dingtalk"] as const;
type Kind = (typeof KINDS)[number];

interface Reading {
  problem?: { reason: string; hint: string };
  people: number;
  departments: number;
  added: number;
  linked: number;
  suspended: number;
  restored: number;
  skipped: number;
  held: number;
}
interface Directory {
  directory: {
    kind: Kind;
    appId: string;
    agentId: string | null;
    secretTail: string;
    enabled: boolean;
    /** Someone has got in through it as it is set now. */
    verified: boolean;
    redirectUrl: string;
    syncedAt: string | null;
    sync: Reading | null;
    /** Why the last try from this page did not work, until one does. */
    tried: { reason: string; hint: string } | null;
  } | null;
  owner: boolean;
  redirectUrls: Record<Kind, string>;
}

/**
 * The company's directory at Feishu, WeCom or DingTalk: its people sign in with the
 * account they have there, and who is in the organization follows it.
 */
export function DirectoryCard({ canManage }: { canManage: boolean }) {
  const { t, ago } = useI18n();
  const s = t.directory;
  const { data, error, reload } = useLoad(() => api<Directory>("/api/settings/directory"));
  const action = useAction();
  const asking = useConfirm();
  const [setting, setSetting] = useState(false);
  const [kind, setKind] = useState<Kind>("feishu");
  const [appId, setAppId] = useState("");
  const [secret, setSecret] = useState("");
  const [agentId, setAgentId] = useState("");
  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return null;
  const { directory } = data;
  const owner = canManage && data.owner;
  const open = () => {
    setKind(directory?.kind ?? "feishu");
    setAppId(directory?.appId ?? "");
    setAgentId(directory?.agentId ?? "");
    setSecret("");
    setSetting(true);
  };
  // The secret may be left out only while the application stays the one already held.
  const same = directory?.kind === kind && directory.appId === appId.trim();
  const ready = appId.trim() && (secret.trim() || same) && (kind !== "wecom" || agentId.trim());
  const save = () =>
    action.run(async () => {
      await api("/api/settings/directory", {
        method: "PUT",
        body: {
          kind,
          appId: appId.trim(),
          ...(secret.trim() ? { secret: secret.trim() } : {}),
          ...(kind === "wecom" ? { agentId: agentId.trim() } : {}),
        },
      });
      setSetting(false);
      await reload();
    });
  const reading = directory?.sync;
  const hostOf = (url: string) => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  };
  /** What kept a try or a reading from working, with what the service named. */
  const problem = (one: { reason: string; hint: string }) => (
    <Notice tone="bad">
      {s.problems[one.reason] ?? s.problems.unreachable}
      {one.hint && <span className="mt-1 block font-mono text-xs break-all">{one.hint}</span>}
    </Notice>
  );
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{s.title}</CardTitle>
          {owner && (
            <CardAction>
              {directory ? (
                <MoreMenu
                  label={t.common.more}
                  items={[
                    { label: t.sso.change, onSelect: open },
                    {
                      label: t.sso.remove,
                      destructive: true,
                      onSelect: () =>
                        void asking.confirm(t.sso.remove, s.removeConfirm).then((yes) =>
                          yes
                            ? action.run(async () => {
                                await api("/api/settings/directory", { method: "DELETE" });
                                await reload();
                              })
                            : undefined,
                        ),
                    },
                  ]}
                />
              ) : (
                <Button size="sm" variant="outline" onClick={open}>
                  {t.sso.setUp}
                </Button>
              )}
            </CardAction>
          )}
        </CardHeader>
        <CardContent className="grid gap-3">
          {action.error && !setting && <Notice tone="bad">{action.error}</Notice>}
          {directory ? (
            <>
              <div className="flex items-center justify-between gap-3 rounded-lg border px-2.5 py-1.5">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                  <span className="font-medium">{s.kinds[directory.kind]}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {directory.appId}
                  </span>
                  {directory.enabled && reading && !reading.problem && (
                    <span className="text-xs text-muted-foreground">
                      {s.read(
                        reading.people,
                        reading.departments,
                        directory.syncedAt ? ago(directory.syncedAt) : "",
                      )}
                    </span>
                  )}
                </div>
                <Badge variant={directory.enabled ? "ok" : directory.verified ? "muted" : "warn"}>
                  <Dot />
                  {directory.enabled ? t.sso.on : directory.verified ? t.sso.tried : t.sso.untried}
                </Badge>
              </div>
              {directory.tried && problem(directory.tried)}
              {directory.enabled && reading?.problem && problem(reading.problem)}
              {directory.enabled && !!reading?.held && (
                <Notice tone="bad">
                  {s.held(reading.held)}
                  {owner && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-2 flex"
                      disabled={action.busy}
                      onClick={() =>
                        void asking
                          .confirm(s.suspend(reading.held), s.suspendConfirm(reading.held))
                          .then((yes) =>
                            yes
                              ? action.run(async () => {
                                  await api("/api/settings/directory/sync", {
                                    method: "POST",
                                    body: { confirm: true },
                                  });
                                  await reload();
                                })
                              : undefined,
                          )
                      }
                    >
                      {s.suspend(reading.held)}
                    </Button>
                  )}
                </Notice>
              )}
              {directory.enabled && !!reading?.skipped && (
                <p className="text-xs text-muted-foreground">{s.skipped(reading.skipped)}</p>
              )}
              {canManage && (directory.enabled || owner) && (
                <div className="flex flex-wrap gap-2">
                  {/* Signs this person in at the directory and makes that account theirs. */}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(async () => {
                        const { url } = await api<{ url: string }>("/api/settings/directory/try", {
                          method: "POST",
                        });
                        location.assign(url);
                      })
                    }
                  >
                    {directory.enabled ? t.sso.connect : t.sso.tryIt}
                  </Button>
                  {directory.enabled && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(async () => {
                          await api("/api/settings/directory/sync", { method: "POST", body: {} });
                          await reload();
                        })
                      }
                    >
                      <RefreshCwIcon />
                      {s.syncNow}
                    </Button>
                  )}
                  {owner && (
                    <Button
                      size="sm"
                      disabled={action.busy || (!directory.enabled && !directory.verified)}
                      title={!directory.enabled && !directory.verified ? t.sso.tryFirst : undefined}
                      onClick={() =>
                        void asking
                          .confirm(
                            directory.enabled ? t.sso.switchOff : t.sso.switchOn,
                            directory.enabled
                              ? t.sso.switchOffConfirm
                              : s.switchOnConfirm(s.kinds[directory.kind] ?? ""),
                          )
                          .then((yes) =>
                            yes
                              ? action.run(async () => {
                                  await api("/api/settings/directory/enabled", {
                                    method: "PUT",
                                    body: { on: !directory.enabled },
                                  });
                                  await reload();
                                })
                              : undefined,
                          )
                      }
                    >
                      {directory.enabled ? t.sso.switchOff : t.sso.switchOn}
                    </Button>
                  )}
                </div>
              )}
              <Copyable label={s.redirectUrl} value={directory.redirectUrl} />
              {directory.kind === "wecom" && (
                <Copyable label={s.trustedDomain} value={hostOf(directory.redirectUrl)} />
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{s.none}</p>
          )}
        </CardContent>
      </Card>

      <Dialog open={setting} onOpenChange={setSetting}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{s.title}</DialogTitle>
            <DialogDescription>{s.setUpLead}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Tabs value={kind} onValueChange={(value) => setKind(value as Kind)}>
              <TabsList>
                {KINDS.map((one) => (
                  <TabsTrigger key={one} value={one}>
                    {s.kinds[one]}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <div className="grid gap-1.5">
              <Label htmlFor="directory-app">{s.appId[kind]}</Label>
              <Input
                id="directory-app"
                className="font-mono"
                autoComplete="off"
                value={appId}
                onChange={(event) => setAppId(event.target.value)}
              />
            </div>
            {kind === "wecom" && (
              <div className="grid gap-1.5">
                <Label htmlFor="directory-agent">{s.agentId}</Label>
                <Input
                  id="directory-agent"
                  className="font-mono"
                  autoComplete="off"
                  value={agentId}
                  onChange={(event) => setAgentId(event.target.value)}
                />
              </div>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="directory-secret">{s.secret}</Label>
              <Input
                id="directory-secret"
                type="password"
                className="font-mono"
                autoComplete="off"
                placeholder={same && directory ? `…${directory.secretTail}` : undefined}
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
              />
            </div>
            <Copyable label={s.redirectUrl} value={data.redirectUrls[kind]} />
            {kind === "wecom" && (
              <Copyable label={s.trustedDomain} value={hostOf(data.redirectUrls[kind])} />
            )}
            {directory?.enabled && !same && <Notice>{s.changeOff}</Notice>}
            {action.error && <Notice tone="bad">{action.error}</Notice>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSetting(false)}>
              {t.common.cancel}
            </Button>
            <Button disabled={action.busy || !ready} onClick={() => void save()}>
              {t.common.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {asking.dialog}
    </>
  );
}
