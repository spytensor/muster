import { isId, newId } from "@muster/protocol";
import type { Hono } from "hono";
import { z } from "zod";
import { type AppKit, type Ctx, type Env, fail } from "./app.js";
import { recordEvent } from "./audit.js";
import type { Db, Queryable } from "./db.js";
import { Refusal } from "./errors.js";
import { notify } from "./notices.js";
import { can } from "./roles.js";

/**
 * Who sees what. A thing a person made (an agent, and later a skill or a knowledge base)
 * is seen by its owner, by the people it was shared with, and by the departments it was
 * shared with. See docs/features/marketplace.md, section 2.
 *
 * What is shared runs as the person using it: their documents, files, connections and
 * allowance. A share carries the thing itself and nothing of its owner's.
 */
export const ITEM_KINDS = ["agent", "skill", "knowledge"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
const isKind = (value: string): value is ItemKind =>
  (ITEM_KINDS as readonly string[]).includes(value);

/** Where each kind is kept, and what tells that a row is a person's own and still there. */
const TABLES: Record<ItemKind, { table: string; own: string }> = {
  agent: { table: "agents", own: "source = 'user' and deleted_at is null" },
  skill: { table: "skills", own: "source = 'user' and deleted_at is null" },
  knowledge: { table: "knowledge_bases", own: "source = 'user' and deleted_at is null" },
};

/**
 * SQL that is true when the item in `alias` was shared with the person ($user) directly or
 * through their department, and they have not put it away. `$org` and `$user` are the
 * positions of the organization and the person in the caller's parameters.
 */
export const sharedWith = (kind: ItemKind, alias: string, org: string, user: string) => `((
  exists (
    select 1 from shares s
     where s.org_id = ${org} and s.kind = '${kind}' and s.item_id = ${alias}.id
       and ((s.to_kind = 'user' and s.to_id = ${user})
         or (s.to_kind = 'department' and s.to_id = (
              select m.department_id from memberships m
               where m.org_id = ${org} and m.user_id = ${user} and m.status = 'active')))
  )
  or ${fromMarket(kind, alias, org, user)}
) and not exists (
  select 1 from share_hidden h where h.user_id = ${user} and h.kind = '${kind}' and h.item_id = ${alias}.id
))`;

/**
 * SQL that is true when the item is published in the marketplace as it now is, open to
 * the person's department or to everyone, and the person added it or their department
 * was given it. A thing changed since it was approved is not there until approved again.
 */
export const fromMarket = (kind: ItemKind, alias: string, org: string, user: string) => {
  const department = `(select m.department_id from memberships m
     where m.org_id = ${org} and m.user_id = ${user} and m.status = 'active')`;
  return `exists (
    select 1 from listings l
     where l.org_id = ${org} and l.kind = '${kind}' and l.item_id = ${alias}.id and l.state = 'published'
       and l.version = ${kind === "knowledge" ? "''" : `${alias}.version`}
       and (l.departments = '{}' or ${department} = any(l.departments))
       and (${department} = any(l.defaults) or exists (
             select 1 from additions d
              where d.user_id = ${user} and d.kind = '${kind}' and d.item_id = ${alias}.id))
  )`;
};

/** Whether this person may start or continue work with this agent: it is the company's, their own, or shared with them. */
export async function mayUseAgent(
  db: Queryable,
  orgId: string,
  userId: string,
  agentId: string,
): Promise<boolean> {
  const rows = await db.query(
    `select 1 from agents a
      where a.id = $3 and a.org_id = $1 and a.state = 'published' and a.deleted_at is null
        and (a.source <> 'user' or a.owner_user_id = $2 or ${sharedWith("agent", "a", "$1", "$2")})`,
    [orgId, userId, agentId],
  );
  return rows.length > 0;
}

/**
 * Takes something out of the marketplace because its owner withdrew or deleted it. Those
 * who had added it no longer have it, and are told: it would otherwise just be gone.
 */
export async function unlist(
  tx: Queryable,
  orgId: string,
  kind: ItemKind,
  id: string,
  name: string,
): Promise<void> {
  const listed = await tx.query(
    "delete from listings where kind = $1 and item_id = $2 returning item_id",
    [kind, id],
  );
  const had = await tx.query<{ user_id: string }>(
    "delete from additions where kind = $1 and item_id = $2 returning user_id",
    [kind, id],
  );
  if (listed.length > 0 && had.length > 0)
    await notify(
      tx,
      { orgId, userIds: had.map((one) => one.user_id) },
      "withdrawn",
      { kind, name },
      "market",
    );
}

const ShareBody = z.strictObject({
  toKind: z.enum(["user", "department"]),
  toId: z.string().refine(isId),
  /** For a file: whether those it is shared with may change it, or only read it. */
  canChange: z.boolean().optional(),
});
/** What can be shared with a colleague: the three that can also be offered in the marketplace, and a file. */
type SharedKind = ItemKind | "file";

export function registerSharing(app: Hono<Env>, kit: AppKit, db: Db): void {
  const { actorOf, clientIp, inTx } = kit;
  const org = (c: Ctx) => c.get("session").org.id;
  const me = (c: Ctx) => c.get("session").user.id;

  /**
   * The item, if this person may share it: their own, or the company's for someone who
   * manages agents. Null when there is no such item for them.
   */
  const shareable = async (c: Ctx, tx: Queryable, kind: SharedKind, id: string) => {
    // A file is shared by the person whose it is, and by nobody else.
    if (kind === "file")
      return (
        (
          await tx.query<{ name: string; owner: string | null; source: string }>(
            "select name, user_id as owner, 'user' as source from files where id = $1 and org_id = $2 and user_id = $3 and deleted_at is null",
            [id, org(c), me(c)],
          )
        )[0] ?? null
      );
    const { table, own } = TABLES[kind];
    const row = (
      await tx.query<{ name: string; owner: string | null; source: string }>(
        `select name, owner_user_id as owner, source from ${table} where id = $1 and org_id = $2 and deleted_at is null`,
        [id, org(c)],
      )
    )[0];
    if (!row) return null;
    const mine =
      row.source === "user"
        ? (
            await tx.query(
              `select 1 from ${table} where id = $1 and owner_user_id = $2 and ${own}`,
              [id, me(c)],
            )
          ).length > 0
        : // What the company made is shared by those who manage it.
          can(c.get("session").role, "agents.manage");
    if (!mine) return null;
    // A skill goes to others only as the words that passed its scan. Said only to whoever
    // may share it: nobody else learns that it exists.
    if (kind === "skill") {
      const passed = await tx.query(
        "select 1 from skills where id = $1 and scan_status = 'passed'",
        [id],
      );
      if (passed.length === 0) throw new Refusal("skill_not_passed");
    }
    return row;
  };
  const item = (c: Ctx) => {
    const kind = c.req.param("kind") ?? "";
    const id = c.req.param("id") ?? "";
    return isKind(kind) && isId(id) ? { kind, id } : null;
  };
  /** The same, for the routes that share: a file can be shared too. */
  const sharing = (c: Ctx): { kind: SharedKind; id: string } | null => {
    const id = c.req.param("id") ?? "";
    return c.req.param("kind") === "file" && isId(id) ? { kind: "file", id } : item(c);
  };

  // Colleagues to share with: any member can find another by name or address. No more is
  // said of a person than a colleague already knows: their name, address and department.
  app.get("/api/app/people", async (c) => {
    const q = (c.req.query("q") ?? "").trim().toLowerCase();
    if (q.length < 1) return c.json([]);
    const rows = await db.query(
      `select u.id, u.name, u.email, d.name as "departmentName"
         from memberships m join users u on u.id = m.user_id
         left join departments d on d.id = m.department_id
        where m.org_id = $1 and m.status = 'active' and u.id <> $2
          and (lower(u.name) like $3 or lower(u.email) like $3)
        order by u.name, u.email limit 12`,
      [org(c), me(c), `%${q.replace(/[%_\\]/g, "\\$&")}%`],
    );
    return c.json(rows);
  });
  app.get("/api/app/departments", async (c) =>
    c.json(
      await db.query("select id, name from departments where org_id = $1 order by name", [org(c)]),
    ),
  );

  // Who an item is shared with, for whoever may share it.
  app.get("/api/app/items/:kind/:id/shares", async (c) => {
    const which = sharing(c);
    if (!which || !(await shareable(c, db, which.kind, which.id))) return fail(c, "not_found");
    const rows = await db.query(
      `select s.to_kind as "toKind", s.to_id as "toId", s.created_at as "since", s.can_change as "canChange",
              coalesce(u.name, d.name) as name, u.email
         from shares s
         left join users u on s.to_kind = 'user' and u.id = s.to_id
         left join departments d on s.to_kind = 'department' and d.id = s.to_id
        where s.org_id = $1 and s.kind = $2 and s.item_id = $3
        order by s.to_kind, name`,
      [org(c), which.kind, which.id],
    );
    return c.json(rows);
  });

  app.put("/api/app/items/:kind/:id/shares", async (c) => {
    const which = sharing(c);
    const parsed = ShareBody.safeParse(await c.req.json().catch(() => null));
    if (!which || !parsed.success) return fail(c, "invalid_request");
    const { toKind, toId } = parsed.data;
    // Only a file is shared to be changed: the others are used, never changed, by whom they reach.
    const canChange = which?.kind === "file" && parsed.data.canChange === true;
    return inTx(c, async (tx) => {
      const found = await shareable(c, tx, which.kind, which.id);
      if (!found) return fail(c, "not_found");
      // Only someone in this organization, and never oneself: one already has one's own.
      if (toKind === "user" && toId === me(c)) return fail(c, "share_self");
      const target =
        toKind === "user"
          ? (
              await tx.query<{ label: string }>(
                `select u.email as label from memberships m join users u on u.id = m.user_id
                  where m.org_id = $1 and m.user_id = $2 and m.status = 'active' and u.id <> $3`,
                [org(c), toId, me(c)],
              )
            )[0]
          : (
              await tx.query<{ label: string }>(
                "select name as label from departments where org_id = $1 and id = $2",
                [org(c), toId],
              )
            )[0];
      // Said plainly: there is nobody, or no department, by that id to share with.
      if (!target) return fail(c, toKind === "user" ? "share_nobody" : "share_no_department");
      // Whether it was shared with them already, and with what, is read under the lock
      // the insert takes: of two requests at once, the second sees what the first wrote.
      const added = await tx.query(
        `insert into shares (id, org_id, kind, item_id, to_kind, to_id, by_user_id, can_change)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (kind, item_id, to_kind, to_id) do nothing returning id`,
        [newId(), org(c), which.kind, which.id, toKind, toId, me(c), canChange],
      );
      if (added.length === 0) {
        const switched = await tx.query(
          `update shares set can_change = $5
            where kind = $1 and item_id = $2 and to_kind = $3 and to_id = $4 and can_change <> $5 returning id`,
          [which.kind, which.id, toKind, toId, canChange],
        );
        // Already shared: what they may do with it can still be changed, and is recorded.
        if (switched.length > 0)
          await recordEvent(tx, {
            orgId: org(c),
            actor: actorOf(c),
            action: "item.shared",
            target: { type: which.kind, id: which.id, label: found.name },
            detail: { with: toKind, id: toId, label: target.label, canChange },
            ip: clientIp(c),
          });
      }
      // Someone who put it away and is given it again sees it again, whether or not the
      // share was still there.
      if (toKind === "user")
        await tx.query(
          "delete from share_hidden where user_id = $1 and kind = $2 and item_id = $3",
          [toId, which.kind, which.id],
        );
      // An agent still waiting for approval is not yet anyone's to use: nobody is told of
      // something they cannot see.
      const usable =
        which.kind !== "agent" ||
        (await tx.query("select 1 from agents where id = $1 and state = 'published'", [which.id]))
          .length > 0;
      if (added.length > 0) {
        // Whoever it was shared with is told: one person, or everyone in the department.
        const told =
          toKind === "user"
            ? [toId]
            : (
                await tx.query<{ user_id: string }>(
                  "select user_id from memberships where org_id = $1 and department_id = $2 and status = 'active' and user_id <> $3",
                  [org(c), toId, me(c)],
                )
              ).map((member) => member.user_id);
        await notify(
          tx,
          { orgId: org(c), userIds: usable ? told : [] },
          "shared",
          { kind: which.kind, name: found.name, by: actorOf(c).email },
          which.kind === "agent"
            ? "agents"
            : which.kind === "skill"
              ? "agents/skills"
              : which.kind === "file"
                ? "documents"
                : "knowledge",
        );
        await recordEvent(tx, {
          orgId: org(c),
          actor: actorOf(c),
          action: "item.shared",
          target: { type: which.kind, id: which.id, label: found.name },
          detail: {
            with: toKind,
            id: toId,
            label: target.label,
            ...(which.kind === "file" ? { canChange } : {}),
          },
          ip: clientIp(c),
        });
      }
      return c.json({ ok: true });
    });
  });

  app.delete("/api/app/items/:kind/:id/shares/:toKind/:toId", async (c) => {
    const which = sharing(c);
    const toKind = c.req.param("toKind");
    const toId = c.req.param("toId") ?? "";
    if (!which || (toKind !== "user" && toKind !== "department") || !isId(toId))
      return fail(c, "not_found");
    return inTx(c, async (tx) => {
      const found = await shareable(c, tx, which.kind, which.id);
      if (!found) return fail(c, "not_found");
      const ended = await tx.query(
        "delete from shares where org_id = $1 and kind = $2 and item_id = $3 and to_kind = $4 and to_id = $5 returning id",
        [org(c), which.kind, which.id, toKind, toId],
      );
      if (ended.length === 0) return fail(c, "not_found");
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "item.unshared",
        target: { type: which.kind, id: which.id, label: found.name },
        detail: { with: toKind, id: toId },
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    });
  });

  // The receiver puts away something shared with them. The share stands for others, and
  // for them too if it reaches them again by name.
  app.post("/api/app/items/:kind/:id/hide", async (c) => {
    const which = item(c);
    if (!which) return fail(c, "not_found");
    const { table } = TABLES[which.kind];
    const shared = await db.query(
      `select 1 from ${table} a where a.id = $3 and a.org_id = $1 and ${sharedWith(which.kind, "a", "$1", "$2")}`,
      [org(c), me(c), which.id],
    );
    if (shared.length === 0) return fail(c, "not_found");
    await db.query(
      "insert into share_hidden (user_id, kind, item_id) values ($1, $2, $3) on conflict do nothing",
      [me(c), which.kind, which.id],
    );
    // Something added from the marketplace is no longer added either.
    await db.query("delete from additions where user_id = $1 and kind = $2 and item_id = $3", [
      me(c),
      which.kind,
      which.id,
    ]);
    return c.json({ ok: true });
  });
}

/** Tables for sharing. See schema.ts, migration 11. */
export const SHARING_SCHEMA = [
  `create table shares (
    id uuid primary key,
    org_id uuid not null references organizations(id) on delete cascade,
    kind text not null,
    item_id uuid not null,
    to_kind text not null check (to_kind in ('user', 'department')),
    to_id uuid not null,
    by_user_id uuid references users(id) on delete set null,
    created_at timestamptz not null default now(),
    unique (kind, item_id, to_kind, to_id)
  )`,
  `create index shares_to on shares (org_id, to_kind, to_id)`,
  // What a person put away from what was shared with them.
  `create table share_hidden (
    user_id uuid not null references users(id) on delete cascade,
    kind text not null,
    item_id uuid not null,
    primary key (user_id, kind, item_id)
  )`,
];
