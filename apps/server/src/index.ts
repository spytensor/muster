import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Alerts, registerAlerts } from "./alerts.js";
import { createApp } from "./app.js";
import { registerBudgets } from "./budgets.js";
import { AuditForwarder, checkChainsDue, registerChain } from "./chain.js";
import { CodeHosts, registerCodeHost } from "./codeHost.js";
import { registerCompany } from "./company.js";
import { loadConfig } from "./config.js";
import { Connections } from "./connections.js";
import { registerConnectors } from "./connectors.js";
import { openEmbeddedDb, openPostgresDb } from "./db.js";
import { registerDesktop } from "./desktop.js";
import { seedDemo } from "./dev/seed.js";
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
import { Retention, registerRetention } from "./retention.js";
import { publicNet } from "./runtime/net.js";
import { Runs } from "./runtime/runs.js";
import { createSearch } from "./runtime/search.js";
import { createSandbox } from "./sandbox.js";
import { RECLAIM_ASK_MS, registerSandboxAdmin, SandboxReclaim } from "./sandboxAdmin.js";
import { registerSandboxUse, sweepSandboxRuns } from "./sandboxUse.js";
import { registerSchedules, Scheduler } from "./schedules.js";
import { registerScim } from "./scim.js";
import { registerSharing } from "./sharing.js";
import { registerSkills } from "./skills.js";
import { registerSso } from "./sso.js";
import { registerToolPolicy } from "./toolPolicy.js";
import { registerTracker, Tracker } from "./tracker.js";
import { serveWeb } from "./web.js";

const config = loadConfig();
if (config.databaseUrl) {
  // Runs in progress live in this process's memory, so one database has one server. The lock
  // is taken before anything else touches the database, migrations included. It
  // is held by a connection of its own for as long as the process lives.
  const { default: pg } = await import("pg");
  const lock = new pg.Client({ connectionString: config.databaseUrl });
  await lock.connect();
  const held = (await lock.query("select pg_try_advisory_lock(741000165) as held")).rows[0]?.held;
  if (!held) {
    console.error(
      "another Muster server is already running on this database; this one will not start",
    );
    process.exit(1);
  }
  lock.on("error", (error) => {
    console.error("lost the database connection that holds this server's lock:", error.message);
    process.exit(1);
  });
}
const db = config.databaseUrl
  ? await openPostgresDb(config.databaseUrl)
  : await openEmbeddedDb(config.dataDir);
if (config.dev) await seedDemo(db, config);
const files = new Files(db, diskStore(config.filesDir), config.maxFileBytes);
const connections = new Connections(db, config);
const sandbox = createSandbox(config);
// What is chosen in the console replaces the model the settings name, from the first run on.
const modelSettings = new ModelSettings(db, config);
await modelSettings.apply();
// The company's repositories, worked on in the sandbox. Its key never leaves this process.
const codeHosts = new CodeHosts(db, config.secretKey, { sandbox });
const runs = new Runs(db, config, files, {
  connections,
  search: createSearch(config),
  sandbox,
  codeHosts,
});
// Nothing is sent from a conversation while a reply is still being written in it.
codeHosts.running = (id) => runs.running(id);
await runs.recover();
const scheduler = new Scheduler(db, config, runs);
const followups = new Followups(db, config, runs, connections);
await followups.recover();
const alerts = new Alerts(db, config, { sandbox });
const tracker = new Tracker(db, config.secretKey);
const forwarder = new AuditForwarder(db, config.secretKey, publicNet);
const reclaim = new SandboxReclaim(db, sandbox);
const app = await createApp(config, db, (inner, kit) => {
  // First: what it reads of each request (the person's time zone) holds for every route after it.
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
    sandbox,
    use: runs.sandboxUse,
    server: config.sandboxDaily,
    reclaim,
  });
  registerMcpConnectors(inner, kit, db, config.secretKey, publicNet);
  registerAlerts(inner, kit, db, alerts);
  registerToolPolicy(inner, kit, db);
  registerTracker(inner, kit, db, tracker);
  registerCodeHost(inner, kit, db, codeHosts);
  registerProjectItems(inner, kit, db, codeHosts);
  registerChain(inner, kit, db, config.secretKey, forwarder);
  registerRetention(inner, kit, db, files, { secretKey: config.secretKey, spaces: sandbox });
  registerSso(inner, kit, db, config, publicNet);
  registerScim(inner, kit, db, config);
});

