import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  // The web app writes its own imports from "@/": tests that draw its screens need the same.
  resolve: { alias: { "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)) } },
  test: {
    // A test that starts a server and a database can take a few seconds on a busy machine.
    testTimeout: 20_000,
    // What a file sets up before its tests (a server, a database, seeded traces) takes as
    // long as a test does, and longer when the machine is also deploying or running other
    // services: observe.test.ts ran past the default ten seconds on the home runner twice
    // on 2026-11-23 (MUS-33).
    hookTimeout: 60_000,
    // On the runner, eight files at a time: with one per core (28 there) the embedded
    // databases together took 19.7 GB on 2026-11-24, and the machine, which also serves
    // production, killed the runner for want of memory.
    ...(process.env.CI ? { maxWorkers: 8 } : {}),
    // The mobile app is outside the workspace and runs its own tests (apps/mobile).
    exclude: [
      ...configDefaults.exclude,
      // Agent worktrees hold whole copies of this repository; their tests are not this checkout's.
      ".claude/**",
      "apps/mobile/**",
      "apps/desktop/out/**",
      "apps/desktop/dist/**",
    ],
  },
});
