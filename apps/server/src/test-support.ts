import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@openclaw/llm-core";
import type { Hono } from "hono";
import { Alerts, registerAlerts } from "./alerts.js";
import { createApp } from "./app.js";
import { registerBudgets } from "./budgets.js";
import { AuditForwarder, registerChain } from "./chain.js";
import { type CodeHostApi, CodeHosts, registerCodeHost } from "./codeHost.js";
import { registerCompany } from "./company.js";
import { type Config, loadConfig } from "./config.js";
import { Connections } from "./connections.js";
import { registerConnectors } from "./connectors.js";
import { type Db, openEmbeddedDb, openPostgresDb } from "./db.js";
import { registerDesktop } from "./desktop.js";
import { registerDrafts } from "./drafts.js";
import { Files } from "./files/service.js";
import { diskStore } from "./files/store.js";
import { registerFiles } from "./files.js";
import { Followups, registerFollowups } from "./followups.js";
import { registerKnowledge } from "./knowledge.js";
import { registerMarket } from "./market.js";
import { registerMcpConnectors } from "./mcpConnectors.js";
import { registerMemory } from "./memory.js";
import { ModelSettings, registerModels } from "./modelSettings.js";
import { registerNotices } from "./notices.js";
import { registerObserve } from "./observe.js";
import { registerProduct } from "./product.js";
import { registerProfile } from "./profile.js";
import { registerProjectItems } from "./projectItemRoutes.js";
import { registerRetention } from "./retention.js";
import type { Net } from "./runtime/net.js";
import { Runs, TURN_NOTE } from "./runtime/runs.js";
import { createSearch } from "./runtime/search.js";
import type { Sandbox } from "./sandbox.js";
import { registerSandboxAdmin, SandboxReclaim } from "./sandboxAdmin.js";
import { registerSandboxUse } from "./sandboxUse.js";
import { registerSchedules, Scheduler } from "./schedules.js";
import { registerScim } from "./scim.js";
import { registerSharing } from "./sharing.js";
import { registerSkills } from "./skills.js";
import { registerSso } from "./sso.js";
import { registerToolPolicy } from "./toolPolicy.js";
import { registerTracker, Tracker } from "./tracker.js";

export const PUBLIC_URL = "http://muster.test";