// The activity log is sent on to where an administrator named, and checked once a day.
// A run of code whose server stopped under it is closed once its time is well past.
const lostRuns = () =>
  sweepSandboxRuns(db).catch((error) => console.error("closing lost runs of code failed:", error));
void lostRuns();
setInterval(lostRuns, 5 * 60 * 1000).unref();
// Workspaces nobody has used for an organization's number of days are released, once an
// hour; asked every few minutes, and done by whichever server process writes the hour's line.
const reclaiming = () =>
  reclaim.tick().catch((error) => console.error("releasing idle workspaces failed:", error));
setTimeout(reclaiming, 60_000).unref();
setInterval(reclaiming, RECLAIM_ASK_MS).unref();
setInterval(() => {
  forwarder.tick().catch((error) => console.error("sending the activity log on failed:", error));
}, 30_000).unref();
const daily = () =>
  checkChainsDue(db, config.secretKey).catch((error) =>
    console.error("checking the activity log failed:", error),
  );
void daily();
setInterval(daily, 60 * 60 * 1000).unref();
// What is past its keeping goes once a day; looked at every hour.
const retention = new Retention(db, files, config.secretKey, sandbox);
setInterval(
  () => {
    retention
      .tick()
      .catch((error) => console.error("purging what is past its keeping failed:", error));
  },
  60 * 60 * 1000,
).unref();

// One loop starts what is due. With one server process per database, as deployed, each
// schedule runs once.
setInterval(() => {
  scheduler.tick().catch((error) => console.error("starting scheduled work failed:", error));
  followups.tick().catch((error) => console.error("waking follow-ups failed:", error));
}, 30_000).unref();

// Once a minute what changed in a linked tracker is read and what changed here is sent
// (tracker.ts). One pass at a time, which the tracker's own `tick` sees to.
setInterval(() => {
  tracker.tick().catch((error) => console.error("keeping the tracker in step failed:", error));
}, 60_000).unref();

// Once a minute the alert rules are asked, and what is waiting to be sent is sent. One
// pass at a time: a webhook that is slow to answer does not pile passes up behind it.
let alerting = false;
setInterval(() => {
  if (alerting) return;
  alerting = true;
  alerts
    .tick()
    .catch((error) => console.error("checking alerts failed:", error))
    .finally(() => {
      alerting = false;
    });
}, 60_000).unref();

// What files say is read a few at a time, so that they can be found by their words: a
// file just made within seconds, the ones kept before this was written in turn. One pass
// at a time, and never in the way of answering.
let indexing = false;
setInterval(() => {
  if (indexing) return;
  indexing = true;
  const began = Date.now();
  // For up to four seconds of every five while there is anything to read, so a library
  // of a thousand kept before this was written is read in minutes, not hours.
  const pass = async (): Promise<void> => {
    while ((await files.indexPending(10)) > 0 && Date.now() - began < 4_000);
  };
  pass()
    .catch((error) => console.error("reading files for search failed:", error))
    .finally(() => {
      indexing = false;
    });
}, 5_000).unref();

// In development the web app usually comes from its own dev server, which forwards to this one.
// When people reach this process directly, it serves the built web app itself.
const direct = !config.dev || new URL(config.publicUrl).port === String(config.port);
const web =
  direct &&
  serveWeb(app, config.webDir || fileURLToPath(new URL("../../web/dist", import.meta.url)));

serve(
  { fetch: app.fetch, port: config.port, hostname: config.dev ? "127.0.0.1" : "0.0.0.0" },
  (info) => {
    console.log(`muster server listening on :${info.port} (public URL ${config.publicUrl})`);
    if (config.dev)
      console.log("development mode: embedded database, passwordless development sign-in is ON");
    console.log(
      web
        ? "serving the web app"
        : direct
          ? "not serving the web app: no build was found"
          : "the web app is served by its own dev server",
    );
    console.log(
      config.model
        ? `agents run on ${config.model.id} at ${config.model.baseUrl}`
        : "no model is configured, so agents cannot run (set MUSTER_MODEL_*)",
    );
  },
);

// Let runs in progress end cleanly so their messages and traces are recorded.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    // Runs end first, then the database is closed properly, so nothing is cut off mid-write.
    void runs
      .stopAll()
      .then(() => db.close())
      .catch(() => undefined)
      .finally(() => process.exit(0));
  });
}
