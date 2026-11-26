import { ArrowRightIcon, CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { go } from "@/App";
import { useConfirm } from "@/components/confirm";
import { MoreMenu } from "@/components/more";
import { Dot, Empty, Loading, Notice, useAction, useLoad } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, NativeSelect } from "@/components/ui/input";
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
import { api, type Me } from "@/lib/api";
import { evidenceOf } from "./alertLinks";
import { cn } from "@/lib/utils";
import { Hint, Lead } from "@/components/ui/hint";

export interface AlertRow {
  id: string;
  rule: string;
  subject: string;
  label: string;
  detail: Record<string, string | number | null>;
  state: "open" | "acknowledged" | "resolved";
  openedAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
}
interface RuleRow {
  rule: string;
  enabled: boolean;
  threshold: number;
  window: number | null;
  comes: { threshold: number; window: number | null };
  min: number;
  max: number;
  available: boolean;
}
interface Delivery {
  url: string | null;
  canSeal: boolean;
  last: {
    status: "pending" | "sent" | "failed";
    said: string;
    attempts: number;
    at: string;
  } | null;
}
interface Settings {
  rules: RuleRow[];
  windows: number[];
  delivery: Delivery;
}

/** What an alert says happened, in the reader's language, from the numbers it was opened with. */
export function useSaid() {
  const { t, money } = useI18n();
  const a = t.alerts;
  return (alert: Pick<AlertRow, "rule" | "subject" | "label" | "detail">): string => {
    const d = alert.detail;
    const n = (key: string) => Number(d[key] ?? 0);
    const window = a.window[n("window")] ?? "";
    switch (alert.rule) {
      case "run_failures":
        return a.said.run_failures({
          errors: n("errors"),
          runs: n("runs"),
          percent: n("percent"),
          window,
        });
      case "blocked_actions":
        return d.who === "agent"
          ? a.said.blocked_agent({
              count: n("count"),
              label: alert.label,
              people: n("people"),
              window,
            })
          : a.said.blocked_person({ count: n("count"), label: alert.label, window });
      case "spend_spike":
        return a.said.spend_spike({
          today: money(n("todayMicros")),
          usual: money(n("usualMicros")),
          times: n("times"),
        });
      case "approval_waiting":
        return a.said.approval_waiting({ label: alert.label, hours: n("hours") });
      case "sandbox_down":
        return a.said.sandbox_down({ minutes: n("minutes") });
      case "model_failing":
        return a.said.model_failing({
          errors: n("errors"),
          calls: n("calls"),
          label: alert.label,
          window,
        });
      default:
        // Raised by another part of the server: what it is, and what it is about if anything.
        return [a.said.raised[alert.rule], alert.label].filter(Boolean).join(" ");
    }
  };
}

function Toggle({
  on,
  label,
  disabled,
  onChange,
}: {
  on: boolean;
  label: string;
  disabled?: boolean;
  onChange(on: boolean): void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50",
        on ? "bg-brand" : "bg-foreground/20",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform",
          on && "translate-x-4",
        )}
      />
    </button>
  );
}

