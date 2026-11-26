import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export interface ProviderConfig {
  id: "google" | "microsoft" | "oidc" | "dev";
  label: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Microsoft only: the directory (tenant) ID sign-ins must come from. */
  tenant?: string;
  /**
   * The company's own provider only: every account in it was given its address by the
   * company, so the address is believed even when the provider does not say it checked it.
   */
  trustEmail?: boolean;
  /** Every account in this provider is the company's own: its people are members by signing in. Needs trustEmail. */
  directory?: boolean;
}

export interface ModelConfig {
  /** Which wire protocol the endpoint speaks. */
  api: "anthropic" | "openai";
  id: string;
  baseUrl: string;
  apiKey: string;
  /** US dollars per million tokens, for the cost recorded on each run. */
  inputPrice: number;
  outputPrice: number;
  /** What a million prompt tokens cost when the service read them from its cache. Unset: the input price. */
  cachedInputPrice?: number;
  /** What a million prompt tokens cost when the service wrote them to its cache. Unset: the input price. */
  cacheWritePrice?: number;
  /** Whether the model can be shown images. */
  vision: boolean;
  /** Seconds the model may take before its first word. 180 when not set. */
  firstWordSeconds?: number;
  /** Seconds it may then say nothing before the call is given up. 90 when not set. */
  silenceSeconds?: number;
  /** The most a model may write in one go, in tokens. 16,000 when not set. */
  maxOutputTokens?: number;
  /** How much the model can be shown at once, in tokens. 128,000 when not set. A conversation is kept within it (runtime/compact.ts). */
  contextWindow?: number;
  /**
   * How hard a model that thinks before answering is told to think, on every call
   * (`reasoning_effort`). Not sent when not set: the model's own default applies, and an
   * endpoint that does not know the setting is not handed it.
   */
  reasoningEffort?: string;
  /** A second model, asked when this one cannot be reached or fails before saying anything. */
  fallback?: ModelConfig;
}

export interface Config {
  dev: boolean;
  port: number;
  /** The origin people reach Muster at, e.g. https://muster.example.com. No trailing slash. */
  publicUrl: string;
  /** PostgreSQL connection string. Empty means the embedded database (development only). */
  databaseUrl: string;
  /** Directory for the embedded database. Empty means in memory. */
  dataDir: string;
  /** Folder holding the built web app, served by this process. Empty when another server hosts it. */
  webDir: string;
  /** Folder where people's files are kept. */
  filesDir: string;
  /**
   * What seals the tokens of people's connections to other services. Empty when none is
   * set: connections are then not offered.
   */
  secretKey: string;
  /**
   * Where agents search the web: Search1API, Tavily, or a SearXNG the company runs. Null when none
   * is set: agents are then not given a search and read only addresses they are told.
   */
  search:
    | { provider: "searxng"; url: string }
    | { provider: "tavily"; key: string }
    | { provider: "search1api"; key: string }
    | null;
  /**
   * Where agents' code is run: the sandbox service beside the server (apps/sandbox). Null
   * when none is set: agents are then not given a way to run code.
   */
  sandbox: { url: string } | null;
  /** The most code one person's agents may run in a day (UTC): runs, and processor seconds. 0 means no limit. */
  sandboxDaily: { runs: number; cpuSeconds: number };
  /** The largest file one upload may be. */
  maxFileBytes: number;
  /** The most tokens one person's agents may use in a day (UTC). 0 means no limit. */
  dailyTokensPerUser: number;
  /** The one email allowed to create the organization on a fresh deployment. */
  bootstrapOwnerEmail: string;
  orgName: string;
  sessionDays: number;
  /** Whether a reverse proxy in front of the server sets X-Forwarded-For. */
  trustProxy: boolean;
  /** The model agents run on. Null means none is configured and agents cannot run. */
  model: ModelConfig | null;
  providers: ProviderConfig[];
}

