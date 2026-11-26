import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Appearance } from "react-native";
import { forgetDownloads } from "./files";
import { DEFAULT_LOCALE, isLocale, type Locale } from "./i18n";
import { ApiError, api, connect } from "./lib/api";
import {
  APP_REDIRECT,
  challengeFromBase64,
  codeFrom,
  serverUrlFrom,
  startUrl,
  verifierFrom,
} from "./lib/pkce";
import { carried, type Profile, taken, type Ways } from "./lib/profile";
import type { Me } from "./lib/types";

export type AppearanceChoice = "system" | "light" | "dark";
const isAppearance = (value: unknown): value is AppearanceChoice =>
  value === "system" || value === "light" || value === "dark";

const KEYS = {
  token: "muster.token",
  server: "muster.server",
  locale: "muster.locale",
  appearance: "muster.appearance",
  /** Set once this phone's old choices have been sent up to the person's profile. */
  carried: "muster.profile.carried",
  agent: "muster.agent",
} as const;

/** The session token never leaves this device (no backup, no transfer) and is readable only while it is unlocked. */
const GUARDED = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

const configured = (Constants.expoConfig?.extra as { serverUrl?: string } | undefined)?.serverUrl;
export const DEFAULT_SERVER = serverUrlFrom(configured ?? "") ?? "http://localhost:7420";

export interface Session {
  /** `starting` while storage is read; `unreachable` when signed in but the server did not answer. */
  status: "starting" | "signedOut" | "signedIn" | "unreachable";
  server: string;
  me: Me | null;
  locale: Locale;
  appearance: AppearanceChoice;
  /** The agent a new conversation starts with, or null for the first one offered. */
  defaultAgent: string | null;
  setDefaultAgent(id: string | null): void;
  /** How the person works, as the server holds it; null until it has been read. Never stored on the phone. */
  profile: Profile | null;
  /** Changes how the person works. Rejects with what the server refused. */
  saveWays(change: Partial<Ways>): Promise<void>;
  /** Opens the system browser to sign in. Resolves to false if the person cancelled. */
  signIn(): Promise<boolean>;
  signOut(): Promise<void>;
  /** Checks the stored session against the server again. */
  retry(): void;
  setServer(url: string): Promise<void>;
  setLocale(locale: Locale): void;
  setAppearance(choice: AppearanceChoice): void;
}

const Context = createContext<Session | null>(null);

