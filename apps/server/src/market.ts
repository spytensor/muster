import { isId } from "@muster/protocol";
import type { Hono } from "hono";
import { z } from "zod";
import { type AppKit, type Ctx, type Env, fail } from "./app.js";
import { recordEvent } from "./audit.js";
import type { Db, Queryable } from "./db.js";
import { Refusal } from "./errors.js";
import { notify } from "./notices.js";
import { can } from "./roles.js";
import { ITEM_KINDS, type ItemKind, unlist } from "./sharing.js";

/**
 * The marketplace: what the company offers its people. A person's own agent, skill or
 * knowledge base gets there by being submitted and approved; an administrator's goes
 * straight in. People add what they want; a department can be given something outright.
 * See docs/features/marketplace.md, sections 7 and 8.
 *
 * Who may use a published thing is decided in sharing.ts (`sharedWith`), the one place
 * every "may this person use it" question goes through.
 */

/** Every item that can be listed, whatever its kind, in one shape. */
const ITEMS = `(
  select 'agent' as kind, id, org_id, owner_user_id, name, description, version, (state = 'published') as ready, risk
    from agents where source = 'user' and deleted_at is null
  union all
  select 'skill', id, org_id, owner_user_id, name, description, version, (scan_status = 'passed'), null
    from skills where source = 'user' and deleted_at is null
  union all
  select 'knowledge', id, org_id, owner_user_id, name, description, '', true, null
    from knowledge_bases where source = 'user' and deleted_at is null
)`;
const DEPARTMENT = `(select m.department_id from memberships m where m.org_id = $1 and m.user_id = $2 and m.status = 'active')`;

export type MarketRules = {
  /** Members may make their own agents, skills and knowledge bases. */
  build: boolean;
  /** Members may share what they made with colleagues and departments. */
  share: boolean;
  /** Members may submit what they made to the marketplace. */
  submit: boolean;
  /** The furthest a member's own agent may reach. */
  reach: "R1" | "R2" | "R3";
};
export async function rulesOf(db: Queryable, orgId: string): Promise<MarketRules> {
  const row = (
    await db.query<MarketRules>(
      `select members_build as build, members_share as share, members_submit as submit, members_reach as reach
         from org_settings where org_id = $1`,
      [orgId],
    )
  )[0];
  return row ?? { build: true, share: true, submit: true, reach: "R3" };
}

const kindOf = (c: Ctx): { kind: ItemKind; id: string } | null => {
  const kind = c.req.param("kind") ?? "";
  const id = c.req.param("id") ?? "";
  return (ITEM_KINDS as readonly string[]).includes(kind) && isId(id)
    ? { kind: kind as ItemKind, id }
    : null;
};
const LINK: Record<ItemKind, string> = {
  agent: "agents",
  skill: "agents/skills",
  knowledge: "knowledge",
};