const Env = z.object({
  MUSTER_DEV: z.string().optional(),
  PORT: z.string().optional(),
  MUSTER_PUBLIC_URL: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  MUSTER_DATA_DIR: z.string().optional(),
  MUSTER_WEB_DIR: z.string().optional(),
  MUSTER_FILES_DIR: z.string().optional(),
  MUSTER_MAX_FILE_MB: z.string().optional(),
  MUSTER_DAILY_TOKENS_PER_USER: z.string().optional(),
  MUSTER_BOOTSTRAP_OWNER_EMAIL: z.string().optional(),
  MUSTER_ORG_NAME: z.string().optional(),
  MUSTER_SESSION_DAYS: z.string().optional(),
  MUSTER_TRUST_PROXY: z.string().optional(),
  MUSTER_MODEL_API: z.string().optional(),
  MUSTER_MODEL_ID: z.string().optional(),
  MUSTER_MODEL_BASE_URL: z.string().optional(),
  MUSTER_MODEL_API_KEY: z.string().optional(),
  MUSTER_MODEL_INPUT_PRICE: z.string().optional(),
  MUSTER_MODEL_OUTPUT_PRICE: z.string().optional(),
  MUSTER_MODEL_CACHED_INPUT_PRICE: z.string().optional(),
  MUSTER_MODEL_CACHE_WRITE_PRICE: z.string().optional(),
  MUSTER_MODEL_VISION: z.string().optional(),
  MUSTER_MODEL_FIRST_WORD_SECONDS: z.string().optional(),
  MUSTER_MODEL_SILENCE_SECONDS: z.string().optional(),
  MUSTER_MODEL_MAX_OUTPUT_TOKENS: z.string().optional(),
  MUSTER_MODEL_CONTEXT_WINDOW: z.string().optional(),
  MUSTER_MODEL_REASONING_EFFORT: z.string().optional(),
  MUSTER_MODEL_FALLBACK_ID: z.string().optional(),
  MUSTER_MODEL_FALLBACK_API: z.string().optional(),
  MUSTER_MODEL_FALLBACK_BASE_URL: z.string().optional(),
  MUSTER_MODEL_FALLBACK_API_KEY: z.string().optional(),
  MUSTER_MODEL_FALLBACK_INPUT_PRICE: z.string().optional(),
  MUSTER_MODEL_FALLBACK_OUTPUT_PRICE: z.string().optional(),
  MUSTER_MODEL_FALLBACK_CACHED_INPUT_PRICE: z.string().optional(),
  MUSTER_MODEL_FALLBACK_CACHE_WRITE_PRICE: z.string().optional(),
  MUSTER_MODEL_FALLBACK_VISION: z.string().optional(),
  MUSTER_GOOGLE_CLIENT_ID: z.string().optional(),
  MUSTER_GOOGLE_CLIENT_SECRET: z.string().optional(),
  MUSTER_MICROSOFT_CLIENT_ID: z.string().optional(),
  MUSTER_MICROSOFT_CLIENT_SECRET: z.string().optional(),
  MUSTER_MICROSOFT_TENANT: z.string().optional(),
  MUSTER_OIDC_ISSUER: z.string().optional(),
  MUSTER_OIDC_CLIENT_ID: z.string().optional(),
  MUSTER_OIDC_CLIENT_SECRET: z.string().optional(),
  MUSTER_OIDC_LABEL: z.string().optional(),
  MUSTER_OIDC_TRUST_EMAIL: z.string().optional(),
  MUSTER_OIDC_DIRECTORY: z.string().optional(),
  MUSTER_SECRET_KEY: z.string().optional(),
  MUSTER_SEARXNG_URL: z.string().optional(),
  MUSTER_SANDBOX_URL: z.string().optional(),
  MUSTER_SANDBOX_DAILY_RUNS: z.string().optional(),
  MUSTER_SANDBOX_DAILY_CPU_SECONDS: z.string().optional(),
  MUSTER_TAVILY_API_KEY: z.string().optional(),
  MUSTER_SEARCH1API_KEY: z.string().optional(),
});

export const DEV_IDP_PATH = "/dev-idp";

const positiveInt = (name: string, raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive whole number, got "${raw}"`);
  return value;
};

/** An allowance that may be taken away: a whole number, where 0 says there is none. */
const allowance = (name: string, raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${name} must be a whole number, 0 for no limit, got "${raw}"`);
  return value;
};

/** How long to wait for the model: short enough to mean something, long enough for any model. */
const wait = (name: string, raw: string | undefined, fallback: number): number => {
  const value = raw === undefined || /^\d+$/.test(raw) ? positiveInt(name, raw, fallback) : 0;
  if (value < 5 || value > 900)
    throw new Error(`${name} must be between 5 and 900 seconds, got "${raw}"`);
  return value;
};

/** How much the model can be shown at once. */
const windowTokens = (raw: string | undefined): number => {
  const value =
    raw === undefined || /^\d+$/.test(raw)
      ? positiveInt("MUSTER_MODEL_CONTEXT_WINDOW", raw, 128_000)
      : 0;
  if (value < 8000 || value > 4_000_000)
    throw new Error(`MUSTER_MODEL_CONTEXT_WINDOW must be between 8000 and 4000000, got "${raw}"`);
  return value;
};

