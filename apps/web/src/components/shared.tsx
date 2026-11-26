import {
  AlertTriangleIcon,
  ArrowDownRightIcon,
  ArrowUpRightIcon,
  CheckCircle2Icon,
  InfoIcon,
} from "lucide-react";
import {
  type DependencyList,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useI18n } from "@/i18n";
import type { Level, Risk, Role } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Lead } from "@/components/ui/hint";

export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("shrink-0", className)} aria-hidden="true">
      <rect width="32" height="32" rx="9" className="fill-primary" />
      <g className="fill-primary-foreground">
        <circle cx="10" cy="11" r="2.2" />
        <circle cx="10" cy="21" r="2.2" />
        <rect x="15" y="9.4" width="9" height="3.2" rx="1.6" />
        <rect x="15" y="19.4" width="9" height="3.2" rx="1.6" opacity=".55" />
      </g>
    </svg>
  );
}

export function Notice({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "bad" | "ok";
  title?: string;
  children: ReactNode;
}) {
  const Icon = tone === "bad" ? AlertTriangleIcon : tone === "ok" ? CheckCircle2Icon : InfoIcon;
  return (
    <div
      className={cn(
        "flex gap-3 rounded-xl border px-4 py-3 text-sm",
        tone === "bad" && "border-destructive/30 bg-destructive/6 text-destructive",
        tone === "ok" && "border-ok/30 bg-ok/6",
        tone === "info" && "bg-muted",
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="grid gap-0.5">
        {title && <p className="font-medium">{title}</p>}
        <div className={cn(title && "text-foreground/80")}>{children}</div>
      </div>
    </div>
  );
}

/** A headline number. `delta` is the change against the previous period; `goodWhenUp` says which direction is good. */
export function Kpi({
  label,
  value,
  hint,
  tone,
  delta,
  goodWhenUp = true,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "ok" | "bad" | "warn";
  delta?: number | null;
  goodWhenUp?: boolean;
}) {
  const { percent, t } = useI18n();
  const shown =
    delta !== undefined && delta !== null && Number.isFinite(delta) && Math.abs(delta) >= 0.005;
  const good = shown && delta > 0 === goodWhenUp;
  return (
    <Card className="gap-3 bg-gradient-to-t from-muted/70 to-card dense:gap-1">
      {/* A figure and its name are two lines by nature: the one header that stays stacked. */}
      <CardHeader className="dense:grid dense:gap-0">
        <CardDescription>{label}</CardDescription>
        <CardTitle
          className={cn(
            "text-2xl font-semibold tracking-tight dense:text-xl",
            tone === "ok" && "text-ok",
            tone === "bad" && "text-destructive",
            tone === "warn" && "text-warn",
          )}
        >
          {value}
        </CardTitle>
        {shown && (
          <CardAction>
            <span
              className={cn(
                "inline-flex items-center gap-0.5 rounded-full border px-2 py-0.5 text-xs",
                good ? "text-ok" : "text-destructive",
              )}
              title={t.dashboard.vsPrevious}
            >
              {delta > 0 ? (
                <ArrowUpRightIcon className="size-3" />
              ) : (
                <ArrowDownRightIcon className="size-3" />
              )}
              {percent(Math.abs(delta))}
            </span>
          </CardAction>
        )}
      </CardHeader>
      {hint && (
        <CardFooter className="text-sm text-muted-foreground dense:text-xs">{hint}</CardFooter>
      )}
    </Card>
  );
}

/**
 * A setting, or a fact, in the console: one row. Its name at the left, what it is beside
 * the name in muted words (as much as fits; the whole is behind the mark when it does not),
 * the control or the value at the right. Never a second line under the name; what is wrong
 * with it, when something is, goes in `below` (docs/features/README.md, "How close a
 * console page sits").
 */
export function SettingRow({
  label,
  lead,
  children,
  below,
  className,
}: {
  label: ReactNode;
  lead?: string | false | null;
  children?: ReactNode;
  /** State that has to be read: an error, a notice. Shown under the row only when given. */
  below?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("border-b last:border-b-0", className)}>
      <div className="flex min-h-9 items-center gap-3 py-1">
        <span className="shrink-0 text-[13px] font-medium">{label}</span>
        {lead ? (
          <Lead as="span" className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {lead}
          </Lead>
        ) : (
          <span className="flex-1" />
        )}
        {children !== undefined && (
          <div className="flex shrink-0 items-center gap-2 text-right text-[13px]">{children}</div>
        )}
      </div>
      {below}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="px-5 py-10 text-center text-sm text-muted-foreground dense:px-3.5 dense:py-2 dense:text-left dense:text-[13px]">
      {children}
    </p>
  );
}

const roleVariant: Record<Role, "default" | "secondary" | "outline" | "muted"> = {
  owner: "default",
  admin: "secondary",
  auditor: "outline",
  billing: "outline",
  member: "muted",
};
export function RoleBadge({ role }: { role: Role }) {
  const { t } = useI18n();
  return <Badge variant={roleVariant[role]}>{t.roles[role]}</Badge>;
}

/** How serious a level is, as a colour: nothing to notice, ordinary, look at this, stop. */
const tones = {
  quiet: { bar: "bg-muted-foreground", text: "text-muted-foreground" },
  plain: { bar: "bg-foreground", text: "text-foreground" },
  warn: { bar: "bg-warn", text: "font-medium text-warn" },
  grave: { bar: "bg-destructive", text: "font-medium text-destructive" },
} as const;
type Tone = keyof typeof tones;

/**
 * A level as a scale: four bars that fill as it rises. Down a column they read as a chart,
 * so the high ones are found without reading; the words beside them say what the level is.
 */
function Scale({ filled, tone }: { filled: number; tone: Tone }) {
  return (
    <span aria-hidden className="flex h-3.5 shrink-0 items-end gap-[2px]">
      {[0, 1, 2, 3].map((bar) => (
        <span
          key={bar}
          className={cn(
            "w-[3px] rounded-[1px]",
            bar < filled ? tones[tone].bar : "bg-foreground/15",
          )}
          style={{ height: `${40 + bar * 20}%` }}
        />
      ))}
    </span>
  );
}

const riskScale: Record<Risk, { filled: number; tone: Tone }> = {
  R1: { filled: 1, tone: "quiet" },
  R2: { filled: 2, tone: "plain" },
  R3: { filled: 3, tone: "warn" },
  R4: { filled: 4, tone: "grave" },
};
/** How far an agent can reach: the scale, the words, and the code for those who know it. */
export function RiskBadge({ risk }: { risk: Risk }) {
  const { t } = useI18n();
  const { filled, tone } = riskScale[risk];
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap text-[13px]">
      <Scale filled={filled} tone={tone} />
      <span className={tones[tone].text}>{t.risk[risk]}</span>
      <span className="num text-[11px] text-muted-foreground">{risk}</span>
    </span>
  );
}

