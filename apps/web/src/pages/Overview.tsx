import { ArrowRightIcon } from "lucide-react";
import { useState } from "react";
import { go } from "@/App";
import {
  BarList,
  ChartCard,
  Heatmap,
  SERIES,
  SegmentedBar,
  TimeArea,
  TimeBars,
  TimeLines,
} from "@/components/charts";
import { Empty, Kpi, Loading, Notice, useLoad } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useI18n } from "@/i18n";
import { type AdminEvent, api, type Dashboard, type Me, type Risk, type Role } from "@/lib/api";
import { eventSummary, eventTarget } from "@/lib/events";
import { ROLE_ORDER } from "@/pages/Members";

const RANGES = ["24h", "7d", "30d", "90d"] as const;
/** Runs that ended without finishing: grey, since nothing went wrong and nothing was done. */
const STOPPED = "var(--chart-axis)";
const change = (now: number, before: number) => (before > 0 ? (now - before) / before : null);

export function OverviewPage({ me }: { me: Me }) {
  const i18n = useI18n();
  const { t, number, compact, money, duration, percent, ago } = i18n;
  const [range, setRange] = useState<(typeof RANGES)[number]>("30d");
  const { data, error } = useLoad(() => api<Dashboard>(`/api/dashboard?range=${range}`), [range]);
  const canAudit = me.permissions.includes("audit.read");
  const recent = useLoad(
    () => (canAudit ? api<AdminEvent[]>("/api/audit?limit=6") : Promise.resolve([])),
    [canAudit],
  );
  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <Loading />;
  const d = t.dashboard;
  const a = data.activity;
  const people = data.people;
  const roleRows = ROLE_ORDER.map((role) => ({
    key: role,
    label: t.roles[role as Role],
    value: people?.byRole.find((r) => r.key === role)?.value ?? 0,
  }));

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={range} onValueChange={(value) => setRange(value as (typeof RANGES)[number])}>
          <TabsList aria-label={d.periodLabel}>
            {RANGES.map((r) => (
              <TabsTrigger key={r} value={r}>
                {t.ranges[r]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      {!a ? (
        <Notice>{d.noAccess}</Notice>
      ) : a.totals.runs === 0 && a.agents.total === 0 ? (
        <Notice>{d.noActivity}</Notice>
      ) : (
        <>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
            <Kpi
              label={d.runs}
              value={number(a.totals.runs)}
              delta={change(a.totals.runs, a.previous.runs)}
              hint={t.ranges[range]}
            />
            <Kpi
              label={d.successRate}
              // Of the runs that were let finish: one a person stopped did not fail.
              value={
                a.totals.runs - a.totals.stopped > 0
                  ? percent(a.totals.ok / (a.totals.runs - a.totals.stopped))
                  : "–"
              }
              delta={
                a.totals.runs - a.totals.stopped > 0 && a.previous.runs - a.previous.stopped > 0
                  ? a.totals.ok / (a.totals.runs - a.totals.stopped) -
                    a.previous.ok / (a.previous.runs - a.previous.stopped)
                  : null
              }
              hint={d.failures(a.totals.errors)}
            />
            <Kpi
              label={d.median}
              value={duration(a.totals.p50)}
              delta={change(a.totals.p50, a.previous.p50)}
              goodWhenUp={false}
              hint={d.p95(duration(a.totals.p95))}
            />
            <Kpi
              label={d.cost}
              value={money(a.totals.costMicros)}
              delta={change(a.totals.costMicros, a.previous.costMicros)}
              goodWhenUp={false}
              hint={
                a.totals.runs
                  ? d.costPerRun(money(a.totals.costMicros / a.totals.runs, 3))
                  : undefined
              }
            />
            <Kpi
              label={d.activeUsers}
              value={number(a.totals.users)}
              delta={change(a.totals.users, a.previous.users)}
              hint={people ? `${d.members}: ${number(people.members)}` : undefined}
            />
            <Kpi
              label={d.needAttention}
              value={number(a.totals.awaiting + a.totals.blocked)}
              tone={a.totals.awaiting + a.totals.blocked > 0 ? "warn" : undefined}
              hint={d.attentionHint(a.totals.awaiting, a.totals.blocked)}
            />
          </section>

          <section className="grid gap-3 xl:grid-cols-3">
            <ChartCard
              className="xl:col-span-2"
              title={d.runsOverTime}
              lead={d.runsOverTimeLead}
              legend={[
                { key: "ok", label: t.runStatus.ok as string, color: SERIES[0] },
                { key: "error", label: t.runStatus.error as string, color: SERIES[1] },
                { key: "blocked", label: t.runStatus.blocked as string, color: SERIES[2] },
                { key: "stopped", label: t.runStatus.stopped as string, color: STOPPED },
                {
                  key: "awaiting",
                  label: t.runStatus.awaiting_approval as string,
                  color: SERIES[3],
                },
              ]}
            >
              <TimeBars
                data={a.series}
                bucket={data.bucket}
                format={compact}
                series={[
                  { key: "ok", label: t.runStatus.ok as string, color: SERIES[0] },
                  { key: "error", label: t.runStatus.error as string, color: SERIES[1] },
                  { key: "blocked", label: t.runStatus.blocked as string, color: SERIES[2] },
                  { key: "stopped", label: t.runStatus.stopped as string, color: STOPPED },
                  {
                    key: "awaiting",
                    label: t.runStatus.awaiting_approval as string,
                    color: SERIES[3],
                  },
                ]}
              />
            </ChartCard>
            <ChartCard title={d.topAgents} lead={d.topAgentsLead}>
              <BarList
                rows={a.byAgent.map((row) => ({
                  key: row.key,
                  label: row.key,
                  value: row.runs,
                  detail: row.errors ? d.failures(row.errors) : undefined,
                }))}
                format={number}
              />
            </ChartCard>
          </section>

          <section className="grid gap-3 xl:grid-cols-2">
            <ChartCard
              title={d.duration}
              lead={d.durationLead}
              legend={[
                { key: "p50", label: d.p50Label, color: SERIES[0] },
                { key: "p95", label: d.p95Label, color: SERIES[1] },
              ]}
            >
              <TimeLines
                data={a.series.map((row) => ({
                  at: row.at,
                  p50: row.p50 / 1000,
                  p95: row.p95 / 1000,
                }))}
                bucket={data.bucket}
                format={(value) => `${number(Math.round(value * 10) / 10)}s`}
                series={[
                  { key: "p50", label: d.p50Label, color: SERIES[0] },
                  { key: "p95", label: d.p95Label, color: SERIES[1] },
                ]}
              />
            </ChartCard>
            <ChartCard title={d.costOverTime} lead={d.costOverTimeLead}>
              <TimeArea
                data={a.series.map((row) => ({ at: row.at, cost: row.costMicros }))}
                bucket={data.bucket}
                format={(value) => money(value)}
                series={[{ key: "cost", label: d.cost, color: SERIES[0] }]}
              />
            </ChartCard>
          </section>

          <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <ChartCard title={d.levels} lead={d.levelsLead}>
              <BarList
                rows={a.byLevel.map((row) => ({
                  key: row.key,
                  label: `${row.key} · ${t.level[row.key]}`,
                  value: row.value,
                  detail: row.blocked ? d.blockedCount(row.blocked) : undefined,
                }))}
                format={number}
              />
            </ChartCard>
            <ChartCard
              title={d.risk}
              lead={d.riskLead(a.agents.total, a.agents.pending)}
              action={<LinkButton to="agents" label={t.nav.agents} />}
            >
              <BarList
                rows={a.agents.byRisk.map((row) => ({
                  key: row.key,
                  label: `${row.key} · ${t.risk[row.key as Risk]}`,
                  value: row.value,
                }))}
                format={number}
              />
            </ChartCard>
            <ChartCard title={d.tools} lead={d.toolsLead}>
              <BarList
                // The plan an agent shows is not work done with a tool.
                rows={a.byTool
                  .filter((row) => row.key !== "plan.set")
                  .map((row) => ({
                    key: row.key,
                    label: <span className="font-mono text-xs">{row.key}</span>,
                    value: row.calls,
                    detail: row.errors ? d.failures(row.errors) : undefined,
                  }))}
                format={number}
              />
            </ChartCard>
          </section>

          <section className="grid gap-3 md:grid-cols-2">
            <ChartCard
              title={d.byDepartment}
              lead={d.byDepartmentLead}
              action={<LinkButton to="usage" label={t.nav.usage} />}
            >
              <BarList
                rows={a.byDepartment.map((row) => ({
                  key: row.key || "-",
                  label: row.key || t.usage.noDepartment,
                  value: row.costMicros,
                  detail: d.runsCount(number(row.runs)),
                }))}
                format={(value) => money(value)}
              />
            </ChartCard>
            <ChartCard title={d.byModel} lead={d.byModelLead}>
              <SegmentedBar
                parts={a.byModel.slice(0, 4).map((row, index) => ({
                  label: row.key,
                  value: row.costMicros,
                  color: SERIES[index] as string,
                }))}
                format={(value) => money(value)}
              />
            </ChartCard>
          </section>

          <ChartCard title={d.heat} lead={d.heatLead}>
            <Heatmap
              cells={a.heat.map((cell) => ({ row: cell.dow, col: cell.hour, value: cell.value }))}
              rowLabels={d.weekdays}
              title={(row, col, value) => d.heatCell(d.weekdays[row] ?? "", col, value)}
            />
          </ChartCard>
        </>
      )}

      <section className="grid gap-3 xl:grid-cols-3">
        {people && (
          <ChartCard
            title={d.people}
            lead={d.peopleLead}
            action={
              me.permissions.includes("members.read") ? (
                <LinkButton to="members" label={t.nav.members} />
              ) : undefined
            }
          >
            <dl className="grid grid-cols-2 gap-3 text-sm">
              {[
                [d.members, people.members],
                [d.invitations, people.invitations],
                [d.sessions, people.sessions],
                [d.suspended, people.suspended],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border px-2.5 py-1.5">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="text-xl font-semibold tracking-tight">
                    {number(value as number)}
                  </dd>
                </div>
              ))}
            </dl>
            <BarList rows={roleRows} format={number} />
          </ChartCard>
        )}
        <ChartCard
          className="xl:col-span-2"
          title={d.recent}
          lead={d.recentLead}
          action={canAudit ? <LinkButton to="audit" label={d.seeAll} /> : undefined}
        >
          {!recent.data || recent.data.length === 0 ? (
            <Empty>{t.common.noData}</Empty>
          ) : (
            <ul className="-mx-5 grid">
              {recent.data.map((event) => (
                <li
                  key={event.id}
                  className="flex items-baseline gap-3 border-t px-3.5 py-1.5 text-sm first:border-t-0"
                >
                  <span className="w-24 shrink-0 text-xs text-muted-foreground">
                    {ago(event.time)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{t.events[event.action] ?? event.action}</span>
                    {event.targetLabel && (
                      <span className="text-muted-foreground"> · {eventTarget(event)}</span>
                    )}
                    {eventSummary(event, i18n) && (
                      <span className="text-muted-foreground"> · {eventSummary(event, i18n)}</span>
                    )}
                  </span>
                  <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                    {event.actorEmail}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </ChartCard>
      </section>
    </>
  );
}

function LinkButton({ to, label }: { to: string; label: string }) {
  return (
    <Button variant="ghost" size="sm" onClick={() => go(to)}>
      {label}
      <ArrowRightIcon />
    </Button>
  );
}
