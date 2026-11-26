import { useConfirm } from "@/components/confirm";
import { MoreMenu } from "@/components/more";
import { Dot, Loading, Notice, Person, useAction, useLoad } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useI18n } from "@/i18n";
import { api, type Me, type Session, type SignInSettings } from "@/lib/api";
import { device } from "@/lib/events";
import { Lead } from "@/components/ui/hint";
import { DirectoryCard } from "./DirectoryCard";
import { SsoCards } from "./Sso";

export function SecurityPage({ me }: { me: Me }) {
  const { t, ago } = useI18n();
  const settings = useLoad(() => api<SignInSettings>("/api/settings/sign-in"));
  const sessions = useLoad(() => api<Session[]>("/api/sessions"));
  const action = useAction();
  const canRevoke = me.permissions.includes("sessions.revoke");
  const asking = useConfirm();
  const failure = settings.error ?? sessions.error;
  if (failure) return <Notice tone="bad">{failure}</Notice>;
  if (!settings.data || !sessions.data) return <Loading />;
  const enabled = new Set(settings.data.providers.map((p) => p.id));
  // Only what this company signs in with. Ways it does not use are not its concern,
  // and a list of them reads as things left undone.
  const notes: Record<string, string> = {
    google: t.security.googleNote,
    microsoft: t.security.microsoftNote,
    oidc: t.security.oidcNote,
  };
  const inUse = settings.data.providers.filter((provider) => provider.id !== "dev");
  return (
    <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_26rem]">
      <div className="grid min-w-0 gap-3">
        <Card className="overflow-hidden pb-0 dense:pb-0">
          <CardHeader>
            <CardTitle>{t.security.sessionsTitle}</CardTitle>
            <CardDescription>{t.security.sessionsLead(sessions.data.length)}</CardDescription>
          </CardHeader>
          <Table pinLast>
            <TableHeader>
              <TableRow>
                <TableHead>{t.security.sessionColumns.member}</TableHead>
                <TableHead>{t.security.sessionColumns.method}</TableHead>
                <TableHead>{t.security.sessionColumns.device}</TableHead>
                <TableHead>{t.security.sessionColumns.ip}</TableHead>
                <TableHead>{t.security.sessionColumns.seen}</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.data.map((session) => (
                <TableRow key={session.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Person name={session.name} email={session.email} />
                      {session.current && <Badge variant="muted">{t.common.current}</Badge>}
                    </div>
                  </TableCell>
                  <TableCell>{t.providers[session.provider] ?? session.provider}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {device(session.userAgent, t.common.unknown, t.security.otherBrowser)}
                  </TableCell>
                  <TableCell className="num text-muted-foreground">
                    {session.ip ?? t.common.unknown}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{ago(session.lastSeenAt)}</TableCell>
                  <TableCell className="text-right">
                    {canRevoke && !session.current && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={action.busy}
                        onClick={() =>
                          void asking
                            .confirm(
                              t.security.end,
                              t.security.endConfirm(session.name || session.email),
                            )
                            .then((yes) =>
                              yes
                                ? action.run(async () => {
                                    await api(`/api/sessions/${session.id}`, { method: "DELETE" });
                                    await sessions.reload();
                                  })
                                : undefined,
                            )
                        }
                      >
                        {t.security.end}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
        {settings.data.domains.length > 0 && (
          <Card className="overflow-hidden pb-0 dense:pb-0">
            <CardHeader>
              <CardTitle>{t.security.domainsTitle}</CardTitle>
              <CardDescription>{t.security.domainsNow}</CardDescription>
            </CardHeader>
            <Table pinLast>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.security.columns.domain}</TableHead>
                  <TableHead>{t.security.columns.how}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {settings.data.domains.map((rule) => (
                  <TableRow key={rule.domain}>
                    <TableCell className="font-mono text-[13px]">{rule.domain}</TableCell>
                    <TableCell>
                      {rule.autoJoin ? (
                        <Badge variant="warn">{t.security.auto}</Badge>
                      ) : (
                        <Badge variant="muted">{t.security.noAuto}</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {me.permissions.includes("settings.manage") && (
                        <MoreMenu
                          label={t.common.more}
                          items={[
                            {
                              label: t.security.removeDomain,
                              destructive: true,
                              onSelect: () =>
                                void asking
                                  .confirm(
                                    t.security.removeDomain,
                                    t.security.removeDomainConfirm(rule.domain),
                                  )
                                  .then((yes) =>
                                    yes
                                      ? action.run(async () => {
                                          await api(
                                            `/api/settings/sign-in/domains/${encodeURIComponent(rule.domain)}`,
                                            { method: "DELETE" },
                                          );
                                          await settings.reload();
                                        })
                                      : undefined,
                                  ),
                            },
                          ]}
                        />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      </div>
      <div className="grid gap-3">
        <Card>
          <CardHeader>
            <CardTitle>{t.security.providersTitle}</CardTitle>
            <CardDescription>{t.security.providersLead(settings.data.sessionDays)}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {inUse.map((provider) => (
              <div
                key={provider.id}
                className="flex items-center justify-between gap-3 rounded-lg border px-2.5 py-1.5"
              >
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                  <span className="font-medium">
                    {provider.id === "oidc"
                      ? provider.label
                      : (t.providers[provider.id] ?? provider.label)}
                  </span>
                  <span className="text-sm text-muted-foreground">{notes[provider.id]}</span>
                  {provider.directory && (
                    <span className="text-xs text-muted-foreground">
                      {t.security.directory}{" "}
                      <span className="font-mono text-foreground">{provider.directory}</span>
                    </span>
                  )}
                </div>
                <Badge variant="ok">
                  <Dot />
                  {t.security.enabled}
                </Badge>
              </div>
            ))}
            {inUse.length > 0 && (
              <>
                <p className="text-sm">
                  {inUse.some((provider) => provider.admits)
                    ? t.security.whoEnters
                    : t.security.whoEntersInvited}
                </p>
                <Lead className="text-xs text-muted-foreground">{t.security.providersWhere}</Lead>
              </>
            )}
            {enabled.has("dev") && (
              <div>
                <Notice tone="bad" title={t.security.devTitle}>
                  {t.security.devBody}
                </Notice>
              </div>
            )}
          </CardContent>
        </Card>
        {me.permissions.includes("settings.read") && (
          <>
            <DirectoryCard canManage={me.permissions.includes("settings.manage")} />
            <SsoCards canManage={me.permissions.includes("settings.manage")} />
          </>
        )}
      </div>
      {asking.dialog}
    </div>
  );
}
