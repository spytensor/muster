import { createContext, type ReactNode, useContext, useMemo } from "react";
import { ApiError } from "../lib/api";
import { en, type Messages } from "./en";
import { zh } from "./zh";

/** Every language the app speaks. To add one, write its messages file and list it here. */
export const LOCALES = {
  en: { messages: en },
  zh: { messages: zh },
} as const satisfies Record<string, { messages: Messages }>;
export type Locale = keyof typeof LOCALES;
export const DEFAULT_LOCALE: Locale = "en";
export const isLocale = (value: unknown): value is Locale =>
  typeof value === "string" && value in LOCALES;

export interface I18n {
  locale: Locale;
  t: Messages;
  /** The message for a failed request or thrown error, in the current language. */
  errorText(failure: unknown): string;
  /** How long ago something happened, in a few words. */
  ago(iso: string): string;
}

const Context = createContext<I18n | null>(null);

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const value = useMemo<I18n>(() => {
    const t = LOCALES[locale].messages;
    return {
      locale,
      t,
      errorText(failure) {
        if (failure instanceof ApiError)
          return failure.status === 0
            ? t.common.network
            : (t.errors[failure.code] ?? (failure.message || t.common.failed));
        return t.common.failed;
      },
      ago(iso) {
        const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
        if (minutes < 1) return t.time.now;
        if (minutes < 60) return t.time.minutes(minutes);
        if (minutes < 60 * 24) return t.time.hours(Math.round(minutes / 60));
        if (minutes < 60 * 24 * 30) return t.time.days(Math.round(minutes / 1440));
        return iso.slice(0, 10);
      },
    };
  }, [locale]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useI18n(): I18n {
  const value = useContext(Context);
  if (!value) throw new Error("useI18n needs an I18nProvider");
  return value;
}
