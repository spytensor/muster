/**
 * The organization's tool policy (MUS-26): what its administrators say agents may do.
 *
 *   - A rule on a tool, for everyone or for one department: allowed, always ask, or off.
 *     A department's rule stands in place of everyone's. A rule can name one tool, or
 *     every tool of one company connector (`company.<connector>.*`).
 *   - A scope for an agent on the company's shelf, and one for every agent that has none
 *     of its own: whether it may read the person's files and their mail, which web sites
 *     it may reach, which knowledge bases and which connector tools it may use.
 *
 * Both are asked of the gateway on every call (runs.ts, `gate`), as they stand at that
 * moment, so a change holds for a reply that is being written. Neither is ever said in an
 * agent's instructions or changes the tools a conversation was begun with: what a model is
 * sent stays the same from one message to the next (cache.test.ts). A conversation that
 * begins after a tool was switched off is simply not offered it (`offAtStart`).
 */
import { isId } from "@muster/protocol";
import type { Hono } from "hono";
import { z } from "zod";
import { type AppKit, type Ctx, type Env, fail } from "./app.js";
import { recordEvent } from "./audit.js";
import type { Db, Queryable } from "./db.js";
import { Refusal } from "./errors.js";
import {
  CLOUD_TOOLS,
  DEVICE_TOOLS,
  isDeviceTool,
  PLAN_TOOL,
  shownSql,
  TOOLS,
} from "./runtime/catalog.js";

export const TOOL_POLICY_SCHEMA = [
  `create table tool_rules (
    org_id uuid not null references organizations(id) on delete cascade,
    department_id uuid references departments(id) on delete cascade,
    tool text not null,
    effect text not null check (effect in ('allow', 'ask', 'off')),
    updated_by uuid references users(id) on delete set null,
    updated_at timestamptz not null default now()
  )`,
  `create unique index tool_rules_one on tool_rules
     (org_id, coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid), tool)`,
  `create table agent_scopes (
    org_id uuid not null references organizations(id) on delete cascade,
    agent_id uuid references agents(id) on delete cascade,
    scope jsonb not null,
    updated_by uuid references users(id) on delete set null,
    updated_at timestamptz not null default now()
  )`,
  `create unique index agent_scopes_one on agent_scopes
     (org_id, coalesce(agent_id, '00000000-0000-0000-0000-000000000000'::uuid))`,
  // The rules that were "off" when a conversation began: what it was never offered.
  `alter table conversations add column tools_off text[]`,
];

export type Effect = "allow" | "ask" | "off";
export const EFFECTS: readonly Effect[] = ["allow", "ask", "off"];

/** What an agent may reach. Everything, unless an administrator said less. */
export interface Scope {
  /** The person's own documents and files, and their files in Microsoft 365. */
  files: boolean;
  /** The person's mail, calendar and chats. */
  mail: boolean;
  /** Every public site, or only these hosts and what is under them. */
  web: "all" | string[];
  /** Every knowledge base it carries, or only these (by id). */
  knowledge: "all" | string[];
  /** Every connector tool it carries, or only these: a tool's name, or `company.<connector>.*`. */
  connectors: "all" | string[];
}
export const OPEN: Scope = {
  files: true,
  mail: true,
  web: "all",
  knowledge: "all",
  connectors: "all",
};

const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const RULE_KEY = /^([a-z0-9]+(\.[a-z0-9_-]+){1,2}|company\.[a-z0-9_-]+\.\*)$/;
const ScopeBody = z.strictObject({
  files: z.boolean(),
  mail: z.boolean(),
  web: z.union([
    z.literal("all"),
    z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .refine((host) => HOST.test(host)),
      )
      .max(100),
  ]),
  knowledge: z.union([z.literal("all"), z.array(z.string().refine(isId)).max(200)]),
  connectors: z.union([z.literal("all"), z.array(z.string().max(200).regex(RULE_KEY)).max(500)]),
});