/** What is so now, and what was: each with where to look, and a way to say "I have it". */
function AlertList({ canManage, onChange }: { canManage: boolean; onChange(): void }) {
  const { t, ago, dateTime } = useI18n();
  const a = t.alerts;
  const [tab, setTab] = useState<"open" | "resolved">("open");
  const { data, error, reload } = useLoad(() => api<AlertRow[]>(`/api/alerts?state=${tab}`), [tab]);
  const action = useAction();
  const said = useSaid();
  // The list follows what the server finds, without the page being opened again.
  useEffect(() => {
    const timer = setInterval(() => void reload(), 60_000);
    return () => clearInterval(timer);
  }, [reload]);
  const acknowledge = (alert: AlertRow) =>
    action.run(async () => {
      await api(`/api/alerts/${alert.id}/acknowledge`, { method: "POST" });
      await reload();
      onChange();
    });
  return (
    <Card className="overflow-hidden pb-0 dense:pb-0">
      <CardHeader>
        <CardTitle>{t.nav.alerts}</CardTitle>
        <CardDescription>{a.lead}</CardDescription>
        <Tabs value={tab} onValueChange={(value) => setTab(value as typeof tab)}>
          <TabsList>
            <TabsTrigger value="open">{a.tabs.open}</TabsTrigger>
            <TabsTrigger value="resolved">{a.tabs.resolved}</TabsTrigger>
          </TabsList>
        </Tabs>
      </CardHeader>
      {(error || action.error) && (
        <div className="px-3.5 pb-2">
          <Notice tone="bad">{error ?? action.error}</Notice>
        </div>
      )}
      {!data ? (
        !error && <Loading />
      ) : data.length === 0 ? (
        <Empty>
          {tab === "open" ? (
            <>
              <span className="font-medium text-foreground">{a.none}</span> {a.noneHint}
            </>
          ) : (
            a.noneResolved
          )}
        </Empty>
      ) : (
        <Table pinLast>
          <TableHeader>
            <TableRow>
              <TableHead>{a.columns.what}</TableHead>
              <TableHead>{a.columns.since}</TableHead>
              <TableHead>{tab === "open" ? a.columns.state : a.columns.resolved}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((alert) => (
              <TableRow key={alert.id}>
                <TableCell className="whitespace-normal">
                  <div className="grid max-w-xl gap-0.5">
                    <span className="font-medium">{a.name[alert.rule] ?? alert.rule}</span>
                    <span className="text-[13px] text-muted-foreground">{said(alert)}</span>
                  </div>
                </TableCell>
                <TableCell className="text-[13px]" title={dateTime(alert.openedAt)}>
                  {ago(alert.openedAt)}
                </TableCell>
                <TableCell className="text-[13px]">
                  {alert.state === "resolved" ? (
                    <span title={alert.resolvedAt ? dateTime(alert.resolvedAt) : undefined}>
                      {ago(alert.resolvedAt)}
                    </span>
                  ) : alert.state === "open" ? (
                    <Badge variant="warn">
                      <Dot />
                      {a.state.open}
                    </Badge>
                  ) : (
                    <Badge
                      variant="muted"
                      title={
                        alert.acknowledgedBy ? a.acknowledgedBy(alert.acknowledgedBy) : undefined
                      }
                    >
                      {a.state.acknowledged}
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    {alert.state !== "resolved" && (
                      <Button variant="ghost" size="sm" onClick={() => go(evidenceOf(alert))}>
                        {a.evidence[alert.rule] ?? t.nav.traces}
                        <ArrowRightIcon />
                      </Button>
                    )}
                    {canManage && alert.state === "open" && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={action.busy}
                        onClick={() => void acknowledge(alert)}
                      >
                        {a.acknowledge}
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

/** One rule: what it watches as a sentence with its number in it, and whether it is on. */
function RuleLine({
  rule,
  windows,
  canManage,
  onSaved,
}: {
  rule: RuleRow;
  windows: number[];
  canManage: boolean;
  onSaved(): Promise<void>;
}) {
  const { t } = useI18n();
  const a = t.alerts;
  const words = a.rule[rule.rule];
  const name = a.name[rule.rule] ?? rule.rule;
  const [threshold, setThreshold] = useState(String(rule.threshold));
  const [window, setWindow] = useState(rule.window);
  const action = useAction();
  const amount = Number(threshold);
  const valid = threshold.trim() !== "" && amount >= rule.min && amount <= rule.max;
  const changed = amount !== rule.threshold || window !== rule.window;
  const save = (next: { enabled?: boolean } = {}) =>
    action.run(async () => {
      await api(`/api/alerts/rules/${rule.rule}`, {
        method: "PUT",
        body: {
          enabled: next.enabled ?? rule.enabled,
          // Switching on or off does not carry a number still being typed.
          threshold: next.enabled === undefined ? amount : rule.threshold,
          window: next.enabled === undefined ? window : rule.window,
        },
      });
      await onSaved();
    });
  return (
    // One row: the rule's name, its sentence with what can be changed in it, and its switch.
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-3.5 py-1 first:border-t-0">
      <div className="flex min-h-7 min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
        <span
          className={cn(
            "w-44 shrink-0 truncate text-[13px] font-medium",
            !rule.enabled && "text-muted-foreground",
          )}
          title={name}
        >
          {name}
        </span>
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px]">
          <span>{words?.before}</span>
          <Input
            type="number"
            inputMode="decimal"
            className="h-7 w-16"
            aria-label={a.amount(name)}
            aria-invalid={!valid}
            min={rule.min}
            max={rule.max}
            step={rule.rule === "spend_spike" ? 0.5 : 1}
            value={threshold}
            disabled={!canManage || action.busy}
            onChange={(event) => setThreshold(event.target.value)}
          />
          <span>{words?.after}</span>
          {window !== null && (
            // The words and what they choose stay together: the choice never drops to a
            // line of its own under the sentence.
            <span className="inline-flex items-center gap-2 whitespace-nowrap">
              <Label className="font-normal" htmlFor={`window-${rule.rule}`}>
                {a.over}
              </Label>
              <NativeSelect
                id={`window-${rule.rule}`}
                className="h-7 w-auto shrink-0"
                value={window}
                disabled={!canManage || action.busy}
                onChange={(event) => setWindow(Number(event.target.value))}
              >
                {windows.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {a.window[minutes]}
                  </option>
                ))}
              </NativeSelect>
            </span>
          )}
          {canManage && changed && (
            <Button size="sm" disabled={!valid || action.busy} onClick={() => void save()}>
              {t.common.save}
            </Button>
          )}
        </div>
        {(rule.available ? words?.note : a.noSandbox) && (
          <Hint>{rule.available ? words?.note : a.noSandbox}</Hint>
        )}
        {action.error && <Notice tone="bad">{action.error}</Notice>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-xs text-muted-foreground">{rule.enabled ? a.on : a.off}</span>
        <Toggle
          on={rule.enabled}
          label={rule.enabled ? a.switchOff(name) : a.switchOn(name)}
          disabled={!canManage || action.busy}
          onChange={(enabled) => void save({ enabled })}
        />
      </div>
    </div>
  );
}

/** Where alerts are also sent: one address, its secret shown once, and how the last one went. */
function DeliveryCard({
  delivery,
  canManage,
  reload,
}: {
  delivery: Delivery;
  canManage: boolean;
  reload(): Promise<void>;
}) {
  const { t, ago } = useI18n();
  const a = t.alerts;
  const [url, setUrl] = useState(delivery.url ?? "");
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [tested, setTested] = useState<{ ok: boolean; said: string } | null>(null);
  const action = useAction();
  const { confirm, dialog } = useConfirm();
  const save = (address: string, newSecret = false) =>
    action.run(async () => {
      setTested(null);
      const saved = await api<{ secret: string | null }>("/api/alerts/webhook", {
        method: "PUT",
        body: { url: address, ...(newSecret ? { newSecret: true } : {}) },
      });
      setUrl(address);
      setSecret(saved.secret);
      setCopied(false);
      await reload();
    });
  const host = (() => {
    try {
      return new URL(delivery.url ?? "").host;
    } catch {
      return "";
    }
  })();
  const last = delivery.last;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{a.deliveryTitle}</CardTitle>
        <CardDescription>{a.deliveryLead}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {!delivery.canSeal && !delivery.url ? (
          <Notice>{a.noSeal}</Notice>
        ) : (
          <>
            <div className="grid gap-1.5">
              <Label htmlFor="alert-webhook">{a.webhook}</Label>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id="alert-webhook"
                  type="url"
                  className="min-w-0 flex-1 basis-72 font-mono text-[13px]"
                  placeholder="https://"
                  value={url}
                  disabled={!canManage || action.busy}
                  onChange={(event) => setUrl(event.target.value)}
                />
                {canManage && (
                  <Button
                    size="sm"
                    disabled={action.busy || !url.trim() || url.trim() === delivery.url}
                    onClick={() => void save(url.trim())}
                  >
                    {t.common.save}
                  </Button>
                )}
                {canManage && delivery.url && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(async () => {
                          setTested(
                            await api<{ ok: boolean; said: string }>("/api/alerts/webhook/test", {
                              method: "POST",
                            }),
                          );
                        })
                      }
                    >
                      {a.test}
                    </Button>
                    <MoreMenu
                      label={t.common.more}
                      items={[
                        {
                          label: a.newSecret,
                          onSelect: () =>
                            void confirm(a.newSecret, a.newSecretConfirm).then((yes) =>
                              yes ? save(delivery.url ?? "", true) : undefined,
                            ),
                        },
                        {
                          label: t.common.remove,
                          destructive: true,
                          onSelect: () =>
                            void confirm(t.common.remove, a.removeConfirm(host)).then((yes) =>
                              yes
                                ? action.run(async () => {
                                    await api("/api/alerts/webhook", { method: "DELETE" });
                                    setUrl("");
                                    setSecret(null);
                                    setTested(null);
                                    await reload();
                                  })
                                : undefined,
                            ),
                        },
                      ]}
                    />
                  </>
                )}
              </div>
              <Lead className="text-xs text-muted-foreground">{a.webhookHint}</Lead>
            </div>
            {secret && (
              <Notice tone="ok" title={a.secretTitle}>
                <div className="grid gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="rounded bg-background px-2 py-1 font-mono text-[13px] break-all">
                      {secret}
                    </code>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void navigator.clipboard.writeText(secret).then(() => setCopied(true))
                      }
                    >
                      {copied ? <CheckIcon /> : <CopyIcon />}
                      {copied ? t.common.copied : t.common.copy}
                    </Button>
                  </div>
                  <p className="text-[13px]">{a.secretBody}</p>
                </div>
              </Notice>
            )}
            {tested && (
              <Notice tone={tested.ok ? "ok" : "bad"}>
                {tested.ok ? a.testOk(tested.said) : a.testBad(tested.said)}
              </Notice>
            )}
            {action.error && <Notice tone="bad">{action.error}</Notice>}
            {delivery.url && last && (
              <p
                className={cn(
                  "text-[13px]",
                  last.status === "sent" ? "text-muted-foreground" : "text-destructive",
                )}
              >
                {last.status === "sent"
                  ? a.last.sent(ago(last.at))
                  : last.status === "failed"
                    ? a.last.failed(ago(last.at), last.attempts, last.said)
                    : last.attempts === 0
                      ? a.last.waiting
                      : a.last.pending(last.attempts, last.said)}
              </p>
            )}
          </>
        )}
      </CardContent>
      {dialog}
    </Card>
  );
}

export function AlertsPage({ me, onChange }: { me: Me; onChange(): void }) {
  const { t } = useI18n();
  const a = t.alerts;
  const canManage = me.permissions.includes("settings.manage");
  const settings = useLoad(() => api<Settings>("/api/alerts/rules"));
  return (
    <div className="grid gap-3">
      <AlertList canManage={canManage} onChange={onChange} />
      {settings.error ? (
        <Notice tone="bad">{settings.error}</Notice>
      ) : !settings.data ? (
        <Loading />
      ) : (
        <div className="grid items-start gap-3 2xl:grid-cols-[minmax(0,1fr)_26rem]">
          <Card className="overflow-hidden pb-0 dense:pb-0">
            <CardHeader>
              <CardTitle>{a.rulesTitle}</CardTitle>
              <CardDescription>{a.rulesLead}</CardDescription>
            </CardHeader>
            <div>
              {settings.data.rules.map((rule) => (
                <RuleLine
                  // A rule saved is drawn again from what was saved.
                  key={`${rule.rule}:${rule.threshold}:${rule.window}`}
                  rule={rule}
                  windows={settings.data?.windows ?? []}
                  canManage={canManage}
                  onSaved={settings.reload}
                />
              ))}
            </div>
          </Card>
          <DeliveryCard
            delivery={settings.data.delivery}
            canManage={canManage}
            reload={settings.reload}
          />
        </div>
      )}
    </div>
  );
}
