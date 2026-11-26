import { isId } from "@muster/protocol";
import type { Hono } from "hono";
import { z } from "zod";
import { type AppKit, type Ctx, type Env, fail } from "./app.js";
import { Refusal } from "./errors.js";
import { Unreadable } from "./files/extract.js";
import { FILE_ENDINGS } from "./files/kind.js";
import { COMMENT_CHARS, type Files, QUOTA_BYTES } from "./files/service.js";

/** Kinds a browser may show in place. Everything else is always a download. */
/** A remark on a file: which part it is about (a slide, a sheet, a section; may be empty) and what is said. */
const CommentBody = z.strictObject({
  part: z.string().trim().max(120).default(""),
  body: z.string().trim().min(1).max(COMMENT_CHARS),
});
const INLINE = new Set(["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Reads a request body up to a limit; null when it is larger. */
async function readUpTo(request: Request, limit: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > limit) return null;
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const whole = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    whole.set(part, at);
    at += part.byteLength;
  }
  return whole;
}

/** Headers for sending a person their own file: it runs nothing and loads nothing when opened from here. */
const sending = (mime: string, name: string, size: number, inline: boolean) => ({
  "content-type": mime,
  "content-length": String(size),
  "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
  "cache-control": "private, no-store",
});

/**
 * People's files: Word, Excel, PowerPoint, PDF, pages, images and plain text. A file
 * belongs to one person; agents reach it only through tools that pass the gateway.
 */
