import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { serveWeb } from "./web.js";

function site() {
  const dir = mkdtempSync(join(tmpdir(), "muster-web-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Muster</title>");
  writeFileSync(join(dir, "assets", "app-abc123.js"), "console.log(1)");
  writeFileSync(join(dir, "mark.svg"), "<svg/>");
  const app = new Hono();
  app.get("/api/known", (c) => c.json({ ok: true }));
  return { app, dir };
}

describe("serving the web app", () => {
  it("serves the page, its assets, and the page again for any path inside the app", async () => {
    const { app, dir } = site();
    expect(serveWeb(app, dir)).toBe(true);
    const page = await app.request("/");
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(page.headers.get("cache-control")).toBe("no-cache");
    const asset = await app.request("/assets/app-abc123.js");
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect(await asset.text()).toBe("console.log(1)");
    expect((await app.request("/mark.svg")).headers.get("content-type")).toBe("image/svg+xml");
    expect(await (await app.request("/some/page")).text()).toContain("<title>Muster</title>");
  });

  it("leaves the server's own paths alone and never reaches outside its folder", async () => {
    const { app, dir } = site();
    serveWeb(app, dir);
    expect(await (await app.request("/api/known")).json()).toEqual({ ok: true });
    expect((await app.request("/api/unknown")).status).toBe(404);
    expect((await app.request("/auth/nothing")).status).toBe(404);
    expect((await app.request("/assets/missing.js")).status).toBe(404);
    for (const path of ["/../package.json", "/assets/../../etc/passwd", "/%2e%2e/secret.txt"]) {
      const response = await app.request(path);
      expect(
        response.status === 404 || (await response.text()).includes("<title>Muster"),
        path,
      ).toBe(true);
    }
  });

  it("does nothing when there is no built web app", () => {
    expect(serveWeb(new Hono(), join(tmpdir(), "muster-nothing-here"))).toBe(false);
    expect(serveWeb(new Hono(), "")).toBe(false);
  });
});
