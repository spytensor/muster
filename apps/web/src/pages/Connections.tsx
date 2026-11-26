import { useConfirm } from "@/components/confirm";
import { MoreMenu } from "@/components/more";
import { Dot, Empty, Loading, Notice, Person, useAction, useLoad } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
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
import { api, type Me } from "@/lib/api";
import { CompanyConnectors } from "./CompanyConnectors";
import { Lead } from "@/components/ui/hint";
import { CodeHostCard } from "./CodeHostCard";
import { TrackerCard } from "./TrackerCard";

interface Connected {
  services: { id: "microsoft"; available: boolean; scopes: string[] }[];
  people: {
    userId: string;
    name: string;
    email: string;
    provider: string;
    account: string;
    since: string;
  }[];
}

/**
 * What outside services agents can read for people here, and who has let them. An
 * administrator sees every connection and can end one; what a connection reads is the
 * person's own and is never shown here.
 */
export function ConnectionsPage({ me }: { me: Me }) {
  const { t, dateTime, ago } = useI18n();
  const c = t.connections;
  const { data, error, reload } = useLoad(() => api<Connected>("/api/connections"));
  // Which services of the person's-own kind are switched off for the whole company.
  const company = useLoad(() =>
    api<{ off: string[]; sending: string[] }>("/api/company-connectors"),
  );
  const action = useAction();
  const { confirm, dialog } = useConfirm();
  const canManage = me.permissions.includes("members.manage");
  const canSet = me.permissions.includes("settings.manage");
  const off = company.data?.off.includes("microsoft") ?? false;
  const switchMicrosoft = async () => {
    if (!off && !(await confirm(c.switchOff, c.switchOffConfirm))) return;
    await action.run(async () => {
      await api("/api/company-connectors/services/microsoft", {
        method: "PUT",
        body: { off: !off },
      });
      await company.reload();
    });
  };
  const sending = company.data?.sending.includes("microsoft") ?? false;
  // Letting mail leave the company and stopping it are both asked about first.
  const switchSending = async () => {
    if (
      !(await confirm(
        sending ? c.stopSending : c.allowSending,
        sending ? c.stopSendingConfirm : c.allowSendingConfirm,
      ))
    )
      return;
    await action.run(async () => {
      await api("/api/company-connectors/services/microsoft", {
        method: "PUT",
        body: { sending: !sending },
      });
      await company.reload();
    });
  };
  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <Loading />;
  const microsoft = data.services.find((service) => service.id === "microsoft");
  const disconnect = async (person: Connected["people"][number]) => {
    if (!(await confirm(c.disconnect, c.disconnectConfirm(person.name || person.email)))) return;
    await action.run(async () => {
      try {
        await api(`/api/connections/${person.userId}/microsoft`, { method: "DELETE" });
      } finally {
        // Whatever happened, the list is shown as it now is.
        await reload();
      }
    });
  };
  return (
    <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_24rem]">
      <div className="xl:col-span-2">
        <CompanyConnectors canManage={canSet} />
      </div>
      {/* Two columns, each its own stack: a short card leaves no hole beside a long one. */}
      <div className="grid gap-3">
        <Card className="overflow-hidden pb-0 dense:pb-0">
          <CardHeader>
            <CardTitle>{c.peopleTitle}</CardTitle>
            <CardDescription>{c.peopleLead}</CardDescription>
          </CardHeader>
          {action.error && (
            <div className="px-3.5">
              <Notice tone="bad">{action.error}</Notice>
            </div>
          )}
          {data.people.length === 0 ? (
            <Empty>{c.nobody}</Empty>
          ) : (
            <Table pinLast>
              <TableHeader>
                <TableRow>
                  <TableHead>{c.columns.person}</TableHead>
                  <TableHead>{c.columns.service}</TableHead>
                  <TableHead>{c.columns.account}</TableHead>
                  <TableHead>{c.columns.since}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.people.map((person) => (
                  <TableRow key={`${person.userId}:${person.provider}`}>
                    <TableCell>
                      <Person name={person.name} email={person.email} />
                    </TableCell>
                    <TableCell>Microsoft 365</TableCell>
                    <TableCell className="font-mono text-[13px]">
                      {person.account}
                      {/* A mailbox that is not the person's own work address is worth a second look. */}
                      {person.account.toLowerCase() !== person.email.toLowerCase() && (
                        <Badge variant="warn" className="ml-2 font-sans">
                          {c.otherAccount}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell title={dateTime(person.since)}>{ago(person.since)}</TableCell>
                    <TableCell className="text-right">
                      {canManage && (
                        <MoreMenu
                          label={t.members.manage(person.name || person.email)}
                          items={[
                            {
                              label: c.disconnect,
                              destructive: true,
                              onSelect: () => void disconnect(person),
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
        </Card>
        <TrackerCard canManage={canSet} />
      </div>
      <div className="grid gap-3">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span className="flex-1">Microsoft 365</span>
              {canSet && (
                <MoreMenu
                  label={t.common.more}
                  items={[
                    ...(off
                      ? []
                      : [
                          sending
                            ? {
                                label: c.stopSending,
                                destructive: true,
                                onSelect: () => void switchSending(),
                              }
                            : { label: c.allowSending, onSelect: () => void switchSending() },
                        ]),
                    off
                      ? { label: c.switchOn, onSelect: () => void switchMicrosoft() }
                      : {
                          label: c.switchOff,
                          destructive: true,
                          onSelect: () => void switchMicrosoft(),
                        },
                  ]}
                />
              )}
            </CardTitle>
            <CardDescription>{c.microsoftLead}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
              {off ? (
                <Badge variant="warn">{c.switchedOff}</Badge>
              ) : microsoft?.available ? (
                <Badge variant="ok">
                  <Dot />
                  {c.available}
                </Badge>
              ) : (
                <Badge variant="muted">{c.unavailable}</Badge>
              )}
              <Lead as="span" className="text-muted-foreground">
                {off
                  ? c.switchedOffLead
                  : microsoft?.available
                    ? c.connected(data.people.length)
                    : c.unavailableLead}
              </Lead>
            </div>
            {microsoft?.available && !off && (
              <div className="grid gap-1.5 border-t pt-3">
                <div className="flex items-center gap-3">
                  <span className="text-xs font-medium text-muted-foreground">{c.sending}</span>
                  <Badge variant={sending ? "ok" : "muted"}>
                    {sending && <Dot />}
                    {sending ? c.sendingOn : c.sendingOff}
                  </Badge>
                </div>
                <Lead className="text-xs text-muted-foreground">{c.sendingLead}</Lead>
              </div>
            )}
            {microsoft?.available && (
              <div className="grid gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">{c.asks}</span>
                <div className="flex flex-wrap gap-1.5">
                  {microsoft.scopes
                    .filter((scope) => scope !== "offline_access")
                    .map((scope) => (
                      <span
                        key={scope}
                        title={c.scope[scope]}
                        className="rounded-md border bg-muted/40 px-2 py-0.5 font-mono text-xs"
                      >
                        {scope}
                      </span>
                    ))}
                </div>
                <Lead as="span" className="text-xs text-muted-foreground">
                  {c.readOnly}
                </Lead>
              </div>
            )}
          </CardContent>
        </Card>
        <CodeHostCard canManage={canSet} />
      </div>
      {dialog}
    </div>
  );
}