/** Whether a rule's key covers a tool: its own name, or every tool of its connector. */
export const covers = (key: string, tool: string) =>
  key === tool || (key.endsWith(".*") && tool.startsWith(key.slice(0, -1)));

/** What each tool is for, as the page groups them. A connector's tools are their own group. */
export function groupOf(tool: string): string {
  if (tool.startsWith("company.")) return "connectors";
  if (tool.startsWith("m365.")) return tool === "m365.files" ? "files" : "mail";
  if (tool.startsWith("web.")) return "web";
  if (tool === "code.run" || tool.startsWith("local.") || tool.startsWith("repo.")) return "code";
  if (tool.startsWith("project.")) return "projects";
  if (tool === "memory.save") return "memory";
  if (tool === "followup.set") return "followups";
  if (tool === "agent.ask" || tool === "knowledge.search") return "agents";
  return "files";
}
/** Every tool a rule can be set on, apart from a connector's: the catalogue's and the person's computer's. */
export const RULED_TOOLS: string[] = [
  ...Object.keys(TOOLS),
  ...Object.keys(DEVICE_TOOLS),
  ...Object.keys(CLOUD_TOOLS),
].filter((name) => name !== PLAN_TOOL);

type RuleRow = {
  tool: string;
  departmentId: string | null;
  effect: Effect;
};

/** The rules that hold for one person: everyone's, and their department's in place of them. */
async function rulesFor(db: Queryable, orgId: string, userId: string): Promise<RuleRow[]> {
  return db.query<RuleRow>(
    `select r.tool, r.department_id as "departmentId", r.effect
       from tool_rules r
      where r.org_id = $1
        and (r.department_id is null or r.department_id =
             (select m.department_id from memberships m where m.org_id = $1 and m.user_id = $2))`,
    [orgId, userId],
  );
}

/**
 * What the rules say of one tool. The department's word before everyone's; within one,
 * a rule on the tool itself before a rule on its whole connector. No rule: allowed.
 */
export function decide(rules: readonly RuleRow[], tool: string): Effect {
  const rank = (rule: RuleRow) => (rule.departmentId ? 2 : 0) + (rule.tool === tool ? 1 : 0);
  let best: RuleRow | undefined;
  for (const rule of rules)
    if (covers(rule.tool, tool) && (!best || rank(rule) > rank(best))) best = rule;
  return best?.effect ?? "allow";
}

const STRICTER: Record<Effect, number> = { allow: 0, ask: 1, off: 2 };
/**
 * What the rules say of a tool as it is used. A tool on the person's computer stands in
 * for the tools it needs (catalog.ts, `DEVICE_TOOLS`): it is held to its own rule and to
 * theirs, whichever is stricter. Where it needs one of several, the most that any of them
 * is left counts: reading a folder is off once every tool it could stand in for is off.
 * This is the one place a tool's effect is decided, for the gateway and for what a
 * conversation is offered when it begins.
 */
export function decideFor(rules: readonly RuleRow[], tool: string): Effect {
  const own = decide(rules, tool);
  if (!isDeviceTool(tool)) return own;
  const needed = DEVICE_TOOLS[tool].needs
    .map((need) => decide(rules, need))
    .reduce<Effect>((least, one) => (STRICTER[one] < STRICTER[least] ? one : least), "off");
  return STRICTER[needed] > STRICTER[own] ? needed : own;
}

export async function effectFor(
  db: Queryable,
  orgId: string,
  userId: string,
  tool: string,
): Promise<Effect> {
  return decideFor(await rulesFor(db, orgId, userId), tool);
}