/** The most a model may write in one go. A whole workbook or deck is one piece of writing. */
const outputTokens = (raw: string | undefined): number => {
  const value =
    raw === undefined || /^\d+$/.test(raw)
      ? positiveInt("MUSTER_MODEL_MAX_OUTPUT_TOKENS", raw, 16_000)
      : 0;
  if (value < 1024 || value > 200_000)
    throw new Error(`MUSTER_MODEL_MAX_OUTPUT_TOKENS must be between 1024 and 200000, got "${raw}"`);
  return value;
};

/** Services name the levels differently ("minimal", "max"); the word is passed on as given. */
const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const effort = (raw: string | undefined): { reasoningEffort?: string } => {
  if (raw === undefined || raw === "") return {};
  if (!EFFORTS.includes(raw))
    throw new Error(
      `MUSTER_MODEL_REASONING_EFFORT must be one of ${EFFORTS.join(", ")}, got "${raw}"`,
    );
  return { reasoningEffort: raw };
};

const price = (name: string, raw: string | undefined): number => {
  if (raw === undefined || raw === "") return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`${name} must be a number of US dollars per million tokens, got "${raw}"`);
  return value;
};

/** A price that may be left unsaid: what is read from or written to a service's cache. */
const cachePrices = (
  prefix: string,
  cached: string | undefined,
  write: string | undefined,
): Pick<ModelConfig, "cachedInputPrice" | "cacheWritePrice"> => ({
  ...(cached ? { cachedInputPrice: price(`${prefix}CACHED_INPUT_PRICE`, cached) } : {}),
  ...(write ? { cacheWritePrice: price(`${prefix}CACHE_WRITE_PRICE`, write) } : {}),
});

