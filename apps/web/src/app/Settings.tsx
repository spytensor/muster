import {
  BarChart3Icon,
  BellIcon,
  BrainIcon,
  DatabaseIcon,
  MonitorIcon,
  PlugIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  UserIcon,
  UserRoundPenIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { signOut } from "@/App";
import { useConfirm } from "@/components/confirm";
import { MoreMenu } from "@/components/more";
import { Loading, Notice, useAction, useLoad } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Lead } from "@/components/ui/hint";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";
import { LOCALES, type Locale, useI18n } from "@/i18n";
import { generalOf, shownAgent } from "@/lib/agentName";
import { api, type Me } from "@/lib/api";
import { desktop } from "@/lib/desktop";
import { device } from "@/lib/events";
import {
  askNoticePermission,
  type NoticeKind,
  noticePermission,
  setWantsNotice,
  wantsNotice,
} from "@/lib/notify";
import { pushWays, saveProfile, useProfile, type Ways } from "@/lib/profile";
import { type ThemeMode, useTheme } from "@/lib/theme";
import { address, cn } from "@/lib/utils";
import { cpuTime } from "@/pages/sandboxLogic";
import type { AppAgent } from "./api";
import { preferAgent, preferredAgent } from "./Chat";
import { MyConnectors } from "./MyConnectors";
import { type Connector, connectMicrosoft, MicrosoftMark } from "./PlusMenu";

export type SettingsSection =
  | "profile"
  | "account"
  | "usage"
  | "general"
  | "connections"
  | "notifications"
  | "memory"
  | "data"
  | "desktop";

const icons: Record<SettingsSection, typeof UserIcon> = {
  profile: UserRoundPenIcon,
  account: UserIcon,
  usage: BarChart3Icon,
  general: SlidersHorizontalIcon,
  connections: PlugIcon,
  notifications: BellIcon,
  memory: BrainIcon,
  data: DatabaseIcon,
  desktop: MonitorIcon,
};