/**
 * The tools a conversation is not offered, fixed when it begins: each tool it would have
 * been offered then that the rules, asked about that very tool (`decideFor`), said was
 * off. Their names are kept on the conversation, so that what its model is sent does not
 * change when an administrator changes a rule later. Later changes are the gateway's.
 *
 * `hidden(name)` is asked while the tools are put together; `keep()` afterwards writes down
 * what was hidden, once. A conversation that already had a reply when this was first
 * asked (one from before the policy existed, or one whose list was never written) hides
 * nothing: its model goes on being sent what it was sent, and the gateway refuses.
 */
export async function offAtStart(
  db: Queryable,
  orgId: string,
  userId: string,
  conversationId: string,
): Promise<{ hidden(tool: string): boolean; keep(): Promise<void> }> {
  const found = (
    await db.query<{ off: string[] | null; begun: boolean }>(
      `select v.tools_off as off,
              exists (select 1 from messages m
                       where m.conversation_id = v.id and m.role = 'assistant'
                         and m.status <> 'running') as begun
         from conversations v where v.id = $1`,
      [conversationId],
    )
  )[0];
  if (found?.off) {
    const kept = found.off;
    return { hidden: (tool) => kept.some((key) => covers(key, tool)), keep: async () => {} };
  }
  // Rules that cannot be read hide nothing and are not written down as "nothing hidden":
  // the reply goes on, the gateway refuses what it cannot judge, and the next reply asks again.
  let unread = false;
  const rules = found?.begun
    ? []
    : await rulesFor(db, orgId, userId).catch((error) => {
        console.error("the tool policy could not be read:", error);
        unread = true;
        return [];
      });
  const hiding = new Set<string>();
  return {
    hidden: (tool) => {
      if (decideFor(rules, tool) !== "off") return false;
      hiding.add(tool);
      return true;
    },
    // Only the first to write it does: two replies beginning at once agree on the earlier.
    keep: async () => {
      if (unread) return;
      await db.query(
        "update conversations set tools_off = $2 where id = $1 and tools_off is null",
        [conversationId, [...hiding].sort()],
      );
    },
  };
}

/** An agent's scope: its own, else the one for every agent, else everything. */
export async function scopeFor(db: Queryable, orgId: string, agentId: string): Promise<Scope> {
  const rows = await db.query<{ own: boolean; scope: Scope }>(
    `select (agent_id is not null) as own, scope from agent_scopes
      where org_id = $1 and (agent_id is null or agent_id = $2)`,
    [orgId, agentId],
  );
  const found = rows.find((row) => row.own) ?? rows[0];
  return found ? { ...OPEN, ...found.scope } : OPEN;
}

const hostOf = (value: unknown): string | null => {
  try {
    return new URL(String(value)).hostname.toLowerCase();
  } catch {
    return null;
  }
};
/**
 * Every tool that hands an agent what is in the person's files: their documents and files
 * here and in Microsoft 365, and the folders on their own computer. Reading, searching and
 * listing there do; so does a command, which can print any file, and looking at what a
 * running one printed. Writing a file there does not. (`local.pr` shows what a code host
 * says of a pull request, which is not the person's files.)
 */
const FILE_TOOLS = new Set([
  "docs.list",
  "docs.read",
  "files.list",
  "files.read",
  "files.outline",
  "data.profile",
  "data.query",
  "m365.files",
  "local.list",
  "local.read",
  "local.search",
  "local.find",
  "local.exec",
  "local.job",
]);
/** Whether a host is on a list of sites: one of them, or under one of them. */
export const onSites = (sites: readonly string[], host: string) =>
  sites.some((one) => host === one || host.endsWith(`.${one}`));
const MAIL_TOOLS = new Set(["m365.mail", "m365.calendar", "m365.chats"]);

/**
 * Why a call is outside what the agent may reach, as a sentence for the agent to pass on;
 * null when it is inside. `bases` are the knowledge bases the agent carries, by id.
 */