const applyAppearance = (choice: AppearanceChoice) =>
  // Null hands the choice back to the system.
  Appearance.setColorScheme(choice === "system" ? null : choice);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Session["status"]>("starting");
  const [server, setServerState] = useState(DEFAULT_SERVER);
  const [token, setToken] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);
  const [appearance, setAppearanceState] = useState<AppearanceChoice>("system");
  const [defaultAgent, setDefaultAgentState] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [attempt, setAttempt] = useState(0);

  const forget = useCallback(() => {
    void SecureStore.deleteItemAsync(KEYS.token);
    // Nothing of the person's stays on the device after they sign out.
    void SecureStore.deleteItemAsync(KEYS.agent);
    void forgetDownloads();
    setDefaultAgentState(null);
    setProfile(null);
    setToken(null);
    setMe(null);
    setStatus("signedOut");
  }, []);
  // Every request reads the current server and token; a 401 anywhere comes back here.
  const signedOut = useRef(forget);
  signedOut.current = forget;
  connect(server, token, () => signedOut.current());

  // Start: read what was kept, then ask the server who this is.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs at start and on each retry
  useEffect(() => {
    let cancelled = false;
    // Anything left from a viewer that was open when the app was closed.
    void forgetDownloads();
    void (async () => {
      const [storedToken, storedServer, storedLocale, storedAppearance, storedAgent] =
        await Promise.all([
          SecureStore.getItemAsync(KEYS.token),
          SecureStore.getItemAsync(KEYS.server),
          SecureStore.getItemAsync(KEYS.locale),
          SecureStore.getItemAsync(KEYS.appearance),
          SecureStore.getItemAsync(KEYS.agent),
        ]).catch(() => [null, null, null, null, null]);
      if (cancelled) return;
      const address = serverUrlFrom(storedServer ?? "") ?? DEFAULT_SERVER;
      setServerState(address);
      if (isLocale(storedLocale)) setLocaleState(storedLocale);
      if (isAppearance(storedAppearance)) {
        setAppearanceState(storedAppearance);
        applyAppearance(storedAppearance);
      }
      setDefaultAgentState(storedAgent ?? null);
      if (!storedToken) {
        setStatus("signedOut");
        return;
      }
      setToken(storedToken);
      try {
        const who = await api<Me>("/api/me", { server: address, token: storedToken });
        if (cancelled) return;
        setMe(who);
        setStatus("signedIn");
      } catch (failure) {
        if (cancelled) return;
        if (failure instanceof ApiError && failure.status === 401) forget();
        else setStatus("unreachable");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const signIn = useCallback(async () => {
    const verifier = verifierFrom(Crypto.getRandomBytes(32));
    const challenge = challengeFromBase64(
      await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, {
        encoding: Crypto.CryptoEncoding.BASE64,
      }),
    );
    const result = await WebBrowser.openAuthSessionAsync(startUrl(server, challenge), APP_REDIRECT);
    if (result.type !== "success") return false;
    const code = codeFrom(result.url);
    if (!code) throw new ApiError(401, "unauthenticated", "");
    const granted = await api<{ token: string }>("/auth/app/token", {
      method: "POST",
      body: { code, verifier },
      server,
      token: null,
    });
    const who = await api<Me>("/api/me", { server, token: granted.token });
    await SecureStore.setItemAsync(KEYS.token, granted.token, GUARDED);
    setToken(granted.token);
    setMe(who);
    setStatus("signedIn");
    return true;
  }, [server]);

  const signOut = useCallback(async () => {
    // Ends the session on the server too; signing out works even if the server cannot be reached.
    await api("/auth/logout", { method: "POST" }).catch(() => undefined);
    forget();
  }, [forget]);

  // How the person works is theirs on every device (the server's profile). Once signed in,
  // the phone sends up what it had chosen for itself, the first time only, and takes what
  // the server holds; after that a choice made here is told to the server as it is made.
  const signedInNow = status === "signedIn";
  const push = useCallback(
    (change: Partial<Ways>) => {
      if (!signedInNow) return;
      void api("/api/app/profile", { method: "PATCH", body: change }).catch(() => undefined);
    },
    [signedInNow],
  );
  useEffect(() => {
    if (!signedInNow) return;
    let cancelled = false;
    void (async () => {
      const [done, storedLocale, storedAppearance, storedAgent] = await Promise.all([
        SecureStore.getItemAsync(KEYS.carried),
        SecureStore.getItemAsync(KEYS.locale),
        SecureStore.getItemAsync(KEYS.appearance),
        SecureStore.getItemAsync(KEYS.agent),
      ]);
      const profile = done
        ? await api<Profile>("/api/app/profile")
        : await api<Profile>("/api/app/profile/carry", {
            method: "POST",
            body: carried({
              locale: storedLocale,
              appearance: storedAppearance,
              agent: storedAgent,
            }),
          });
      if (!done) await SecureStore.setItemAsync(KEYS.carried, "1");
      if (cancelled) return;
      setProfile(profile);
      const now = taken(profile.ways);
      if (isLocale(now.locale)) {
        setLocaleState(now.locale);
        void SecureStore.setItemAsync(KEYS.locale, now.locale);
      }
      if (isAppearance(now.appearance)) {
        setAppearanceState(now.appearance);
        applyAppearance(now.appearance);
        void SecureStore.setItemAsync(KEYS.appearance, now.appearance);
      }
      if (now.agent) {
        setDefaultAgentState(now.agent);
        void SecureStore.setItemAsync(KEYS.agent, now.agent);
      }
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [signedInNow]);

  const value = useMemo<Session>(
    () => ({
      status,
      server,
      me,
      locale,
      appearance,
      defaultAgent,
      setDefaultAgent(id) {
        setDefaultAgentState(id);
        void (id
          ? SecureStore.setItemAsync(KEYS.agent, id)
          : SecureStore.deleteItemAsync(KEYS.agent));
        push({ defaultAgent: id });
      },
      profile,
      async saveWays(change) {
        setProfile(await api<Profile>("/api/app/profile", { method: "PATCH", body: change }));
      },
      signIn,
      signOut,
      retry: () => {
        setStatus("starting");
        setAttempt((n) => n + 1);
      },
      async setServer(url) {
        await SecureStore.setItemAsync(KEYS.server, url);
        setServerState(url);
      },
      setLocale(next) {
        setLocaleState(next);
        void SecureStore.setItemAsync(KEYS.locale, next);
        push({ locale: next });
      },
      setAppearance(choice) {
        setAppearanceState(choice);
        applyAppearance(choice);
        void SecureStore.setItemAsync(KEYS.appearance, choice);
        push({ theme: choice });
      },
    }),
    [status, server, me, locale, appearance, defaultAgent, profile, signIn, signOut, push],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useSession(): Session {
  const value = useContext(Context);
  if (!value) throw new Error("useSession needs a SessionProvider");
  return value;
}