export interface Harness {
  app: Hono<never>;
  db: Db;
  config: Config;
  runs: Runs;
  scheduler: Scheduler;
  followups: Followups;
  alerts: Alerts;
  tracker: Tracker;
  codeHosts: CodeHosts;
  files: Files;
  modelSettings: ModelSettings;
  /** Walks the whole sign-in flow through the development provider. `existingCookie` is a session the browser already holds. */
  signIn(
    email: string,
    existingCookie?: string,
  ): Promise<{ cookie: string | null; error: string | null; setCookie: string | null }>;
  /** Starts an attempt and returns its callback path and the browser-binding cookie. */
  start(email: string): Promise<{ callback: string; binding: string }>;
  /** Sends a file as the web app does: the bytes as the body, the name in the address. */
  upload(cookie: string | null, name: string, bytes: Uint8Array | string): Promise<Response>;
  api(
    cookie: string | null,
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Response>;
  /** The authorization redirect for a fresh attempt, without completing it. */
  beginLogin(email: string): Promise<string>;
}

const pathOf = (url: string) => {
  if (!url.startsWith(PUBLIC_URL)) throw new Error(`unexpected redirect target: ${url}`);
  return url.slice(PUBLIC_URL.length);
};

/**
 * A fresh database for one test file. Embedded by default; with MUSTER_TEST_DATABASE_URL
 * set to a PostgreSQL server, a new database there, so the same tests prove the same
 * behaviour on the database production uses.
 */
async function openTestDb(): Promise<Db> {
  const server = process.env.MUSTER_TEST_DATABASE_URL;
  if (!server) return openEmbeddedDb();
  const name = `muster_test_${randomBytes(6).toString("hex")}`;
  const { default: pg } = await import("pg");
  const admin = new pg.Client({ connectionString: server });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = new URL(server);
  url.pathname = `/${name}`;
  const db = await openPostgresDb(url.toString());
  // Each test has its own database, and a pool that keeps its connections for a while.
  // With enough tests in one file the server runs out of connections, so the pools of
  // tests long finished are closed. The last few stay: a run may still be writing.
  opened.push(db);
  while (opened.length > 3)
    await opened
      .shift()
      ?.close()
      .catch(() => undefined);
  return db;
}
const opened: Db[] = [];

export async function harness(
  env: Record<string, string> = {},
  options: {
    streamFn?: StreamFn;
    net?: Net;
    noModel?: boolean;
    /** Stands in for a connected service (Microsoft's sign-in and Graph). */
    service?: typeof fetch;
    /** Stands in for the web search service. */
    search?: typeof fetch;
    /** Stands in for the sandbox where code runs. */
    sandbox?: Sandbox;
    /** Stands in for a model service when an administrator tests a model in the console. */
    modelService?: typeof fetch;
    /** Stands in for the company's code host. */
    codeHost?: (at: { baseUrl: string; key: string }) => CodeHostApi;
  } = {},
): Promise<Harness> {
  const config = loadConfig({
    MUSTER_DEV: "1",
    MUSTER_PUBLIC_URL: PUBLIC_URL,
    MUSTER_BOOTSTRAP_OWNER_EMAIL: "owner@acme.test",
    MUSTER_ORG_NAME: "Acme",
    ...(options.noModel
      ? {}
      : {
          MUSTER_MODEL_API: "openai",
          MUSTER_MODEL_ID: "test-model",
          MUSTER_MODEL_API_KEY: "test-key",
          MUSTER_MODEL_BASE_URL: "https://model.invalid",
          MUSTER_MODEL_INPUT_PRICE: "2",
          MUSTER_MODEL_OUTPUT_PRICE: "10",
        }),
    ...env,
  });
  const db = await openTestDb();
  // Tests never reach a real model or the real network: both are supplied or refuse.
  const refuse: Net = { request: async () => Promise.reject(new Error("no network in tests")) };
  const files = new Files(
    db,
    diskStore(mkdtempSync(join(tmpdir(), "muster-test-files-"))),
    config.maxFileBytes,
  );
  const connections = new Connections(
    db,
    config,
    options.service ?? (() => Promise.reject(new Error("no network in tests"))),
  );
  const modelSettings = new ModelSettings(
    db,
    config,
    options.modelService ?? (() => Promise.reject(new Error("no network in tests"))),
  );
  await modelSettings.apply();
  const codeHosts = new CodeHosts(db, config.secretKey, {
    net: options.net ?? refuse,
    download: () => Promise.reject(new Error("no network in tests")),
    api: options.codeHost,
    sandbox: options.sandbox ?? null,
  });
  const runs = new Runs(db, config, files, {
    codeHosts,
    streamFn: options.streamFn,
    net: options.net ?? refuse,
    connections,
    search: createSearch(
      config,
      options.search ?? (() => Promise.reject(new Error("no network in tests"))),
    ),
    sandbox: options.sandbox ?? null,
  });
  codeHosts.running = (id) => runs.running(id);
  const scheduler = new Scheduler(db, config, runs);
  const followups = new Followups(db, config, runs, connections);
  const alerts = new Alerts(db, config, {
    sandbox: options.sandbox ?? null,
    net: options.net ?? refuse,
  });
  const tracker = new Tracker(db, config.secretKey, { net: options.net ?? refuse });
  const forwarder = new AuditForwarder(db, config.secretKey, options.net ?? refuse);
  const app = (await createApp(config, db, (inner, kit) => {
    registerFollowups(inner, kit, db, followups);
    registerMarket(inner, kit, db);
    registerNotices(inner, kit, db);
    registerMemory(inner, kit, db);
    registerProfile(inner, kit, db);
    registerSchedules(inner, kit, db, scheduler);
    registerObserve(inner, kit, db);
    registerProduct(inner, kit, db, config, runs, files);
    registerFiles(inner, kit, files);
    registerDesktop(inner, join(config.filesDir, "_desktop"), config.publicUrl);
    registerConnectors(inner, kit, db, config, connections);
    registerDrafts(inner, kit, db, connections);
    registerSharing(inner, kit, db);
    registerSkills(inner, kit, db);
    registerKnowledge(inner, kit, db, files);
    registerCompany(inner, kit, db, config.secretKey);
    registerModels(inner, kit, db, modelSettings);
    registerBudgets(inner, kit, db, config);
    registerSandboxUse(inner, kit, db, runs.sandboxUse);
    registerSandboxAdmin(inner, kit, db, {
      sandbox: options.sandbox ?? null,
      use: runs.sandboxUse,
      server: config.sandboxDaily,
      reclaim: new SandboxReclaim(db, options.sandbox ?? null),
    });
    registerMcpConnectors(inner, kit, db, config.secretKey, options.net ?? refuse);
    registerAlerts(inner, kit, db, alerts);
    registerToolPolicy(inner, kit, db);
    registerTracker(inner, kit, db, tracker);
    registerCodeHost(inner, kit, db, codeHosts);
    registerProjectItems(inner, kit, db, codeHosts);
    registerChain(inner, kit, db, config.secretKey, forwarder);
    registerRetention(inner, kit, db, files, {
      secretKey: config.secretKey,
      spaces: options.sandbox ?? null,
    });
    registerSso(inner, kit, db, config, options.net ?? refuse);
    registerScim(inner, kit, db, config);
  })) as unknown as Hono<never>;

  // Returns the callback path and the cookie that binds the attempt to "this browser".
  const start = async (email: string) => {
    const begin = await app.request("/auth/login/dev");
    const binding = begin.headers.get("set-cookie")?.split(";")[0] ?? "";
    const authorize = await app.request(
      `${pathOf(begin.headers.get("location") ?? "")}&email=${encodeURIComponent(email)}`,
    );
    return { callback: pathOf(authorize.headers.get("location") ?? ""), binding };
  };
  const beginLogin = async (email: string) => (await start(email)).callback;

  return {
    app,
    db,
    config,
    runs,
    scheduler,
    followups,
    alerts,
    tracker,
    codeHosts,
    files,
    modelSettings,
    beginLogin,
    start,
    async signIn(email, existing) {
      const { callback, binding } = await start(email);
      const done = await app.request(callback, {
        headers: { cookie: [binding, existing].filter(Boolean).join("; ") },
      });
      const target = new URL(done.headers.get("location") ?? "");
      const session = done.headers
        .getSetCookie()
        .find((value) => value.startsWith("muster_session="));
      return {
        cookie: session?.split(";")[0] ?? null,
        error: target.searchParams.get("error"),
        setCookie: session ?? null,
      };
    },
    async upload(cookie, name, bytes) {
      return app.request(`/api/app/files?name=${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { origin: PUBLIC_URL, ...(cookie ? { cookie } : {}) },
        body: bytes,
      });
    },
    async api(cookie, method, path, body, headers = {}) {
      return app.request(path, {
        method,
        headers: {
          origin: PUBLIC_URL,
          ...(cookie ? { cookie } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    },
  };
}

/**
 * Everything Muster told a model apart from the conversation: its instructions, and what
 * was said with the person's message because it does not stay the same (runs.ts,
 * `turnParts`). What a test means by "the agent was told".
 */
export function toldTo(context: {
  systemPrompt?: string;
  messages: readonly { role: string; content?: unknown }[];
}): string {
  const said = context.messages.flatMap((message) => {
    if (message.role !== "user") return [];
    const text =
      typeof message.content === "string"
        ? message.content
        : (message.content as { type?: string; text?: string }[])
            .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
            .join("");
    const at = text.indexOf(TURN_NOTE);
    return at < 0 ? [] : [text.slice(at)];
  });
  return [context.systemPrompt ?? "", ...said].join("\n\n");
}
