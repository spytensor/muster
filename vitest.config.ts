import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  // The web app writes its own imports from "@/": tests that draw its screens need the same.
  resolve: { alias: { "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)) } },
  test: {
    // A test that starts a server and a database can take a few seconds on a busy machine,
    // and several times that on a hosted runner with a few shared cores: two tests ran
    // past twenty seconds there on 2026-11-26, the first time this ran on GitHub's machines.
    testTimeout: process.env.CI ? 90_000 : 20_000,
    // What a file sets up before its tests (a server, a database, seeded traces) takes as
    // long as a test does.
    hookTimeout: process.env.CI ? 120_000 : 60_000,
    // In CI, no more files at a time than the machine has cores, and never more than
    // eight: each file's embedded database takes memory, and more files than cores only
    // makes every one of them slower.
    ...(process.env.CI ? { maxWorkers: Math.min(8, availableParallelism()) } : {}),
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
