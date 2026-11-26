import { isId, newId } from "@muster/protocol";
import type { Hono } from "hono";
import { z } from "zod";
import { type AppKit, type Ctx, type Env, fail } from "./app.js";
import { recordEvent } from "./audit.js";
import type { CodeHosts } from "./codeHost.js";
import type { Db, Queryable } from "./db.js";
import { Refusal } from "./errors.js";
import {
  dropItem,
  ITEM_DETAIL_CHARS,
  ITEM_KINDS,
  ITEM_TITLE_CHARS,
  ITEM_URL_CHARS,
  ItemProblem,
  keepItem,
  listItems,
  lives,
  moveItem,
  type ProjectItem,
} from "./projectItems.js";
import { listDocs, projectAccess } from "./projects.js";

/** What is written in the activity log when something kept in a project changes. */
export async function recordItem(
  db: Queryable,
  event: {
    orgId: string;
    actor: { userId: string; email: string };
    action: "project.item_added" | "project.item_changed" | "project.item_removed";
    project: { id: string; name: string };
    item: Pick<ProjectItem, "kind" | "title">;
    /** The agent that did it for the person, when one did. */
    agent?: string | null;
    /** It was only given another place among those of its kind. */
    moved?: boolean;
    ip?: string | null;
  },
): Promise<void> {
  await recordEvent(db, {
    orgId: event.orgId,
    actor: event.actor,
    action: event.action,
    target: { type: "project", id: event.project.id, label: event.project.name.slice(0, 120) },
    detail: {
      kind: event.item.kind,
      title: event.item.title.slice(0, 120),
      ...(event.agent ? { agent: event.agent } : {}),
      ...(event.moved ? { moved: true } : {}),
    },
    ip: event.ip ?? null,
  });
}

/**
 * What lives in a project, as its page reads and changes it (MUS-59). Anyone in the
 * project reads the list; its owner and whoever works in it change it. An agent changes
 * it through `project.keep` and `project.drop` (runs.ts), under the same rule.
 */