export function registerMarket(app: Hono<Env>, kit: AppKit, db: Db): void {
  const { actorOf, clientIp, inTx, need } = kit;
  const org = (c: Ctx) => c.get("session").org.id;
  const me = (c: Ctx) => c.get("session").user.id;
  const runsIt = (c: Ctx) => can(c.get("session").role, "agents.manage");

  // The organization's rules are enforced here, where the act happens, before the routes
  // that do it. Those who run the organization are not bound by rules for members.
  app.use("/api/app/*", async (c, next) => {
    const path = c.req.path;
    const method = c.req.method;
    const makes =
      method === "POST" &&
      (/^\/api\/app\/(agents|skills|knowledge)$/.test(path) ||
        /^\/api\/app\/agents\/[^/]+\/copy$/.test(path));
    const shares = method === "PUT" && /^\/api\/app\/items\/[^/]+\/[^/]+\/shares$/.test(path);
    if ((makes || shares) && c.get("session") && !runsIt(c as Ctx)) {
      const rules = await rulesOf(db, org(c as Ctx));
      if (makes && !rules.build) return fail(c, "building_off");
      if (shares && !rules.share) return fail(c, "sharing_off");
    }
    return next();
  });

  // What the company offers this person, what they offered it, and what they could offer.
  app.get("/api/app/market", async (c) => {
    const items = await db.query(
      `select i.kind, i.id, i.name, i.description, i.risk, (i.owner_user_id = $2) as mine,
              json_build_object('name', o.name, 'email', o.email) as by,
              l.decided_at as "since",
              (select count(*)::int from additions d where d.kind = i.kind and d.item_id = i.id) as adds,
              exists (select 1 from additions d where d.user_id = $2 and d.kind = i.kind and d.item_id = i.id) as added,
              coalesce(${DEPARTMENT} = any(l.defaults), false) as given,
              coalesce((select json_agg(d.name order by d.name) from departments d where d.id = any(l.departments)), '[]'::json) as departments
         from listings l join ${ITEMS} i on i.kind = l.kind and i.id = l.item_id and i.org_id = l.org_id
         left join users o on o.id = i.owner_user_id
        where l.org_id = $1 and l.state = 'published' and l.version = i.version and i.ready
          and (l.departments = '{}' or ${DEPARTMENT} = any(l.departments) or i.owner_user_id = $2)
        order by i.kind, i.name`,
      [org(c), me(c)],
    );
    const mine = await db.query(
      `select i.kind, i.id, i.name, i.ready,
              case when l.state = 'published' and l.version <> i.version then 'changed' else l.state end as state,
              l.reason, l.departments
         from ${ITEMS} i left join listings l on l.kind = i.kind and l.item_id = i.id
        where i.org_id = $1 and i.owner_user_id = $2 order by i.kind, i.name`,
      [org(c), me(c)],
    );
    // What everyone has from the start is not on the shelf: it is already among the
    // person's agents, and the shelf is for what they could add (CHA-271).
    const rules = await rulesOf(db, org(c));
    return c.json({
      items,
      mine,
      maySubmit: runsIt(c) || rules.submit,
      decides: runsIt(c),
    });
  });

  // Offers something of one's own to the company. An administrator's goes straight in;
  // anyone else's waits for one.
  app.post("/api/app/market/:kind/:id", async (c) => {
    const which = kindOf(c);
    const parsed = z
      .strictObject({
        departments: z.array(z.string().refine(isId)).max(50).default([]),
        note: z.string().trim().max(500).default(""),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!which || !parsed.success) return fail(c, "invalid_request");
    return inTx(c, async (tx) => {
      const item = (
        await tx.query<{ name: string; version: string; ready: boolean }>(
          `select name, version, ready from ${ITEMS} i where i.kind = $1 and i.id = $2 and i.org_id = $3 and i.owner_user_id = $4`,
          [which.kind, which.id, org(c), me(c)],
        )
      )[0];
      if (!item) throw new Refusal("not_found");
      // A skill that did not pass its scan, or an agent still waiting for approval, is not offered.
      if (!item.ready) throw new Refusal("not_ready_to_publish");
      const direct = runsIt(c);
      if (!direct && !(await rulesOf(tx, org(c))).submit) throw new Refusal("submitting_off");
      const known = parsed.data.departments.length
        ? await tx.query("select id from departments where org_id = $1 and id = any($2::uuid[])", [
            org(c),
            parsed.data.departments,
          ])
        : [];
      if (known.length !== new Set(parsed.data.departments).size)
        throw new Refusal("invalid_request");
      await tx.query(
        `insert into listings (org_id, kind, item_id, state, version, departments, note, submitted_by, decided_by, decided_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, case when $9::uuid is null then null else now() end)
         on conflict (kind, item_id) do update set state = excluded.state, version = excluded.version,
           departments = excluded.departments, note = excluded.note, submitted_by = excluded.submitted_by,
           submitted_at = now(), decided_by = excluded.decided_by, decided_at = excluded.decided_at, reason = ''`,
        [
          org(c),
          which.kind,
          which.id,
          direct ? "published" : "pending",
          item.version,
          parsed.data.departments,
          parsed.data.note,
          me(c),
          direct ? me(c) : null,
        ],
      );
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: direct ? "market.published" : "market.submitted",
        target: { type: which.kind, id: which.id, label: item.name },
        detail: { departments: parsed.data.departments },
        ip: clientIp(c),
      });
      return c.json({ state: direct ? "published" : "pending" });
    });
  });

  // Its owner takes it out of the marketplace again. Those who added it no longer have it.
  app.delete("/api/app/market/:kind/:id", async (c) => {
    const which = kindOf(c);
    if (!which) return fail(c, "not_found");
    return inTx(c, async (tx) => {
      const item = (
        await tx.query<{ name: string }>(
          `select i.name from ${ITEMS} i join listings l on l.kind = i.kind and l.item_id = i.id
            where i.kind = $1 and i.id = $2 and i.org_id = $3 and i.owner_user_id = $4`,
          [which.kind, which.id, org(c), me(c)],
        )
      )[0];
      if (!item) throw new Refusal("not_found");
      await unlist(tx, org(c), which.kind, which.id, item.name);
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "market.withdrawn",
        target: { type: which.kind, id: which.id, label: item.name },
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    });
  });

  // Adds a published thing to one's workspace, or takes it out again.
  const visible = async (c: Ctx, which: { kind: ItemKind; id: string }) =>
    (
      await db.query(
        `select 1 from listings l join ${ITEMS} i on i.kind = l.kind and i.id = l.item_id
          where l.org_id = $1 and l.kind = $3 and l.item_id = $4 and l.state = 'published' and l.version = i.version
            and i.ready and i.owner_user_id is distinct from $2
            and (l.departments = '{}' or ${DEPARTMENT} = any(l.departments))`,
        [org(c), me(c), which.kind, which.id],
      )
    ).length > 0;
  app.put("/api/app/market/:kind/:id/added", async (c) => {
    const which = kindOf(c);
    if (!which || !(await visible(c, which))) return fail(c, "not_found");
    await db.query(
      "insert into additions (user_id, kind, item_id) values ($1, $2, $3) on conflict do nothing",
      [me(c), which.kind, which.id],
    );
    // Put away earlier and added again, it is back.
    await db.query("delete from share_hidden where user_id = $1 and kind = $2 and item_id = $3", [
      me(c),
      which.kind,
      which.id,
    ]);
    return c.json({ ok: true });
  });
  app.delete("/api/app/market/:kind/:id/added", async (c) => {
    const which = kindOf(c);
    if (!which) return fail(c, "not_found");
    await db.query("delete from additions where user_id = $1 and kind = $2 and item_id = $3", [
      me(c),
      which.kind,
      which.id,
    ]);
    return c.json({ ok: true });
  });

  // For those who run the organization: everything offered, in any state, and the rules.
  app.get("/api/market", async (c) => {
    const denied = need(c, "agents.read");
    if (denied) return denied;
    const listings = await db.query(
      `select i.kind, i.id, i.name, i.description, i.risk, i.ready,
              case when l.state = 'published' and l.version <> i.version then 'changed' else l.state end as state,
              l.note, l.reason, l.departments, l.defaults, l.submitted_at as "submittedAt", l.decided_at as "decidedAt",
              json_build_object('name', o.name, 'email', o.email) as by,
              (select u.email from users u where u.id = l.decided_by) as "decidedBy",
              (select count(*)::int from additions d where d.kind = i.kind and d.item_id = i.id) as adds,
              i.version,
              -- What a reviewer decides on: the thing itself, as it now is.
              case i.kind
                when 'agent' then (
                  select json_build_object('instructions', a.instructions, 'tools', a.tools, 'carries',
                           coalesce((select json_agg(json_build_object('kind', k.kind, 'name', k.name) order by k.kind, k.name)
                              from agent_parts p join (
                                select 'skill' as kind, id, name from skills where deleted_at is null
                                union all select 'knowledge', id, name from knowledge_bases where deleted_at is null
                                union all select 'connector', id, name from org_connectors where deleted_at is null
                              ) k on k.kind = p.kind and k.id = p.item_id where p.agent_id = a.id), '[]'::json))
                    from agents a where a.id = i.id)
                when 'skill' then (
                  select json_build_object('instructions', k.instructions, 'texts', k.texts, 'findings', k.scan_findings)
                    from skills k where k.id = i.id)
                else (
                  select json_build_object('documents',
                           coalesce((select json_agg(n.name order by n.created_at) from knowledge_items n where n.kb_id = i.id), '[]'::json)))
              end as content
         from listings l join ${ITEMS} i on i.kind = l.kind and i.id = l.item_id and i.org_id = l.org_id
         left join users o on o.id = i.owner_user_id
        where l.org_id = $1 order by l.submitted_at desc`,
      [org(c)],
    );
    return c.json({ rules: await rulesOf(db, org(c)), listings });
  });

  // A decision on a listing: let it in, send it back with a reason, or take it down.
  app.post("/api/market/:kind/:id/decide", async (c) => {
    const denied = need(c, "agents.manage");
    if (denied) return denied;
    const which = kindOf(c);
    const parsed = z
      .strictObject({
        decision: z.enum(["approve", "return", "take_down"]),
        reason: z.string().trim().max(500).default(""),
        // The version the reviewer was shown. Approving is of that one and no other.
        version: z.string().max(200).optional(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!which || !parsed.success) return fail(c, "invalid_request");
    const { decision, reason, version } = parsed.data;
    if (decision === "approve" && version === undefined) return fail(c, "invalid_request");
    // Sent back or taken down, its maker is told why.
    if (decision !== "approve" && !reason) return fail(c, "reason_needed");
    return inTx(c, async (tx) => {
      const row = (
        await tx.query<{
          name: string;
          version: string;
          ready: boolean;
          owner: string | null;
          state: string;
          listed: string;
          defaults: string[];
        }>(
          `select i.name, i.version, i.ready, i.owner_user_id as owner, l.state, l.version as listed, l.defaults
             from listings l join ${ITEMS} i on i.kind = l.kind and i.id = l.item_id
            where l.org_id = $1 and l.kind = $2 and l.item_id = $3 for update of l`,
          [org(c), which.kind, which.id],
        )
      )[0];
      if (!row) throw new Refusal("not_found");
      // What waits for a decision is what its owner submitted, or changed after approval.
      // Something sent back or taken down waits for its owner, not for a second decision.
      const waiting =
        row.state === "pending" || (row.state === "published" && row.listed !== row.version);
      if (decision === "take_down" ? row.state !== "published" : !waiting)
        throw new Refusal("already_decided");
      if (decision === "approve" && !row.ready) throw new Refusal("not_ready_to_publish");
      // Changed by its owner while it waited: what was read is not what would go in.
      if (decision === "approve" && version !== row.version) throw new Refusal("listing_changed");
      const state =
        decision === "approve" ? "published" : decision === "return" ? "returned" : "withdrawn";
      await tx.query(
        "update listings set state = $3, version = $4, reason = $5, decided_by = $6, decided_at = now() where kind = $1 and item_id = $2",
        [which.kind, which.id, state, row.version, reason, me(c)],
      );
      const told = row.owner ? [row.owner] : [];
      if (decision === "take_down") {
        // It leaves the workspace of everyone who added it, and they are told why.
        const had = await tx.query<{ user_id: string }>(
          "delete from additions where kind = $1 and item_id = $2 returning user_id",
          [which.kind, which.id],
        );
        told.push(...had.map((one) => one.user_id));
        // So do the people of the departments that started with it.
        if (row.defaults.length > 0) {
          const given = await tx.query<{ user_id: string }>(
            "select user_id from memberships where org_id = $1 and status = 'active' and department_id = any($2::uuid[])",
            [org(c), row.defaults],
          );
          told.push(...given.map((one) => one.user_id));
        }
      }
      await notify(
        tx,
        { orgId: org(c), userIds: told },
        decision === "approve" ? "approved" : decision === "return" ? "returned" : "taken_down",
        { kind: which.kind, name: row.name, reason: reason || null },
        decision === "approve" ? "market" : LINK[which.kind],
      );
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action:
          decision === "approve"
            ? "market.approved"
            : decision === "return"
              ? "market.returned"
              : "market.taken_down",
        target: { type: which.kind, id: which.id, label: row.name },
        detail: reason ? { reason } : {},
        ip: clientIp(c),
      });
      return c.json({ state });
    });
  });

  // Who a published thing is for, and whose new people start with it.
  app.patch("/api/market/:kind/:id", async (c) => {
    const denied = need(c, "agents.manage");
    if (denied) return denied;
    const which = kindOf(c);
    const parsed = z
      .strictObject({
        departments: z.array(z.string().refine(isId)).max(50),
        defaults: z.array(z.string().refine(isId)).max(50),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!which || !parsed.success) return fail(c, "invalid_request");
    const { departments, defaults } = parsed.data;
    return inTx(c, async (tx) => {
      const all = [...new Set([...departments, ...defaults])];
      const known = all.length
        ? await tx.query("select id from departments where org_id = $1 and id = any($2::uuid[])", [
            org(c),
            all,
          ])
        : [];
      // A department that is given it must be one it is open to.
      if (
        known.length !== all.length ||
        (departments.length > 0 && defaults.some((id) => !departments.includes(id)))
      )
        throw new Refusal("invalid_request");
      const changed = await tx.query<{ name: string }>(
        `update listings l set departments = $4, defaults = $5 from ${ITEMS} i
          where l.org_id = $1 and l.kind = $2 and l.item_id = $3 and i.kind = l.kind and i.id = l.item_id
          returning i.name`,
        [org(c), which.kind, which.id, departments, defaults],
      );
      if (!changed[0]) throw new Refusal("not_found");
      // Narrowed: someone who added it and is no longer among those it is for loses it, and is told.
      if (departments.length > 0) {
        const lost = await tx.query<{ user_id: string }>(
          `delete from additions d where d.kind = $1 and d.item_id = $2 and not exists (
             select 1 from memberships m where m.org_id = $3 and m.user_id = d.user_id
                and m.department_id = any($4::uuid[]))
           returning d.user_id`,
          [which.kind, which.id, org(c), departments],
        );
        if (lost.length > 0)
          await notify(
            tx,
            { orgId: org(c), userIds: lost.map((one) => one.user_id) },
            "withdrawn",
            { kind: which.kind, name: changed[0].name },
            "market",
          );
      }
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "market.reach_changed",
        target: { type: which.kind, id: which.id, label: changed[0].name },
        detail: { departments, defaults },
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    });
  });

  app.put("/api/settings/market", async (c) => {
    const denied = need(c, "settings.manage");
    if (denied) return denied;
    const parsed = z
      .strictObject({
        build: z.boolean(),
        share: z.boolean(),
        submit: z.boolean(),
        reach: z.enum(["R1", "R2", "R3"]),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, "invalid_request");
    const rules = parsed.data;
    return inTx(c, async (tx) => {
      await tx.query(
        `insert into org_settings (org_id, members_build, members_share, members_submit, members_reach)
         values ($1, $2, $3, $4, $5)
         on conflict (org_id) do update set members_build = excluded.members_build, members_share = excluded.members_share,
           members_submit = excluded.members_submit, members_reach = excluded.members_reach`,
        [org(c), rules.build, rules.share, rules.submit, rules.reach],
      );
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "settings.market_rules_changed",
        target: { type: "settings", id: "market", label: "Marketplace rules" },
        detail: rules,
        ip: clientIp(c),
      });
      return c.json(rules);
    });
  });

  // An owner hands everything one person made to another: for when someone leaves.
  app.post("/api/members/:id/handover", async (c) => {
    if (c.get("session").role !== "owner") return fail(c, "forbidden");
    const from = c.req.param("id");
    const parsed = z
      .strictObject({ to: z.string().refine(isId) })
      .safeParse(await c.req.json().catch(() => null));
    if (!isId(from) || !parsed.success || parsed.data.to === from)
      return fail(c, "invalid_request");
    const to = parsed.data.to;
    return inTx(c, async (tx) => {
      const people = await tx.query<{ id: string; name: string; email: string; status: string }>(
        `select u.id, u.name, u.email, m.status from memberships m join users u on u.id = m.user_id
          where m.org_id = $1 and u.id = any($2::uuid[])`,
        [org(c), [from, to]],
      );
      const giver = people.find((person) => person.id === from);
      const taker = people.find((person) => person.id === to);
      if (!giver || taker?.status !== "active") throw new Refusal("not_found");
      const moved: Record<string, number> = {};
      for (const [kind, table] of [
        ["agent", "agents"],
        ["skill", "skills"],
        ["knowledge", "knowledge_bases"],
      ] as const) {
        // A name the new owner already uses is told apart by whose it was.
        const rows = await tx.query(
          `update ${table} t set owner_user_id = $3,
                  name = case when exists (
                           select 1 from ${table} o where o.org_id = $1 and o.owner_user_id = $3
                              and o.deleted_at is null and lower(o.name) = lower(t.name))
                         then left(t.name, 40) || ' (' || left($4, 16) || ')' else t.name end
            where t.org_id = $1 and t.owner_user_id = $2 and t.source = 'user' and t.deleted_at is null
            returning t.id`,
          [org(c), from, to, giver.name || giver.email],
        );
        moved[kind] = rows.length;
        // What was shared with the new owner is now simply theirs.
        await tx.query(
          `delete from shares s using ${table} t where s.kind = $1 and s.item_id = t.id
              and t.owner_user_id = $2 and s.to_kind = 'user' and s.to_id = $2`,
          [kind, to],
        );
        await tx.query(
          `delete from additions d using ${table} t where d.kind = $1 and d.item_id = t.id
              and t.owner_user_id = $2 and d.user_id = $2`,
          [kind, to],
        );
      }
      const total = Object.values(moved).reduce((sum, n) => sum + n, 0);
      if (total > 0)
        await notify(
          tx,
          { orgId: org(c), userIds: [to] },
          "handed_over",
          { name: giver.name || giver.email, count: String(total) },
          "agents",
        );
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "member.handed_over",
        target: { type: "member", id: from, label: giver.email },
        detail: { to: taker.email, ...moved },
        ip: clientIp(c),
      });
      return c.json({ moved });
    });
  });
}

/** Tables for the marketplace. See schema.ts, migration 16. */
export const MARKET_SCHEMA = [
  `create table listings (
    org_id uuid not null references organizations(id) on delete cascade,
    kind text not null check (kind in ('agent', 'skill', 'knowledge')),
    item_id uuid not null,
    state text not null check (state in ('pending', 'published', 'returned', 'withdrawn')),
    version text not null default '',
    departments uuid[] not null default '{}',
    defaults uuid[] not null default '{}',
    note text not null default '',
    reason text not null default '',
    submitted_by uuid references users(id) on delete set null,
    submitted_at timestamptz not null default now(),
    decided_by uuid references users(id) on delete set null,
    decided_at timestamptz,
    primary key (kind, item_id)
  )`,
  `create table additions (
    user_id uuid not null references users(id) on delete cascade,
    kind text not null,
    item_id uuid not null,
    added_at timestamptz not null default now(),
    primary key (user_id, kind, item_id)
  )`,
  `alter table org_settings add column members_build boolean not null default true`,
  `alter table org_settings add column members_share boolean not null default true`,
  `alter table org_settings add column members_submit boolean not null default true`,
  `alter table org_settings add column members_reach text not null default 'R3' check (members_reach in ('R1', 'R2', 'R3'))`,
];
