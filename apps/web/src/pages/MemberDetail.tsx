import { type ReactNode, useState } from "react";
import { useConfirm } from "@/components/confirm";
import { MoreMenu } from "@/components/more";
import { Avatar, Dot, Loading, Notice, RoleBadge, useAction, useLoad } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Lead } from "@/components/ui/hint";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useI18n } from "@/i18n";
import { api, type Me, type Member } from "@/lib/api";
import { go } from "../App";
import { EraseMemberDialog } from "./EraseMember";

/** Everything the organization holds about one person. See GET /api/members/:id. */
interface Profile {
  member: Member & { signIn: string[] };
  sessions:
    | {
        id: string;
        provider: string;
        kind: string;
        lastSeenAt: string;
        ip: string | null;
        userAgent: string | null;
      }[]
    | null;
  connections: { provider: string; account: string; since: string }[];
  /** Which parts of their profile they have set, by name. What they say is theirs alone. */
  profile?: string[];
  usage: {
    runs: number;
    failed: number;
    blocked: number;
    tokens: number;
    costMicros: number;
    lastRunAt: string | null;
    byAgent: { name: string; runs: number; costMicros: number }[];
  };
  agents: { id: string; name: string; state: string; risk: string }[];
  holds: { conversations: number; files: number; fileBytes: number; documents: number };
  approvals: { pending: number; approved: number; rejected: number; expired: number };
  runs: { traceId: string; agent: string; status: string; startedAt: string; ms: number }[] | null;
  events: { time: string; actorEmail: string; action: string }[] | null;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-2">
      <h3 className="section-title">{title}</h3>
      {children}
    </section>
  );
}
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-3 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}
function Figure({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg bg-muted/50 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="num text-lg font-semibold">{value}</div>
    </div>
  );
}

/**
 * One person, in full, for those who run the organization: who they are and how they
 * sign in, where they are signed in, what they connected, what their agents did and
 * cost, what they keep, and what was done to their membership. What they said to an
 * agent is not here.
 */