const levelScale: Record<Level, { filled: number; tone: Tone }> = {
  A0: { filled: 0, tone: "quiet" },
  A1: { filled: 1, tone: "quiet" },
  A2: { filled: 2, tone: "plain" },
  A3: { filled: 3, tone: "warn" },
  A4: { filled: 4, tone: "grave" },
};
/**
 * How far one action reaches. `named` writes the words out ("Write in workspace"); without
 * it they are in the hint, for a table that already says them in the next column.
 */
export function LevelBadge({ level, named }: { level: Level; named?: boolean }) {
  const { t } = useI18n();
  const { filled, tone } = levelScale[level];
  return (
    <span
      className="inline-flex items-center gap-2 whitespace-nowrap text-[13px]"
      title={named ? undefined : t.level[level]}
    >
      {named && <span className={tones[tone].text}>{t.level[level]}</span>}
      <Scale filled={filled} tone={tone} />
      <span className={cn("num text-[11px]", named ? "text-muted-foreground" : tones[tone].text)}>
        {level}
      </span>
    </span>
  );
}

export function Dot({ className }: { className?: string }) {
  return <span className={cn("size-1.5 rounded-full bg-current", className)} />;
}

/** Initials on a quiet disc; people here rarely have a picture. */
export function Avatar({
  name,
  email,
  className,
}: {
  name: string;
  email: string;
  className?: string;
}) {
  const text = (name || email).trim();
  const words = text.split(/[\s.@_-]+/).filter(Boolean);
  const initials = /[一-鿿]/.test(text)
    ? text.slice(-2)
    : ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? words[0]?.[1] ?? "")).toUpperCase();
  return (
    <span
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-full bg-secondary text-xs font-medium text-muted-foreground dense:size-6 dense:text-[10px]",
        className,
      )}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}

export function Person({ name, email }: { name: string; email: string }) {
  return (
    // In the console a person is one line: the name, then the address beside it, muted.
    <div className="flex min-w-0 items-center gap-3 dense:gap-2">
      <Avatar name={name} email={email} />
      <div className="grid min-w-0 dense:flex dense:items-baseline dense:gap-2">
        <span className="font-medium dense:shrink-0">{name || email}</span>
        {name && (
          <span className="text-xs text-muted-foreground dense:max-w-56 dense:truncate">
            {email}
          </span>
        )}
      </div>
    </div>
  );
}

/** Runs one action with its own busy state and readable error. */
export function useAction() {
  const { errorText } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      return await action();
    } catch (failure) {
      setError(errorText(failure));
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run, setError };
}

/** Loads data for a page, again whenever `deps` change, and exposes a reload. Keeps showing the last data while reloading. */
export function useLoad<T>(load: () => Promise<T>, deps: DependencyList = []) {
  const { errorText } = useI18n();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loader = useRef(load);
  loader.current = load;
  const translate = useRef(errorText);
  translate.current = errorText;
  const latest = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++latest.current;
    setLoading(true);
    try {
      const result = await loader.current();
      // A slower, older request must not overwrite a newer one.
      if (mine !== latest.current) return;
      setData(result);
      setError(null);
    } catch (failure) {
      if (mine === latest.current) setError(translate.current(failure));
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload, ...deps]);
  return { data, error, loading, reload };
}

export function Loading() {
  const { t } = useI18n();
  return <p className="py-24 text-center text-sm text-muted-foreground">{t.common.loading}</p>;
}
