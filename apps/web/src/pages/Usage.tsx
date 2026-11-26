import { useState } from "react";
import { ChartCard, SERIES, TimeArea } from "@/components/charts";
import { Empty, Kpi, Loading, Notice, useLoad } from "@/components/shared";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useI18n } from "@/i18n";
import { api, type Dashboard, type Me } from "@/lib/api";
import { BudgetsCard } from "@/pages/Budgets";
import { Lead } from "@/components/ui/hint";

const RANGES = ["24h", "7d", "30d", "90d"] as const;

export function UsagePage({ me }: { me: Me }) {
  const { t, number, compact, money, percent } = useI18n();
  const [range, setRange] = useState<(typeof RANGES)[number]>("30d");
  const { data, error } = useLoad(() => api<Dashboard>(`/api/dashboard?range=${range}`), [range]);
  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <Loading />;
  const a = data.activity;
  const u = t.usage;
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Lead className="text-sm text-muted-foreground">{u.lead}</Lead>
        <Tabs value={range} onValueChange={(value) => setRange(value as (typeof RANGES)[number])}>
          <TabsList>
            {RANGES.map((r) => (
              <TabsTrigger key={r} value={r}>
                {t.ranges[r]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      <BudgetsCard />
      {me.permissions.includes("settings.read") && (
        <a
          href="#/admin/sandbox"
          className="justify-self-start text-[13px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {u.sandbox} →
        </a>
      )}
      {!a || a.totals.runs === 0 ? (
        <Notice>{t.dashboard.noActivity}</Notice>
      ) : (
        <>
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Kpi
              label={u.total}
              value={money(a.totals.costMicros)}
              hint={t.dashboard.costPerRun(money(a.totals.costMicros / a.totals.runs, 3))}
            />
            <Kpi label={u.runs} value={number(a.totals.runs)} />
            <Kpi label={u.tokens} value={compact(a.totals.tokens)} />
            <Kpi label={u.users} value={number(a.totals.users)} />
          </section>
          <ChartCard title={u.daily}>
            <TimeArea
              data={a.series.map((row) => ({ at: row.at, cost: row.costMicros }))}
              bucket={data.bucket}
              format={(value) => money(value)}
              series={[{ key: "cost", label: t.dashboard.cost, color: SERIES[0] }]}
              height={260}
            />
          </ChartCard>
          <section className="grid gap-3 xl:grid-cols-2">
            <Card className="overflow-hidden pb-0 dense:pb-0">
              <CardHeader>
                <CardTitle>{u.byDepartment}</CardTitle>
              </CardHeader>
              <Table pinLast>
                <TableHeader>
                  <TableRow>
                    <TableHead>{u.columns.department}</TableHead>
                    <TableHead className="text-right">{u.columns.people}</TableHead>
                    <TableHead className="text-right">{u.columns.runs}</TableHead>
                    <TableHead className="text-right">{u.columns.cost}</TableHead>
                    <TableHead className="text-right">{u.columns.share}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {a.byDepartment.map((row) => (
                    <TableRow key={row.key || "-"}>
                      <TableCell className={row.key ? "font-medium" : "text-muted-foreground"}>
                        {row.key || u.noDepartment}
                      </TableCell>
                      <TableCell className="num text-right">{number(row.users)}</TableCell>
                      <TableCell className="num text-right">{number(row.runs)}</TableCell>
                      <TableCell className="num text-right">{money(row.costMicros)}</TableCell>
                      <TableCell className="num text-right text-muted-foreground">
                        {percent(row.costMicros / a.totals.costMicros)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
            <Card className="overflow-hidden pb-0 dense:pb-0">
              <CardHeader>
                <CardTitle>{u.byModel}</CardTitle>
              </CardHeader>
              {a.byModel.length === 0 ? (
                <Empty>{t.common.noData}</Empty>
              ) : (
                <Table pinLast>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{u.columns.model}</TableHead>
                      <TableHead className="text-right">{u.columns.calls}</TableHead>
                      <TableHead className="text-right">{u.columns.tokens}</TableHead>
                      <TableHead className="text-right">{u.columns.cost}</TableHead>
                      <TableHead className="text-right">{u.columns.share}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {a.byModel.map((row) => (
                      <TableRow key={row.key}>
                        <TableCell className="font-mono text-xs">{row.key}</TableCell>
                        <TableCell className="num text-right">{number(row.calls)}</TableCell>
                        <TableCell className="num text-right">{compact(row.tokens)}</TableCell>
                        <TableCell className="num text-right">{money(row.costMicros)}</TableCell>
                        <TableCell className="num text-right text-muted-foreground">
                          {percent(row.costMicros / a.totals.costMicros)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Card>
          </section>
        </>
      )}
    </>
  );
}