export function registerProjectItems(app: Hono<Env>, kit: AppKit, db: Db, hosts: CodeHosts): void {
  const { actorOf, clientIp, inTx } = kit;
  const org = (c: Ctx) => c.get("session").org.id;
  const me = (c: Ctx) => c.get("session").user.id;
  const RANK = { view: 0, work: 1, owner: 2 } as const;
  const reach = async (c: Ctx, need: keyof typeof RANK, tx: Queryable = db) => {
    const id = c.req.param("id") ?? "";
    const access = isId(id) ? await projectAccess(tx, org(c), me(c), id) : null;
    if (!access) throw new Refusal("not_found");
    if (RANK[access.reach] < RANK[need]) throw new Refusal("project_view_only");
    return {
      orgId: org(c),
      userId: access.ownerId,
      projectId: id,
      actorId: me(c),
      name: access.name,
      reach: access.reach,
    };
  };
  const shown = (item: ProjectItem) => ({ ...item, updatedAt: item.updatedAt });

  app.get("/api/app/projects/:id/items", async (c) => {
    const at = await reach(c, "view");
    const [items, docs] = await Promise.all([listItems(db, at), listDocs(db, at)]);
    return c.json({ items: lives(items, docs).map(shown) });
  });

  const text = (most: number) => z.string().max(most);
  const Fields = {
    title: text(ITEM_TITLE_CHARS * 2).optional(),
    detail: text(ITEM_DETAIL_CHARS * 2).optional(),
    url: text(ITEM_URL_CHARS).nullable().optional(),
    ref: text(300).optional(),
    version: text(200).optional(),
    branch: text(200).optional(),
    email: text(300).optional(),
    phone: text(60).optional(),
    due: text(20).optional(),
  };
  const said = (c: Ctx, error: unknown) => {
    if (error instanceof ItemProblem) return fail(c, error.code);
    throw error;
  };

  app.post("/api/app/projects/:id/items", async (c) => {
    const parsed = z
      .strictObject({ kind: z.enum(ITEM_KINDS), ...Fields })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, "invalid_item");
    const body = parsed.data;
    return inTx(c, async (tx) => {
      const at = await reach(c, "work", tx);
      try {
        const kept = await keepItem(tx, at, { ...body, url: body.url ?? undefined }, null, newId);
        if (!kept) return fail(c, "not_found");
        await recordItem(tx, {
          orgId: org(c),
          actor: actorOf(c),
          action: "project.item_added",
          project: { id: at.projectId, name: at.name },
          item: kept.item,
          ip: clientIp(c),
        });
        return c.json(shown(kept.item));
      } catch (error) {
        return said(c, error);
      }
    });
  });

  app.patch("/api/app/projects/:id/items/:item", async (c) => {
    const item = c.req.param("item");
    const parsed = z
      .strictObject({ ...Fields, to: z.number().int().min(0).max(100).optional() })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success || !isId(item)) return fail(c, "invalid_item");
    const { to, ...body } = parsed.data;
    return inTx(c, async (tx) => {
      const at = await reach(c, "work", tx);
      try {
        const changes = Object.values(body).some((value) => value !== undefined);
        // An address taken away is said as null; one not spoken of is left as it is.
        const kept = changes
          ? await keepItem(
              tx,
              at,
              { id: item, ...body, url: body.url === null ? "" : body.url },
              null,
              newId,
            )
          : null;
        if (changes && !kept) return fail(c, "not_found");
        if (to !== undefined && !(await moveItem(tx, at, item, to))) return fail(c, "not_found");
        const now = (await listItems(tx, at)).find((one) => one.id === item);
        if (!now) return fail(c, "not_found");
        // A thing only moved among the others of its kind is a change like any other.
        await recordItem(tx, {
          orgId: org(c),
          actor: actorOf(c),
          action: "project.item_changed",
          project: { id: at.projectId, name: at.name },
          item: now,
          moved: to !== undefined && !kept,
          ip: clientIp(c),
        });
        return c.json(shown(now));
      } catch (error) {
        return said(c, error);
      }
    });
  });

  app.delete("/api/app/projects/:id/items/:item", async (c) => {
    const item = c.req.param("item");
    if (!isId(item)) return fail(c, "not_found");
    return inTx(c, async (tx) => {
      const at = await reach(c, "work", tx);
      const was = await dropItem(tx, at, { id: item });
      if (!was) return fail(c, "not_found");
      await recordItem(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "project.item_removed",
        project: { id: at.projectId, name: at.name },
        item: was,
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    });
  });

  // How the project's repositories stand on the code host: asked for after the page is
  // shown. What cannot be had is said with its reason, in a word the page can put in a
  // quiet line: no code host is connected, this person may not work on that repository,
  // or the host did not answer. Nothing of the host's answer is passed on.
  app.get("/api/app/projects/:id/repos", async (c) => {
    const at = await reach(c, "view");
    const refs = (await listItems(db, at)).flatMap((item) =>
      item.kind === "repo" && item.ref ? [item.ref] : [],
    );
    type Standing = Awaited<ReturnType<CodeHosts["standing"]>>;
    let read: Standing = { facts: {}, absent: {} };
    try {
      // What this person may be shown of the code host, not what the project's owner may.
      read = await hosts.standing(org(c), me(c), refs);
    } catch {
      read = { facts: {}, absent: Object.fromEntries(refs.map((ref) => [ref, "failed"])) };
    }
    // By the name as the project keeps it, whatever its letters' case on the host.
    const facts: Standing["facts"] = {};
    const absent: Standing["absent"] = {};
    const lower = <T>(from: Record<string, T>) =>
      new Map(Object.entries(from).map(([name, value]) => [name.toLowerCase(), value]));
    const had = lower(read.facts);
    const why = lower(read.absent);
    for (const ref of refs) {
      const found = had.get(ref.toLowerCase());
      if (found) facts[ref] = found;
      else absent[ref] = why.get(ref.toLowerCase()) ?? "failed";
    }
    // One reason for the page's one line, when every repository lacks its facts for the same.
    const reasons = [...new Set(Object.values(absent))];
    const reason = Object.keys(facts).length === 0 && reasons.length === 1 ? reasons[0] : null;
    return c.json({ facts, absent, reason: reason ?? null });
  });
}
