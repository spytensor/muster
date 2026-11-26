import { isId, newId } from "@muster/protocol";
import type { Hono } from "hono";
import { z } from "zod";
import { type AppKit, type Ctx, type Env, fail } from "./app.js";
import { recordEvent } from "./audit.js";
import type { Db, Queryable } from "./db.js";
import { Refusal } from "./errors.js";
import type { Files } from "./files/service.js";
import { plainName } from "./names.js";
import { sharedWith, unlist } from "./sharing.js";

/**
 * Knowledge bases: a set of documents an agent can look things up in. A base is its
 * owner's; who else may read it is who it is shared with. An agent searches, for a
 * person, only bases that person can see, whatever the agent carries.
 *
 * Search is by words. Text is cut into passages; a question is matched on its words
 * (Latin words, and pairs of characters for Chinese, which has no spaces). It finds what
 * shares words with the question; it does not understand meaning. See
 * docs/features/marketplace.md, section 5.
 */
const PASSAGE = 900;
const OVERLAP = 120;
const PASSAGES_PER_BASE = 2000;
const ITEM_CHARS = 400_000;

/** Cuts text into passages at paragraph ends where it can, each a little into the next. */
export function passagesOf(text: string): string[] {
  const clean = text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  const out: string[] = [];
  for (let at = 0; at < clean.length && out.length < PASSAGES_PER_BASE; ) {
    let end = Math.min(clean.length, at + PASSAGE);
    if (end < clean.length) {
      // Back to the last paragraph or sentence end in the second half, so a passage reads whole.
      const window = clean.slice(at + PASSAGE / 2, end);
      const cut = Math.max(
        window.lastIndexOf("\n\n"),
        window.lastIndexOf("。"),
        window.lastIndexOf(". "),
      );
      if (cut > 0) end = at + PASSAGE / 2 + cut + 1;
    }
    const passage = clean.slice(at, end).trim();
    if (passage) out.push(passage);
    if (end >= clean.length) break;
    at = Math.max(end - OVERLAP, at + 1);
  }
  return out;
}

/** The words of a text as they are matched: Latin words, and each pair of neighbouring Chinese characters. */
export function termsOf(text: string): string[] {
  const terms: string[] = [];
  const lower = text.toLowerCase();
  for (const word of lower.match(/[a-z0-9][a-z0-9_.-]*[a-z0-9]|[a-z0-9]/g) ?? [])
    if (word.length >= 2) terms.push(word);
  for (const run of lower.match(/[㐀-鿿豈-﫿]+/g) ?? []) {
    if (run.length === 1) terms.push(run);
    for (let i = 0; i + 1 < run.length; i++) terms.push(run.slice(i, i + 2));
  }
  return terms;
}

export interface Hit {
  base: string;
  source: string;
  text: string;
}

