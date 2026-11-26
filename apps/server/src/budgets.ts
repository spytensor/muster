import { isId, newId } from "@muster/protocol";
import type { Hono } from "hono";
import { z } from "zod";
import { type AppKit, type Ctx, type Env, fail } from "./app.js";
import { recordEvent } from "./audit.js";
import type { Config } from "./config.js";
import type { Db, Queryable } from "./db.js";
import { Refusal } from "./errors.js";
import { notify } from "./notices.js";

/**
 * Budgets: the most the company's agents may cost in a calendar month, for the company as
 * a whole, for a department, and for one person. What counts is what each run was recorded
 * to have cost (`traces.cost_micros`), so a model with no price counts for nothing. Months
 * are UTC, like the days of the daily allowance. See docs/features/admin-console.md.
 *
 * At four fifths of a limit the people concerned are told once. At the limit no new run
 * starts, and a run that is going stops after the call that reached it. Two runs at once
 * each stop after their own next call, so a limit can be passed by what those calls cost
 * and no more.
 */

/** See schema.ts, step 37. */
export const BUDGETS_SCHEMA = [
  `create table budgets (
    id uuid primary key,
    org_id uuid not null references organizations(id) on delete cascade,
    -- 'everyone': the limit of each person who has none of their own.
    scope text not null check (scope in ('company', 'department', 'everyone', 'person')),
    -- The department or the person. Null for the company and for everyone.
    target_id uuid,
    -- Millionths of a US dollar a month, as costs are kept.
    monthly_micros bigint not null check (monthly_micros > 0),
    updated_at timestamptz not null default now(),
    check ((scope in ('company', 'everyone')) = (target_id is null))
  )`,
  `create unique index budgets_one on budgets
     (org_id, scope, coalesce(target_id, '00000000-0000-0000-0000-000000000000'::uuid))`,
  // That people were told a limit was near (80) or reached (100) this month: said once.
  `create table budget_marks (
    org_id uuid not null references organizations(id) on delete cascade,
    scope text not null,
    target_id uuid not null,
    month text not null,
    level integer not null,
    at timestamptz not null default now(),
    primary key (org_id, scope, target_id, month, level)
  )`,
];

export type BudgetScope = "company" | "department" | "person";
/** One limit that holds for a person, and what has been spent against it this month. */
export interface Standing {
  scope: BudgetScope;
  /** The department's or the person's id; the company's own for the company. */
  targetId: string;
  /** The department's name. Null for the other two. */
  name: string | null;
  limitMicros: number;
  spentMicros: number;
}

const MONTH_START = "date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'";
/** The most a limit can be: ten million dollars a month. */
const LIMIT_MICROS = 10_000_000_000_000;
/** From here on the people concerned are told the limit is near. */
const NEAR = 0.8;

const Body = z.object({
  scope: z.enum(["company", "department", "everyone", "person"]),
  targetId: z.string().refine(isId).nullable().default(null),
  /** Null takes the limit away. */
  monthlyMicros: z.number().int().min(1).max(LIMIT_MICROS).nullable(),
});

export class Budgets {
  constructor(private readonly db: Db) {}

  /**
   * The limits that hold for one person, widest first, each with this month's spending.
   * `exceptTrace` leaves one run out: a run that is going counts its own spending itself.
   */
  async standing(orgId: string, userId: string, exceptTrace?: string): Promise<Standing[]> {
    const limits = await this.db.query<{
      scope: "company" | "department" | "everyone" | "person";
      targetId: string | null;
      name: string | null;
      monthlyMicros: string;
    }>(
      `select b.scope, b.target_id as "targetId", d.name, b.monthly_micros as "monthlyMicros"
         from budgets b
         left join memberships m on m.org_id = b.org_id and m.user_id = $2
         left join departments d on b.scope = 'department' and d.id = b.target_id
        where b.org_id = $1
          and (b.scope in ('company', 'everyone')
               or (b.scope = 'person' and b.target_id = $2)
               or (b.scope = 'department' and b.target_id = m.department_id))`,
      [orgId, userId],
    );
    if (limits.length === 0) return [];
    const department = limits.find((row) => row.scope === "department");
    const spent = (
      await this.db.query<{ company: string; department: string; person: string }>(
        `select coalesce(sum(t.cost_micros), 0) as company,
                coalesce(sum(t.cost_micros) filter (where t.user_id = $2), 0) as person,
                coalesce(sum(t.cost_micros) filter (where m.department_id = $3), 0) as department
           from traces t left join memberships m on m.user_id = t.user_id and m.org_id = t.org_id
          where t.org_id = $1 and t.started_at >= ${MONTH_START}
            and ($4::uuid is null or t.id <> $4)`,
        [orgId, userId, department?.targetId ?? null, exceptTrace ?? null],
      )
    )[0];
    const out: Standing[] = [];
    const company = limits.find((row) => row.scope === "company");
    if (company)
      out.push({
        scope: "company",
        targetId: orgId,
        name: null,
        limitMicros: Number(company.monthlyMicros),
        spentMicros: Number(spent?.company ?? 0),
      });
    if (department?.targetId)
      out.push({
        scope: "department",
        targetId: department.targetId,
        name: department.name,
        limitMicros: Number(department.monthlyMicros),
        spentMicros: Number(spent?.department ?? 0),
      });
    // A person's own limit is theirs; without one, everyone's.
    const person =
      limits.find((row) => row.scope === "person") ??
      limits.find((row) => row.scope === "everyone");
    if (person)
      out.push({
        scope: "person",
        targetId: userId,
        name: null,
        limitMicros: Number(person.monthlyMicros),
        spentMicros: Number(spent?.person ?? 0),
      });
    return out;
  }

