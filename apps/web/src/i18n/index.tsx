import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { ApiError } from "@/lib/api";
import { pushWays } from "@/lib/profile";
import { en, type Messages } from "./en";
import { zh } from "./zh";

/** Registered languages. The first is the default. */
export const LOCALES = {
  en: { messages: en, tag: "en-US" },
  zh: { messages: zh, tag: "zh-CN" },
} as const;
export type Locale = keyof typeof LOCALES;
const STORAGE_KEY = "muster.locale";

function initialLocale(): Locale {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved && Object.hasOwn(LOCALES, saved) ? (saved as Locale) : "en";
}

export interface I18n {
  locale: Locale;
  setLocale(locale: Locale): void;
  t: Messages;
  /** The message for a failed request or thrown error, in the current language. */
  errorText(failure: unknown): string;
  dateTime(iso: string): string;
  date(iso: string): string;
  ago(iso: string | null): string;
  number(value: number): string;
  compact(value: number): string;
  /** Money stored as millionths of a US dollar. */
  money(micros: number, digits?: number): string;
  /** A calendar month, "2026-11", as people say it: "November 2026". */
  monthName(month: string): string;
  /** A duration in milliseconds, as "850 ms", "4.2 s" or "1 min 20 s". */
  duration(ms: number): string;
  percent(ratio: number): string;
}

const Context = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  useEffect(() => {
    document.documentElement.lang = LOCALES[locale].tag;
  }, [locale]);
  const value = useMemo<I18n>(() => {
    const { messages: t, tag } = LOCALES[locale];
    const dateTime = new Intl.DateTimeFormat(tag, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    const date = new Intl.DateTimeFormat(tag, { year: "numeric", month: "short", day: "numeric" });
    const relative = new Intl.RelativeTimeFormat(tag, { numeric: "auto", style: "short" });
    const number = new Intl.NumberFormat(tag);
    const compact = new Intl.NumberFormat(tag, { notation: "compact", maximumFractionDigits: 1 });
    const seconds = new Intl.NumberFormat(tag, { maximumFractionDigits: 1 });
    return {
      locale,
      setLocale(next) {
        localStorage.setItem(STORAGE_KEY, next);
        setLocaleState(next);
        // Theirs on every device, once they are signed in.
        pushWays({ locale: next });
      },
      t,
      errorText(failure) {
        if (failure instanceof ApiError)
          // What this page found out for itself, before the server was asked, is said in
          // its own words; only a request that went nowhere is the network's.
          return failure.status === 0
            ? failure.code === "file_not_readable"
              ? t.files.unreadableOne
              : t.common.network
            : (t.errors[failure.code] ?? failure.message);
        return t.common.failed;
      },
      dateTime: (iso) => dateTime.format(new Date(iso)),
      date: (iso) => date.format(new Date(iso)),
      ago(iso) {
        if (!iso) return t.common.never;
        const minutes = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
        if (Math.abs(minutes) < 60) return relative.format(minutes, "minute");
        if (Math.abs(minutes) < 60 * 24) return relative.format(Math.round(minutes / 60), "hour");
        if (Math.abs(minutes) < 60 * 24 * 30)
          return relative.format(Math.round(minutes / 1440), "day");
        return date.format(new Date(iso));
      },
      number: (value) => number.format(value),
      compact: (value) => compact.format(value),
      monthName: (month) =>
        /^\d{4}-\d{2}$/.test(month)
          ? new Intl.DateTimeFormat(tag, {
              month: "long",
              year: "numeric",
              timeZone: "UTC",
            }).format(new Date(`${month}-01T00:00:00Z`))
          : month,
      money: (micros, digits) =>
        new Intl.NumberFormat(tag, {
          style: "currency",
          currency: "USD",
          minimumFractionDigits: digits ?? 2,
          maximumFractionDigits: digits ?? 2,
        }).format(micros / 1_000_000),
      duration(ms) {
        if (ms < 1000) return `${Math.round(ms)} ms`;
        if (ms < 60_000) return `${seconds.format(ms / 1000)} s`;
        return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
      },
      percent: (ratio) =>
        new Intl.NumberFormat(tag, { style: "percent", maximumFractionDigits: 1 }).format(ratio),
    };
  }, [locale]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useI18n(): I18n {
  const value = useContext(Context);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
}
