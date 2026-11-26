import { isId, newId } from "@muster/protocol";
import type { Hono } from "hono";
import { z } from "zod";
import { type AppKit, type Ctx, type Env, fail } from "./app.js";
import type { Db, Queryable } from "./db.js";

/**
 * Memory: what a person asked their agents to keep from one conversation to the next. It
 * is the person's own: it goes with them to every agent they use, and the list of what is
 * remembered is shown to nobody else. (What they typed and what an agent answered in a
 * conversation is in that conversation's record, which administrators can read.) See docs/features/marketplace.md, section 11.
 */
export const MEMORY_LIMIT = 200;
export const MEMORY_CHARS = 400;

/** What is remembered for a person, oldest first. Empty when they turned memory off. */
export async function memoriesOf(
  db: Queryable,
  orgId: string,
  userId: string,
): Promise<{ on: boolean; texts: string[] }> {
  const off = (
    await db.query<{ off: boolean }>(
      "select memory_off as off from memberships where org_id = $1 and user_id = $2",
      [orgId, userId],
    )
  )[0]?.off;
  if (off !== false) return { on: false, texts: [] };
  const rows = await db.query<{ text: string }>(
    "select text from memories where org_id = $1 and user_id = $2 order by created_at limit $3",
    [orgId, userId, MEMORY_LIMIT],
  );
  return { on: true, texts: rows.map((row) => row.text) };
}

/** Keeps one sentence. Says so in words the model passes on. */
export async function remember(
  db: Queryable,
  at: { orgId: string; userId: string; conversationId: string },
  said: string,
): Promise<string> {
  const text = said.replace(/\s+/g, " ").trim();
  if (text.length < 3) throw new Error("Say what to remember, in one plain sentence.");
  if (text.length > MEMORY_CHARS)
    throw new Error(`A memory is one sentence, ${MEMORY_CHARS} characters at most. Shorten it.`);
  const held = (
    await db.query<{ n: number }>(
      "select count(*)::int as n from memories where org_id = $1 and user_id = $2",
      [at.orgId, at.userId],
    )
  )[0]?.n;
  if ((held ?? 0) >= MEMORY_LIMIT)
    throw new Error(
      `Memory is full (${MEMORY_LIMIT}). Tell the person: they can remove some in Settings, under Memory.`,
    );
  await db.query(
    "insert into memories (id, org_id, user_id, text, conversation_id) values ($1, $2, $3, $4, $5)",
    [newId(), at.orgId, at.userId, text, at.conversationId],
  );
  // The sentence is not repeated here: what this returns is on record, and a memory is not.
  return 'Remembered. Say so in your reply, beginning "Remembered:".';
}

export function registerMemory(app: Hono<Env>, _kit: AppKit, db: Db): void {
  const org = (c: Ctx) => c.get("session").org.id;
  const me = (c: Ctx) => c.get("session").user.id;

  app.get("/api/app/memory", async (c) => {
    const off = (
      await db.query<{ off: boolean }>(
        "select memory_off as off from memberships where org_id = $1 and user_id = $2",
        [org(c), me(c)],
      )
    )[0]?.off;
    const memories = await db.query(
      `select m.id, m.text, m.created_at as "createdAt", m.conversation_id as "conversationId", v.title as conversation
         from memories m left join conversations v on v.id = m.conversation_id and v.user_id = m.user_id
        where m.org_id = $1 and m.user_id = $2 order by m.created_at desc`,
      [org(c), me(c)],
    );
    return c.json({ off: off ?? false, limit: MEMORY_LIMIT, memories });
  });

  app.put("/api/app/memory/settings", async (c) => {
    const parsed = z
      .strictObject({ off: z.boolean() })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, "invalid_request");
    await db.query("update memberships set memory_off = $3 where org_id = $1 and user_id = $2", [
      org(c),
      me(c),
      parsed.data.off,
    ]);
    return c.json({ off: parsed.data.off });
  });

  app.patch("/api/app/memory/:id", async (c) => {
    const id = c.req.param("id");
    const parsed = z
      .strictObject({ text: z.string().trim().min(3).max(MEMORY_CHARS) })
      .safeParse(await c.req.json().catch(() => null));
    if (!isId(id) || !parsed.success) return fail(c, "invalid_request");
    const changed = await db.query(
      "update memories set text = $4 where id = $1 and org_id = $2 and user_id = $3 returning id",
      [id, org(c), me(c), parsed.data.text.replace(/\s+/g, " ")],
    );
    return changed.length ? c.json({ ok: true }) : fail(c, "not_found");
  });

  app.delete("/api/app/memory/:id", async (c) => {
    const id = c.req.param("id");
    if (!isId(id)) return fail(c, "not_found");
    const removed = await db.query(
      "delete from memories where id = $1 and org_id = $2 and user_id = $3 returning id",
      [id, org(c), me(c)],
    );
    return removed.length ? c.json({ ok: true }) : fail(c, "not_found");
  });

  app.delete("/api/app/memory", async (c) => {
    const removed = await db.query(
      "delete from memories where org_id = $1 and user_id = $2 returning id",
      [org(c), me(c)],
    );
    return c.json({ removed: removed.length });
  });
}

/** See schema.ts, migration 17. */
export const MEMORY_SCHEMA = [
  `create table memories (
    id uuid primary key,
    org_id uuid not null references organizations(id) on delete cascade,
    user_id uuid not null references users(id) on delete cascade,
    text text not null,
    conversation_id uuid references conversations(id) on delete set null,
    created_at timestamptz not null default now()
  )`,
  `create index memories_user on memories (org_id, user_id, created_at)`,
  `alter table memberships add column memory_off boolean not null default false`,
];