  /** The widest limit this person's work has reached, or null when a run may start. */
  async reached(orgId: string, userId: string): Promise<BudgetScope | null> {
    const standing = await this.standing(orgId, userId);
    return standing.find((s) => s.spentMicros >= s.limitMicros)?.scope ?? null;
  }

  /**
   * How much a run that is going may still cost before a limit is reached, and whose limit
   * that is. What the run itself has cost is left out: it adds that itself, as it goes.
   * Null when no limit holds.
   */
  async room(
    orgId: string,
    userId: string,
    traceId: string,
  ): Promise<{ leftMicros: number; scope: BudgetScope } | null> {
    const standing = await this.standing(orgId, userId, traceId);
    let least: { leftMicros: number; scope: BudgetScope } | null = null;
    for (const s of standing) {
      const leftMicros = s.limitMicros - s.spentMicros;
      // The widest of equals: raising a person's limit does not help when the company's is spent.
      if (!least || leftMicros < least.leftMicros) least = { leftMicros, scope: s.scope };
    }
    return least;
  }

  /**
   * Tells the people concerned, once a month for each, that a limit is near or reached:
   * the person for their own, the administrators for a department's and the company's.
   * Called after a run and when one is refused. Never fails what called it.
   */
  async tell(orgId: string, userId: string): Promise<void> {
    try {
      for (const s of await this.standing(orgId, userId)) {
        const level =
          s.spentMicros >= s.limitMicros ? 100 : s.spentMicros >= s.limitMicros * NEAR ? 80 : 0;
        if (!level) continue;
        await this.db.tx(async (tx) => {
          // Reached without having been near (one large run): told of reaching it, once.
          const fresh = await tx.query(
            `insert into budget_marks (org_id, scope, target_id, month, level)
             select $1::uuid, $2::text, $3::uuid, to_char(now() at time zone 'UTC', 'YYYY-MM'), l
               from unnest($4::int[]) as l
             on conflict do nothing returning level`,
            [orgId, s.scope, s.targetId, level === 100 ? [80, 100] : [80]],
          );
          if (!fresh.some((row) => (row as { level: number }).level === level)) return;
          const userIds =
            s.scope === "person"
              ? [userId]
              : (
                  await tx.query<{ user_id: string }>(
                    "select user_id from memberships where org_id = $1 and status = 'active' and role in ('owner', 'admin')",
                    [orgId],
                  )
                ).map((row) => row.user_id);
          await notify(
            tx,
            { orgId, userIds },
            level === 100 ? "budget_reached" : "budget_near",
            {
              scope: s.scope,
              name: s.name,
              limit: String(s.limitMicros),
              spent: String(s.spentMicros),
            },
            "",
          );
        });
      }
    } catch (error) {
      console.error("telling people of a budget failed:", error);
    }
  }
}

/** The refusal a person is given when a limit is reached: it says whose, and so who to ask. */
export const BUDGET_REFUSAL = {
  company: "budget_company",
  department: "budget_department",
  person: "budget_person",
} as const;

