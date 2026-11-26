import { forgetForms } from "@/app/forms";
import {
  ActivityIcon,
  ArrowLeftIcon,
  CableIcon,
  BotIcon,
  Building2Icon,
  CheckIcon,
  BoxIcon,
  CpuIcon,
  KeyRoundIcon,
  LanguagesIcon,
  LayoutDashboardIcon,
  LoaderCircleIcon,
  ArrowUpIcon,
  LockIcon,
  LogOutIcon,
  MenuIcon,
  MonitorIcon,
  MoonIcon,
  ReceiptTextIcon,
  ScrollTextIcon,
  ArchiveXIcon,
  ShieldCheckIcon,
  StoreIcon,
  SunIcon,
  TriangleAlertIcon,
  UsersIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Mark } from "@/components/shared";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { LOCALES, type Locale, useI18n } from "@/i18n";
import type { Messages } from "@/i18n/en";
import { ApiError, api, type Me, type Permission, whenSignedOut } from "@/lib/api";
import { desktop } from "@/lib/desktop";
import { LOCAL, syncProfile } from "@/lib/profile";
import { type ThemeMode, useTheme } from "@/lib/theme";
import { address, cn } from "@/lib/utils";
import { Workspace } from "@/app/Workspace";
import { AgentsPage } from "@/pages/Agents";
import { AlertsPage } from "@/pages/Alerts";
import { AuditPage } from "@/pages/Audit";
import { DepartmentsPage } from "@/pages/Departments";
import { MembersPage } from "@/pages/Members";
import { OverviewPage } from "@/pages/Overview";
import { ConnectionsPage } from "@/pages/Connections";
import { MarketPage } from "@/pages/Market";
import { SecurityPage } from "@/pages/Security";
import { RetentionPage } from "@/pages/Retention";
import { SandboxPage } from "@/pages/Sandbox";
import { ModelsPage, PoliciesPage } from "@/pages/System";
import { TracesPage } from "@/pages/Traces";
import { UsagePage } from "@/pages/Usage";
import { Lead } from "@/components/ui/hint";

export type Page =
  | "overview"
  | "alerts"
  | "members"
  | "departments"
  | "security"
  | "audit"
  | "retention"
  | "agents"
  | "traces"
  | "usage"
  | "policies"
  | "market"
  | "connections"
  | "models"
  | "sandbox";

interface NavItem {
  id: Page;
  icon: typeof UsersIcon;
  /** Shown only to people holding one of these permissions, or this role. */
  needs?: Permission;
  orRole?: Me["role"];
}
const nav: { group: keyof Messages["nav"]["groups"]; items: NavItem[] }[] = [
  {
    group: "organization",
    items: [
      { id: "overview", icon: LayoutDashboardIcon },
      { id: "alerts", icon: TriangleAlertIcon, needs: "settings.read" },
      { id: "members", icon: UsersIcon, needs: "members.read" },
      { id: "departments", icon: Building2Icon, needs: "members.read" },
    ],
  },
  {
    group: "security",
    items: [
      { id: "security", icon: KeyRoundIcon, needs: "settings.read" },
      { id: "audit", icon: ScrollTextIcon, needs: "audit.read" },
      { id: "retention", icon: ArchiveXIcon, needs: "settings.read" },
    ],
  },
  {
    group: "agents",
    items: [
      { id: "agents", icon: BotIcon, needs: "agents.read" },
      { id: "traces", icon: ActivityIcon, needs: "traces.read" },
      { id: "usage", icon: ReceiptTextIcon, needs: "traces.read", orRole: "billing" },
      { id: "market", icon: StoreIcon, needs: "agents.read" },
      { id: "policies", icon: ShieldCheckIcon, needs: "settings.read" },
    ],
  },
  {
    group: "platform",
    items: [
      { id: "connections", icon: CableIcon, needs: "members.read" },
      { id: "models", icon: CpuIcon, needs: "settings.read" },
      { id: "sandbox", icon: BoxIcon, needs: "settings.read" },
    ],
  },
];
const all = nav.flatMap((group) => group.items);