/** The passages of these bases that best share words with the question. */
export async function searchKnowledge(
  db: Queryable,
  baseIds: string[],
  question: string,
  limit = 5,
): Promise<Hit[]> {
  const wanted = [...new Set(termsOf(question))];
  if (baseIds.length === 0 || wanted.length === 0) return [];
  const rows = await db.query<{ base: string; source: string; text: string }>(
    `select b.name as base, i.name as source, p.text
       from knowledge_passages p
       join knowledge_items i on i.id = p.item_id
       join knowledge_bases b on b.id = p.kb_id
      where p.kb_id = any($1::uuid[]) and b.deleted_at is null
      limit 8000`,
    [baseIds],
  );
  if (rows.length === 0) return [];
  // How many passages hold each word: a word in every passage says little.
  const held = rows.map((row) => {
    const counts = new Map<string, number>();
    for (const term of termsOf(row.text)) counts.set(term, (counts.get(term) ?? 0) + 1);
    return counts;
  });
  const scored = rows
    .map((row, index) => {
      const counts = held[index] as Map<string, number>;
      let score = 0;
      let matched = 0;
      for (const term of wanted) {
        const n = counts.get(term) ?? 0;
        if (n === 0) continue;
        matched += 1;
        const inPassages = held.reduce((sum, other) => sum + (other.has(term) ? 1 : 0), 0);
        score += Math.log(1 + rows.length / inPassages) * Math.min(3, n);
      }
      // A passage that holds more of the question's different words comes first.
      return { row, score: score * (0.5 + matched / wanted.length) };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((item) => item.row);
}

/** The bases among these that this person may read: their own and those shared with them. */
export async function readableBases(
  db: Queryable,
  orgId: string,
  userId: string,
  ids: string[],
): Promise<{ id: string; name: string }[]> {
  if (ids.length === 0) return [];
  return db.query(
    `select b.id, b.name from knowledge_bases b
      where b.org_id = $1 and b.deleted_at is null and b.id = any($3::uuid[])
        and (b.owner_user_id = $2 or ${sharedWith("knowledge", "b", "$1", "$2")})`,
    [orgId, userId, ids],
  );
}

const BaseBody = z.strictObject({
  name: plainName(60),
  description: z.string().trim().max(300).default(""),
});

export function registerKnowledge(app: Hono<Env>, kit: AppKit, db: Db, files: Files): void {
  const { actorOf, clientIp, inTx } = kit;
  const org = (c: Ctx) => c.get("session").org.id;
  const me = (c: Ctx) => c.get("session").user.id;
  const own = async (tx: Queryable, c: Ctx, id: string) =>
    (
      await tx.query<{ name: string }>(
        "select name from knowledge_bases where id = $1 and org_id = $2 and owner_user_id = $3 and deleted_at is null",
        [id, org(c), me(c)],
      )
    )[0];

  app.get("/api/app/knowledge", async (c) => {
    const rows = await db.query(
      `select b.id, b.name, b.description, b.updated_at as "updatedAt", (b.owner_user_id = $2) as mine,
              case when b.owner_user_id <> $2 then json_build_object('name', o.name, 'email', o.email) end as "sharedBy",
              (select count(*)::int from shares s where s.kind = 'knowledge' and s.item_id = b.id) as shares,
              (select count(*)::int from knowledge_items i where i.kb_id = b.id) as items,
              (select count(*)::int from knowledge_passages p where p.kb_id = b.id) as passages
         from knowledge_bases b left join users o on o.id = b.owner_user_id
        where b.org_id = $1 and b.deleted_at is null
          and (b.owner_user_id = $2 or ${sharedWith("knowledge", "b", "$1", "$2")})
        order by (b.owner_user_id = $2) desc, b.name`,
      [org(c), me(c)],
    );
    return c.json(rows);
  });

  // What is in a base, for anyone who may read it.
  app.get("/api/app/knowledge/:id", async (c) => {
    const id = c.req.param("id");
    if (!isId(id) || (await readableBases(db, org(c), me(c), [id])).length === 0)
      return fail(c, "not_found");
    return c.json(
      await db.query(
        `select i.id, i.name, i.status, i.problem, i.chars, i.created_at as "addedAt",
                (select count(*)::int from knowledge_passages p where p.item_id = i.id) as passages
           from knowledge_items i where i.kb_id = $1 order by i.created_at`,
        [id],
      ),
    );
  });

  const save = async (c: Ctx, id: string | null) => {
    const parsed = BaseBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, "invalid_request");
    return inTx(c, async (tx) => {
      if (id && !(await own(tx, c, id))) throw new Refusal("not_found");
      const clash = await tx.query(
        "select 1 from knowledge_bases where org_id = $1 and owner_user_id = $2 and lower(name) = lower($3) and deleted_at is null and id <> $4",
        [org(c), me(c), parsed.data.name, id ?? newId()],
      );
      if (clash.length > 0) throw new Refusal("knowledge_name_taken");
      const baseId = id ?? newId();
      if (id)
        await tx.query(
          "update knowledge_bases set name = $2, description = $3, updated_at = now() where id = $1",
          [id, parsed.data.name, parsed.data.description],
        );
      else
        await tx.query(
          "insert into knowledge_bases (id, org_id, owner_user_id, source, name, description) values ($1, $2, $3, 'user', $4, $5)",
          [baseId, org(c), me(c), parsed.data.name, parsed.data.description],
        );
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: id ? "knowledge.changed" : "knowledge.created",
        target: { type: "knowledge", id: baseId, label: parsed.data.name },
        ip: clientIp(c),
      });
      return c.json({ id: baseId });
    });
  };
  app.post("/api/app/knowledge", (c) => save(c, null));
  app.patch("/api/app/knowledge/:id", (c) => {
    const id = c.req.param("id");
    return isId(id) ? save(c, id) : Promise.resolve(fail(c, "not_found"));
  });

  app.delete("/api/app/knowledge/:id", async (c) => {
    const id = c.req.param("id");
    if (!isId(id)) return fail(c, "not_found");
    return inTx(c, async (tx) => {
      const base = await own(tx, c, id);
      if (!base) throw new Refusal("not_found");
      await tx.query("update knowledge_bases set deleted_at = now() where id = $1", [id]);
      // What it held is not kept once it is gone.
      await tx.query("delete from knowledge_passages where kb_id = $1", [id]);
      await tx.query("delete from knowledge_items where kb_id = $1", [id]);
      await tx.query("delete from shares where kind = 'knowledge' and item_id = $1", [id]);
      await unlist(tx, org(c), "knowledge", id, base.name);
      await tx.query("delete from agent_parts where kind = 'knowledge' and item_id = $1", [id]);
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "knowledge.deleted",
        target: { type: "knowledge", id, label: base.name },
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    });
  });

  // Adds one of the person's files or documents. Its text is copied into the base: the
  // base does not empty when the person later deletes their own copy.
  app.post("/api/app/knowledge/:id/items", async (c) => {
    const id = c.req.param("id");
    const parsed = z
      .strictObject({
        fileId: z.string().refine(isId).optional(),
        documentId: z.string().refine(isId).optional(),
      })
      .refine((value) => Boolean(value.fileId) !== Boolean(value.documentId))
      .safeParse(await c.req.json().catch(() => null));
    if (!isId(id) || !parsed.success) return fail(c, "invalid_request");
    if (!(await own(db, c, id))) return fail(c, "not_found");
    const owner = { orgId: org(c), userId: me(c) };
    let name = "";
    let text = "";
    let problem: string | null = null;
    // Whether there was more than a base keeps of one document.
    let cut = false;
    if (parsed.data.fileId) {
      const file = await files.find(owner, parsed.data.fileId);
      if (!file) return fail(c, "not_found");
      name = file.name;
      try {
        const read = await files.longText(owner.orgId, file, ITEM_CHARS);
        text = read.text;
        cut = read.truncated;
      } catch (error) {
        // Said to the person as the reader said it: protected, damaged, a picture.
        problem = error instanceof Error ? error.message.slice(0, 300) : "It could not be read.";
      }
    } else {
      const document = (
        await db.query<{ title: string; content: string }>(
          "select title, content from documents where id = $1 and org_id = $2 and user_id = $3",
          [parsed.data.documentId, owner.orgId, owner.userId],
        )
      )[0];
      if (!document) return fail(c, "not_found");
      name = document.title;
      text = document.content;
    }
    if (text.length > ITEM_CHARS) cut = true;
    text = text.slice(0, ITEM_CHARS);
    if (!problem && !text.trim()) problem = "It holds no text.";
    const passages = problem ? [] : passagesOf(text);
    return inTx(c, async (tx) => {
      // One add to a base at a time, so the same document sent twice at once is still caught.
      await tx.query("select 1 from knowledge_bases where id = $1 for update", [id]);
      const room = (
        await tx.query<{ n: number }>(
          "select count(*)::int as n from knowledge_passages where kb_id = $1",
          [id],
        )
      )[0]?.n;
      // The same thing a second time would be found twice by every search.
      if (passages.length > 0) {
        const twice = await tx.query(
          `select 1 from knowledge_items i where i.kb_id = $1 and i.name = $2 and i.chars = $3 and i.status = 'ready'
              and (select md5(string_agg(p.text, '' order by p.seq)) from knowledge_passages p where p.item_id = i.id) = md5($4) limit 1`,
          [id, name, text.length, passages.join("")],
        );
        if (twice.length > 0) throw new Refusal("knowledge_duplicate");
      }
      if ((room ?? 0) + passages.length > PASSAGES_PER_BASE) throw new Refusal("knowledge_full");
      const itemId = newId();
      await tx.query(
        "insert into knowledge_items (id, kb_id, name, status, problem, chars) values ($1, $2, $3, $4, $5, $6)",
        [
          itemId,
          id,
          name,
          problem ? "failed" : "ready",
          // Ready, and said to be only its beginning: nobody is left thinking the rest is there.
          problem ??
            (cut
              ? `Only the first ${ITEM_CHARS.toLocaleString("en-US")} characters are kept; the rest of this document is not in the knowledge base.`
              : null),
          text.length,
        ],
      );
      for (const [seq, passage] of passages.entries())
        await tx.query(
          "insert into knowledge_passages (kb_id, item_id, seq, text) values ($1, $2, $3, $4)",
          [id, itemId, seq, passage],
        );
      await tx.query("update knowledge_bases set updated_at = now() where id = $1", [id]);
      return c.json({
        id: itemId,
        status: problem ? "failed" : "ready",
        problem,
        cut,
        passages: passages.length,
      });
    });
  });

  app.delete("/api/app/knowledge/:id/items/:item", async (c) => {
    const id = c.req.param("id");
    const item = c.req.param("item");
    if (!isId(id) || !isId(item) || !(await own(db, c, id))) return fail(c, "not_found");
    const removed = await db.query(
      "delete from knowledge_items where id = $1 and kb_id = $2 returning id",
      [item, id],
    );
    if (removed.length === 0) return fail(c, "not_found");
    await db.query("update knowledge_bases set updated_at = now() where id = $1", [id]);
    return c.json({ ok: true });
  });
}

/** Tables for knowledge bases. See schema.ts, migration 13. */
export const KNOWLEDGE_SCHEMA = [
  `create table knowledge_bases (
    id uuid primary key,
    org_id uuid not null references organizations(id) on delete cascade,
    owner_user_id uuid references users(id) on delete set null,
    source text not null check (source in ('platform', 'org', 'user')),
    name text not null,
    description text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    deleted_at timestamptz
  )`,
  `create table knowledge_items (
    id uuid primary key,
    kb_id uuid not null references knowledge_bases(id) on delete cascade,
    name text not null,
    status text not null check (status in ('ready', 'failed')),
    problem text,
    chars integer not null default 0,
    created_at timestamptz not null default now()
  )`,
  `create table knowledge_passages (
    kb_id uuid not null references knowledge_bases(id) on delete cascade,
    item_id uuid not null references knowledge_items(id) on delete cascade,
    seq integer not null,
    text text not null,
    primary key (item_id, seq)
  )`,
  `create index knowledge_passages_base on knowledge_passages (kb_id)`,
];
