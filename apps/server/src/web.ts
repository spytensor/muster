import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import type { Env, Hono } from "hono";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".bcmap": "application/octet-stream",
  ".ttf": "font/ttf",
  ".pfb": "application/octet-stream",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

/** The page may load only its own scripts and talk only to this server. */
const PAGE_HEADERS = {
  "content-security-policy":
    // Beyond its own files the page needs three things: inline styles, images and fonts held in
    // memory (a Word file's own pictures and typefaces), and WebAssembly for the PDF engine.
    // It loads no image from any other site: a reply must not be able to make the browser call out.
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-src 'self' http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-cache",
};

/** Paths the server answers itself; an unknown one under these is a 404, never the web app. */
const SERVER_PATHS = /^\/(api|auth|dev-idp)(\/|$)/;

/**
 * Serves the built web app from `dir`, so one process is the whole deployment.
 * Only files found in `dir` when the server started can be served: a request is
 * looked up in that list and never turned into a path on disk.
 */
export function serveWeb<E extends Env>(app: Hono<E>, dir: string): boolean {
  if (!dir || !existsSync(join(dir, "index.html"))) return false;
  const files = new Map<string, string>();
  const walk = (folder: string) => {
    for (const name of readdirSync(folder)) {
      const full = join(folder, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.set(`/${relative(dir, full).split(sep).join("/")}`, full);
    }
  };
  walk(dir);
  const index = files.get("/index.html") as string;

  app.get("*", async (c, next) => {
    const path = c.req.path;
    if (SERVER_PATHS.test(path)) return next();
    const file = files.get(path);
    if (file && file !== index) {
      return c.body(await readFile(file), 200, {
        "content-type": TYPES[extname(file)] ?? "application/octet-stream",
        "x-content-type-options": "nosniff",
        // Built assets carry a hash of their content in their name.
        "cache-control": path.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      });
    }
    // A missing file with an extension is missing; anything else is a page of the app.
    if (extname(path) && path !== "/index.html") return next();
    return c.body(await readFile(index), 200, {
      "content-type": TYPES[".html"] as string,
      ...PAGE_HEADERS,
    });
  });
  return true;
}