/** The address after the "#", as its parts: "#/admin/traces/t/<id>?range=7d" gives ["admin", "traces", "t", "<id>"]. */
const parts = () =>
  (location.hash.replace(/^#\/?/, "").split("?")[0] ?? "").split("/").filter(Boolean);
/** The admin page and the rest of the path: ["admin", "traces", "t", "<id>"] gives ["traces", ["t", "<id>"]]. */
const route = ([, id, ...rest]: string[]): [Page, string[]] => [
  all.some((item) => item.id === id) ? (id as Page) : "overview",
  rest,
];
/** Goes to a page of the admin console. */
export const go = (path: string) => {
  location.hash = `/admin/${path}`;
};
/** Goes to a page of the workspace: "" for a new conversation, "c/<id>", "documents" and so on. */
export const goApp = (path: string) => {
  location.hash = `/${path}`;
};

const RETURN_KEY = "muster.return";
/** Whether a failure means the server is away for now: no answer at all, or a gateway saying so. */
const away = (error: unknown) =>
  error instanceof ApiError && [0, 502, 503, 504].includes(error.status);

export function App() {
  const { errorText, t, locale, setLocale } = useI18n();
  const { mode, setMode } = useTheme();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  // Once someone is signed in, their profile is read: how they work is the same on every
  // device, so the language and appearance chosen elsewhere take effect here too.
  const who = me?.user.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: read once for each person who signs in
  useEffect(() => {
    if (!who) return;
    void syncProfile().then(
      ({ ways }) => {
        if (ways.locale && ways.locale !== locale) setLocale(ways.locale);
        if (ways.theme && ways.theme !== mode) setMode(ways.theme);
      },
      () => undefined,
    );
  }, [who]);
  const [failure, setFailure] = useState<unknown>(null);
  useEffect(() => {
    whenSignedOut(() => setMe(null));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let over = false;
    const ask = () =>
      api<Me>("/api/me").then(
        (loaded) => {
          if (over) return;
          const wanted = sessionStorage.getItem(RETURN_KEY);
          sessionStorage.removeItem(RETURN_KEY);
          if (wanted?.startsWith("#/") && !location.hash) location.hash = wanted.slice(1);
          setFailure(null);
          setMe(loaded);
        },
        (error: unknown) => {
          if (over) return;
          if (error instanceof ApiError && error.status === 401) {
            setFailure(null);
            return setMe(null);
          }
          setFailure(error);
          // The server did not answer, or something in front of it said it is away. That
          // says nothing about who this is: the page waits and asks again. Anything else
          // will not get better by asking, and the person is shown it.
          if (away(error)) timer = setTimeout(ask, 2000);
          else setMe(null);
        },
      );
    void ask();
    return () => {
      over = true;
      clearTimeout(timer);
    };
  }, []);
  const [path, setPath] = useState(parts);
  useEffect(() => {
    const change = () => setPath(parts());
    addEventListener("hashchange", change);
    return () => removeEventListener("hashchange", change);
  }, []);
  if (me === undefined)
    return failure ? (
      <div className="grid min-h-dvh place-items-center p-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <LoaderCircleIcon className="size-4 animate-spin" />
          {t.login.unreachable}
        </div>
      </div>
    ) : null;
  if (me === null) {
    const Screen = Login;
    return <Screen failure={failure ? errorText(failure) : null} />;
  }
  if (path[0] !== "admin") return <Workspace me={me} path={path} />;
  if (!me.permissions.includes("console.access")) return <NoAccess me={me} />;
  return <Console me={me} path={path} />;
}

export const signOut = async () => {
  // What was typed into forms and not sent is not left in this browser for whoever is next.
  forgetForms();
  // Nor which agent they start with or what they are told of: those are theirs, kept in
  // their profile. The language and appearance stay, as the sign-in page is drawn in them.
  for (const key of [LOCAL.agent, LOCAL.notify("approvals"), LOCAL.notify("replies")])
    localStorage.removeItem(key);
  // In the desktop app the session lives with the app, which ends it and forgets it.
  if (desktop) await desktop.signOut();
  else await api("/auth/logout", { method: "POST" }).catch(() => undefined);
  location.assign("/");
};

const themeIcon: Record<ThemeMode, typeof SunIcon> = {
  light: SunIcon,
  dark: MoonIcon,
  system: MonitorIcon,
};

/** Language and appearance, available before and after signing in. */
export function Preferences({ align = "end" }: { align?: "start" | "end" | "center" }) {
  const { t, locale, setLocale } = useI18n();
  const { mode, setMode } = useTheme();
  const ThemeIcon = themeIcon[mode];
  return (
    <div className="flex items-center gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" aria-label={t.settings.language}>
            <LanguagesIcon />
            <span className="hidden sm:inline">{t.language}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align}>
          {(Object.keys(LOCALES) as Locale[]).map((id) => (
            <DropdownMenuItem key={id} onSelect={() => setLocale(id)}>
              <CheckIcon className={cn(locale !== id && "invisible")} />
              {LOCALES[id].messages.language}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`${t.settings.theme}: ${t.settings[mode]}`}
          >
            <ThemeIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align}>
          {(["light", "dark", "system"] as ThemeMode[]).map((id) => {
            const Icon = themeIcon[id];
            return (
              <DropdownMenuItem key={id} onSelect={() => setMode(id)}>
                <CheckIcon className={cn(mode !== id && "invisible")} />
                <Icon />
                {t.settings[id]}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * The page a signed-out person meets, and every page like it: what to do on the left,
 * and on a wide window a picture of what Muster is on the right.
 */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="app-strip grid min-h-dvh bg-background lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <div className="flex min-h-dvh flex-col px-6 py-6 sm:px-10">
        <div className="flex flex-1 items-center justify-center">
          <div className="grid w-full max-w-[400px] gap-6">{children}</div>
        </div>
        <div className="flex justify-center lg:justify-start">
          <Preferences align="start" />
        </div>
      </div>
      <SignInPicture />
    </main>
  );
}

/**
 * What Muster is, in one picture: someone asks, an agent works, and every step it takes
 * passes the gateway and is on the record. Drawn, not a photograph, so it reads in any
 * language and at any width; hidden where the window has no room for it.
 */
function SignInPicture() {
  const { t } = useI18n();
  const p = t.login.picture;
  const tone = { allow: "bg-emerald-400", ask: "bg-amber-400", block: "bg-rose-400" } as const;
  return (
    <aside
      aria-hidden="true"
      className="relative m-3 hidden overflow-hidden rounded-[28px] bg-[#0b0d12] text-white lg:block"
    >
      <div className="absolute inset-0 bg-[radial-gradient(120%_70%_at_70%_0%,#3b5bfd55_0%,transparent_60%),radial-gradient(90%_60%_at_15%_100%,#12b98155_0%,transparent_60%),radial-gradient(70%_50%_at_95%_95%,#f59e0b40_0%,transparent_60%)]" />
      <div className="absolute inset-0 [background-image:linear-gradient(#ffffff0a_1px,transparent_1px),linear-gradient(90deg,#ffffff0a_1px,transparent_1px)] [background-size:44px_44px] [mask-image:radial-gradient(80%_70%_at_50%_45%,#000_30%,transparent_100%)]" />
      <div className="relative flex h-full flex-col justify-center gap-7 px-[9%] py-12">
        <p className="max-w-[26ch] text-[30px] leading-[1.2] font-semibold tracking-tight text-balance">
          {p.title.map((line) => (
            <span key={line} className="block">
              {line}
            </span>
          ))}
        </p>
        <div className="grid max-w-[460px] gap-2.5">
          <div className="flex items-center gap-3 rounded-2xl bg-white/95 px-4 py-3.5 text-[15px] text-[#0d0d0d] shadow-2xl shadow-black/40">
            <span className="min-w-0 flex-1 truncate">{p.ask}</span>
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-[#0d0d0d] text-white">
              <ArrowUpIcon className="size-4" />
            </span>
          </div>
          <ul className="grid gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/[0.06] backdrop-blur">
            {p.steps.map((step) => (
              <li key={step.what} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                <span className={cn("size-1.5 shrink-0 rounded-full", tone[step.tone])} />
                <span className="w-24 shrink-0 truncate text-white/60">{step.who}</span>
                <span className="min-w-0 flex-1 truncate">{step.what}</span>
                <span className="shrink-0 text-white/60">{step.rule}</span>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-[13px] text-white/55">{p.foot}</p>
      </div>
    </aside>
  );
}

/** The mark people know each sign-in provider by. */
function ProviderMark({ id }: { id: string }) {
  if (id === "microsoft")
    return (
      <svg aria-hidden="true" viewBox="0 0 21 21" className="size-[18px] shrink-0">
        <rect x="1" y="1" width="9" height="9" fill="#f25022" />
        <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
        <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
        <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
      </svg>
    );
  if (id === "google")
    return (
      <svg aria-hidden="true" viewBox="0 0 48 48" className="size-[18px] shrink-0">
        <path
          fill="#EA4335"
          d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.2C12.4 13.7 17.7 9.5 24 9.5z"
        />
        <path
          fill="#4285F4"
          d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.500-4.800 7.200l7.700 6c4.500-4.200 6.900-10.300 6.900-17.700z"
        />
        <path
          fill="#FBBC05"
          d="M10.500 28.600c-.5-1.400-.8-3-.8-4.600s.3-3.200.8-4.600l-7.900-6.200C.900 16.500 0 20.100 0 24s.900 7.500 2.600 10.800l7.900-6.200z"
        />
        <path
          fill="#34A853"
          d="M24 48c6.500 0 11.900-2.100 15.900-5.800l-7.700-6c-2.100 1.400-4.900 2.300-8.200 2.300-6.300 0-11.600-4.200-13.500-9.900l-7.900 6.200C6.500 42.600 14.600 48 24 48z"
        />
      </svg>
    );
  // The three services a company's people already work in: each by its colour and the
  // first character of its name, which is how its people tell them apart.
  const tile = {
    feishu: ["#3370ff", "飞"],
    lark: ["#3370ff", "L"],
    wecom: ["#0f8be8", "企"],
    dingtalk: ["#1677ff", "钉"],
  }[id];
  if (tile)
    return (
      <span
        aria-hidden="true"
        className="grid size-[22px] shrink-0 place-items-center rounded-md text-[12px] leading-none font-semibold text-white"
        style={{ background: tile[0] }}
      >
        {tile[1]}
      </span>
    );
  return <KeyRoundIcon aria-hidden="true" className="size-[18px] shrink-0 text-muted-foreground" />;
}

function Login({ failure }: { failure: string | null }) {
  const { t } = useI18n();
  const [providers, setProviders] = useState<{ id: string; label: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const code = new URLSearchParams(location.search).get("error");
  const error = failure ?? (code ? (t.login.errors[code] ?? t.login.errors.failed) : null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let over = false;
    const ask = () =>
      api<{ id: string; label: string }[]>("/auth/providers").then(
        (list) => !over && setProviders(list),
        (error: unknown) => {
          if (over) return;
          // Shown as not loaded, and asked for again while the server may only be starting.
          setProviders([]);
          if (away(error)) timer = setTimeout(ask, 3000);
        },
      );
    void ask();
    return () => {
      over = true;
      clearTimeout(timer);
    };
  }, []);
  // In the desktop app the person signs in in their own browser, never inside the app's window.
  const [waiting, setWaiting] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  // Each press is its own attempt: the app drops the one before it, whose late answer is ignored.
  const attempt = useRef(0);
  const go = async (provider?: string) => {
    if (desktop) {
      const mine = ++attempt.current;
      setGaveUp(false);
      setWaiting(true);
      const done = await desktop.signIn(provider).catch(() => false);
      if (done) return location.reload();
      if (mine !== attempt.current) return;
      setWaiting(false);
      setGaveUp(true);
      return;
    }
    if (!provider) return;
    setBusy(true);
    // Signing in leaves the page; remember where the person was headed.
    sessionStorage.setItem(RETURN_KEY, location.hash);
    location.assign(`/auth/login/${provider}`);
  };
  return (
    <Shell>
      <Mark className="size-12" />
      <div className="grid gap-1.5">
        <h1 className="text-[32px] leading-tight font-semibold tracking-tight">{t.login.title}</h1>
        <Lead className="text-[15px] text-muted-foreground">
          {waiting ? t.login.waitingBrowser : t.login.lead}
        </Lead>
      </div>
      {(error || gaveUp) && (
        <p className="w-full rounded-2xl border border-destructive/30 bg-destructive/6 px-4 py-3 text-left text-sm text-destructive">
          {error ?? t.login.browserFailed}
        </p>
      )}
      <div className="grid w-full gap-3 empty:hidden">
        {/* Each company account is a button with that provider's own mark, as people know it. */}
        {providers
          ?.filter((provider) => provider.id !== "dev")
          .map((provider) => (
            <button
              type="button"
              key={provider.id}
              disabled={busy}
              onClick={() => void go(provider.id)}
              className="relative flex h-[52px] w-full items-center justify-center rounded-full border border-foreground/15 bg-card px-12 text-[15px] font-medium transition-colors outline-none hover:border-foreground/30 hover:bg-foreground/[0.04] focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60"
            >
              <span className="absolute left-5 grid place-items-center">
                <ProviderMark id={provider.id} />
              </span>
              {t.login.with(
                provider.id === "oidc"
                  ? provider.label
                  : (t.providers[provider.id] ?? provider.label),
              )}
            </button>
          ))}
        {providers?.length === 0 && (
          <p className="text-sm text-muted-foreground">{t.login.noProviders}</p>
        )}
        {desktop && providers?.length === 0 && (
          // The list could not be read: the server's own page in the browser offers the choice.
          <Button size="lg" className="h-[52px] w-full rounded-full" onClick={() => void go()}>
            {t.login.withBrowser}
          </Button>
        )}
      </div>
      {providers?.some((provider) => provider.id !== "dev") && (
        <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <LockIcon className="size-3.5 shrink-0" />
          {desktop ? t.login.ssoBrowser : t.login.sso}
        </p>
      )}
      {providers?.some((provider) => provider.id === "dev") && (
        // Exists only on a developer's own machine, and is kept apart so it is never taken for a way in.
        <div className="grid w-full gap-3">
          <div className="flex items-center gap-3 text-[11px] tracking-wide text-muted-foreground uppercase">
            <span className="h-px flex-1 bg-border" />
            {t.login.devOnly}
            <span className="h-px flex-1 bg-border" />
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void go("dev")}
            className="flex h-[52px] w-full items-center justify-center rounded-full border border-dashed border-foreground/20 px-6 text-[15px] font-medium text-muted-foreground transition-colors outline-none hover:border-foreground/40 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60"
          >
            {t.login.with(t.login.devProvider)}
          </button>
        </div>
      )}
      {desktop && (
        <Button
          variant="ghost"
          size="sm"
          className="justify-self-start"
          onClick={() => void desktop?.changeServer()}
        >
          {t.login.changeServer}
        </Button>
      )}
    </Shell>
  );
}

function NoAccess({ me }: { me: Me }) {
  const { t } = useI18n();
  return (
    <Shell>
      <Mark className="size-12" />
      <div className="grid gap-1.5">
        <h1 className="text-[32px] leading-tight font-semibold tracking-tight">
          {t.login.signedInTitle}
        </h1>
        <p className="text-[15px] text-muted-foreground">
          {t.login.noAccess(address(me.user.email) || me.user.name, me.org.name, t.roles[me.role])}
        </p>
      </div>
      <div className="grid gap-3">
        <Button className="h-[52px] w-full rounded-full text-[15px]" onClick={() => goApp("")}>
          {t.app.backToApp}
        </Button>
        <Button
          variant="outline"
          className="h-[52px] w-full rounded-full text-[15px]"
          onClick={() => void signOut()}
        >
          {t.settings.signOut}
        </Button>
      </div>
    </Shell>
  );
}

function Console({ me, path }: { me: Me; path: string[] }) {
  const { t } = useI18n();
  const [page, rest] = route(path);
  const [menu, setMenu] = useState(false);
  // The page scrolls inside the frame, so the frame is what the keyboard must reach: a new
  // page starts at its top with the keys (arrows, Page Down, Space) already working on it.
  const frame = useRef<HTMLDivElement>(null);
  const here = path.join("/");
  // biome-ignore lint/correctness/useExhaustiveDependencies: moving to another page closes the menu
  useEffect(() => setMenu(false), [here]);
  const visible = (item: NavItem) =>
    !item.needs || me.permissions.includes(item.needs) || item.orRole === me.role;
  const allowed: Page = all.some((item) => item.id === page && visible(item)) ? page : "overview";
  // Alerts nobody has acknowledged yet, counted beside the page that lists them. Asked
  // again every minute, as often as the rules themselves are.
  const [alerts, setAlerts] = useState(0);
  const seesAlerts = me.permissions.includes("settings.read");
  const countAlerts = useCallback(() => {
    if (!seesAlerts) return;
    void api<{ open: number }>("/api/alerts/count").then(
      (count) => setAlerts(count.open),
      () => undefined,
    );
  }, [seesAlerts]);
  useEffect(() => {
    countAlerts();
    const timer = setInterval(countAlerts, 60_000);
    return () => clearInterval(timer);
  }, [countAlerts]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: it is the change of page that moves it
  useEffect(() => {
    const scroller = frame.current;
    if (!scroller) return;
    scroller.scrollTop = 0;
    scroller.focus({ preventScroll: true });
  }, [allowed]);

  const sidebar = (
    <nav className="flex h-full flex-col gap-5 overflow-y-auto p-3">
      <div className="flex items-center gap-2.5 px-2 pt-1">
        <Mark className="size-8" />
        <span className="text-[15px] font-semibold tracking-tight">Muster</span>
        <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
          {t.nav.admin}
        </span>
      </div>
      {nav.map((group) => {
        const items = group.items.filter(visible);
        if (items.length === 0) return null;
        return (
          <div key={group.group} className="grid gap-0.5">
            <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">
              {t.nav.groups[group.group]}
            </p>
            {items.map((item) => (
              <button
                type="button"
                key={item.id}
                onClick={() => go(item.id)}
                aria-current={allowed === item.id ? "page" : undefined}
                className={cn(
                  "flex h-9 items-center gap-2.5 rounded-lg px-2 text-sm transition-colors hover:bg-accent",
                  allowed === item.id && "bg-accent font-medium",
                )}
              >
                <item.icon className="size-4 text-muted-foreground" />
                <span className="flex-1 truncate text-left">{t.nav[item.id]}</span>
                {item.id === "alerts" && alerts > 0 && (
                  <span className="num rounded-full bg-warn/14 px-1.5 text-xs font-medium text-warn">
                    {alerts}
                  </span>
                )}
              </button>
            ))}
          </div>
        );
      })}
      <div className="mt-auto grid gap-2 border-t pt-3">
        <a
          href="#/"
          className="flex h-9 items-center gap-2.5 rounded-lg px-2 text-sm transition-colors hover:bg-accent"
        >
          <ArrowLeftIcon className="size-4 text-muted-foreground" />
          {t.app.backToApp}
        </a>
        <p className="truncate px-2 text-xs text-muted-foreground">{me.org.name}</p>
      </div>
    </nav>
  );

  return (
    // The console is a frame that stays put: the page inside it scrolls, the frame and the
    // sidebar do not. When the whole document scrolled, the frame's edges slid under the
    // header and the page could be pulled past its ends.
    // `data-dense`: everything in the console sits close (index.css, the `dense` variant).
    <div data-dense className="flex h-dvh overflow-hidden bg-sidebar">
      <aside className="app-lights hidden h-full w-56 shrink-0 md:block">{sidebar}</aside>
      <Sheet open={menu} onOpenChange={setMenu}>
        <SheetContent side="left" className="app-lights bg-sidebar p-0">
          <SheetTitle className="sr-only">{t.nav.open}</SheetTitle>
          {sidebar}
        </SheetContent>
      </Sheet>
      <div className="h-full min-w-0 flex-1 md:py-2 md:pr-2">
        <div
          ref={frame}
          tabIndex={-1}
          className="h-full overflow-y-auto overscroll-contain bg-background outline-none md:rounded-xl md:border md:shadow-xs"
        >
          <header className="app-drag sticky top-0 z-10 flex h-11 items-center gap-2 border-b bg-background/85 px-4 backdrop-blur md:rounded-t-xl">
            <Button
              variant="ghost"
              size="icon"
              className="-ml-2 md:hidden"
              onClick={() => setMenu(true)}
              aria-label={t.nav.open}
            >
              <MenuIcon />
            </Button>
            <h1 className="truncate text-sm font-medium">{t.nav[allowed]}</h1>
            <div className="ml-auto flex items-center gap-1">
              <Preferences />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="gap-2">
                    <span className="hidden max-w-40 truncate lg:inline">
                      {me.user.name || me.user.email}
                    </span>
                    <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
                      {t.roles[me.role]}
                    </span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {address(me.user.email) && (
                    <>
                      <div className="px-2 py-1.5 text-xs text-muted-foreground">
                        {me.user.email}
                      </div>
                      <DropdownMenuSeparator />
                    </>
                  )}
                  <DropdownMenuItem onSelect={() => void signOut()}>
                    <LogOutIcon />
                    {t.settings.signOut}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>
          <main className="grid gap-3 p-4">
            {allowed === "overview" ? (
              <OverviewPage me={me} />
            ) : allowed === "alerts" ? (
              <AlertsPage me={me} onChange={countAlerts} />
            ) : allowed === "members" ? (
              <MembersPage me={me} />
            ) : allowed === "departments" ? (
              <DepartmentsPage me={me} />
            ) : allowed === "security" ? (
              <SecurityPage me={me} />
            ) : allowed === "audit" ? (
              <AuditPage me={me} />
            ) : allowed === "retention" ? (
              <RetentionPage me={me} />
            ) : allowed === "agents" ? (
              <AgentsPage me={me} />
            ) : allowed === "traces" ? (
              <TracesPage me={me} path={rest} />
            ) : allowed === "usage" ? (
              <UsagePage me={me} />
            ) : allowed === "policies" ? (
              <PoliciesPage me={me} />
            ) : allowed === "market" ? (
              <MarketPage me={me} />
            ) : allowed === "connections" ? (
              <ConnectionsPage me={me} />
            ) : allowed === "sandbox" ? (
              <SandboxPage />
            ) : (
              <ModelsPage />
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