export function outsideScope(
  scope: Scope,
  tool: string,
  args: unknown,
  bases: readonly string[] = [],
): string | null {
  if (!scope.files && FILE_TOOLS.has(tool))
    return "The organization does not let this agent read the person's files. Tell them so; do not try another way.";
  // Running code is not reading files; running it over the person's files is.
  if (
    !scope.files &&
    tool === "code.run" &&
    Array.isArray((args as { files?: unknown })?.files) &&
    (args as { files: unknown[] }).files.length > 0
  )
    return "The organization does not let this agent read the person's files, so it cannot put them in the sandbox. Run the code without them, or tell the person.";
  if (!scope.mail && MAIL_TOOLS.has(tool))
    return "The organization does not let this agent read the person's mail, calendar or chats. Tell them so; do not try another way.";
  if (scope.web !== "all" && (tool === "web.fetch" || tool === "web.send")) {
    const host = hostOf((args as { url?: unknown })?.url);
    const allowed = scope.web;
    if (!host || !onSites(allowed, host))
      return `The organization lets this agent reach only these sites: ${allowed.join(", ") || "none"}. ${host ?? "That address"} is not one of them. Tell the person so; do not try another address for the same thing.`;
  }
  // A search goes to the search service and brings back any site: an agent held to a list
  // of sites does not search. It reads the sites it is given.
  if (scope.web !== "all" && tool === "web.search")
    return `The organization lets this agent reach only these sites: ${scope.web.join(", ") || "none"}. It may not search the web. Read a page on one of them instead, or tell the person.`;
  if (scope.knowledge !== "all" && tool === "knowledge.search") {
    const allowed = scope.knowledge;
    if (!bases.some((id) => allowed.includes(id)))
      return "The organization does not let this agent use the knowledge bases it carries. Tell the person so.";
  }
  if (scope.connectors !== "all" && tool.startsWith("company.")) {
    if (!scope.connectors.some((key) => covers(key, tool)))
      return "The organization does not let this agent use this connector's tool. Tell the person so; do not try another way.";
  }
  return null;
}
/** The knowledge bases a scope leaves an agent, of those it carries. */
export const basesInScope = (scope: Scope, bases: readonly string[]): string[] =>
  scope.knowledge === "all" ? [...bases] : bases.filter((id) => scope.knowledge.includes(id));

/** Said to the agent when a tool is off: it tells the person and does not go round it. */
export const OFF_REASON =
  "The organization has switched this off for agents. It was not done. Tell the person so in a few words; do not try another way to do the same thing.";

const ZERO = "00000000-0000-0000-0000-000000000000";