function loadModel(e: z.infer<typeof Env>): ModelConfig | null {
  if (!e.MUSTER_MODEL_ID && !e.MUSTER_MODEL_API_KEY) return null;
  const api = e.MUSTER_MODEL_API ?? "";
  if (api !== "anthropic" && api !== "openai")
    throw new Error(
      'MUSTER_MODEL_API must be "anthropic" or "openai" (any endpoint that speaks OpenAI chat completions)',
    );
  if (!e.MUSTER_MODEL_ID || !e.MUSTER_MODEL_API_KEY)
    throw new Error(
      "MUSTER_MODEL_ID and MUSTER_MODEL_API_KEY are both required to configure a model",
    );
  const baseUrl = (
    e.MUSTER_MODEL_BASE_URL ??
    (api === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1")
  ).replace(/\/+$/, "");
  if (!/^https?:\/\//.test(baseUrl))
    throw new Error(`MUSTER_MODEL_BASE_URL is not a URL: "${baseUrl}"`);
  const waits = {
    firstWordSeconds: wait(
      "MUSTER_MODEL_FIRST_WORD_SECONDS",
      e.MUSTER_MODEL_FIRST_WORD_SECONDS,
      180,
    ),
    silenceSeconds: wait("MUSTER_MODEL_SILENCE_SECONDS", e.MUSTER_MODEL_SILENCE_SECONDS, 90),
    maxOutputTokens: outputTokens(e.MUSTER_MODEL_MAX_OUTPUT_TOKENS),
    contextWindow: windowTokens(e.MUSTER_MODEL_CONTEXT_WINDOW),
  };
  const thinks = effort(e.MUSTER_MODEL_REASONING_EFFORT);
  // The second model. Only its name is required: what is not given is the first model's
  // (the same service and key, another model of it).
  const secondApi = e.MUSTER_MODEL_FALLBACK_API ?? api;
  if (e.MUSTER_MODEL_FALLBACK_ID && secondApi !== "anthropic" && secondApi !== "openai")
    throw new Error('MUSTER_MODEL_FALLBACK_API must be "anthropic" or "openai"');
  const secondUrl = (e.MUSTER_MODEL_FALLBACK_BASE_URL ?? baseUrl).replace(/\/+$/, "");
  if (!/^https?:\/\//.test(secondUrl))
    throw new Error(`MUSTER_MODEL_FALLBACK_BASE_URL is not a URL: "${secondUrl}"`);
  const fallback: ModelConfig | undefined = e.MUSTER_MODEL_FALLBACK_ID
    ? {
        api: secondApi as "anthropic" | "openai",
        id: e.MUSTER_MODEL_FALLBACK_ID,
        baseUrl: secondUrl,
        apiKey: e.MUSTER_MODEL_FALLBACK_API_KEY ?? e.MUSTER_MODEL_API_KEY,
        inputPrice: price("MUSTER_MODEL_FALLBACK_INPUT_PRICE", e.MUSTER_MODEL_FALLBACK_INPUT_PRICE),
        outputPrice: price(
          "MUSTER_MODEL_FALLBACK_OUTPUT_PRICE",
          e.MUSTER_MODEL_FALLBACK_OUTPUT_PRICE,
        ),
        ...cachePrices(
          "MUSTER_MODEL_FALLBACK_",
          e.MUSTER_MODEL_FALLBACK_CACHED_INPUT_PRICE,
          e.MUSTER_MODEL_FALLBACK_CACHE_WRITE_PRICE,
        ),
        // Shown an image only if it can see: what the first model was shown is what it gets.
        vision: e.MUSTER_MODEL_FALLBACK_VISION === "1",
        ...waits,
        // How hard to think is a setting of the service it is sent to. A second model on
        // another service, or speaking another protocol, is not handed the first one's:
        // it may not know the setting and would refuse every call, when it is most needed.
        ...(secondUrl === baseUrl && secondApi === api ? thinks : {}),
      }
    : undefined;
  return {
    ...(fallback ? { fallback } : {}),
    api,
    id: e.MUSTER_MODEL_ID,
    baseUrl,
    apiKey: e.MUSTER_MODEL_API_KEY,
    inputPrice: price("MUSTER_MODEL_INPUT_PRICE", e.MUSTER_MODEL_INPUT_PRICE),
    outputPrice: price("MUSTER_MODEL_OUTPUT_PRICE", e.MUSTER_MODEL_OUTPUT_PRICE),
    ...cachePrices(
      "MUSTER_MODEL_",
      e.MUSTER_MODEL_CACHED_INPUT_PRICE,
      e.MUSTER_MODEL_CACHE_WRITE_PRICE,
    ),
    vision: e.MUSTER_MODEL_VISION === "1",
    firstWordSeconds: wait(
      "MUSTER_MODEL_FIRST_WORD_SECONDS",
      e.MUSTER_MODEL_FIRST_WORD_SECONDS,
      180,
    ),
    silenceSeconds: wait("MUSTER_MODEL_SILENCE_SECONDS", e.MUSTER_MODEL_SILENCE_SECONDS, 90),
    maxOutputTokens: outputTokens(e.MUSTER_MODEL_MAX_OUTPUT_TOKENS),
    contextWindow: windowTokens(e.MUSTER_MODEL_CONTEXT_WINDOW),
    ...thinks,
  };
}

/** Tenants that mean "any directory". Sign-in must be tied to one directory. */
const SHARED_MICROSOFT_TENANTS = new Set(["common", "organizations", "consumers"]);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // A variable set to nothing is the same as one not set, so a deployment file can list them all.
  const e = Env.parse(
    Object.fromEntries(Object.entries(env).filter(([, value]) => value?.trim() !== "")),
  );
  const dev = e.MUSTER_DEV === "1";
  const port = positiveInt("PORT", e.PORT, 7410);
  const publicUrl = (e.MUSTER_PUBLIC_URL ?? (dev ? "http://localhost:5173" : "")).trim();
  if (!publicUrl) throw new Error("MUSTER_PUBLIC_URL is required");
  let origin: string;
  try {
    origin = new URL(publicUrl).origin;
  } catch {
    throw new Error(`MUSTER_PUBLIC_URL is not a URL: "${publicUrl}"`);
  }
  // The value is compared with the browser's Origin header and used to build the
  // sign-in redirect, so it must be exactly an origin: scheme, host, optional port.
  if (origin !== publicUrl) {
    throw new Error(
      `MUSTER_PUBLIC_URL must be a bare origin such as "${origin}", got "${publicUrl}"`,
    );
  }
  const databaseUrl = e.DATABASE_URL ?? "";
  if (!dev && !databaseUrl) throw new Error("DATABASE_URL is required outside development");
  // Development mode turns on a sign-in that needs no password. It must never sit
  // in front of a real database or a real site.
  if (dev && (databaseUrl || publicUrl.startsWith("https://"))) {
    throw new Error(
      "MUSTER_DEV=1 cannot be combined with DATABASE_URL or an https MUSTER_PUBLIC_URL",
    );
  }

  const providers: ProviderConfig[] = [];
  // A provider with some of its settings and not the others is a mistake, not a provider to
  // leave out: saying so at start beats a sign-in page with a button missing.
  const whole = (name: string, parts: Record<string, string | undefined>) => {
    const missing = Object.keys(parts).filter((key) => !parts[key]);
    if (missing.length > 0 && missing.length < Object.keys(parts).length)
      throw new Error(`${name} sign-in is half set: ${missing.join(", ")} is missing`);
    return missing.length === 0;
  };
  whole("Google", {
    MUSTER_GOOGLE_CLIENT_ID: e.MUSTER_GOOGLE_CLIENT_ID,
    MUSTER_GOOGLE_CLIENT_SECRET: e.MUSTER_GOOGLE_CLIENT_SECRET,
  });
  whole("Microsoft", {
    MUSTER_MICROSOFT_CLIENT_ID: e.MUSTER_MICROSOFT_CLIENT_ID,
    MUSTER_MICROSOFT_CLIENT_SECRET: e.MUSTER_MICROSOFT_CLIENT_SECRET,
    MUSTER_MICROSOFT_TENANT: e.MUSTER_MICROSOFT_TENANT,
  });
  if (
    whole("The company's own (OIDC)", {
      MUSTER_OIDC_ISSUER: e.MUSTER_OIDC_ISSUER,
      MUSTER_OIDC_CLIENT_ID: e.MUSTER_OIDC_CLIENT_ID,
      MUSTER_OIDC_CLIENT_SECRET: e.MUSTER_OIDC_CLIENT_SECRET,
    })
  ) {
    // Any provider that speaks OpenID Connect: Keycloak, Authing, Okta, Authentik, a
    // company's own. It is found from its issuer address, which must be https.
    // Kept as written: a provider's issuer is compared letter for letter, and some end in "/".
    let issuer = (e.MUSTER_OIDC_ISSUER as string).trim();
    let parsed: URL | null = null;
    try {
      parsed = new URL(issuer);
      if (parsed.pathname === "/" && !parsed.search) issuer = parsed.origin;
    } catch {}
    if (!parsed || (parsed.protocol !== "https:" && !dev))
      throw new Error(`MUSTER_OIDC_ISSUER must be an https address, got "${issuer}"`);
    providers.push({
      id: "oidc",
      label: (e.MUSTER_OIDC_LABEL ?? "").trim().slice(0, 40) || "Company account",
      issuer,
      clientId: e.MUSTER_OIDC_CLIENT_ID as string,
      clientSecret: e.MUSTER_OIDC_CLIENT_SECRET as string,
      trustEmail: e.MUSTER_OIDC_TRUST_EMAIL === "1",
      directory: e.MUSTER_OIDC_DIRECTORY === "1",
    });
  }
  if (e.MUSTER_GOOGLE_CLIENT_ID && e.MUSTER_GOOGLE_CLIENT_SECRET) {
    providers.push({
      id: "google",
      label: "Google",
      issuer: "https://accounts.google.com",
      clientId: e.MUSTER_GOOGLE_CLIENT_ID,
      clientSecret: e.MUSTER_GOOGLE_CLIENT_SECRET,
    });
  }
  if (
    e.MUSTER_MICROSOFT_CLIENT_ID &&
    e.MUSTER_MICROSOFT_CLIENT_SECRET &&
    e.MUSTER_MICROSOFT_TENANT
  ) {
    const tenant = e.MUSTER_MICROSOFT_TENANT.trim().toLowerCase();
    // The token's `tid` is the directory's GUID, so a domain name here would never match.
    if (
      SHARED_MICROSOFT_TENANTS.has(tenant) ||
      !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(tenant)
    ) {
      throw new Error(
        `MUSTER_MICROSOFT_TENANT must be one directory's ID (a GUID), not "${tenant}"`,
      );
    }
    providers.push({
      id: "microsoft",
      label: "Microsoft",
      issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
      clientId: e.MUSTER_MICROSOFT_CLIENT_ID,
      clientSecret: e.MUSTER_MICROSOFT_CLIENT_SECRET,
      tenant,
    });
  }
  if (dev) {
    providers.push({
      id: "dev",
      label: "Development account",
      issuer: `${publicUrl}${DEV_IDP_PATH}`,
      clientId: "muster-dev",
      // Made up at start: the development provider lives in this process, so nothing else needs to know it.
      clientSecret: randomBytes(24).toString("hex"),
    });
  }
  if (providers.length === 0) throw new Error("no sign-in provider is configured");

  // In development files go with the in-memory database: a folder that does not outlive the machine's temp space.
  const filesDir = e.MUSTER_FILES_DIR ?? (dev ? join(tmpdir(), "muster-dev-files") : "data/files");
  let secretKey = (e.MUSTER_SECRET_KEY ?? "").trim();
  if (secretKey && secretKey.length < 32)
    throw new Error("MUSTER_SECRET_KEY must be at least 32 characters");
  if (!secretKey && dev) {
    // Development keeps one of its own beside the files, so connections survive a restart.
    const kept = join(filesDir, ".secret-key");
    mkdirSync(filesDir, { recursive: true });
    if (!existsSync(kept)) writeFileSync(kept, randomBytes(32).toString("hex"), { mode: 0o600 });
    secretKey = readFileSync(kept, "utf8").trim();
  }

  const searxng = (e.MUSTER_SEARXNG_URL ?? "").trim();
  const tavily = (e.MUSTER_TAVILY_API_KEY ?? "").trim();
  const search1api = (e.MUSTER_SEARCH1API_KEY ?? "").trim();
  // A key pasted with a line break or a quote in it would make every search fail as if the
  // network were down. It is refused here, where the cause can be said.
  for (const [name, key] of [
    ["MUSTER_SEARCH1API_KEY", search1api],
    ["MUSTER_TAVILY_API_KEY", tavily],
  ] as const)
    if (key && !/^[\x21\x23-\x26\x28-\x7e]+$/.test(key))
      throw new Error(
        `${name} holds characters a key cannot have (a space, a quote or a line break?)`,
      );
  if ([searxng, tavily, search1api].filter(Boolean).length > 1)
    throw new Error(
      "set one of MUSTER_SEARCH1API_KEY, MUSTER_TAVILY_API_KEY or MUSTER_SEARXNG_URL, not several",
    );
  if (searxng) {
    let address: URL | null = null;
    try {
      address = new URL(searxng);
    } catch {}
    if (!address || !/^https?:$/.test(address.protocol) || address.username || address.password)
      throw new Error("MUSTER_SEARXNG_URL must be an http or https address, without a user name");
  }
  const search: Config["search"] = search1api
    ? { provider: "search1api", key: search1api }
    : searxng
      ? { provider: "searxng", url: searxng }
      : tavily
        ? { provider: "tavily", key: tavily }
        : null;

  const sandboxUrl = (e.MUSTER_SANDBOX_URL ?? "").trim();
  if (sandboxUrl) {
    let address: URL | null = null;
    try {
      address = new URL(sandboxUrl);
    } catch {}
    if (!address || !/^https?:$/.test(address.protocol) || address.username)
      throw new Error("MUSTER_SANDBOX_URL must be an http or https address, without a user name");
  }

  const bootstrapOwnerEmail = (e.MUSTER_BOOTSTRAP_OWNER_EMAIL ?? (dev ? "owner@muster.test" : ""))
    .trim()
    .toLowerCase();
  if (!bootstrapOwnerEmail) throw new Error("MUSTER_BOOTSTRAP_OWNER_EMAIL is required");

  return {
    dev,
    port,
    publicUrl,
    databaseUrl,
    dataDir: e.MUSTER_DATA_DIR ?? "",
    webDir: e.MUSTER_WEB_DIR ?? "",
    filesDir,
    secretKey,
    search,
    sandbox: sandboxUrl ? { url: sandboxUrl } : null,
    sandboxDaily: {
      runs: allowance("MUSTER_SANDBOX_DAILY_RUNS", e.MUSTER_SANDBOX_DAILY_RUNS, 200),
      cpuSeconds: allowance(
        "MUSTER_SANDBOX_DAILY_CPU_SECONDS",
        e.MUSTER_SANDBOX_DAILY_CPU_SECONDS,
        3600,
      ),
    },
    dailyTokensPerUser: e.MUSTER_DAILY_TOKENS_PER_USER
      ? positiveInt("MUSTER_DAILY_TOKENS_PER_USER", e.MUSTER_DAILY_TOKENS_PER_USER, 0)
      : 0,
    maxFileBytes: positiveInt("MUSTER_MAX_FILE_MB", e.MUSTER_MAX_FILE_MB, 25) * 1024 * 1024,
    bootstrapOwnerEmail,
    orgName: e.MUSTER_ORG_NAME?.trim() || "Muster",
    sessionDays: positiveInt("MUSTER_SESSION_DAYS", e.MUSTER_SESSION_DAYS, 7),
    trustProxy: e.MUSTER_TRUST_PROXY === "1",
    model: loadModel(e),
    providers,
  };
}
