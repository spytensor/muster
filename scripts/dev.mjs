// Starts everything needed to use Muster on this machine: the server and the web app.
//   pnpm dev
// Settings come from the environment, or from a `.env` file at the repository root.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";

import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
  // A value in .env may point at a variable your shell already has, written ${NAME}: a key
  // kept in your shell profile is then used without a second copy of it on disk. Only what
  // .env itself sets is rewritten.
  for (const name of Object.keys(parseEnv(readFileSync(".env", "utf8")))) {
    const value = process.env[name];
    if (value?.includes("${"))
      process.env[name] = value.replace(/\$\{(\w+)\}/g, (_, other) => process.env[other] ?? "");
  }
}

// The server imports the workspace's packages as built code; a fresh checkout has none yet.
if (!existsSync("packages/protocol/dist") || !existsSync("vendor/openclaw/agent-core/dist")) {
  console.log("First run: building the workspace packages…");
  const built = spawnSync("pnpm", ["build"], { stdio: "inherit" });
  if (built.status !== 0) process.exit(built.status ?? 1);
}

const SERVER = 7410;
const WEB = 5173;
/** Whether something answers on a port of this machine, on either of its two local addresses. */
const answers = (port, host) =>
  new Promise((resolve) => {
    const socket = createConnection({ port, host });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
const busy = async (port) => (await answers(port, "127.0.0.1")) || (await answers(port, "::1"));
for (const [port, what] of [
  [SERVER, "the server"],
  [WEB, "the web app"],
]) {
  if (await busy(port)) {
    console.error(
      `Port ${port} (${what}) is already in use. Muster may already be running: open http://localhost:${WEB}\n` +
        "If it runs as the background service, see `pnpm service status`; to stop that: `pnpm service stop`.\n" +
        `To stop anything else that holds the port:  lsof -ti tcp:${port} | xargs kill`,
    );
    process.exit(1);
  }
}

if (!process.env.MUSTER_MODEL_API_KEY) {
  console.warn(
    "No model is configured, so agents cannot reply. Set MUSTER_MODEL_API, MUSTER_MODEL_ID,\n" +
      "MUSTER_MODEL_BASE_URL and MUSTER_MODEL_API_KEY in the environment or in .env (see .env.example).\n",
  );
}

const children = [
  ["server", ["--filter", "@muster/server", "dev"]],
  ["web", ["--filter", "@muster/web", "dev"]],
].map(([name, args]) => {
  // Each part runs in a process group of its own, so stopping it also stops what it started.
  const child = spawn("pnpm", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    detached: true,
  });
  const say = (chunk) => {
    for (const line of String(chunk).split("\n")) if (line.trim()) console.log(`[${name}] ${line}`);
  };
  child.stdout.on("data", say);
  child.stderr.on("data", say);
  child.on("exit", (code) => {
    console.error(`[${name}] stopped (${code ?? "signal"}); stopping the rest.`);
    stop(code ?? 1);
  });
  return child;
});

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // It has already gone.
    }
  }
  setTimeout(() => process.exit(code), 500);
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

for (let i = 0; i < 120; i++) {
  if ((await busy(SERVER)) && (await busy(WEB))) {
    console.log(
      `\nMuster is ready: http://localhost:${WEB}\n` +
        "Sign in with a development account (owner@muster.test is the owner). Ctrl+C stops it.\n",
    );
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
