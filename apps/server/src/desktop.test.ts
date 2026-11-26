import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { later } from "./desktop.js";
import { type Harness, harness, PUBLIC_URL } from "./test-support.js";

describe("the desktop app's updates", () => {
  let h: Harness;
  let dir: string;
  beforeAll(async () => {
    h = await harness();
    dir = join(h.config.filesDir, "_desktop");
    // Whatever an earlier run left is not this run's.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const ask = (query: string) => h.app.request(`/desktop/update?${query}`);

  it("knows which version is the later", () => {
    expect(later("0.10.0", "0.9.3")).toBe(true);
    expect(later("1.0.0", "0.99.99")).toBe(true);
    expect(later("0.2.0", "0.2.0")).toBe(false);
    expect(later("0.1.9", "0.2.0")).toBe(false);
    // What is not a version is never the later, and nothing is later than it.
    expect(later("latest", "0.1.0")).toBe(false);
    expect(later("0.2.0", "")).toBe(false);
    expect(later("0.2.0", "0.1")).toBe(false);
  });

  it("says nothing is newer when no build is kept, and needs no session to be asked", async () => {
    const got = await ask("platform=darwin&arch=arm64&version=0.1.0");
    expect(got.status).toBe(204);
    expect((await h.app.request("/desktop/releases/Muster-0.2.0-darwin-arm64.zip")).status).toBe(
      404,
    );
  });

  it("offers a kept build that is later than the one asking, and hands it over", async () => {
    writeFileSync(join(dir, "Muster-0.2.0-darwin-arm64.zip"), "the app");
    writeFileSync(
      join(dir, "darwin-arm64.json"),
      JSON.stringify({ version: "0.2.0", file: "Muster-0.2.0-darwin-arm64.zip", notes: "Faster." }),
    );
    const got = await ask("platform=darwin&arch=arm64&version=0.1.0");
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({
      url: `${PUBLIC_URL}/desktop/releases/Muster-0.2.0-darwin-arm64.zip`,
      name: "0.2.0",
      notes: "Faster.",
    });
    // The newest has nothing newer; nor has another processor, another system, or nonsense.
    for (const query of [
      "platform=darwin&arch=arm64&version=0.2.0",
      "platform=darwin&arch=arm64&version=0.3.0",
      "platform=darwin&arch=x64&version=0.1.0",
      "platform=win32&arch=arm64&version=0.1.0",
      "platform=../../etc&arch=arm64&version=0.1.0",
      "platform=darwin&arch=arm64&version=nonsense",
      "",
    ])
      expect((await ask(query)).status, query).toBe(204);
    const file = await h.app.request("/desktop/releases/Muster-0.2.0-darwin-arm64.zip");
    expect(file.status).toBe(200);
    expect(file.headers.get("content-length")).toBe("7");
    expect(await file.text()).toBe("the app");
  });

  it("hands over nothing but a build's archive from its own folder", async () => {
    // The small file that names the build is not an archive; nor is anything outside.
    for (const name of [
      "darwin-arm64.json",
      "..%2F..%2F.secret-key",
      ".secret-key",
      "%2e%2e%2fa.zip",
      "a.txt",
    ])
      expect((await h.app.request(`/desktop/releases/${name}`)).status, name).toBe(404);
    // A build named and not there is not offered.
    writeFileSync(
      join(dir, "darwin-x64.json"),
      JSON.stringify({ version: "9.0.0", file: "gone.zip" }),
    );
    expect((await ask("platform=darwin&arch=x64&version=0.1.0")).status).toBe(204);
    // Nor one whose archive is named with a path.
    writeFileSync(
      join(dir, "linux-x64.json"),
      JSON.stringify({ version: "9.0.0", file: "../x.zip" }),
    );
    expect((await ask("platform=linux&arch=x64&version=0.1.0")).status).toBe(204);
  });
});