export function registerBudgets(app: Hono<Env>, kit: AppKit, db: Db, config: Config): void {
  const { actorOf, clientIp, inTx, need } = kit;
  const org = (c: Ctx) => c.get("session").org.id;

  // This month against each limit, for whoever may see what agents cost.
  app.get("/api/budgets", async (c) => {
    const denied = need(c, "console.access");
    if (denied) return denied;
    const args = [org(c)];
    const since = `t.org_id = $1 and t.started_at >= ${MONTH_START}`;
    const [limits, company, departments, people] = await Promise.all([
      db.query<{ scope: string; targetId: string | null; monthlyMicros: string }>(
        `select scope, target_id as "targetId", monthly_micros as "monthlyMicros" from budgets where org_id = $1`,
        args,
      ),
      db.query<{ spent: string; month: string }>(
        `select coalesce(sum(t.cost_micros), 0) as spent,
                to_char(now() at time zone 'UTC', 'YYYY-MM') as month from traces t where ${since}`,
        args,
      ),
      db.query<{ id: string; name: string; people: number; spent: string }>(
        `select d.id, d.name,
                (select count(*)::int from memberships m where m.department_id = d.id and m.status = 'active') as people,
                coalesce((select sum(t.cost_micros) from traces t
                           join memberships m on m.user_id = t.user_id and m.org_id = t.org_id
                          where ${since} and m.department_id = d.id), 0) as spent
           from departments d where d.org_id = $1 order by d.name`,
        args,
      ),
      // Everyone who can be given a limit, whoever spent the most first.
      db.query<{
        id: string;
        name: string;
        email: string;
        department: string | null;
        spent: string;
      }>(
        `select u.id, u.name, u.email, d.name as department,
                coalesce((select sum(t.cost_micros) from traces t where ${since} and t.user_id = u.id), 0) as spent
           from memberships m join users u on u.id = m.user_id
           left join departments d on d.id = m.department_id
          where m.org_id = $1 and m.status = 'active'
          order by spent desc, u.email limit 500`,
        args,
      ),
    ]);
    const limit = (scope: string, targetId: string | null = null) => {
      const row = limits.find((l) => l.scope === scope && l.targetId === targetId);
      return row ? Number(row.monthlyMicros) : null;
    };
    const model = config.model;
    return c.json({
      month: company[0]?.month ?? "",
      canManage: !need(c, "settings.manage"),
      // With no price on the model nothing is counted, and no limit is ever reached.
      priced: Boolean(model && (model.inputPrice > 0 || model.outputPrice > 0)),
      company: { limitMicros: limit("company"), spentMicros: Number(company[0]?.spent ?? 0) },
      everyone: { limitMicros: limit("everyone") },
      departments: departments.map((d) => ({
        id: d.id,
        name: d.name,
        people: d.people,
        limitMicros: limit("department", d.id),
        spentMicros: Number(d.spent),
      })),
      people: people.map((p) => ({
        id: p.id,
        name: p.name,
        email: p.email,
        department: p.department,
        limitMicros: limit("person", p.id),
        spentMicros: Number(p.spent),
      })),
    });
  });

  // Sets one limit, or takes it away.
  app.put("/api/budgets", async (c) => {
    const denied = need(c, "settings.manage");
    if (denied) return denied;
    const parsed = Body.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, "invalid_budget");
    const { scope, targetId, monthlyMicros } = parsed.data;
    if ((scope === "company" || scope === "everyone") !== (targetId === null))
      return fail(c, "invalid_budget");
    return inTx(c, async (tx) => {
      const label = await labelOf(tx, org(c), scope, targetId);
      if (label === null) throw new Refusal("not_found");
      const before = (
        await tx.query<{ monthly_micros: string }>(
          "select monthly_micros from budgets where org_id = $1 and scope = $2 and target_id is not distinct from $3 for update",
          [org(c), scope, targetId],
        )
      )[0];
      await tx.query(
        "delete from budgets where org_id = $1 and scope = $2 and target_id is not distinct from $3",
        [org(c), scope, targetId],
      );
      if (monthlyMicros !== null)
        await tx.query(
          "insert into budgets (id, org_id, scope, target_id, monthly_micros) values ($1, $2, $3, $4, $5)",
          [newId(), org(c), scope, targetId, monthlyMicros],
        );
      // A limit that changed is a new limit: people are told again when it is near.
      await tx.query(
        `delete from budget_marks where org_id = $1 and month = to_char(now() at time zone 'UTC', 'YYYY-MM')
            and ($2 = 'everyone' and scope = 'person' or scope = $2 and target_id = $3)`,
        [org(c), scope, scope === "company" ? org(c) : targetId],
      );
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: monthlyMicros === null ? "budget.removed" : "budget.set",
        target: { type: "budget", id: targetId ?? org(c), label },
        detail: {
          scope,
          monthlyMicros,
          before: before ? Number(before.monthly_micros) : null,
        },
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    });
  });
}

/** Whose limit it is, in words for the record. Null when there is no such department or person. */
async function labelOf(
  tx: Queryable,
  orgId: string,
  scope: string,
  targetId: string | null,
): Promise<string | null> {
  if (scope === "company") return "company";
  if (scope === "everyone") return "each person";
  if (scope === "department")
    return (
      (
        await tx.query<{ name: string }>(
          "select name from departments where id = $1 and org_id = $2",
          [targetId, orgId],
        )
      )[0]?.name ?? null
    );
  return (
    (
      await tx.query<{ email: string }>(
        `select u.email from users u join memberships m on m.user_id = u.id
          where u.id = $1 and m.org_id = $2 and m.status <> 'removed'`,
        [targetId, orgId],
      )
    )[0]?.email ?? null
  );
}