export function MemberDetail({
  me,
  id,
  onClose,
  onAct,
}: {
  me: Me;
  id: string;
  onClose(): void;
  /** Hands an action on this person to the page, which asks and then reloads. */
  onAct(kind: "edit" | "suspend" | "reactivate" | "remove" | "restore", member: Member): void;
}) {
  const { t, ago, date, dateTime, number, money } = useI18n();
  const d = t.members.detail;
  const { data, error, reload } = useLoad(() => api<Profile>(`/api/members/${id}`), [id]);
  const end = useAction();
  const asking = useConfirm();
  const [erasing, setErasing] = useState(false);
  const m = data?.member;
  const self = m?.id === me.user.id;
  const manageable =
    m &&
    !self &&
    me.permissions.includes("members.manage") &&
    (me.role === "owner" || !["owner", "admin"].includes(m.role));
  const canEnd = me.permissions.includes("sessions.revoke");
  const most = Math.max(1, ...(data?.usage.byAgent.map((row) => row.runs) ?? []));
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="gap-0 overflow-y-auto sm:max-w-2xl">
        <SheetHeader className="border-b">
          {m ? (
            <div className="flex items-center gap-3">
              <Avatar name={m.name} email={m.email} className="size-11 text-sm" />
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <SheetTitle>{m.name || m.email}</SheetTitle>
                  <RoleBadge role={m.role} />
                  <Badge
                    variant={
                      m.status === "active"
                        ? "ok"
                        : m.status === "suspended"
                          ? "destructive"
                          : "muted"
                    }
                  >
                    <Dot />
                    {t.status[m.status]}
                  </Badge>
                </div>
                <SheetDescription className="truncate">{m.email}</SheetDescription>
              </div>
            </div>
          ) : (
            <SheetTitle>{t.members.columns.member}</SheetTitle>
          )}
        </SheetHeader>
        {error ? (
          <div className="p-3.5">
            <Notice tone="bad">{error}</Notice>
          </div>
        ) : !data || !m ? (
          <Loading />
        ) : (
          <div className="grid gap-3 p-3.5">
            {manageable && (
              <div className="flex flex-wrap gap-2">
                {m.status === "removed" ? (
                  <>
                    <Button size="sm" onClick={() => onAct("restore", m)}>
                      {t.members.restore}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-destructive"
                      onClick={() => setErasing(true)}
                    >
                      {t.members.eraseData}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button size="sm" variant="outline" onClick={() => onAct("edit", m)}>
                      {t.members.edit}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onAct(m.status === "active" ? "suspend" : "reactivate", m)}
                    >
                      {m.status === "active" ? t.members.suspend : t.members.reactivate}
                    </Button>
                    <MoreMenu
                      label={t.members.manage(m.email)}
                      items={[
                        {
                          label: t.members.removeFromOrg,
                          destructive: true,
                          onSelect: () => onAct("remove", m),
                        },
                      ]}
                    />
                  </>
                )}
              </div>
            )}

            <Section title={d.identity}>
              <dl className="grid gap-1.5">
                <Fact label={t.members.columns.department}>
                  {m.departmentName ?? t.common.unassigned}
                </Fact>
                <Fact label={t.members.columns.joined}>
                  {date(m.joinedAt)} · {t.joinedVia[m.joinedVia]}
                </Fact>
                <Fact label={d.signsInWith}>
                  {m.signIn.length
                    ? m.signIn.map((provider) => t.providers[provider] ?? provider).join(", ")
                    : d.neverSignedIn}
                </Fact>
                <Fact label={t.members.columns.lastLogin}>{ago(m.lastLoginAt)}</Fact>
              </dl>
            </Section>

            <Section title={d.usage}>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Figure label={d.runs} value={number(data.usage.runs)} />
                <Figure label={d.cost} value={money(data.usage.costMicros)} />
                <Figure label={d.tokens} value={number(data.usage.tokens)} />
                <Figure
                  label={d.failedBlocked}
                  value={`${number(data.usage.failed)} · ${number(data.usage.blocked)}`}
                />
              </div>
              {data.usage.byAgent.length > 0 ? (
                <ul className="grid gap-1.5 pt-1">
                  {data.usage.byAgent.map((row) => (
                    <li
                      key={row.name}
                      className="grid grid-cols-[10rem_1fr_auto] items-center gap-3 text-sm"
                    >
                      <span className="truncate">{row.name}</span>
                      <span
                        className="h-1.5 overflow-hidden rounded-full bg-muted"
                        aria-hidden="true"
                      >
                        <span
                          className="block h-full rounded-full bg-brand"
                          style={{ width: `${(row.runs / most) * 100}%` }}
                        />
                      </span>
                      <span className="num text-muted-foreground">
                        {d.runsCount(number(row.runs))} · {money(row.costMicros)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">{d.noRuns}</p>
              )}
            </Section>

            {data.runs && data.runs.length > 0 && (
              <Section title={d.recentRuns}>
                <ul className="divide-y rounded-lg border">
                  {data.runs.map((run) => (
                    <li key={run.traceId}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-3 px-3 py-1.5 text-left text-sm hover:bg-accent"
                        onClick={() => go(`traces/t/${run.traceId}`)}
                      >
                        <span className="w-32 shrink-0 text-muted-foreground">
                          {dateTime(run.startedAt)}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{run.agent}</span>
                        <Badge
                          variant={
                            run.status === "ok"
                              ? "ok"
                              : run.status === "error"
                                ? "destructive"
                                : run.status === "stopped"
                                  ? "muted"
                                  : "warn"
                          }
                        >
                          {t.runStatus[run.status] ?? run.status}
                        </Badge>
                      </button>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            <Section title={d.holds}>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Figure label={d.conversations} value={number(data.holds.conversations)} />
                <Figure label={d.documents} value={number(data.holds.documents)} />
                <Figure label={d.files} value={number(data.holds.files)} />
                <Figure label={d.storage} value={t.files.size(data.holds.fileBytes)} />
              </div>
              <Lead className="text-xs text-muted-foreground">{d.holdsNote}</Lead>
            </Section>

            <Section title={d.agents(data.agents.length)}>
              {data.agents.length === 0 ? (
                <p className="text-sm text-muted-foreground">{d.noAgents}</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {data.agents.map((agent) => (
                    <span
                      key={agent.id}
                      className="rounded-full border bg-muted/40 px-2.5 py-0.5 text-xs"
                    >
                      {agent.name}
                      <span className="text-muted-foreground">
                        {" "}
                        · {agent.risk} · {t.agents.state[agent.state] ?? agent.state}
                      </span>
                    </span>
                  ))}
                </div>
              )}
            </Section>

            <Section title={d.connections}>
              {data.connections.length === 0 ? (
                <p className="text-sm text-muted-foreground">{d.noConnections}</p>
              ) : (
                <dl className="grid gap-1.5">
                  {data.connections.map((connection) => (
                    <Fact key={connection.provider} label="Microsoft 365">
                      <span className="font-mono text-[13px]">{connection.account}</span>
                      <span className="text-muted-foreground"> · {ago(connection.since)}</span>
                    </Fact>
                  ))}
                </dl>
              )}
            </Section>

            <Section title={d.profile}>
              <Lead className="text-sm text-muted-foreground">{d.profileLead}</Lead>
              {(data.profile ?? []).length === 0 ? (
                <p className="pt-1 text-sm">{d.profileNone}</p>
              ) : (
                <div className="flex flex-wrap gap-1.5 pt-1.5">
                  {(data.profile ?? []).map((field) => (
                    <Badge key={field} variant="muted">
                      {d.profileFields[field] ?? field}
                    </Badge>
                  ))}
                </div>
              )}
            </Section>

            <Section title={d.approvals}>
              <p className="text-sm">
                {d.approvalsLine(
                  data.approvals.pending,
                  data.approvals.approved,
                  data.approvals.rejected,
                  data.approvals.expired,
                )}
              </p>
            </Section>

            {data.sessions && (
              <Section title={d.sessions(data.sessions.length)}>
                {end.error && <Notice tone="bad">{end.error}</Notice>}
                {data.sessions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{d.noSessions}</p>
                ) : (
                  <ul className="divide-y rounded-lg border">
                    {data.sessions.map((session) => (
                      <li key={session.id} className="flex items-center gap-3 px-3 py-1.5 text-sm">
                        <span className="min-w-0 flex-1 truncate">
                          {t.providers[session.provider] ?? session.provider}
                          <span className="text-muted-foreground">
                            {" "}
                            · {session.ip ?? t.common.unknown} · {ago(session.lastSeenAt)}
                          </span>
                        </span>
                        {canEnd &&
                          !self &&
                          (me.role === "owner" || !["owner", "admin"].includes(m.role)) && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={end.busy}
                              onClick={() =>
                                void asking
                                  .confirm(t.security.end, t.security.endConfirm(m.name || m.email))
                                  .then((yes) =>
                                    yes
                                      ? end.run(async () => {
                                          await api(`/api/sessions/${session.id}`, {
                                            method: "DELETE",
                                          });
                                          await reload();
                                        })
                                      : undefined,
                                  )
                              }
                            >
                              {t.security.end}
                            </Button>
                          )}
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            )}

            {data.events && data.events.length > 0 && (
              <Section title={d.history}>
                <ul className="grid gap-1 text-sm">
                  {data.events.map((event, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list read once
                    <li key={index} className="flex gap-3">
                      <span className="w-32 shrink-0 text-muted-foreground">
                        {dateTime(event.time)}
                      </span>
                      <span className="min-w-0 flex-1">
                        {t.events[event.action] ?? event.action}
                        <span className="text-muted-foreground"> · {event.actorEmail}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
          </div>
        )}
        {asking.dialog}
        {erasing && m && (
          <EraseMemberDialog
            id={m.id}
            onClose={(erased) => {
              setErasing(false);
              if (erased) void reload();
            }}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