export function registerFiles(app: Hono<Env>, kit: AppKit, files: Files): void {
  const { clientIp } = kit;
  const owner = (c: Ctx) => {
    const s = c.get("session");
    return { orgId: s.org.id, userId: s.user.id, email: s.user.email };
  };
  const mine = (c: Ctx, id: string) => (isId(id) ? files.find(owner(c), id) : undefined);

  app.get("/api/app/files/limits", (c) =>
    c.json({
      maxBytes: files.maxBytes,
      quotaBytes: QUOTA_BYTES,
      endings: FILE_ENDINGS,
    }),
  );

  app.get("/api/app/files", async (c) => c.json(await files.list(owner(c))));

  // The library, a page at a time: found, narrowed, sorted and counted by the database.
  app.get("/api/app/library", async (c) => {
    const ask = (name: string) => c.req.query(name) ?? "";
    const show = ask("show");
    const sort = ask("sort");
    const project = ask("project");
    return c.json(
      await files.library(owner(c), {
        q: ask("q"),
        show: show === "made" || show === "uploaded" || show === "notes" ? show : "all",
        kind: /^[a-z]{1,20}$/.test(ask("kind")) ? ask("kind") : null,
        projectId: isId(project) ? project : null,
        sort: sort === "name" || sort === "size" ? sort : "recent",
        offset: Number.isFinite(Number(ask("offset"))) ? Number(ask("offset")) : 0,
        limit:
          Number.isFinite(Number(ask("limit"))) && Number(ask("limit")) > 0
            ? Number(ask("limit"))
            : 60,
      }),
    );
  });

  // Several at once, each as it would be deleted alone: a file only by its owner, with
  // its entry in the record; a note only by whoever wrote it. Says how many went.
  app.post("/api/app/library/delete", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      files?: unknown;
      notes?: unknown;
    } | null;
    const ids = (value: unknown) =>
      (Array.isArray(value) ? value : []).filter(
        (id): id is string => typeof id === "string" && isId(id),
      );
    const wanted = { files: ids(body?.files), notes: ids(body?.notes) };
    if (
      wanted.files.length + wanted.notes.length === 0 ||
      wanted.files.length + wanted.notes.length > 200
    )
      return fail(c, "invalid_request");
    let deleted = 0;
    for (const id of wanted.files) {
      const file = await files.find(owner(c), id);
      if (file?.mine && (await files.remove(owner(c), file, clientIp(c)))) deleted += 1;
    }
    deleted += await files.removeNotes(owner(c), wanted.notes);
    return c.json({ deleted });
  });

  // The body is the file itself; its name travels in the address.
  app.post("/api/app/files", async (c) => {
    const bytes = await readUpTo(c.req.raw, files.maxBytes);
    if (!bytes) return fail(c, "file_too_large");
    try {
      return c.json(
        await files.add(owner(c), {
          name: c.req.query("name") ?? "",
          bytes,
          source: "upload",
          ip: clientIp(c),
        }),
      );
    } catch (error) {
      if (error instanceof Refusal) return fail(c, error.code);
      throw error;
    }
  });

  // One file as the person may reach it: whether it is theirs, and whether they may change it.
  app.get("/api/app/files/:id", async (c) => {
    const file = await mine(c, c.req.param("id"));
    if (!file) return fail(c, "not_found");
    const { sha256: _sha, ownerId: _owner, ...shown } = file;
    return c.json({ ...shown, size: Number(file.size) });
  });

  app.get("/api/app/files/:id/content", async (c) => {
    const file = await mine(c, c.req.param("id"));
    if (!file) return fail(c, "not_found");
    const body = await files.content(owner(c).orgId, file.id);
    if (!body) return fail(c, "not_found");
    const inline = INLINE.has(file.mime) && c.req.query("download") === undefined;
    return new Response(body, {
      headers: sending(file.mime, file.name, Number(file.size), inline),
    });
  });

  // The file's text: what an agent reads, and what the viewer falls back to.
  app.get("/api/app/files/:id/text", async (c) => {
    const file = await mine(c, c.req.param("id"));
    if (!file) return fail(c, "not_found");
    try {
      return c.json(await files.text(owner(c).orgId, file));
    } catch (error) {
      if (error instanceof Unreadable)
        return c.json({ text: "", truncated: false, problem: error.message });
      throw error;
    }
  });

  // A workbook as grids of what its cells show, for viewing it as a spreadsheet.
  app.get("/api/app/files/:id/sheets", async (c) => {
    const file = await mine(c, c.req.param("id"));
    if (!file || !/\.xls[xm]$/i.test(file.name)) return fail(c, "not_found");
    try {
      return c.json(await files.sheets(owner(c).orgId, file));
    } catch (error) {
      if (error instanceof Unreadable) return fail(c, "unreadable_file");
      throw error;
    }
  });

  // A file an agent made, version by version: what changed in each, and who asked.
  app.get("/api/app/files/:id/versions", async (c) => {
    const file = await mine(c, c.req.param("id"));
    if (!file) return fail(c, "not_found");
    return c.json({ current: file.version, versions: await files.versions(owner(c), file.id) });
  });
  const numbered = (c: Ctx) => {
    const n = c.req.param("n") ?? "";
    return /^\d{1,6}$/.test(n) ? Number(n) : null;
  };
  // An earlier version, made again from what it was made from, to download and look at.
  app.get("/api/app/files/:id/versions/:n/content", async (c) => {
    const n = numbered(c);
    const id = c.req.param("id");
    const found = n === null || !isId(id) ? null : await files.versionBytes(owner(c), id, n);
    if (!found) return fail(c, "not_found");
    const name = found.file.name.replace(/(\.[a-z0-9]+)$/i, ` (version ${n})$1`);
    const body = found.bytes.buffer.slice(
      found.bytes.byteOffset,
      found.bytes.byteOffset + found.bytes.byteLength,
    ) as ArrayBuffer;
    return new Response(body, {
      headers: sending(found.file.mime, name, found.bytes.byteLength, false),
    });
  });
  // Brings an earlier version back as the newest. What it replaces stays in the list.
  app.post("/api/app/files/:id/versions/:n/restore", async (c) => {
    const n = numbered(c);
    const id = c.req.param("id");
    const file = n === null || !isId(id) ? null : await files.restore(owner(c), id, n, clientIp(c));
    return file ? c.json(file) : fail(c, "not_found");
  });

  // What people said about a file: anyone who may open it reads and adds; whoever may
  // change it, or said it, marks it dealt with.
  app.get("/api/app/files/:id/comments", async (c) => {
    const file = await mine(c, c.req.param("id"));
    if (!file) return fail(c, "not_found");
    return c.json(await files.comments(owner(c), file.id));
  });
  app.post("/api/app/files/:id/comments", async (c) => {
    const body = CommentBody.safeParse(await c.req.json().catch(() => null));
    const id = c.req.param("id");
    if (!body.success || !isId(id)) return fail(c, "invalid_request");
    const made = await files.comment(owner(c), id, body.data);
    if (made === "full") return fail(c, "comments_full");
    return made ? c.json(made) : fail(c, "not_found");
  });
  app.patch("/api/app/files/:id/comments/:n", async (c) => {
    const n = numbered(c);
    const id = c.req.param("id");
    const body = z
      .strictObject({ status: z.enum(["open", "resolved"]) })
      .safeParse(await c.req.json().catch(() => null));
    if (n === null || !isId(id) || !body.success) return fail(c, "invalid_request");
    const file = await files.find(owner(c), id);
    if (!file) return fail(c, "not_found");
    const changed = await files.settle(owner(c), id, [n], body.data.status, file.version);
    return changed > 0 ? c.json({ ok: true }) : fail(c, "not_found");
  });

  app.delete("/api/app/files/:id", async (c) => {
    const file = await mine(c, c.req.param("id"));
    // Only its owner deletes a file: one shared with the person is not theirs to remove.
    if (!file?.mine) return fail(c, "not_found");
    return (await files.remove(owner(c), file, clientIp(c)))
      ? c.json({ ok: true })
      : fail(c, "not_found");
  });
}