/** One setting: what it is on the left, the control on the right. */
function Row({ label, lead, children }: { label: string; lead?: string; children?: ReactNode }) {
  return (
    <div className="flex min-h-14 items-center gap-6 border-b py-3 last:border-b-0">
      <div className="grid min-w-0 flex-1 gap-0.5">
        <span className="text-[13px] font-medium">{label}</span>
        {lead && (
          <Lead as="span" className="text-[13px] text-muted-foreground">
            {lead}
          </Lead>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
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
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cn(
        "relative h-5 w-9 rounded-full transition-colors disabled:opacity-50",
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

interface MySession {
  id: string;
  provider: string;
  kind: "browser" | "app";
  lastSeenAt: string;
  userAgent: string | null;
  current: boolean;
}

function Account({ me }: { me: Me }) {
  const { t, ago } = useI18n();
  const a = t.prefs.account;
  const { data, error, reload } = useLoad(() => api<MySession[]>("/api/app/sessions"));
  const { busy, error: failure, run } = useAction();
  const end = (session: MySession) =>
    run(async () => {
      // Ending the session this page runs on is signing out.
      if (session.current) return signOut();
      await api(`/api/app/sessions/${session.id}`, { method: "DELETE" });
      await reload();
    });
  return (
    <>
      <Lead className="pb-2 text-[13px] text-muted-foreground">{a.profileLead}</Lead>
      <Row label={a.name}>
        <span className="text-[13px]">{me.user.name || "—"}</span>
      </Row>
      <Row label={a.email}>
        <span className="text-[13px]">{address(me.user.email) || "—"}</span>
      </Row>
      <Row label={a.org}>
        <span className="text-[13px]">{me.org.name}</span>
      </Row>
      <Row label={a.role} lead={t.roleSummary[me.role]}>
        <span className="text-[13px]">{t.roles[me.role]}</span>
      </Row>
      <h4 className="pt-8 text-sm font-semibold">{a.devices}</h4>
      <Lead className="pb-2 text-[13px] text-muted-foreground">{a.devicesLead}</Lead>
      {(error || failure) && <Notice tone="bad">{error ?? failure}</Notice>}
      {!data && !error && <Loading />}
      {data?.map((session) => (
        <Row
          key={session.id}
          label={`${device(session.userAgent, t.common.unknown, t.common.unknown)} · ${a[session.kind]}`}
          lead={session.current ? a.thisDevice : a.lastSeen(ago(session.lastSeenAt))}
        >
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void end(session)}>
            {a.signOut}
          </Button>
        </Row>
      ))}
    </>
  );
}

interface UsageSums {
  runs: number;
  tokens: number;
  /** What went in and what came out; what went in and was read from the model's cache. */
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costMicros: number;
}
interface MyUsage {
  totals: UsageSums;
  byAgent: (UsageSums & { agent: string })[];
  byDay: (UsageSums & { day: string })[];
  byConversation: (UsageSums & { id: string; title: string })[];
  /** Code run today against the day's allowance (0: none). Null where the server runs no code. */
  code?: { runs: number; cpuSeconds: number; limitRuns: number; limitCpuSeconds: number } | null;
  /** This month against each limit that holds for the person; money only for their own. */
  month?: {
    scope: "person" | "department" | "company";
    share: number;
    limitMicros?: number;
    spentMicros?: number;
  }[];
  /** What the person's agents have used today, and the day's allowance (0 when there is none). */
  today: { tokens: number; limit: number };
}

/** How much of what went in was read from the model's cache; a dash when nothing went in. */
const hitRate = (sums: { inputTokens: number; cachedTokens: number }) =>
  sums.inputTokens > 0 ? `${Math.round((sums.cachedTokens / sums.inputTokens) * 100)}%` : "–";

function Usage() {
  const { t, number, compact, money } = useI18n();
  const u = t.prefs.usage;
  const [range, setRange] = useState("30d");
  const { data, error } = useLoad(() => api<MyUsage>(`/api/app/usage?range=${range}`), [range]);
  const most = Math.max(1, ...(data?.byDay.map((day) => day.tokens) ?? []));
  return (
    <>
      <div className="flex items-center gap-3 pb-2">
        <Lead className="min-w-0 flex-1 text-xs text-muted-foreground">{u.lead}</Lead>
        <div className="flex rounded-md bg-foreground/6 p-0.5">
          {Object.entries(u.ranges).map(([id, label]) => (
            <button
              type="button"
              key={id}
              aria-pressed={range === id}
              onClick={() => setRange(id)}
              className={cn(
                "h-6 rounded px-2 text-xs",
                range === id ? "bg-background font-medium shadow-xs" : "text-muted-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
      {!data && !error && <Loading />}
      {data && (
        <>
          {data.today.limit > 0 && (
            <div className="mb-2 grid gap-1 rounded-lg border px-3 py-2">
              <div className="flex items-baseline justify-between text-xs">
                <span className="font-medium">{u.today}</span>
                <span className="num text-muted-foreground">
                  {u.todayOf(number(data.today.tokens), number(data.today.limit))}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-foreground/10">
                <div
                  className={cn(
                    "h-full rounded-full",
                    data.today.tokens >= data.today.limit ? "bg-destructive" : "bg-brand",
                  )}
                  style={{
                    width: `${Math.min(100, (data.today.tokens / data.today.limit) * 100)}%`,
                  }}
                />
              </div>
            </div>
          )}
          {(data.month ?? []).map((limit) => (
            <div key={limit.scope} className="mb-2 grid gap-1 rounded-lg border px-3 py-2">
              <div className="flex items-baseline justify-between text-xs">
                <span className="font-medium">{u.month[limit.scope]}</span>
                <span className="num text-muted-foreground">
                  {limit.limitMicros !== undefined && limit.spentMicros !== undefined
                    ? u.monthOf(money(limit.spentMicros), money(limit.limitMicros))
                    : `${Math.round(limit.share * 100)}%`}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-foreground/10">
                <div
                  className={cn(
                    "h-full rounded-full",
                    limit.share >= 1
                      ? "bg-destructive"
                      : limit.share >= 0.8
                        ? "bg-amber-500"
                        : "bg-brand",
                  )}
                  style={{ width: `${Math.round(limit.share * 100)}%` }}
                />
              </div>
            </div>
          ))}
          <dl className="grid grid-cols-3 gap-2">
            {(
              [
                [u.runs, number(data.totals.runs), null],
                [u.tokens, compact(data.totals.tokens), null],
                [u.cost, money(data.totals.costMicros), null],
                [u.input, compact(data.totals.inputTokens), null],
                [u.output, compact(data.totals.outputTokens), null],
                [
                  u.cached,
                  hitRate(data.totals),
                  u.cachedOf(compact(data.totals.cachedTokens), compact(data.totals.inputTokens)),
                ],
              ] as const
            ).map(([label, value, note]) => (
              <div key={label} className="rounded-lg border px-3 py-2">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="num text-lg font-semibold">{value}</dd>
                {note && <dd className="num text-[11px] text-muted-foreground">{note}</dd>}
              </div>
            ))}
          </dl>
          <Lead className="pt-1.5 text-[11px] text-muted-foreground">{u.cachedHelp}</Lead>
          {data.code && (data.code.runs > 0 || data.code.limitRuns > 0) && (
            <p className="num pt-1.5 text-xs text-muted-foreground">
              {data.code.limitRuns > 0
                ? u.code(
                    number(data.code.runs),
                    number(data.code.limitRuns),
                    cpuTime(data.code.cpuSeconds, t.sandbox.units),
                  )
                : u.codeFree(
                    number(data.code.runs),
                    cpuTime(data.code.cpuSeconds, t.sandbox.units),
                  )}
            </p>
          )}
          {data.totals.runs === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">{u.none}</p>
          ) : (
            <>
              <h4 className="pt-4 pb-1 text-[13px] font-semibold">{u.byDay}</h4>
              {/* One series, so no legend: the heading names it. Each bar says its own numbers on hover. */}
              <div className="flex h-20 items-end gap-0.5 border-b" role="img" aria-label={u.byDay}>
                {data.byDay.map((day) => (
                  <div
                    key={day.day}
                    title={`${u.dayTitle(day.day, day.runs, number(day.tokens))} · ${u.cached} ${hitRate(day)}`}
                    className="min-w-1 flex-1 rounded-t-sm bg-(--series-1)"
                    style={{ height: `${Math.max(3, (day.tokens / most) * 100)}%` }}
                  />
                ))}
              </div>
              <div className="num flex justify-between pt-0.5 text-[11px] text-muted-foreground">
                <span>{data.byDay[0]?.day}</span>
                <span>{data.byDay.at(-1)?.day}</span>
              </div>
              <h4 className="pt-4 text-[13px] font-semibold">{u.byAgent}</h4>
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-1.5 font-normal" />
                    <th className="py-1.5 text-right font-normal">{u.runs}</th>
                    <th className="py-1.5 text-right font-normal">{u.tokens}</th>
                    <th className="py-1.5 text-right font-normal">{u.cached}</th>
                    <th className="py-1.5 text-right font-normal">{u.cost}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byAgent.map((row) => (
                    <tr key={row.agent} className="border-b last:border-b-0">
                      <td className="py-1.5">{row.agent}</td>
                      <td className="num py-1.5 text-right">{number(row.runs)}</td>
                      <td className="num py-1.5 text-right">{number(row.tokens)}</td>
                      <td className="num py-1.5 text-right">{hitRate(row)}</td>
                      <td className="num py-1.5 text-right">{money(row.costMicros)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.byConversation.length > 0 && (
                <>
                  <h4 className="pt-4 text-[13px] font-semibold">{u.byConversation}</h4>
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr className="border-b text-left text-xs text-muted-foreground">
                        <th className="py-1.5 font-normal" />
                        <th className="py-1.5 text-right font-normal">{u.runs}</th>
                        <th className="py-1.5 text-right font-normal">{u.tokens}</th>
                        <th className="py-1.5 text-right font-normal">{u.cached}</th>
                        <th className="py-1.5 text-right font-normal">{u.cost}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.byConversation.map((row) => (
                        <tr key={row.id} className="border-b last:border-b-0">
                          <td className="w-full max-w-0 truncate py-1.5 pr-3">
                            <a className="hover:underline" href={`#/c/${row.id}`}>
                              {row.title || u.untitled}
                            </a>
                          </td>
                          <td className="num py-1.5 text-right">{number(row.runs)}</td>
                          <td className="num py-1.5 text-right">{number(row.tokens)}</td>
                          <td className="num py-1.5 text-right">{hitRate(row)}</td>
                          <td className="num py-1.5 text-right">{money(row.costMicros)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}

/** The time zone this device is in. */
const deviceZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};
/** Every time zone this browser knows, for the person who wants one fixed. */
const ZONES: string[] = (() => {
  try {
    return (
      (Intl as unknown as { supportedValuesOf?(key: string): string[] }).supportedValuesOf?.(
        "timeZone",
      ) ?? []
    );
  } catch {
    return [];
  }
})();

/**
 * Who the person is and how they work. Who they are is the organization's and is only
 * shown. How they work is theirs: kept on the server, the same on every device, and told
 * to the agents that work for them. The signature is the exception: it goes under a mail
 * on its card and is never given to an agent.
 */
function ProfileSection({ me }: { me: Me }) {
  const { t } = useI18n();
  const p = t.prefs.profile;
  const a = t.prefs.account;
  const profile = useProfile();
  const action = useAction();
  const [style, setStyle] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [start, setStart] = useState<string | null>(null);
  const [end, setEnd] = useState<string | null>(null);
  if (!profile) return <Loading />;
  const { ways, identity, limits } = profile;
  /** Saves, and says whether it was kept: what the person typed stays where it is when it was not. */
  const save = (change: Partial<Ways>, text = false) =>
    action.run(async () => {
      setSaved(false);
      await saveProfile(change);
      // Said only for what has a Save button; a menu shows its own new value.
      setSaved(text);
      return true;
    });
  // The hours as they are being typed: kept only once the person leaves the field, so a
  // half-typed time is never sent, and never put back to what it was mid-edit.
  const startNow = start ?? ways.workStart ?? "";
  const endNow = end ?? ways.workEnd ?? "";
  const keepHours = () => {
    if (start === null && end === null) return;
    const from = startNow || "09:00";
    const to = endNow || "18:00";
    if (from === ways.workStart && to === ways.workEnd) {
      setStart(null);
      setEnd(null);
      return;
    }
    void save({ workStart: from, workEnd: to, workDays: ways.workDays ?? [1, 2, 3, 4, 5] }).then(
      (ok) => {
        if (!ok) return;
        setStart(null);
        setEnd(null);
      },
    );
  };
  const days = ways.workDays ?? [1, 2, 3, 4, 5];
  const hours = Boolean(ways.workStart && ways.workEnd);
  const styleNow = style ?? ways.answerStyle ?? "";
  const signatureNow = signature ?? ways.signature ?? "";
  const changed =
    styleNow.trim() !== (ways.answerStyle ?? "") || signatureNow.trim() !== (ways.signature ?? "");
  return (
    <>
      <Lead className="pb-2 text-[13px] text-muted-foreground">{a.profileLead}</Lead>
      <Row label={a.name}>
        <span className="text-[13px]">{identity.name || me.user.name || "—"}</span>
      </Row>
      <Row label={a.email}>
        <span className="text-[13px]">{address(identity.email) || "—"}</span>
      </Row>
      <Row label={a.org}>
        <span className="text-[13px]">{identity.org}</span>
      </Row>
      <Row label={a.role} lead={t.roleSummary[me.role]}>
        <span className="text-[13px]">{t.roles[me.role]}</span>
      </Row>
      <Row label={p.department}>
        <span className="text-[13px]">{identity.department ?? "—"}</span>
      </Row>

      <h4 className="pt-8 text-sm font-semibold">{p.ways}</h4>
      <Lead className="pb-2 text-[13px] text-muted-foreground">{p.waysLead}</Lead>
      {action.error && <Notice tone="bad">{action.error}</Notice>}
      <Row label={p.zone} lead={p.zoneLead}>
        <NativeSelect
          aria-label={p.zone}
          value={ways.timezone ?? ""}
          disabled={action.busy}
          onChange={(event) => void save({ timezone: event.target.value || null })}
        >
          <option value="">{p.zoneDevice(ways.timezone ? deviceZone() : profile.zone)}</option>
          {ZONES.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </NativeSelect>
      </Row>
      <Row label={p.hours} lead={p.hoursLead}>
        <div className="flex items-center gap-1.5">
          <Input
            type="time"
            aria-label={p.start}
            className="h-8 w-28"
            value={startNow}
            onChange={(event) => setStart(event.target.value)}
            onBlur={keepHours}
          />
          <span className="text-muted-foreground">–</span>
          <Input
            type="time"
            aria-label={p.end}
            className="h-8 w-28"
            value={endNow}
            onChange={(event) => setEnd(event.target.value)}
            onBlur={keepHours}
          />
          {hours && (
            <Button
              size="sm"
              variant="ghost"
              disabled={action.busy}
              onClick={() => void save({ workStart: null, workEnd: null, workDays: null })}
            >
              {p.clear}
            </Button>
          )}
        </div>
      </Row>
      {hours && (
        <Row label={p.days}>
          <div className="flex gap-1">
            {p.weekdays.map((name, day) => {
              const on = days.includes(day);
              return (
                <button
                  type="button"
                  // biome-ignore lint/suspicious/noArrayIndexKey: the days of a week never reorder
                  key={day}
                  aria-pressed={on}
                  disabled={action.busy || (on && days.length === 1)}
                  onClick={() =>
                    void save({
                      workDays: on ? days.filter((one) => one !== day) : [...days, day],
                    })
                  }
                  className={cn(
                    "h-7 min-w-9 rounded-md px-1.5 text-xs transition-colors",
                    on ? "bg-brand text-white" : "bg-foreground/8 text-muted-foreground",
                  )}
                >
                  {name}
                </button>
              );
            })}
          </div>
        </Row>
      )}

      <div className="grid gap-1.5 border-b py-3">
        <label htmlFor="profile-style" className="text-[13px] font-medium">
          {p.style}
        </label>
        <Lead as="span" className="text-[13px] text-muted-foreground">
          {p.styleLead}
        </Lead>
        <Textarea
          id="profile-style"
          rows={2}
          maxLength={limits.answerStyle}
          placeholder={p.styleHint}
          value={styleNow}
          onChange={(event) => {
            setSaved(false);
            setStyle(event.target.value);
          }}
        />
        <span className="text-right text-xs text-muted-foreground">
          {styleNow.length}/{limits.answerStyle}
        </span>
      </div>
      <div className="grid gap-1.5 py-3">
        <label htmlFor="profile-signature" className="text-[13px] font-medium">
          {p.signature}
        </label>
        <Lead as="span" className="text-[13px] text-muted-foreground">
          {p.signatureLead}
        </Lead>
        <Textarea
          id="profile-signature"
          rows={4}
          maxLength={limits.signature}
          value={signatureNow}
          onChange={(event) => {
            setSaved(false);
            setSignature(event.target.value);
          }}
        />
      </div>
      <div className="flex items-center gap-3 pb-2">
        <Button
          size="sm"
          disabled={action.busy || !changed}
          onClick={() =>
            void save(
              { answerStyle: styleNow.trim() || null, signature: signatureNow.trim() || null },
              true,
            ).then((ok) => {
              if (!ok) return;
              setStyle(null);
              setSignature(null);
            })
          }
        >
          {t.common.save}
        </Button>
        {saved && !changed && <span className="text-xs text-muted-foreground">{p.saved}</span>}
      </div>
    </>
  );
}

function General() {
  const { t, locale, setLocale } = useI18n();
  const g = t.prefs.general;
  const { mode, setMode } = useTheme();
  const { data } = useLoad(() => api<{ agents: AppAgent[] }>("/api/app/agents"));
  const usable = data?.agents.filter((agent) => agent.state === "published") ?? [];
  const [agent, setAgent] = useState(preferredAgent);
  // The same choice the start page makes when nothing was chosen: the general assistant.
  const chosen = usable.find((item) => item.id === agent) ?? generalOf(usable) ?? usable[0];
  return (
    <>
      <Row label={g.language}>
        <NativeSelect
          aria-label={g.language}
          value={locale}
          onChange={(event) => setLocale(event.target.value as Locale)}
        >
          {(Object.keys(LOCALES) as Locale[]).map((id) => (
            <option key={id} value={id}>
              {LOCALES[id].messages.language}
            </option>
          ))}
        </NativeSelect>
      </Row>
      <Row label={g.appearance}>
        <NativeSelect
          aria-label={g.appearance}
          value={mode}
          onChange={(event) => setMode(event.target.value as ThemeMode)}
        >
          {(["system", "light", "dark"] as ThemeMode[]).map((id) => (
            <option key={id} value={id}>
              {t.settings[id]}
            </option>
          ))}
        </NativeSelect>
      </Row>
      <Row label={g.defaultAgent} lead={g.defaultAgentLead}>
        <NativeSelect
          aria-label={g.defaultAgent}
          value={chosen?.id ?? ""}
          onChange={(event) => {
            preferAgent(event.target.value);
            setAgent(event.target.value);
            pushWays({ defaultAgent: event.target.value });
          }}
        >
          {usable.map((item) => (
            <option key={item.id} value={item.id}>
              {shownAgent(item)}
            </option>
          ))}
        </NativeSelect>
      </Row>
    </>
  );
}

/** The services a person has let their agents read for them, and the way to connect or take that back. */
function Connections() {
  const { t, ago } = useI18n();
  const k = t.prefs.connections;
  const { data, error, reload } = useLoad(() => api<Connector[]>("/api/app/connectors"));
  const { busy, error: failure, run } = useAction();
  const { confirm, dialog } = useConfirm();
  // Consent is given on the service's own page, in another tab or the system's browser.
  // The list is read again when the person comes back to this window.
  useEffect(() => {
    const again = () => void reload();
    addEventListener("focus", again);
    return () => removeEventListener("focus", again);
  }, [reload]);
  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <Loading />;
  const connect = () => run(connectMicrosoft);
  const disconnect = async (account: string) => {
    if (!(await confirm(k.disconnect, k.disconnectConfirm(account)))) return;
    await run(async () => {
      await api("/api/app/connectors/microsoft", { method: "DELETE" });
      await reload();
    });
  };
  return (
    <>
      <Lead className="pb-3 text-[13px] text-muted-foreground">{k.lead}</Lead>
      {failure && <Notice tone="bad">{failure}</Notice>}
      {data.map((connector) => (
        <section key={connector.id} className="glass grid gap-3 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-foreground/5">
              <MicrosoftMark className="size-5" />
            </span>
            <div className="grid min-w-0 flex-1 gap-0.5">
              <h4 className="text-sm font-semibold">{k.microsoft.name}</h4>
              <Lead className="text-[13px] text-muted-foreground">
                {connector.connected
                  ? k.connectedAs(connector.connected.account, ago(connector.connected.since))
                  : connector.available
                    ? k.microsoft.lead
                    : connector.off
                      ? k.off
                      : k.unavailable}
              </Lead>
            </div>
            {connector.connected ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void disconnect(connector.connected?.account ?? "")}
              >
                {k.disconnect}
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={busy || !connector.available}
                onClick={() => void connect()}
              >
                {k.connect}
              </Button>
            )}
          </div>
          <ul className="grid gap-1 text-[13px] sm:grid-cols-2">
            {k.microsoft.can.map((line) => (
              <li key={line} className="flex gap-1.5">
                <span className="text-muted-foreground">·</span>
                {line}
              </li>
            ))}
          </ul>
          <Lead className="text-xs text-muted-foreground">{k.microsoft.cannot}</Lead>
          {connector.connected?.sends &&
            !(connector.connected.sends.mail && connector.connected.sends.teams) && (
              <p className="text-xs text-amber-600 dark:text-amber-400">{k.microsoft.reconnect}</p>
            )}
        </section>
      ))}
      <MyConnectors />
      {dialog}
    </>
  );
}

function Notifications() {
  const { t } = useI18n();
  const n = t.prefs.notifications;
  const [permission, setPermission] = useState(noticePermission);
  const [on, setOn] = useState({
    approvals: wantsNotice("approvals"),
    replies: wantsNotice("replies"),
  });
  const change = async (kind: NoticeKind, value: boolean) => {
    setWantsNotice(kind, value);
    setOn((now) => ({ ...now, [kind]: value }));
    pushWays({ notify: { ...on, [kind]: value } });
    // The browser asks the person once, the first time something is turned on.
    if (value && permission === "default") setPermission(await askNoticePermission());
  };
  const blocked = permission === "denied" || permission === "unsupported";
  return (
    <>
      <Lead className="pb-1 text-xs text-muted-foreground">{n.lead}</Lead>
      {blocked && <Notice>{permission === "denied" ? n.denied : n.unsupported}</Notice>}
      <Row label={n.approvals} lead={n.approvalsLead}>
        <Toggle
          on={on.approvals && !blocked}
          label={n.approvals}
          disabled={blocked}
          onChange={(value) => void change("approvals", value)}
        />
      </Row>
      <Row label={n.replies} lead={n.repliesLead}>
        <Toggle
          on={on.replies && !blocked}
          label={n.replies}
          disabled={blocked}
          onChange={(value) => void change("replies", value)}
        />
      </Row>
    </>
  );
}

function Data({ onChange }: { onChange(): void }) {
  const { t } = useI18n();
  const d = t.prefs.data;
  const { busy, error, run } = useAction();
  const [done, setDone] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();
  const clear = async () => {
    if (!(await confirm(d.clear, d.clearConfirm))) return;
    await run(async () => {
      const { removed } = await api<{ removed: number }>("/api/app/conversations", {
        method: "DELETE",
      });
      setDone(d.cleared(removed));
      onChange();
      // The conversation on screen may be one of those just removed.
      if (location.hash.startsWith("#/c/")) location.hash = "/";
    });
  };
  return (
    <>
      {error && <Notice tone="bad">{error}</Notice>}
      {done && <Notice tone="ok">{done}</Notice>}
      <Row label={d.clear} lead={d.clearLead}>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void clear()}>
          {d.clear}
        </Button>
      </Row>
      <Lead className="pt-3 text-xs text-muted-foreground">{d.whoSees}</Lead>
      {dialog}
    </>
  );
}

interface Remembered {
  id: string;
  text: string;
  createdAt: string;
  conversationId: string | null;
  conversation: string | null;
}

/** Everything the person's agents remember about them: read it, correct it, remove it, or turn it off. */
function Memory() {
  const { t, ago, dateTime } = useI18n();
  const m = t.prefs.memory;
  const { data, error, reload } = useLoad(() =>
    api<{ off: boolean; limit: number; memories: Remembered[] }>("/api/app/memory"),
  );
  const action = useAction();
  const { confirm, dialog } = useConfirm();
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <Loading />;
  const act = (fn: () => Promise<unknown>) =>
    action.run(async () => {
      await fn();
      await reload();
    });
  const removeAll = async () => {
    if (!(await confirm(m.removeAll, m.removeAllConfirm(data.memories.length)))) return;
    await act(() => api("/api/app/memory", { method: "DELETE" }));
  };
  return (
    <>
      {action.error && <Notice tone="bad">{action.error}</Notice>}
      <Row label={m.on} lead={m.onLead}>
        <Toggle
          on={!data.off}
          label={m.on}
          disabled={action.busy}
          onChange={(on) =>
            void act(() => api("/api/app/memory/settings", { method: "PUT", body: { off: !on } }))
          }
        />
      </Row>
      <div className="flex items-center gap-2 pt-3 pb-1.5">
        <span className="flex-1 text-[13px] font-medium">
          {m.count(data.memories.length, data.limit)}
        </span>
        {data.memories.length > 0 && (
          <MoreMenu
            label={t.common.more}
            items={[{ label: m.removeAll, destructive: true, onSelect: () => void removeAll() }]}
          />
        )}
      </div>
      {data.memories.length === 0 ? (
        <Lead className="text-xs text-muted-foreground">{m.none}</Lead>
      ) : (
        <ul className="divide-y rounded-lg border">
          {data.memories.map((memory) => (
            <li key={memory.id} className="flex items-start gap-2 px-3 py-2">
              {editing?.id === memory.id ? (
                <form
                  className="flex min-w-0 flex-1 items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void act(async () => {
                      await api(`/api/app/memory/${memory.id}`, {
                        method: "PATCH",
                        body: { text: editing.text },
                      });
                      setEditing(null);
                    });
                  }}
                >
                  <Input
                    autoFocus
                    value={editing.text}
                    maxLength={400}
                    aria-label={m.edit}
                    onChange={(event) => setEditing({ id: memory.id, text: event.target.value })}
                  />
                  <Button size="sm" disabled={editing.text.trim().length < 3 || action.busy}>
                    {t.common.save}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    type="button"
                    onClick={() => setEditing(null)}
                  >
                    {t.common.cancel}
                  </Button>
                </form>
              ) : (
                <>
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="text-[13px]">{memory.text}</span>
                    <span
                      className="truncate text-xs text-muted-foreground"
                      title={dateTime(memory.createdAt)}
                    >
                      {ago(memory.createdAt)}
                      {memory.conversation ? ` · ${memory.conversation}` : ""}
                    </span>
                  </span>
                  <MoreMenu
                    label={t.common.more}
                    items={[
                      {
                        label: m.edit,
                        onSelect: () => setEditing({ id: memory.id, text: memory.text }),
                      },
                      {
                        label: t.common.delete,
                        destructive: true,
                        onSelect: () =>
                          void (async () => {
                            if (await confirm(t.common.delete, m.removeConfirm))
                              await act(() =>
                                api(`/api/app/memory/${memory.id}`, { method: "DELETE" }),
                              );
                          })(),
                      },
                    ]}
                  />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <Lead className="pt-3 text-xs text-muted-foreground">{m.whoSees}</Lead>
      {dialog}
    </>
  );
}

function DesktopApp() {
  const { t } = useI18n();
  const d = t.prefs.desktop;
  return (
    <>
      <Row label={d.server}>
        <span className="font-mono text-xs">{location.origin}</span>
      </Row>
      <Row label={d.change} lead={d.changeLead}>
        <Button size="sm" variant="outline" onClick={() => void desktop?.changeServer()}>
          {d.change}
        </Button>
      </Row>
    </>
  );
}

/** The person's settings: one place for their account, usage, preferences and data. */
export function Settings({
  me,
  section,
  onSection,
  onClose,
  onChange,
}: {
  me: Me;
  section: SettingsSection;
  onSection(section: SettingsSection): void;
  onClose(): void;
  onChange(): void;
}) {
  const { t } = useI18n();
  const p = t.prefs;
  const [query, setQuery] = useState("");
  const all = (Object.keys(icons) as SettingsSection[]).filter((id) => id !== "desktop" || desktop);
  // A section matches a search by its own name or by the name of anything in it.
  const words = (id: SettingsSection) =>
    [p.sections[id], ...Object.values(p[id]).filter((value) => typeof value === "string")]
      .join(" ")
      .toLowerCase();
  const needle = query.trim().toLowerCase();
  const shown = all.filter((id) => !needle || words(id).includes(needle));
  const current = shown.includes(section) ? section : shown[0];
  useEffect(() => {
    if (current && current !== section) onSection(current);
  }, [current, section, onSection]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="glass-thick flex h-[min(720px,88dvh)] max-w-5xl gap-0 overflow-hidden p-0">
        <nav className="flex w-56 shrink-0 flex-col gap-2 border-r p-3">
          <DialogTitle className="px-2 pt-1.5 text-sm">{p.title}</DialogTitle>
          <DialogDescription className="sr-only">{p.search}</DialogDescription>
          <label className="flex h-7 items-center gap-1.5 rounded-md bg-foreground/5 px-2 text-[13px] focus-within:ring-1 focus-within:ring-ring">
            <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={p.search}
              aria-label={p.search}
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
            />
          </label>
          <div className="grid">
            {shown.map((id) => {
              const Icon = icons[id];
              return (
                <button
                  type="button"
                  key={id}
                  className="row"
                  aria-current={id === current ? "page" : undefined}
                  onClick={() => onSection(id)}
                >
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                  {p.sections[id]}
                </button>
              );
            })}
            {shown.length === 0 && (
              <p className="px-2 text-xs text-muted-foreground">{p.noMatch}</p>
            )}
          </div>
        </nav>
        <div className="relative min-w-0 flex-1 overflow-y-auto px-8 py-6">
          {current && (
            <>
              <h3 className="pb-3 text-base font-semibold">{p.sections[current]}</h3>
              {current === "profile" ? (
                <ProfileSection me={me} />
              ) : current === "account" ? (
                <Account me={me} />
              ) : current === "usage" ? (
                <Usage />
              ) : current === "general" ? (
                <General />
              ) : current === "connections" ? (
                <Connections />
              ) : current === "notifications" ? (
                <Notifications />
              ) : current === "memory" ? (
                <Memory />
              ) : current === "data" ? (
                <Data onChange={onChange} />
              ) : (
                <DesktopApp />
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