export function registerToolPolicy(app: Hono<Env>, kit: AppKit, db: Db): void {
  const { need, actorOf, clientIp, inTx } = kit;
  const parse = async <T>(
    c: Ctx,
    schema: z.ZodType<T>,
    code: Parameters<typeof fail>[1],
  ): Promise<T> => {
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new Refusal(code);
    return parsed.data;
  };
  const org = (c: Ctx) => c.get("session").org.id;

  // Everything the page shows: the tools, the rules as they stand, and the scopes.
  app.get("/api/policies/tools", async (c) => {
    const denied = need(c, "settings.read");
    if (denied) return denied;
    const [rules, departments, connectors, scopes, agents, bases] = await Promise.all([
      db.query<RuleRow>(
        `select tool, department_id as "departmentId", effect from tool_rules where org_id = $1
          order by tool, department_id nulls first`,
        [org(c)],
      ),
      db.query<{ id: string; name: string }>(
        "select id, name from departments where org_id = $1 order by name",
        [org(c)],
      ),
      // The company's own connectors, not a person's: each as one row, for all its tools.
      db.query<{ slug: string; name: string; kind: string }>(
        `select slug, name, kind from org_connectors
          where org_id = $1 and deleted_at is null and owner_id is null order by name`,
        [org(c)],
      ),
      db.query<{ agentId: string | null; scope: Scope }>(
        `select agent_id as "agentId", scope from agent_scopes where org_id = $1`,
        [org(c)],
      ),
      // The agents on the company's shelf: the platform's, the company's, and people's that were published to it.
      db.query<{ id: string; name: string }>(
        `select a.id, ${shownSql("a")} as name from agents a
          where a.org_id = $1 and a.state = 'published'
            and (a.source <> 'user' or exists (
                  select 1 from listings l
                   where l.kind = 'agent' and l.item_id = a.id and l.state = 'published'))
          order by a.name`,
        [org(c)],
      ),
      db.query<{ id: string; name: string }>(
        `select b.id, b.name from knowledge_bases b
          where b.org_id = $1 and exists (
                select 1 from listings l
                 where l.kind = 'knowledge' and l.item_id = b.id and l.state = 'published')
          order by b.name`,
        [org(c)],
      ),
    ]);
    const levels: Record<string, string> = Object.fromEntries([
      ...Object.entries(TOOLS).map(([name, tool]) => [name, tool.level]),
      ...Object.entries(DEVICE_TOOLS).map(([name, tool]) => [name, tool.level]),
      ...Object.entries(CLOUD_TOOLS).map(([name, tool]) => [name, tool.level]),
    ]);
    return c.json({
      tools: [
        ...RULED_TOOLS.map((name) => ({ key: name, group: groupOf(name), level: levels[name] })),
        ...connectors.map((connector) => ({
          key: `company.${connector.slug}.*`,
          group: "connectors",
          name: connector.name,
          kind: connector.kind,
        })),
      ],
      rules,
      departments,
      scopes: {
        everyone: scopes.find((row) => !row.agentId)?.scope ?? null,
        agents: agents.map((agent) => ({
          ...agent,
          scope: scopes.find((row) => row.agentId === agent.id)?.scope ?? null,
        })),
      },
      bases,
      connectors: connectors.map((connector) => ({
        key: `company.${connector.slug}.*`,
        name: connector.name,
      })),
    });
  });

  // One rule. For everyone, "allow" is no rule at all; for a department, "inherit" takes
  // its own word away and leaves everyone's.
  app.put("/api/policies/tools", async (c) => {
    const denied = need(c, "settings.manage");
    if (denied) return denied;
    const body = await parse(
      c,
      z.strictObject({
        tool: z.string().max(200).regex(RULE_KEY),
        departmentId: z.string().refine(isId).nullable(),
        effect: z.enum(["allow", "ask", "off", "inherit"]),
      }),
      "invalid_tool_rule",
    );
    const known =
      RULED_TOOLS.includes(body.tool) ||
      (body.tool.endsWith(".*") &&
        (
          await db.query(
            "select 1 from org_connectors where org_id = $1 and deleted_at is null and owner_id is null and slug = $2",
            [org(c), body.tool.slice("company.".length, -2)],
          )
        ).length > 0);
    if (!known) return fail(c, "invalid_tool_rule");
    if (body.effect === "inherit" && !body.departmentId) return fail(c, "invalid_tool_rule");
    return inTx(c, async (tx) => {
      // One change to the policy at a time for an organization: two that set the same
      // rule for the first time would otherwise both find none and both write one.
      await tx.query("select 1 from organizations where id = $1 for update", [org(c)]);
      let department: string | null = null;
      if (body.departmentId) {
        const found = await tx.query<{ name: string }>(
          "select name from departments where id = $1 and org_id = $2",
          [body.departmentId, org(c)],
        );
        if (!found[0]) return fail(c, "invalid_tool_rule");
        department = found[0].name;
      }
      const before =
        (
          await tx.query<{ effect: Effect }>(
            `select effect from tool_rules
              where org_id = $1 and tool = $2 and coalesce(department_id, '${ZERO}'::uuid) = coalesce($3::uuid, '${ZERO}'::uuid)
              for update`,
            [org(c), body.tool, body.departmentId],
          )
        )[0]?.effect ?? null;
      // No rule and "allowed for everyone" are the same thing, and are kept as no rule.
      const after: Effect | null =
        body.effect === "inherit" || (body.effect === "allow" && !body.departmentId)
          ? null
          : body.effect;
      if (before === after) return c.json({ ok: true, changed: false });
      await tx.query(
        `delete from tool_rules
          where org_id = $1 and tool = $2 and coalesce(department_id, '${ZERO}'::uuid) = coalesce($3::uuid, '${ZERO}'::uuid)`,
        [org(c), body.tool, body.departmentId],
      );
      if (after)
        await tx.query(
          `insert into tool_rules (org_id, department_id, tool, effect, updated_by) values ($1, $2, $3, $4, $5)
           on conflict (org_id, coalesce(department_id, '${ZERO}'::uuid), tool)
           do update set effect = excluded.effect, updated_by = excluded.updated_by, updated_at = now()`,
          [org(c), body.departmentId, body.tool, after, c.get("session").user.id],
        );
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "policy.tool_changed",
        target: { type: "tool", id: body.tool, label: body.tool },
        detail: {
          department: department ?? null,
          before: before ?? (body.departmentId ? "inherit" : "allow"),
          after: after ?? (body.departmentId ? "inherit" : "allow"),
        },
        ip: clientIp(c),
      });
      return c.json({ ok: true, changed: true });
    });
  });

  // An agent's scope, or the one for every agent ("everyone"). Null takes it away.
  app.put("/api/policies/scopes/:agent", async (c) => {
    const denied = need(c, "settings.manage");
    if (denied) return denied;
    const which = c.req.param("agent");
    if (which !== "everyone" && !isId(which)) return fail(c, "not_found");
    const body = await parse(
      c,
      z.strictObject({ scope: ScopeBody.nullable() }),
      "invalid_agent_scope",
    );
    const agentId = which === "everyone" ? null : which;
    return inTx(c, async (tx) => {
      // One change to the policy at a time for an organization: two that set the same
      // rule for the first time would otherwise both find none and both write one.
      await tx.query("select 1 from organizations where id = $1 for update", [org(c)]);
      let label = "every agent";
      if (agentId) {
        const agent = await tx.query<{ name: string }>(
          "select name from agents where id = $1 and org_id = $2",
          [agentId, org(c)],
        );
        if (!agent[0]) return fail(c, "not_found");
        label = agent[0].name;
      }
      const before =
        (
          await tx.query<{ scope: Scope }>(
            `select scope from agent_scopes
              where org_id = $1 and coalesce(agent_id, '${ZERO}'::uuid) = coalesce($2::uuid, '${ZERO}'::uuid)
              for update`,
            [org(c), agentId],
          )
        )[0]?.scope ?? null;
      const after = body.scope
        ? {
            ...body.scope,
            web: body.scope.web === "all" ? "all" : [...new Set(body.scope.web)].sort(),
          }
        : null;
      if (JSON.stringify(before) === JSON.stringify(after))
        return c.json({ ok: true, changed: false });
      await tx.query(
        `delete from agent_scopes
          where org_id = $1 and coalesce(agent_id, '${ZERO}'::uuid) = coalesce($2::uuid, '${ZERO}'::uuid)`,
        [org(c), agentId],
      );
      if (after)
        await tx.query(
          `insert into agent_scopes (org_id, agent_id, scope, updated_by) values ($1, $2, $3::jsonb, $4)
           on conflict (org_id, coalesce(agent_id, '${ZERO}'::uuid))
           do update set scope = excluded.scope, updated_by = excluded.updated_by, updated_at = now()`,
          [org(c), agentId, JSON.stringify(after), c.get("session").user.id],
        );
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "policy.scope_changed",
        target: { type: "agent", id: agentId ?? "everyone", label },
        detail: { before, after },
        ip: clientIp(c),
      });
      return c.json({ ok: true, changed: true });
    });
  });
}
