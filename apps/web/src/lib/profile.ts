import { useSyncExternalStore } from "react";
import { api } from "./api";

/**
 * A person's profile, as the server keeps it (apps/server/src/profile.ts): how they work,
 * the same on every device. This browser used to keep language, appearance, the agent for
 * new conversations and what to be told of for itself; those are now copies of what the
 * server holds, kept here so the page can start in the right language before it has asked.
 */
export interface Ways {
  locale: "en" | "zh" | null;
  theme: "system" | "light" | "dark" | null;
  defaultAgent: string | null;
  notify: { approvals?: boolean; replies?: boolean } | null;
  timezone: string | null;
  workDays: number[] | null;
  workStart: string | null;
  workEnd: string | null;
  answerStyle: string | null;
  signature: string | null;
}
export interface Profile {
  identity: {
    name: string;
    email: string;
    org: string;
    role: string;
    department: string | null;
  };
  ways: Ways;
  /** The time zone in use: the one fixed, or this device's. */
  zone: string;
  limits: { answerStyle: number; signature: number };
}

/** Where this browser keeps its copies. The same names it used when they were the only ones. */
export const LOCAL = {
  locale: "muster.locale",
  theme: "muster.theme",
  agent: "muster.agent",
  notify: (kind: "approvals" | "replies") => `muster.notify.${kind}`,
  /** Set once this browser's old choices have been sent up. */
  carried: "muster.profile.carried",
} as const;

let current: Profile | null = null;
const listeners = new Set<() => void>();
const publish = (profile: Profile) => {
  current = profile;
  for (const listener of listeners) listener();
};
/** The profile once it has been read; null before, and for someone not signed in. */
export const useProfile = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );

/** What this browser had chosen before the server kept it, for the one time it is sent up. */
function own(): Partial<Ways> {
  const locale = localStorage.getItem(LOCAL.locale);
  const theme = localStorage.getItem(LOCAL.theme);
  const agent = localStorage.getItem(LOCAL.agent);
  const notify: NonNullable<Ways["notify"]> = {};
  for (const kind of ["approvals", "replies"] as const) {
    const said = localStorage.getItem(LOCAL.notify(kind));
    if (said) notify[kind] = said !== "off";
  }
  return {
    ...(locale === "en" || locale === "zh" ? { locale } : {}),
    ...(theme === "light" || theme === "dark" ? { theme } : {}),
    ...(agent ? { defaultAgent: agent } : {}),
    ...(Object.keys(notify).length ? { notify } : {}),
  };
}

/** Writes what the server holds into this browser's copies. A field never chosen leaves the copy as it is. */
function keep(ways: Ways): void {
  if (ways.locale) localStorage.setItem(LOCAL.locale, ways.locale);
  if (ways.theme === "system") localStorage.removeItem(LOCAL.theme);
  else if (ways.theme) localStorage.setItem(LOCAL.theme, ways.theme);
  if (ways.defaultAgent) localStorage.setItem(LOCAL.agent, ways.defaultAgent);
  for (const kind of ["approvals", "replies"] as const) {
    const on = ways.notify?.[kind];
    if (on !== undefined) localStorage.setItem(LOCAL.notify(kind), on ? "on" : "off");
  }
}

/**
 * Reads the person's profile when they are signed in. The first time in this browser, what
 * it had chosen for itself is sent up, and kept by the server only where the person had
 * not chosen yet; after that the server's is what holds, here as everywhere.
 */
export async function syncProfile(): Promise<Profile> {
  let profile: Profile;
  if (localStorage.getItem(LOCAL.carried)) profile = await api<Profile>("/api/app/profile");
  else {
    profile = await api<Profile>("/api/app/profile/carry", { method: "POST", body: own() });
    localStorage.setItem(LOCAL.carried, "1");
  }
  keep(profile.ways);
  publish(profile);
  return profile;
}

/** Changes the profile and answers with it as it now is. Throws what the server refused. */
export async function saveProfile(change: Partial<Ways>): Promise<Profile> {
  const profile = await api<Profile>("/api/app/profile", { method: "PATCH", body: change });
  keep(profile.ways);
  publish(profile);
  return profile;
}

/**
 * Tells the server of a choice made with one of the page's own controls (the language
 * menu, the appearance menu, …), which have already taken effect here. Nothing is sent
 * before the person is signed in and their profile has been read: the sign-in page's
 * language menu is this browser's alone.
 */
export function pushWays(change: Partial<Ways>): void {
  if (!current) return;
  void saveProfile(change).catch(() => undefined);
}

/** A mail's body with the person's signature under it, unless it already ends with it. */
export const signed = (body: string, signature: string) =>
  !signature || body.trimEnd().endsWith(signature) ? body : `${body.trimEnd()}\n\n${signature}`;
/**
 * A mail's body without the signature under it: what may be handed back to an agent that
 * is asked to work on the mail again. The signature is the person's and is never given to
 * a model; it is put back by the card when the agent's new draft arrives.
 */
export const unsigned = (body: string, signature: string) =>
  signature && body.trimEnd().endsWith(signature)
    ? body.trimEnd().slice(0, -signature.length).trimEnd()
    : body;
