import { isId, newId } from "@muster/protocol";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { type AppKit, type Ctx, type Env, fail, storable } from "./app.js";
import { recordEvent } from "./audit.js";
import { BUDGET_REFUSAL } from "./budgets.js";
import { changes, usableConnectors } from "./company.js";
import type { Config } from "./config.js";
import type { Db, Queryable } from "./db.js";
import { Refusal } from "./errors.js";
import { type Files, QUOTA_BYTES } from "./files/service.js";
import { AnswerBody, formAnswer } from "./forms.js";
import { readableBases } from "./knowledge.js";
import { rulesOf } from "./market.js";
import { plainName, sameAs } from "./names.js";
import { notify } from "./notices.js";
import { fieldsSet } from "./profile.js";
import {
  addStep,
  addUpdate,
  adoptSteps,
  changeStep,
  DAY,
  DOC_KINDS,
  HEALTHS,
  keepProjectNotes,
  listDocs,
  listMembers,
  listSteps,
  listUpdates,
  NotesChanged,
  PROJECT_NOTES_CHARS,
  PROJECT_ROLES,
  type ProjectReach,
  type ProjectUpdate,
  pinDoc,
  projectAccess,
  reaches,
  reachOf,
  removeMember,
  removeStep,
  removeUpdate,
  STEP_RESULT_CHARS,
  STEP_STATES,
  STEP_TITLE_CHARS,
  StepProblem,
  setMember,
  stepFor,
  UPDATE_CHARS,
  unpinDoc,
} from "./projects.js";
import { can } from "./roles.js";
import {
  GENERAL_SHOWN,
  IMPLIED_TOOLS,
  isToolName,
  legacyByline,
  legacySql,
  MODES,
  type Mode,
  PLATFORM_AGENTS,
  riskOf,
  shownSql,
  TOOLS,
  type ToolName,
  versionOf,
} from "./runtime/catalog.js";
import { compactAt } from "./runtime/compact.js";
import type { ContextParts } from "./runtime/context.js";
import { MAX_OUTPUT_TOKENS } from "./runtime/models.js";
import { APPROVAL_MINUTES, ASIDE_MAX, type Runs, SPAN_TEXT } from "./runtime/runs.js";
import { SEARCH_HOSTS } from "./runtime/search.js";
import { mayUseAgent, sharedWith, unlist } from "./sharing.js";
import { usableSkills } from "./skills.js";
import { ticketsOf } from "./tracker.js";

/**
 * What a message says of the computer it was sent from: the names of the folders attached
 * to the project, and what each is (a repository, its branch and state, its own
 * instructions), as the desktop app found them. Never a path, and never a file's content
 * other than those instruction files.
 */
const DeviceBody = z
  .strictObject({
    folders: z.array(z.string().trim().min(1).max(120)).max(20),
    notes: z
      .array(
        z.strictObject({
          name: z.string().max(120),
          repository: z.boolean(),
          branch: z.string().max(250).nullable(),
          changed: z.number().int().min(0).max(10_000_000).nullable(),
          instructions: z
            .array(z.strictObject({ file: z.string().max(300), text: z.string().max(6000) }))
            .max(2),
          checks: z.array(z.string().trim().min(1).max(300)).max(5).optional(),
        }),
      )
      .max(20)
      .optional(),
  })
  .optional();

/** The model name recorded on agents when no model is configured yet. */
export const NO_MODEL = "unconfigured";

/** Gives a new organization the agents every organization starts with. Safe to call repeatedly. */
export async function ensurePlatformAgents(
  db: Queryable,
  orgId: string,
  model: string,
): Promise<void> {
  const existing = await db.query(
    "select 1 from agents where org_id = $1 and source = 'platform' limit 1",
    [orgId],
  );
  if (existing.length > 0) {
    // The agents the platform provides follow their definitions: a new release may teach them more.
    // Each such change is on the record, like any other change to an agent.
    for (const agent of PLATFORM_AGENTS) {
      const changed = await db.query<{ id: string }>(
        `update agents set description = $3, instructions = $4, tools = $5, risk = $6
          where org_id = $1 and source = 'platform' and name = $2
            and (description, instructions, tools) is distinct from ($3, $4, $5::text[])
          returning id`,
        [
          orgId,
          agent.name,
          agent.description,
          agent.instructions,
          agent.tools,
          riskOf(agent.tools),
        ],
      );
      for (const row of changed)
        await recordEvent(db, {
          orgId,
          actor: { userId: null, email: "muster (new release)" },
          action: "agent.changed",
          target: { type: "agent", id: row.id, label: agent.name },
          detail: { risk: riskOf(agent.tools), tools: agent.tools },
        });
    }
    // Every agent runs on the one configured model; a version names the model, instructions and tools.
    const stale = await db.query<{
      id: string;
      instructions: string;
      tools: string[];
      version: string;
      state: string;
      risk: string;
      source: string;
      name: string;
    }>(
      "select id, name, instructions, tools, version, state, risk, source from agents where org_id = $1",
      [orgId],
    );
    let restamped = 0;
    for (const agent of stale) {
      const version = await stamp(db, { ...agent, model });
      if (version !== agent.version) {
        // A person's agent that an administrator approved was approved as one exact version.
        // What it carries has changed, so it waits to be looked at again.
        // How far it reaches is worked out again too: a connector it carries may have gained
        // an action that changes something since the agent was last saved.
        const changing = await db.query(
          `select 1 from agent_parts p join org_connectors k on p.kind = 'connector' and k.id = p.item_id
            where p.agent_id = $1 and k.deleted_at is null
              and (exists (select 1 from jsonb_array_elements(k.actions) a where a->>'method' <> 'GET')
                or exists (select 1 from jsonb_array_elements(k.tools) t
                            where (t->>'on')::boolean and t->>'approved' = t->>'hash' and t->>'level' = 'ask'))
            limit 1`,
          [agent.id],
        );
        const risk =
          agent.source === "user"
            ? riskOf([...agent.tools, ...(changing.length > 0 ? ["web.send"] : [])])
            : agent.risk;
        const again =
          agent.source === "user" &&
          agent.state === "published" &&
          (risk === "R3" || risk === "R4");
        await db.query(
          "update agents set model = $2, version = $3, state = $4, risk = $5 where id = $1",
          [agent.id, model, version, again ? "pending" : agent.state, risk],
        );
        // Said of the agent itself: a skill or connector it carries changed, so its approval no longer stands.
        if (again)
          await recordEvent(db, {
            orgId,
            actor: { userId: null, email: "muster (what an agent carries changed)" },
            action: "agent.sent_back",
            target: { type: "agent", id: agent.id, label: agent.name },
            detail: { reason: "a carried part changed", was: agent.version, now: version },
          });
        restamped += 1;
      }
    }
    // The model is part of what an agent is. A new one changes every agent at once, and that is on the record.
    if (restamped > 0)
      await recordEvent(db, {
        orgId,
        actor: { userId: null, email: "muster (configuration)" },
        action: "agents.model_changed",
        target: { type: "organization", id: orgId, label: model },
        detail: { model, agents: restamped },
      });
    return;
  }
  for (const agent of PLATFORM_AGENTS) {
    await db.query(
      `insert into agents (id, org_id, name, description, source, risk, state, version, model, instructions, tools)
       values ($1, $2, $3, $4, 'platform', $5, 'published', $6, $7, $8, $9)
       on conflict do nothing`,
      [
        newId(),
        orgId,
        agent.name,
        agent.description,
        riskOf(agent.tools),
        await versionOf({ model, instructions: agent.instructions, tools: agent.tools }),
        model,
        agent.instructions,
        agent.tools,
      ],
    );
  }
}

const AGENT_COLUMNS = `a.id, a.name, a.description, a.source, a.risk, a.state, a.version, a.model, a.instructions, a.tools,
  a.owner_user_id as "ownerId", a.created_at as "createdAt"`;

const AgentBody = z.strictObject({
  name: plainName(60),
  description: z.string().trim().max(300).default(""),
  instructions: z.string().trim().min(1).max(8000),
  // What comes with a carried part or with the person's memory is not asked for by name.
  // What comes with a carried part or with the person's memory is not asked for by name:
  // it is left out, so an agent saved before this rule can still be saved.
  tools: z
    .array(z.string().refine(isToolName))
    .max(20)
    .transform((names) => names.filter((name) => !IMPLIED_TOOLS.includes(name as ToolName))),
  /** Skills the agent carries: followed whenever it works. */
  skills: z.array(z.string().refine(isId)).max(8).default([]),
  /** Knowledge bases the agent carries: where it looks things up. */
  knowledge: z.array(z.string().refine(isId)).max(8).default([]),
  /** Company connectors the agent carries: the systems it can reach. */
  connectors: z.array(z.string().refine(isId)).max(8).default([]),
});

/**
 * Sets what an agent carries, from what its builder may use. What it carries is part of
 * its version (see `stamp`), so an approval is of the agent with exactly those parts.
 */
async function carry(
  tx: Queryable,
  orgId: string,
  userId: string,
  agentId: string,
  parts: { skills: string[]; knowledge: string[]; connectors: string[] },
): Promise<string[]> {
  const systems = [...new Set(parts.connectors)];
  const reachable = await usableConnectors(tx, orgId, userId, systems);
  if (reachable.length !== systems.length) throw new Refusal("agent_part_unavailable");
  await tx.query("delete from agent_parts where agent_id = $1 and kind = 'connector'", [agentId]);
  for (const system of reachable)
    await tx.query(
      "insert into agent_parts (agent_id, kind, item_id) values ($1, 'connector', $2)",
      [agentId, system.id],
    );
  const bases = [...new Set(parts.knowledge)];
  const readable = await readableBases(tx, orgId, userId, bases);
  if (readable.length !== bases.length) throw new Refusal("agent_part_unavailable");
  await tx.query("delete from agent_parts where agent_id = $1 and kind = 'knowledge'", [agentId]);
  for (const base of readable)
    await tx.query(
      "insert into agent_parts (agent_id, kind, item_id) values ($1, 'knowledge', $2)",
      [agentId, base.id],
    );
  const wanted = [...new Set(parts.skills)];
  const found = wanted.length
    ? await tx.query<{ id: string; version: string }>(
        `select k.id, k.version from skills k
          where k.org_id = $1 and k.deleted_at is null and k.id = any($3::uuid[])
            and (k.owner_user_id = $2 or (k.scan_status = 'passed' and ${sharedWith("skill", "k", "$1", "$2")}))
          order by k.id`,
        [orgId, userId, wanted],
      )
    : [];
  if (found.length !== wanted.length) throw new Refusal("agent_part_unavailable");
  await tx.query("delete from agent_parts where agent_id = $1 and kind = 'skill'", [agentId]);
  for (const skill of found)
    await tx.query("insert into agent_parts (agent_id, kind, item_id) values ($1, 'skill', $2)", [
      agentId,
      skill.id,
    ]);
  // A connector that can change something reaches as far as sending does.
  return changes(reachable) ? ["web.send"] : [];
}

/**
 * The version of an agent: its model, instructions and tools, and each thing it carries
 * as that thing now is. Every place that stamps a version uses this, so the stamp always
 * says the same of the same agent.
 */
async function stamp(
  tx: Queryable,
  agent: { id: string; model: string; instructions: string; tools: string[] },
): Promise<string> {
  const parts = await tx.query<{ id: string; version: string }>(
    `select k.id, k.version from agent_parts p join skills k on p.kind = 'skill' and k.id = p.item_id
      where p.agent_id = $1 and k.deleted_at is null order by k.id`,
    [agent.id],
  );
  // Which knowledge bases, not what is in them: a base is filled and corrected all the
  // time, and what it says is material to work with, never part of the agent's rules.
  const bases = await tx.query<{ id: string }>(
    `select b.id from agent_parts p join knowledge_bases b on p.kind = 'knowledge' and b.id = p.item_id
      where p.agent_id = $1 and b.deleted_at is null order by b.id`,
    [agent.id],
  );
  // A connector as what it can do: one whose address or actions change is a different thing
  // to approve. Who may use it and whether it is on are not part of the agent.
  const systems = await tx.query<{ id: string; at: string }>(
    // An MCP server's part is the tools switched on, each as it was read, and whether it asks.
    `select k.id, md5(k.base_url || k.actions::text || coalesce((
              select string_agg((t->>'name') || ':' || (t->>'hash') || ':' || (t->>'level'), ',' order by t->>'name')
                from jsonb_array_elements(k.tools) t
               where (t->>'on')::boolean and t->>'approved' = t->>'hash'), '')) as at
       from agent_parts p join org_connectors k on p.kind = 'connector' and k.id = p.item_id
      where p.agent_id = $1 and k.deleted_at is null order by k.id`,
    [agent.id],
  );
  const all = [
    ...parts.map((part) => `skill ${part.id}@${part.version}`),
    ...bases.map((base) => `knowledge ${base.id}`),
    ...systems.map((system) => `connector ${system.id}@${system.at}`),
  ];
  const carried = all.length ? `\n\n[carries ${all.join(", ")}]` : "";
  return versionOf({
    model: agent.model,
    instructions: agent.instructions + carried,
    tools: agent.tools,
  });
}

export function registerProduct(
  app: Hono<Env>,
  kit: AppKit,
  db: Db,
  config: Config,
  runs: Runs,
  files: Files,
): void {
  const { need, actorOf, clientIp, inTx } = kit;
  // Someone who is suspended or removed stops being answered at once, not when their run ends.
  kit.onMemberBlocked((userId) => runs.stopUser(userId));
  const org = (c: Ctx) => c.get("session").org.id;
  const me = (c: Ctx) => c.get("session").user.id;
  /** The model's name now: it can be changed in the console while the server runs. */
  const modelNow = () => config.model?.id ?? NO_MODEL;
  const parse = async <T>(
    c: Ctx,
    schema: z.ZodType<T>,
    code: Parameters<typeof fail>[1],
  ): Promise<T> => {
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new Refusal(code);
    return parsed.data;
  };

  // Everything under /api/app is for any active member: it is the product itself.

  app.get("/api/app/tools", (c) =>
    c.json(
      Object.entries(TOOLS)
        // What comes with a carried part is not something to tick.
        .filter(([name]) => !IMPLIED_TOOLS.includes(name as ToolName))
        .map(([name, tool]) => ({
          name,
          level: tool.level,
          summary: tool.summary,
        })),
    ),
  );

  const usedToday = (orgId: string, userId: string) => runs.usedToday(orgId, userId);

  // How far a person lets agents go without asking is theirs to say, in each conversation.
  // Until 2026-11-21 an administrator set a ceiling on it (`org_settings.max_mode`, the
  // routes `/api/app/policy` and `/api/settings/policy`): removed at the owner's word, as
  // a choice that is the person's, about their own computer and their own reading.

  // One agent in full, for those who run the organization: who uses it, what it did and
  // cost, what it asked people to confirm, and what was decided about it. Never what
  // was said to it or what it answered.
  app.get("/api/agents/:id/record", async (c) => {
    const denied = need(c, "agents.read");
    if (denied) return denied;
    const id = c.req.param("id");
    if (!isId(id)) return fail(c, "not_found");
    const s = c.get("session");
    const agent = (
      await db.query<{ created_at: Date }>(
        "select created_at from agents where id = $1 and org_id = $2",
        [id, s.org.id],
      )
    )[0];
    if (!agent) return fail(c, "not_found");
    const args = [s.org.id, id];
    const [usage, people, approvals, holds, runs, events] = await Promise.all([
      db.query<{ runs: string; tokens: string; costMicros: string; medianMs: string | null }>(
        `select count(*) as runs, coalesce(sum(prompt_tokens + completion_tokens), 0) as tokens,
                coalesce(sum(cost_micros), 0) as "costMicros",
                percentile_cont(0.5) within group (order by duration_ms) as "medianMs"
           from traces where org_id = $1 and agent_id = $2 and started_at > now() - interval '30 days'`,
        args,
      ),
      // Who relies on it is for those who may see members.
      can(s.role, "members.read")
        ? db.query<{ name: string; email: string; runs: string; lastRunAt: Date }>(
            `select u.name, u.email, count(*) as runs, max(t.started_at) as "lastRunAt"
               from traces t join users u on u.id = t.user_id
              where t.org_id = $1 and t.agent_id = $2 and t.started_at > now() - interval '30 days'
              group by u.id, u.name, u.email order by count(*) desc limit 8`,
            args,
          )
        : null,
      db.query<{ tool: string; status: string; n: string }>(
        `select tool, status, count(*) as n from approvals
          where org_id = $1 and agent_id = $2 and requested_at > now() - interval '30 days'
          group by tool, status`,
        args,
      ),
      db.query<{ conversations: string }>(
        "select count(*) as conversations from conversations where org_id = $1 and agent_id = $2",
        args,
      ),
      can(s.role, "traces.read")
        ? db.query(
            `select t.id as "traceId", u.name as person, u.email, t.status, t.started_at as "startedAt", t.duration_ms as ms
               from traces t left join users u on u.id = t.user_id
              where t.org_id = $1 and t.agent_id = $2 order by t.started_at desc limit 8`,
            args,
          )
        : null,
      can(s.role, "audit.read")
        ? db.query(
            `select time, actor_email as "actorEmail", action from admin_events
              where org_id = $1 and target_type = 'agent' and target_id = $2
              order by seq desc limit 10`,
            args,
          )
        : null,
    ]);
    const n = (value: string | null | undefined) => Number(value ?? 0);
    return c.json({
      createdAt: agent.created_at,
      usage: {
        runs: n(usage[0]?.runs),
        tokens: n(usage[0]?.tokens),
        costMicros: n(usage[0]?.costMicros),
        medianMs: Math.round(n(usage[0]?.medianMs)),
      },
      people: people?.map((row) => ({ ...row, runs: n(row.runs) })) ?? null,
      approvals: approvals.map((row) => ({ tool: row.tool, status: row.status, count: n(row.n) })),
      conversations: n(holds[0]?.conversations),
      runs,
      events,
    });
  });

  // Everything the organization holds about one person, for those who run it: who they
  // are and how they sign in, what they have open and connected, what their agents did
  // and cost, and what was done to their membership. Never what they said or were told.
  app.get("/api/members/:id", async (c) => {
    const denied = need(c, "members.read");
    if (denied) return denied;
    const id = c.req.param("id");
    if (!isId(id)) return fail(c, "not_found");
    const s = c.get("session");
    const member = (
      await db.query(
        `select u.id, u.email, u.name, u.last_login_at as "lastLoginAt", m.role, m.status,
                m.joined_at as "joinedAt", m.joined_via as "joinedVia",
                m.department_id as "departmentId", d.name as "departmentName"
           from memberships m join users u on u.id = m.user_id
           left join departments d on d.id = m.department_id
          where m.org_id = $1 and m.user_id = $2`,
        [s.org.id, id],
      )
    )[0];
    if (!member) return fail(c, "not_found");
    const one = async <T extends Record<string, unknown>>(sql: string) =>
      (await db.query<T>(sql, [s.org.id, id]))[0] as T;
    const [signIn, sessions, connections, usage, byAgent, agents, holds, approvals, runs, events] =
      await Promise.all([
        db.query<{ provider: string }>(
          "select provider from identities where user_id = $1 order by created_at",
          [id],
        ),
        can(s.role, "sessions.read")
          ? db.query(
              `select public_id as id, provider, kind, last_seen_at as "lastSeenAt", ip, user_agent as "userAgent"
                 from sessions where org_id = $1 and user_id = $2 and revoked_at is null and expires_at > now()
                order by last_seen_at desc limit 20`,
              [s.org.id, id],
            )
          : null,
        db.query(
          `select provider, account, created_at as since from connections where org_id = $1 and user_id = $2`,
          [s.org.id, id],
        ),
        one<{
          runs: string;
          failed: string;
          blocked: string;
          tokens: string;
          costMicros: string;
          lastRunAt: Date | null;
        }>(
          `select count(*) as runs, count(*) filter (where status = 'error') as failed,
                  count(*) filter (where status = 'blocked') as blocked,
                  coalesce(sum(prompt_tokens + completion_tokens), 0) as tokens,
                  coalesce(sum(cost_micros), 0) as "costMicros", max(started_at) as "lastRunAt"
             from traces where org_id = $1 and user_id = $2 and started_at > now() - interval '30 days'`,
        ),
        db.query<{ name: string; runs: string; costMicros: string }>(
          `select ${shownSql("a")} as name, count(*) as runs, coalesce(sum(t.cost_micros), 0) as "costMicros"
             from traces t join agents a on a.id = t.agent_id
            where t.org_id = $1 and t.user_id = $2 and t.started_at > now() - interval '30 days'
            group by 1 order by count(*) desc limit 8`,
          [s.org.id, id],
        ),
        db.query(
          `select id, name, state, risk from agents where org_id = $1 and owner_user_id = $2 and deleted_at is null order by name`,
          [s.org.id, id],
        ),
        one<{ conversations: string; files: string; fileBytes: string; documents: string }>(
          `select (select count(*) from conversations where org_id = $1 and user_id = $2) as conversations,
                  (select count(*) from files where org_id = $1 and user_id = $2 and deleted_at is null) as files,
                  (select coalesce(sum(size), 0) from files where org_id = $1 and user_id = $2 and deleted_at is null) as "fileBytes",
                  (select count(*) from documents where org_id = $1 and user_id = $2) as documents`,
        ),
        one<{ pending: string; approved: string; rejected: string; expired: string }>(
          `select count(*) filter (where status = 'pending') as pending,
                  count(*) filter (where status = 'approved') as approved,
                  count(*) filter (where status = 'rejected') as rejected,
                  count(*) filter (where status = 'expired') as expired
             from approvals where org_id = $1 and user_id = $2 and requested_at > now() - interval '30 days'`,
        ),
        // Runs are named only for those who may open them.
        can(s.role, "traces.read")
          ? db.query(
              `select t.id as "traceId", ${shownSql("a")} as agent, t.status, t.started_at as "startedAt", t.duration_ms as ms
                 from traces t join agents a on a.id = t.agent_id
                where t.org_id = $1 and t.user_id = $2 order by t.started_at desc limit 8`,
              [s.org.id, id],
            )
          : null,
        can(s.role, "audit.read")
          ? db.query(
              `select time, actor_email as "actorEmail", action, detail from admin_events
                where org_id = $1 and target_type = 'member' and target_id = $2
                order by seq desc limit 8`,
              [s.org.id, id],
            )
          : null,
      ]);
    const n = (value: string | undefined) => Number(value ?? 0);
    return c.json({
      member: { ...member, signIn: [...new Set(signIn.map((row) => row.provider))] },
      // Which parts of their profile they have set, by name: never what any of them says.
      profile: await fieldsSet(db, id),
      sessions,
      connections,
      usage: {
        runs: n(usage.runs),
        failed: n(usage.failed),
        blocked: n(usage.blocked),
        tokens: n(usage.tokens),
        costMicros: n(usage.costMicros),
        lastRunAt: usage.lastRunAt,
        byAgent: byAgent.map((row) => ({
          name: row.name,
          runs: n(row.runs),
          costMicros: n(row.costMicros),
        })),
      },
      agents,
      holds: {
        conversations: n(holds.conversations),
        files: n(holds.files),
        fileBytes: n(holds.fileBytes),
        documents: n(holds.documents),
      },
      approvals: {
        pending: n(approvals.pending),
        approved: n(approvals.approved),
        rejected: n(approvals.rejected),
        expired: n(approvals.expired),
      },
      runs,
      events,
    });
  });

  // How this server is set up, for administrators: the model, the rules the gateway
  // applies, and what is kept. Every value is what the server is actually using.
  app.get("/api/system", async (c) => {
    const denied = need(c, "settings.read");
    if (denied) return denied;
    const stored = (
      await db.query<{ count: string; bytes: string }>(
        "select count(*) as count, coalesce(sum(size), 0) as bytes from files where org_id = $1 and deleted_at is null",
        [org(c)],
      )
    )[0];
    return c.json({
      model: config.model && {
        id: config.model.id,
        api: config.model.api,
        host: new URL(config.model.baseUrl).host,
        vision: config.model.vision,
        // The second model, asked when the first cannot answer at all.
        second: config.model.fallback
          ? { id: config.model.fallback.id, host: new URL(config.model.fallback.baseUrl).host }
          : null,
        inputPrice: config.model.inputPrice,
        outputPrice: config.model.outputPrice,
      },
      // Where agents search the web: the kind of service and its host, never a key.
      search: config.search && {
        provider: config.search.provider,
        host:
          config.search.provider === "searxng"
            ? new URL(config.search.url).host
            : SEARCH_HOSTS[config.search.provider],
      },
      // Whether agents can run code, and what keeps that code apart from this server.
      sandbox: await runs.sandboxState(),
      limits: {
        dailyTokensPerUser: config.dailyTokensPerUser,
        // What one person may run of code in a day: runs, and processor seconds. 0: no limit.
        sandboxDaily: config.sandboxDaily,
        approvalMinutes: APPROVAL_MINUTES,
        maxFileBytes: files.maxBytes,
      },
      files: {
        count: Number(stored?.count ?? 0),
        bytes: Number(stored?.bytes ?? 0),
        quotaBytes: QUOTA_BYTES,
        // Who holds the most, so an administrator can see where the space goes.
        byPerson: (
          await db.query<{ email: string; name: string; count: string; bytes: string }>(
            `select u.email, u.name, count(*) as count, sum(f.size) as bytes
               from files f join users u on u.id = f.user_id
              where f.org_id = $1 and f.deleted_at is null
              group by u.id order by sum(f.size) desc limit 20`,
            [org(c)],
          )
        ).map((row) => ({ ...row, count: Number(row.count), bytes: Number(row.bytes) })),
      },
      // What the gateway does with a call at each level. See `gate` in runtime/runs.ts.
      rules: [
        { level: "A0", effect: "allow" },
        { level: "A1", effect: "allow" },
        { level: "A2", effect: "allow" },
        { level: "A3", effect: "ask" },
        { level: "A4", effect: "deny" },
      ],
      tools: Object.entries(TOOLS).map(([name, tool]) => ({ name, level: tool.level })),
    });
  });

  // ---- agents a person can talk to, and their own ----

  app.get("/api/app/agents", async (c) => {
    await ensurePlatformAgents(db, org(c), modelNow());
    // Published agents of the organization, the person's own in any state, and what
    // colleagues shared with them or their department (usable ones only).
    const rows = await db.query(
      `select ${AGENT_COLUMNS}, (a.owner_user_id = $2) as mine,
              case when a.source = 'user' and a.owner_user_id <> $2
                   then json_build_object('name', o.name, 'email', o.email) end as "sharedBy",
              (select count(*)::int from shares s where s.kind = 'agent' and s.item_id = a.id) as shares,
              coalesce((select json_agg(json_build_object('kind', k.kind, 'id', k.id, 'name', k.name) order by k.kind desc, k.name)
                          from agent_parts p join (
                                 select 'skill' as kind, id, name from skills where deleted_at is null
                                 union all
                                 select 'knowledge', id, name from knowledge_bases where deleted_at is null
                                 union all
                                 select 'connector', id, name from org_connectors where deleted_at is null
                               ) k on k.kind = p.kind and k.id = p.item_id
                         where p.agent_id = a.id), '[]'::json) as carries
         from agents a left join users o on o.id = a.owner_user_id
        where a.org_id = $1 and a.deleted_at is null
          and ((a.source <> 'user' and a.state = 'published') or a.owner_user_id = $2
            or (a.source = 'user' and a.state = 'published' and ${sharedWith("agent", "a", "$1", "$2")}))
        order by (a.owner_user_id = $2) desc, (a.source = 'user') desc, a.name`,
      [org(c), me(c)],
    );
    return c.json({ agents: rows, canRun: config.model !== null });
  });

  /** A person's own agent. R1 and R2 are usable at once; R3 and R4 wait for an administrator. */
  /** Refuses a member's own agent that reaches further than the organization lets one. */
  const withinReach = async (c: Ctx, tx: Queryable, risk: string) => {
    if (can(c.get("session").role, "agents.manage")) return;
    if (risk > (await rulesOf(tx, org(c))).reach) throw new Refusal("agent_reach");
  };
  const stateFor = (tools: string[]) =>
    riskOf(tools) === "R1" || riskOf(tools) === "R2" ? "published" : "pending";

  /**
   * Whether an administrator stopped one of this person's agents in the last 30 days and
   * has not let it back since, whether or not the person deleted it meanwhile. While that
   * is so, whatever they build or change waits for an administrator, however little it
   * reaches: otherwise the agent that was stopped is built again under another name and
   * runs at once. It goes by what the record says an administrator did, not by the agent's
   * state, which deleting an agent also changes.
   */
  const held = async (c: Ctx, tx: Queryable) =>
    !can(c.get("session").role, "agents.manage") &&
    (
      await tx.query(
        `select 1 from agents a
           join admin_events e on e.org_id = a.org_id and e.target_id = a.id::text and e.action = 'agent.suspended'
          where a.org_id = $1 and a.owner_user_id = $2 and a.source = 'user'
            and e.time > now() - interval '30 days'
            and not exists (select 1 from admin_events later where later.org_id = e.org_id and later.target_id = e.target_id
                              and later.action in ('agent.restored', 'agent.approved') and later.seq > e.seq)
          limit 1`,
        [org(c), me(c)],
      )
    ).length > 0;
  /** Whether a name is one the person already uses, or reads as one of the company's agents. */
  const nameTaken = async (c: Ctx, tx: Queryable, name: string, except: string | null = null) => {
    const names = await tx.query<{ name: string }>(
      "select name from agents where org_id = $1 and (owner_user_id = $2 or source <> 'user') and deleted_at is null and ($3::uuid is null or id <> $3)",
      [org(c), me(c), except],
    );
    if (names.some((agent) => sameAs(agent.name) === sameAs(name))) return true;
    // The name the general agent is known by is nobody else's either (catalog.ts,
    // `shownOf`). An agent that had it before this was so keeps it when it is changed.
    if (sameAs(name) !== sameAs(GENERAL_SHOWN)) return false;
    const had = except
      ? (await tx.query<{ name: string }>("select name from agents where id = $1", [except]))[0]
      : undefined;
    return !had || sameAs(had.name) !== sameAs(name);
  };

  app.post("/api/app/agents", async (c) => {
    const body = await parse(c, AgentBody, "invalid_agent");
    const tools = [...new Set(body.tools)].sort();
    return inTx(c, async (tx) => {
      if (await nameTaken(c, tx, body.name)) throw new Refusal("agent_name_taken");
      const wait = await held(c, tx);
      const id = newId();
      let risk = riskOf(tools);
      await tx.query(
        `insert into agents (id, org_id, name, description, source, owner_user_id, risk, state, version, model, instructions, tools)
         values ($1, $2, $3, $4, 'user', $5, $6, $7, '', $8, $9, $10)`,
        [
          id,
          org(c),
          body.name,
          body.description,
          me(c),
          risk,
          wait ? "pending" : stateFor(tools),
          modelNow(),
          body.instructions,
          tools,
        ],
      );
      // What it carries can take it further than its tools do.
      const reach = [
        ...tools,
        ...(await carry(tx, org(c), me(c), id, {
          skills: body.skills,
          knowledge: body.knowledge,
          connectors: body.connectors,
        })),
      ];
      risk = riskOf(reach);
      await withinReach(c, tx, risk);
      await tx.query("update agents set version = $2, risk = $3, state = $4 where id = $1", [
        id,
        await stamp(tx, { id, model: modelNow(), instructions: body.instructions, tools }),
        risk,
        wait ? "pending" : stateFor(reach),
      ]);
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "agent.created",
        target: { type: "agent", id, label: body.name },
        detail: { risk, tools },
        ip: clientIp(c),
      });
      return c.json({ id, risk, state: wait ? "pending" : stateFor(reach) });
    });
  });

  // A person's own copy of an agent that was shared with them: theirs to change, and from
  // then on apart from the one it was made from.
  app.post("/api/app/agents/:id/copy", async (c) => {
    const id = c.req.param("id");
    if (!isId(id)) return fail(c, "not_found");
    return inTx(c, async (tx) => {
      const from = (
        await tx.query<{
          name: string;
          description: string;
          instructions: string;
          tools: string[];
        }>(
          `select a.name, a.description, a.instructions, a.tools from agents a
            where a.id = $3 and a.org_id = $1 and a.deleted_at is null and a.source = 'user'
              and a.state = 'published' and a.owner_user_id <> $2 and ${sharedWith("agent", "a", "$1", "$2")}`,
          [org(c), me(c), id],
        )
      )[0];
      if (!from) throw new Refusal("not_found");
      // Its name, or its name with a number, whichever the person may give an agent: one
      // they do not have yet and that does not read as one of the company's (as a new
      // agent's is checked). So a copy of a colleague's older "Muster" is "Muster (2)".
      let name = from.name;
      for (let n = 2; n < 200 && (await nameTaken(c, tx, name)); n++)
        name = `${from.name.slice(0, 55)} (${n})`;
      const copy = newId();
      const tools = [...new Set(from.tools)].sort();
      let risk = riskOf(tools);
      await tx.query(
        `insert into agents (id, org_id, name, description, source, owner_user_id, risk, state, version, model, instructions, tools)
         values ($1, $2, $3, $4, 'user', $5, $6, $7, $8, $9, $10, $11)`,
        [
          copy,
          org(c),
          name,
          from.description,
          me(c),
          risk,
          stateFor(tools),
          await versionOf({ model: modelNow(), instructions: from.instructions, tools }),
          modelNow(),
          from.instructions,
          tools,
        ],
      );
      // What the original carries comes along as far as this person may use each part.
      const theirs = await tx.query<{ kind: string; item_id: string }>(
        "select kind, item_id from agent_parts where agent_id = $1",
        [id],
      );
      const of = (kind: string) =>
        theirs.filter((part) => part.kind === kind).map((part) => part.item_id);
      const reach = [
        ...tools,
        ...(await carry(tx, org(c), me(c), copy, {
          skills: (await usableSkills(tx, org(c), me(c), of("skill"))).map((skill) => skill.id),
          knowledge: (await readableBases(tx, org(c), me(c), of("knowledge"))).map((b) => b.id),
          connectors: (await usableConnectors(tx, org(c), me(c), of("connector"))).map((k) => k.id),
        })),
      ];
      risk = riskOf(reach);
      await withinReach(c, tx, risk);
      const state = (await held(c, tx)) ? "pending" : stateFor(reach);
      await tx.query("update agents set version = $2, risk = $3, state = $4 where id = $1", [
        copy,
        await stamp(tx, { id: copy, model: modelNow(), instructions: from.instructions, tools }),
        risk,
        state,
      ]);
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "agent.created",
        target: { type: "agent", id: copy, label: name },
        detail: { risk, tools, copiedFrom: id },
        ip: clientIp(c),
      });
      return c.json({ id: copy, name, state });
    });
  });

  app.patch("/api/app/agents/:id", async (c) => {
    const id = c.req.param("id");
    if (!isId(id)) return fail(c, "not_found");
    const body = await parse(c, AgentBody, "invalid_agent");
    const tools = [...new Set(body.tools)].sort();
    return inTx(c, async (tx) => {
      const current = (
        await tx.query<{ risk: string; state: string; version: string }>(
          "select risk, state, version from agents where id = $1 and org_id = $2 and owner_user_id = $3 and source = 'user' and deleted_at is null for update",
          [id, org(c), me(c)],
        )
      )[0];
      if (!current) throw new Refusal("not_found");
      // What an administrator suspended is restored as it was: it cannot be changed meanwhile,
      // or restoring it would publish something nobody looked at.
      if (current.state === "suspended") throw new Refusal("agent_suspended");
      if (await nameTaken(c, tx, body.name, id)) throw new Refusal("agent_name_taken");
      const reach = [
        ...tools,
        ...(await carry(tx, org(c), me(c), id, {
          skills: body.skills,
          knowledge: body.knowledge,
          connectors: body.connectors,
        })),
      ];
      const risk = riskOf(reach);
      await withinReach(c, tx, risk);
      const version = await stamp(tx, {
        id,
        model: modelNow(),
        instructions: body.instructions,
        tools,
      });
      // An agent that needs an administrator's approval is approved as one exact version:
      // any change to what it is told or may use sends it back. One that needs none is
      // usable as soon as it is saved. A suspended agent stays suspended.
      const state =
        stateFor(reach) === "published" && !(await held(c, tx))
          ? "published"
          : version === current.version
            ? current.state
            : "pending";
      await tx.query(
        "update agents set name = $2, description = $3, instructions = $4, tools = $5, risk = $6, state = $7, version = $8, model = $9 where id = $1",
        [
          id,
          body.name,
          body.description,
          body.instructions,
          tools,
          risk,
          state,
          version,
          modelNow(),
        ],
      );
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "agent.changed",
        target: { type: "agent", id, label: body.name },
        detail: { risk, tools },
        ip: clientIp(c),
      });
      return c.json({ id, risk, state });
    });
  });

  app.delete("/api/app/agents/:id", async (c) => {
    const id = c.req.param("id");
    if (!isId(id)) return fail(c, "not_found");
    const response = await inTx(c, async (tx) => {
      // Its conversations and runs go with it, so ask only for the person's own.
      const removed = await tx.query<{ name: string }>(
        // The row stays: every run and approval of this agent still points at it.
        "update agents set deleted_at = now(), state = 'suspended' where id = $1 and org_id = $2 and owner_user_id = $3 and source = 'user' and deleted_at is null returning name",
        [id, org(c), me(c)],
      );
      if (!removed[0]) throw new Refusal("not_found");
      // Nobody it was shared with keeps it.
      await tx.query("delete from shares where kind = 'agent' and item_id = $1", [id]);
      await unlist(tx, org(c), "agent", id, removed[0].name);
      await tx.query(
        "update conversations set archived_at = now() where agent_id = $1 and archived_at is null",
        [id],
      );
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "agent.deleted",
        target: { type: "agent", id, label: removed[0].name },
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    });
    // Whatever it was doing stops, including anything waiting for a confirmation.
    if (response.status === 200) await runs.stopAgent(id);
    return response;
  });

  // Administrators approve, suspend and restore agents from the roster.
  app.patch("/api/agents/:id", async (c) => {
    const denied = need(c, "agents.manage");
    if (denied) return denied;
    const id = c.req.param("id");
    const body = await parse(
      c,
      // The version is the one the administrator was looking at when they decided.
      z.strictObject({ state: z.enum(["published", "suspended"]), version: z.string().length(64) }),
      "invalid_request",
    );
    if (!isId(id)) return fail(c, "not_found");
    const response = await inTx(c, async (tx) => {
      const agent = (
        await tx.query<{ name: string; state: string; version: string }>(
          "select name, state, version from agents where id = $1 and org_id = $2 and deleted_at is null for update",
          [id, org(c)],
        )
      )[0];
      if (!agent) throw new Refusal("not_found");
      // A draft is its owner's business until they finish it.
      if (agent.state === "draft") throw new Refusal("agent_unavailable");
      // The agent changed after the administrator loaded it: what they saw is not what would be approved.
      // Suspending is urgent and always allowed; approving is of what was read.
      if (body.state === "published" && agent.version !== body.version)
        throw new Refusal("agent_changed");
      // Already what was asked for: nothing changes and nothing is written down as changed.
      if (agent.state === body.state) return c.json({ ok: true });
      await tx.query("update agents set state = $2 where id = $1", [id, body.state]);
      const action =
        body.state === "suspended"
          ? "agent.suspended"
          : agent.state === "pending"
            ? "agent.approved"
            : "agent.restored";
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action,
        target: { type: "agent", id, label: agent.name },
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    });
    if (response.status === 200 && body.state === "suspended") await runs.stopAgent(id);
    return response;
  });

  // ---- documents: the person's own workspace, which agents read and write through tools ----

  // ---- projects: a person's place for one piece of ongoing work ----

  const RANK = { view: 0, work: 1, owner: 2 } as const;
  /**
   * The project named in the path, as this person reaches it, for what they are about to
   * do: see it, work in it, or what only its owner does. What comes back says where its
   * things are kept (under its owner) and who is acting. One they cannot reach is not
   * there; one they reach but may not do this in says so.
   */
  const reach = async (c: Ctx, need: keyof typeof RANK, tx: Queryable = db) => {
    const id = c.req.param("id") ?? "";
    const access = isId(id) ? await projectAccess(tx, org(c), me(c), id) : null;
    if (!access) throw new Refusal("not_found");
    if (RANK[access.reach] < RANK[need])
      throw new Refusal(need === "owner" ? "project_owner_only" : "project_view_only");
    return {
      orgId: org(c),
      userId: access.ownerId,
      projectId: id,
      actorId: me(c),
      name: access.name,
      reach: access.reach,
    };
  };

  const ProjectBody = z.strictObject({
    name: plainName(60),
    // What every agent working in the project is told, on top of its own brief.
    instructions: z.string().max(8000).default(""),
  });

  app.get("/api/app/projects", async (c) => {
    const rows = await db.query(
      `select p.id, p.name, p.instructions, p.updated_at as "updatedAt",
              p.notes, p.notes_at as "notesAt", ${legacySql("p.notes_by")} as "notesBy", p.notes_rev as "notesRev",
              (p.notes_before is not null) as "notesEarlier",
              -- A conversation in a project is its person's alone: each counts their own.
              (select count(*) from conversations v where v.project_id = p.id and v.user_id = $2 and v.archived_at is null) as conversations,
              (select count(*) from project_steps s where s.project_id = p.id) as steps,
              (select count(*) from project_steps s where s.project_id = p.id and s.state = 'done') as "stepsDone",
              (select u.health from project_updates u where u.project_id = p.id order by u.created_at desc, u.id desc limit 1) as health,
              -- What the page counts at its top: what lives in it, and when it was last said how it goes.
              (select max(u.created_at) from project_updates u where u.project_id = p.id) as "updateAt",
              (select count(*) from project_items i where i.project_id = p.id) as items,
              (select count(*) from project_items i where i.project_id = p.id and i.kind = 'repo') as repos,
              ${reachOf("p", "$2")} as role,
              case when p.user_id <> $2 then json_build_object('id', o.id, 'name', o.name) end as owner,
              (select count(*) from project_members pm where pm.project_id = p.id) as people
         from projects p join users o on o.id = p.user_id
        where p.org_id = $1 and ${reaches("p", "$2")} order by lower(p.name), p.id`,
      [org(c), me(c)],
    );
    return c.json(
      rows.map((row) => ({
        ...row,
        conversations: Number(row.conversations),
        steps: Number(row.steps),
        stepsDone: Number(row.stepsDone),
        items: Number(row.items),
        repos: Number(row.repos),
        people: Number(row.people),
      })),
    );
  });

  app.post("/api/app/projects", async (c) => {
    const body = await parse(c, ProjectBody, "invalid_project");
    const id = newId();
    const made = await db.query(
      `insert into projects (id, org_id, user_id, name, instructions) values ($1, $2, $3, $4, $5)
       on conflict (user_id, lower(name)) do nothing returning id`,
      [id, org(c), me(c), body.name, body.instructions],
    );
    return made.length ? c.json({ id }) : fail(c, "project_exists");
  });

  app.put("/api/app/projects/:id", async (c) => {
    const id = c.req.param("id");
    const body = await parse(c, ProjectBody, "invalid_project");
    if (!isId(id)) return fail(c, "not_found");
    return inTx(c, async (tx) => {
      // One that is not there is said to be not there, before its name is looked at.
      await reach(c, "owner", tx);
      const mine = await tx.query(
        "select 1 from projects where id = $1 and org_id = $2 and user_id = $3 for update",
        [id, org(c), me(c)],
      );
      if (mine.length === 0) throw new Refusal("not_found");
      const clash = await tx.query(
        "select 1 from projects where user_id = $1 and lower(name) = lower($2) and id <> $3",
        [me(c), body.name, id],
      );
      if (clash.length > 0) throw new Refusal("project_exists");
      const saved = await tx.query(
        "update projects set name = $4, instructions = $5, updated_at = now() where id = $1 and org_id = $2 and user_id = $3 returning id",
        [id, org(c), me(c), body.name, body.instructions],
      );
      if (saved.length === 0) throw new Refusal("not_found");
      return c.json({ ok: true });
    });
  });

  // The project's notes, as the person writes them. An agent writes them with project.note.
  app.put("/api/app/projects/:id/notes", async (c) => {
    const body = await parse(
      c,
      // `seen`: when the notes the page started from were written, so that a change made
      // meanwhile (by an agent in a conversation) is not written over unseen.
      z.strictObject({
        notes: z.string().max(PROJECT_NOTES_CHARS),
        seen: z.number().int().min(0).optional(),
      }),
      "invalid_project",
    );
    const at = await reach(c, "work");
    try {
      const saved = await keepProjectNotes(db, at, body.notes, null, body.seen);
      return saved ? c.json({ ok: true }) : fail(c, "not_found");
    } catch (error) {
      if (error instanceof NotesChanged) return fail(c, "notes_changed");
      throw error;
    }
  });
  // The notes as the person last left them, or as they stood before agents changed them.
  app.post("/api/app/projects/:id/notes/restore", async (c) => {
    const at = await reach(c, "work");
    const back = await db.query(
      `update projects set notes = notes_before, notes_before = notes, notes_at = now(), notes_by = null, notes_rev = notes_rev + 1
        where id = $1 and org_id = $2 and user_id = $3 and notes_before is not null returning id`,
      [at.projectId, at.orgId, at.userId],
    );
    return back.length ? c.json({ ok: true }) : fail(c, "not_found");
  });

  // A project's steps: what is still to do in it. The person keeps them here; an agent
  // working in the project keeps them with project.step.
  const day = z.string().regex(DAY).nullable();
  app.get("/api/app/projects/:id/steps", async (c) => {
    const at = await reach(c, "view");
    // A step tied to a work item in the company's tracker says which (tracker.ts).
    const tickets = await ticketsOf(db, org(c), at.projectId);
    return c.json(
      (await listSteps(db, at)).map((step) => ({
        ...stepFor(step, me(c)),
        ticket: tickets.get(step.id) ?? null,
      })),
    );
  });
  app.post("/api/app/projects/:id/steps", async (c) => {
    const body = await parse(
      c,
      z.strictObject({
        title: z.string().trim().min(1).max(STEP_TITLE_CHARS),
        due: day.optional(),
        agentId: z.string().refine(isId).nullable().optional(),
      }),
      "invalid_step",
    );
    const at = await reach(c, "work");
    try {
      const made = await addStep(db, at, { id: newId(), ...body }, null);
      return made ? c.json(stepFor(made, me(c))) : fail(c, "not_found");
    } catch (error) {
      if (error instanceof StepProblem) return fail(c, error.code);
      throw error;
    }
  });
  // The step lines of the notes ("- [ ] …") made steps, and taken out of the notes, in one go.
  app.post("/api/app/projects/:id/steps/adopt", async (c) => {
    const body = await parse(c, z.strictObject({ seen: z.number().int().min(0) }), "invalid_step");
    const at = await reach(c, "work");
    try {
      const made = await adoptSteps(db, at, newId, body.seen);
      return made === null ? fail(c, "not_found") : c.json({ made });
    } catch (error) {
      if (error instanceof NotesChanged) return fail(c, "notes_changed");
      if (error instanceof StepProblem) return fail(c, error.code);
      throw error;
    }
  });
  app.patch("/api/app/projects/:id/steps/:step", async (c) => {
    const body = await parse(
      c,
      z.strictObject({
        title: z.string().trim().min(1).max(STEP_TITLE_CHARS).optional(),
        state: z.enum(STEP_STATES).optional(),
        due: day.optional(),
        agentId: z.string().refine(isId).nullable().optional(),
        conversationId: z.string().refine(isId).nullable().optional(),
        result: z.string().max(STEP_RESULT_CHARS).optional(),
        before: z.string().refine(isId).nullable().optional(),
      }),
      "invalid_step",
    );
    const step = c.req.param("step");
    if (!isId(step)) return fail(c, "not_found");
    const at = await reach(c, "work");
    if (body.conversationId) {
      // Only a conversation of this project, and the person's own, can be the one working on its step.
      const theirs = await db.query(
        "select 1 from conversations where id = $1 and org_id = $2 and user_id = $3 and project_id = $4",
        [body.conversationId, org(c), me(c), at.projectId],
      );
      if (theirs.length === 0) return fail(c, "invalid_step");
    }
    try {
      const changed = await changeStep(db, at, { id: step }, body, null);
      return changed ? c.json(stepFor(changed, me(c))) : fail(c, "not_found");
    } catch (error) {
      if (error instanceof StepProblem) return fail(c, error.code);
      throw error;
    }
  });
  app.delete("/api/app/projects/:id/steps/:step", async (c) => {
    const step = c.req.param("step");
    if (!isId(step)) return fail(c, "not_found");
    return (await removeStep(db, await reach(c, "work"), step))
      ? c.json({ ok: true })
      : fail(c, "not_found");
  });

  // A project's updates: how it is going, said at a moment and kept. The person writes
  // them here; an agent working in the project drafts them with project.update.
  // An update as one person is shown it: whether it is theirs, and whether they may take it back.
  const updateFor = (update: ProjectUpdate, viewer: string, reach: ProjectReach) => ({
    ...update,
    mine: update.author?.id === viewer,
    canRemove: reach === "owner" || (reach === "work" && update.author?.id === viewer),
  });
  app.get("/api/app/projects/:id/updates", async (c) => {
    const at = await reach(c, "view");
    return c.json((await listUpdates(db, at)).map((one) => updateFor(one, me(c), at.reach)));
  });
  app.post("/api/app/projects/:id/updates", async (c) => {
    const body = await parse(
      c,
      z.strictObject({ health: z.enum(HEALTHS), text: z.string().trim().min(1).max(UPDATE_CHARS) }),
      "invalid_update",
    );
    const at = await reach(c, "work");
    const made = await addUpdate(db, at, { id: newId(), ...body }, null);
    return made ? c.json(updateFor(made, me(c), at.reach)) : fail(c, "not_found");
  });
  app.delete("/api/app/projects/:id/updates/:update", async (c) => {
    const update = c.req.param("update");
    if (!isId(update)) return fail(c, "not_found");
    // The owner removes any update; someone working in the project, one of their own.
    return (await removeUpdate(db, await reach(c, "work"), update))
      ? c.json({ ok: true })
      : fail(c, "not_found");
  });

  // A project's key documents: files pinned for what they are. The person pins them; every
  // conversation in the project is told which they are.
  app.get("/api/app/projects/:id/docs", async (c) =>
    c.json(await listDocs(db, await reach(c, "view"))),
  );
  app.put("/api/app/projects/:id/docs/:file", async (c) => {
    const body = await parse(c, z.strictObject({ kind: z.enum(DOC_KINDS) }), "invalid_doc");
    const file = c.req.param("file");
    if (!isId(file)) return fail(c, "not_found");
    const at = await reach(c, "owner");
    try {
      return (await pinDoc(db, at, { id: newId(), fileId: file, kind: body.kind }))
        ? c.json({ ok: true })
        : fail(c, "not_found");
    } catch (error) {
      if (error instanceof StepProblem) return fail(c, error.code);
      throw error;
    }
  });
  app.delete("/api/app/projects/:id/docs/:file", async (c) => {
    const file = c.req.param("file");
    if (!isId(file)) return fail(c, "not_found");
    return (await unpinDoc(db, await reach(c, "owner"), file))
      ? c.json({ ok: true })
      : fail(c, "not_found");
  });

  // A project's people: the colleagues its owner brought into it, to see it or to work
  // in it. Everyone in the project sees who is in it; only the owner changes that, and
  // anyone may take themself out.
  app.get("/api/app/projects/:id/members", async (c) =>
    c.json(
      (await listMembers(db, await reach(c, "view"))).map((one) => ({
        ...one,
        me: one.id === me(c),
      })),
    ),
  );
  app.put("/api/app/projects/:id/members/:user", async (c) => {
    const body = await parse(c, z.strictObject({ role: z.enum(PROJECT_ROLES) }), "invalid_member");
    const user = c.req.param("user");
    if (!isId(user)) return fail(c, "invalid_member");
    return inTx(c, async (tx) => {
      const at = await reach(c, "owner", tx);
      let kept: Awaited<ReturnType<typeof setMember>>;
      try {
        kept = await setMember(tx, at, user, body.role);
      } catch (error) {
        if (error instanceof StepProblem) throw new Refusal(error.code);
        throw error;
      }
      if (!kept) throw new Refusal("not_found");
      if (kept.did !== "same") {
        await recordEvent(tx, {
          orgId: org(c),
          actor: actorOf(c),
          action: kept.did === "added" ? "project.member_added" : "project.member_changed",
          target: { type: "project", id: at.projectId, label: at.name },
          detail: { id: user, label: kept.name, role: body.role },
          ip: clientIp(c),
        });
        // Someone brought in is told, once: the project would otherwise just appear in their list.
        if (kept.did === "added")
          await notify(
            tx,
            { orgId: org(c), userIds: [user] },
            "project_added",
            { name: at.name, by: c.get("session").user.name, role: body.role },
            `p/${at.projectId}`,
          );
      }
      return c.json({ ok: true });
    });
  });
  app.delete("/api/app/projects/:id/members/:user", async (c) => {
    const user = c.req.param("user");
    if (!isId(user)) return fail(c, "not_found");
    return inTx(c, async (tx) => {
      // The owner takes anyone out; anyone takes themself out.
      const at = await reach(c, user === me(c) ? "view" : "owner", tx);
      const name = await removeMember(tx, at, user);
      if (name === null) throw new Refusal("not_found");
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: user === me(c) ? "project.member_left" : "project.member_removed",
        target: { type: "project", id: at.projectId, label: at.name },
        detail: { id: user, label: name },
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    });
  });

  // The project goes; its conversations stay, no longer grouped.
  app.delete("/api/app/projects/:id", async (c) => {
    const at = await reach(c, "owner");
    const removed = await db.query(
      "delete from projects where id = $1 and org_id = $2 and user_id = $3 returning id",
      [at.projectId, at.orgId, at.userId],
    );
    return removed.length ? c.json({ ok: true }) : fail(c, "not_found");
  });

  const DocumentBody = z.strictObject({
    title: z.string().trim().min(1).max(120),
    content: z.string().max(200_000).default(""),
  });

  app.get("/api/app/documents", async (c) => {
    const rows = await db.query(
      `select id, title, length(content) as size, updated_at as "updatedAt" from documents where org_id = $1 and user_id = $2 order by updated_at desc`,
      [org(c), me(c)],
    );
    return c.json(rows.map((row) => ({ ...row, size: Number(row.size) })));
  });

  app.get("/api/app/documents/:id", async (c) => {
    const id = c.req.param("id");
    const row = isId(id)
      ? (
          await db.query(
            `select id, title, content, updated_at as "updatedAt", previous_at as "previousAt" from documents where id = $1 and org_id = $2 and user_id = $3`,
            [id, org(c), me(c)],
          )
        )[0]
      : undefined;
    return row ? c.json(row) : fail(c, "not_found");
  });

  app.post("/api/app/documents", async (c) => {
    const body = await parse(c, DocumentBody, "invalid_document");
    const id = newId();
    const made = await db.query(
      "insert into documents (id, org_id, user_id, title, content) values ($1, $2, $3, $4, $5) on conflict (user_id, title) do nothing returning id",
      [id, org(c), me(c), body.title, body.content],
    );
    return made.length ? c.json({ id }) : fail(c, "document_exists");
  });

  app.put("/api/app/documents/:id", async (c) => {
    const id = c.req.param("id");
    const body = await parse(c, DocumentBody, "invalid_document");
    if (!isId(id)) return fail(c, "not_found");
    return inTx(c, async (tx) => {
      const clash = await tx.query(
        "select 1 from documents where user_id = $1 and title = $2 and id <> $3",
        [me(c), body.title, id],
      );
      if (clash.length > 0) throw new Refusal("document_exists");
      const saved = await tx.query(
        // The person's own edit is the document now: there is no longer an agent's change to undo.
        "update documents set title = $4, content = $5, updated_at = now(), previous_content = null, previous_at = null where id = $1 and org_id = $2 and user_id = $3 returning id",
        [id, org(c), me(c), body.title, body.content],
      );
      if (saved.length === 0) throw new Refusal("not_found");
      return c.json({ ok: true });
    });
  });

  // What an agent replaced comes back, and what it wrote is kept in its place, so this too can be undone.
  app.post("/api/app/documents/:id/restore", async (c) => {
    const id = c.req.param("id");
    const swapped = isId(id)
      ? await db.query(
          `update documents set content = previous_content, previous_content = content,
             previous_at = updated_at, updated_at = now()
           where id = $1 and org_id = $2 and user_id = $3 and previous_content is not null returning id`,
          [id, org(c), me(c)],
        )
      : [];
    return swapped.length ? c.json({ ok: true }) : fail(c, "not_found");
  });

  app.delete("/api/app/documents/:id", async (c) => {
    const id = c.req.param("id");
    const removed = isId(id)
      ? await db.query(
          "delete from documents where id = $1 and org_id = $2 and user_id = $3 returning id",
          [id, org(c), me(c)],
        )
      : [];
    return removed.length ? c.json({ ok: true }) : fail(c, "not_found");
  });

  // ---- conversations ----

  const mine = async (c: Ctx, id: string | undefined) =>
    id && isId(id)
      ? (
          await db.query<{
            id: string;
            agent_id: string;
            title: string;
            project_id: string | null;
            mode: Mode;
          }>(
            `select v.id, v.agent_id, v.title, v.mode,
                    (select p.id from projects p where p.id = v.project_id and ${reaches("p", "v.user_id")}) as project_id
               from conversations v where v.id = $1 and v.org_id = $2 and v.user_id = $3 and v.archived_at is null`,
            [id, org(c), me(c)],
          )
        )[0]
      : undefined;

  app.get("/api/app/conversations", async (c) => {
    const rows = await db.query(
      `select v.id, v.title, v.updated_at as "updatedAt", a.id as "agentId", ${shownSql("a")} as "agentName",
              -- Of a project the person no longer reaches, nothing is said: the conversation is just theirs.
              (select p.id from projects p where p.id = v.project_id and ${reaches("p", "v.user_id")}) as "projectId",
              exists (select 1 from messages m where m.conversation_id = v.id and m.status = 'running') as running
         from conversations v join agents a on a.id = v.agent_id
        where v.org_id = $1 and v.user_id = $2 and v.archived_at is null
          -- One nobody has written in yet is not a conversation to show: it has a name or a message.
          and (v.title <> '' or exists (select 1 from messages m where m.conversation_id = v.id))
        order by v.updated_at desc limit 200`,
      [org(c), me(c)],
    );
    return c.json(rows);
  });

  app.post("/api/app/conversations", async (c) => {
    const body = await parse(
      c,
      z.strictObject({
        agentId: z.string().refine(isId),
        projectId: z.string().refine(isId).nullish(),
        mode: z.enum(MODES).optional(),
      }),
      "invalid_request",
    );
    // A conversation is started in a project of the person's own, in one they were
    // brought into to work in, or in none.
    if (body.projectId) {
      const access = await projectAccess(db, org(c), me(c), body.projectId);
      if (!access) return fail(c, "not_found");
      if (access.reach === "view") return fail(c, "project_view_only");
    }
    // The company's, the person's own, or one a colleague shared with them.
    if (!(await mayUseAgent(db, org(c), me(c), body.agentId))) return fail(c, "agent_unavailable");
    const id = newId();
    await db.query(
      "insert into conversations (id, org_id, user_id, agent_id, project_id, mode) values ($1, $2, $3, $4, $5, $6)",
      [id, org(c), me(c), body.agentId, body.projectId ?? null, body.mode ?? "ask"],
    );
    return c.json({ id });
  });

  app.get("/api/app/conversations/:id", async (c) => {
    const conversation = await mine(c, c.req.param("id"));
    if (!conversation) return fail(c, "not_found");
    const messages = await db.query(
      `select m.id, m.seq, m.role, m.content, m.status, m.trace_id as "traceId", m.created_at as "createdAt", m.steps, m.plan, m.attachments, m.ending, m.ending_detail as "endingDetail", m.action, m.origin,
              (m.resume is not null and m.status <> 'running') as "canContinue",
              m.agent_id as "agentId", ${shownSql("g")} as "agentName"
         from messages m left join agents g on g.id = m.agent_id where m.conversation_id = $1 order by m.seq`,
      [conversation.id],
    );
    // Who a step was passed to is kept in the step as words. One passed to the general
    // agent before its shown name was the one kept says "Assistant": it is read as Muster.
    for (const message of messages as { steps?: { by?: unknown }[] | null }[])
      for (const step of message.steps ?? [])
        if (typeof step.by === "string") step.by = legacyByline(step.by);
    const agent = (
      await db.query<{ tools: string[] }>(
        // `general`: the agent a conversation has when nobody called one, which the page
        // names Muster (CHA-271). A colleague's agent of the same name is not it.
        "select id, name, description, risk, state, tools, (source = 'platform' and name = $2) as general from agents where id = $1",
        [conversation.agent_id, PLATFORM_AGENTS[0]?.name ?? ""],
      )
    )[0];
    // Files a reply here made that are no longer there: said by the server, which knows,
    // not worked out by a page from a list that is cut short or not yet read (CHA-269).
    const made = [
      ...new Set(
        (messages as { steps?: { file?: unknown }[] }[]).flatMap((message) =>
          (message.steps ?? []).flatMap((step) =>
            typeof step.file === "string" && isId(step.file) ? [step.file] : [],
          ),
        ),
      ),
    ];
    const kept = made.length
      ? await db.query<{ id: string }>(
          "select id from files where id = any($1::uuid[]) and org_id = $2 and deleted_at is null",
          [made, org(c)],
        )
      : [];
    const gone = made.filter((id) => !kept.some((file) => file.id === id));
    // What it can do in this person's hands: a carried knowledge base counts only if
    // they may read it.
    const carried = await db.query<{ item_id: string }>(
      "select item_id from agent_parts where agent_id = $1 and kind = 'knowledge'",
      [conversation.agent_id],
    );
    const reads = await readableBases(
      db,
      org(c),
      me(c),
      carried.map((part) => part.item_id),
    );
    if (agent && reads.length > 0) agent.tools = [...agent.tools, "knowledge.search"];
    const approvals = await db.query(
      // With the agent that wants it: not always the conversation's own (CHA-264).
      `select p.id, p.tool, p.level, p.summary, p.status, p.requested_at as "requestedAt", p.requested_at + interval '${APPROVAL_MINUTES} minutes' as "expiresAt", ${shownSql("a")} as "agentName"
         from approvals p join agents a on a.id = p.agent_id where p.conversation_id = $1 and p.status = 'pending' order by p.requested_at`,
      [conversation.id],
    );
    // How full the model's window was at its last call here: what the pane shows as
    // a share. The provider's own count, so what compaction left out is not in it.
    // And what that call was made of, by part, as the run estimated it (context.ts); the
    // provider's count is the true total, and the page scales the parts to it.
    const filled = await db.query<{ tokens: number; parts: ContextParts | null }>(
      `select s.prompt_tokens as tokens, s.attributes->'context' as parts
         from spans s join traces t on t.id = s.trace_id
        where t.conversation_id = $1 and t.org_id = $2 and s.kind = 'llm'
          and (s.prompt_tokens > 0 or s.attributes ? 'context')
        order by t.started_at desc, s.seq desc limit 1`,
      [conversation.id, org(c)],
    );
    const window = config.model?.contextWindow ?? 128_000;
    // The conversation's summary for its agents, and about how much of the window the next
    // reply's conversation part will take: the summary and the messages after it, the newest
    // 200 at most, as a run sends them (context-panel.md).
    const [summaryRow] = await db.query<{
      summary: string | null;
      seq: number | null;
      at: string | null;
      chars: number;
    }>(
      `select v.summary, v.summary_seq as seq, v.summary_at as at,
              coalesce(length(v.summary), 0) + coalesce((
                select sum(length(r.content)) from (
                  select m.content from messages m
                   where m.conversation_id = v.id and m.status = 'complete'
                     and m.seq > (case when v.summary is null then -1 else coalesce(v.summary_seq, 0) end)
                   order by m.seq desc limit 200) r), 0)::int as chars
         from conversations v where v.id = $1`,
      [conversation.id],
    );
    return c.json({
      summary: summaryRow?.summary
        ? { seq: summaryRow.seq ?? 0, at: summaryRow.at, text: summaryRow.summary }
        : null,
      context: {
        nextConversation: Math.ceil((summaryRow?.chars ?? 0) / 3),
        tokens: Number(filled[0]?.tokens ?? 0),
        window,
        // Where compaction begins within a reply; above it is kept for the answer.
        compactAt: compactAt(window, config.model?.maxOutputTokens ?? MAX_OUTPUT_TOKENS),
        parts: filled[0]?.parts ?? null,
      },
      id: conversation.id,
      title: conversation.title,
      projectId: conversation.project_id,
      mode: conversation.mode,
      agent,
      messages,
      approvals,
      gone,
    });
  });

  // The person may name a conversation themselves.
  app.patch("/api/app/conversations/:id", async (c) => {
    const conversation = await mine(c, c.req.param("id"));
    if (!conversation) return fail(c, "not_found");
    const body = await parse(
      c,
      z.strictObject({ title: z.string().trim().min(1).max(120) }),
      "invalid_request",
    );
    await db.query("update conversations set title = $2 where id = $1", [
      conversation.id,
      body.title,
    ]);
    return c.json({ id: conversation.id, title: body.title });
  });

  // How much the person lets agents do in this conversation without asking.
  app.put("/api/app/conversations/:id/mode", async (c) => {
    const conversation = await mine(c, c.req.param("id"));
    if (!conversation) return fail(c, "not_found");
    const body = await parse(c, z.strictObject({ mode: z.enum(MODES) }), "invalid_request");
    await db.query("update conversations set mode = $2 where id = $1", [
      conversation.id,
      body.mode,
    ]);
    return c.json({ ok: true });
  });

  app.delete("/api/app/conversations/:id", async (c) => {
    const conversation = await mine(c, c.req.param("id"));
    if (!conversation) return fail(c, "not_found");
    await runs.stop(conversation.id);
    await db.query("update conversations set archived_at = now() where id = $1", [conversation.id]);
    // What was waiting on the person in it is no longer asked.
    await db.query(
      "update approvals set status = 'expired', decided_at = now() where conversation_id = $1 and status = 'pending'",
      [conversation.id],
    );
    return c.json({ ok: true });
  });

  // Sending a message starts a run. The reply arrives on the events stream below.
  app.post("/api/app/conversations/:id/messages", async (c) => {
    const conversation = await mine(c, c.req.param("id"));
    if (!conversation) return fail(c, "not_found");
    const body = await parse(
      c,
      z.strictObject({
        content: z.string().trim().max(20_000).default(""),
        files: z.array(z.string().refine(isId)).max(10).default([]),
        // Sent by the desktop app: the names of the folders on that computer attached to the
        // conversation's project. Their paths stay on the computer.
        device: DeviceBody,
        // Skills the person picked for this message with "/".
        skills: z.array(z.string().refine(isId)).max(3).default([]),
        // The agent the person invited with "@" to answer this message.
        agentId: z.string().refine(isId).optional(),
        // The message answers a form in the reply before it (forms.ts). It then says nothing else.
        action: AnswerBody.optional(),
        // The component set the client draws: forms are taught only to a client that draws them.
        ui: z.number().int().min(1).max(99).optional(),
      }),
      "invalid_request",
    );
    // A message says something or brings something.
    if (!body.action && !body.content && body.files.length === 0) return fail(c, "invalid_request");
    if (
      body.action &&
      (body.content || body.files.length > 0 || body.agentId || body.skills.length > 0)
    )
      return fail(c, "invalid_request");
    if (!config.model) return fail(c, "model_unavailable");
    const s = c.get("session");
    // An agent a colleague shared and has since taken back is no longer theirs to run. What
    // was said stays; nothing more is asked of it.
    const of = (
      await db.query<{ agent_id: string }>("select agent_id from conversations where id = $1", [
        conversation.id,
      ])
    )[0];
    if (!of || !(await mayUseAgent(db, s.org.id, s.user.id, body.agentId ?? of.agent_id)))
      return fail(c, "agent_unavailable");
    // A skill picked by name is one the person may use. One that is not, or that does not
    // exist, is said, not quietly left out.
    const picked = [...new Set(body.skills)];
    if ((await usableSkills(db, s.org.id, s.user.id, picked)).length !== picked.length)
      return fail(c, "skill_unavailable");
    // The organization may cap what one person's agents use in a day.
    if (
      config.dailyTokensPerUser > 0 &&
      (await usedToday(s.org.id, s.user.id)) >= config.dailyTokensPerUser
    )
      return fail(c, "budget_reached");
    // And what the company, a department or one person may spend in a month.
    const over = await runs.budgets.reached(s.org.id, s.user.id);
    if (over) {
      void runs.budgets.tell(s.org.id, s.user.id);
      return fail(c, BUDGET_REFUSAL[over]);
    }
    // A run is going: what the person says now is for it, not for a second run. It is
    // handed to the agent as it works. Words only: a file, a skill or another agent is a
    // new message, and waits for this reply.
    if (runs.running(conversation.id)) {
      // A form is answered to a finished reply. While a run is going its reply is no longer
      // the last thing said, and an answer is never words added to the run.
      if (body.action) return fail(c, "form_closed");
      if (body.files.length > 0 || body.skills.length > 0 || body.agentId || !body.content)
        return fail(c, "run_in_progress");
      if (body.content.length > ASIDE_MAX) return fail(c, "invalid_request");
      if (runs.aside(conversation.id, storable(body.content))) return c.json({ aside: true }, 202);
    }
    const attachments = await files.attachments({ orgId: s.org.id, userId: s.user.id }, body.files);
    if (!attachments) return fail(c, "not_found");
    const answer = body.action
      ? await formAnswer(db, { id: conversation.id, orgId: s.org.id }, body.action)
      : null;
    if (typeof answer === "string") return fail(c, answer);
    // An answer goes to the agent that asked: an invited agent's form is answered to it.
    const asked = answer?.agentId ?? body.agentId;
    if (answer?.agentId && !(await mayUseAgent(db, s.org.id, s.user.id, answer.agentId)))
      return fail(c, "agent_unavailable");
    const started = await runs.start({
      conversationId: conversation.id,
      orgId: s.org.id,
      user: { id: s.user.id, email: s.user.email },
      content: answer?.content ?? body.content,
      ...(answer ? { action: { record: answer.record, replySeq: answer.replySeq } } : {}),
      ...(body.ui ? { ui: body.ui } : {}),
      attachments,
      ...(body.device ? { device: { ...body.device, session: s.sessionId } } : {}),
      ...(body.skills.length ? { skills: body.skills } : {}),
      ...(asked && asked !== of.agent_id ? { agentId: asked } : {}),
    });
    if (started === "closed") return fail(c, "form_closed");
    if (started === "busy") return fail(c, "run_in_progress");
    if (started === "unavailable" || started === "nothing") return fail(c, "agent_unavailable");
    return c.json(started);
  });

  // Going on with the last reply, which failed or was stopped, from what it had already
  // done. The same reply is written further; nothing it did is done again.
  app.post("/api/app/conversations/:id/continue", async (c) => {
    const conversation = await mine(c, c.req.param("id"));
    if (!conversation) return fail(c, "not_found");
    const body = await parse(
      c,
      z.strictObject({
        device: DeviceBody,
        // The component set the client draws, as with a message.
        ui: z.number().int().min(1).max(99).optional(),
      }),
      "invalid_request",
    );
    if (!config.model) return fail(c, "model_unavailable");
    const s = c.get("session");
    // The agent that was answering, if it is still the person's to run.
    const last = (
      await db.query<{ agent_id: string | null }>(
        `select coalesce(m.agent_id, v.agent_id) as agent_id from messages m join conversations v on v.id = m.conversation_id
          where m.conversation_id = $1 order by m.seq desc limit 1`,
        [conversation.id],
      )
    )[0];
    if (!last?.agent_id) return fail(c, "nothing_to_continue");
    if (!(await mayUseAgent(db, s.org.id, s.user.id, last.agent_id)))
      return fail(c, "agent_unavailable");
    if (
      config.dailyTokensPerUser > 0 &&
      (await usedToday(s.org.id, s.user.id)) >= config.dailyTokensPerUser
    )
      return fail(c, "budget_reached");
    const over = await runs.budgets.reached(s.org.id, s.user.id);
    if (over) return fail(c, BUDGET_REFUSAL[over]);
    const started = await runs.start({
      conversationId: conversation.id,
      orgId: s.org.id,
      user: { id: s.user.id, email: s.user.email },
      content: "",
      resume: true,
      ...(body.ui ? { ui: body.ui } : {}),
      ...(body.device ? { device: { ...body.device, session: s.sessionId } } : {}),
    });
    if (started === "busy") return fail(c, "run_in_progress");
    if (started === "unavailable") return fail(c, "agent_unavailable");
    if (started === "nothing") return fail(c, "nothing_to_continue");
    return c.json(started);
  });

  // What is asked of this signed-in desktop app, in any conversation, as it is asked.
  app.get("/api/app/device/events", async (c) => {
    const session = c.get("session").sessionId;
    return streamSSE(c, async (stream) => {
      const feed = runs.watchDevice(session);
      stream.onAbort(() => feed.close());
      for await (const ask of feed)
        await stream.writeSSE({
          event: "ping" in ask ? "ping" : "ask",
          data: JSON.stringify(ask),
        });
    });
  });

  // What an agent asked of the person's computer, for the desktop app to check before it
  // does it. Only while the call waits, and only to the session the message came from.
  app.get("/api/app/conversations/:id/device/:call", async (c) => {
    const conversation = await mine(c, c.req.param("id"));
    if (!conversation) return fail(c, "not_found");
    const call = runs.deviceCall(conversation.id, c.req.param("call"), c.get("session").sessionId);
    return call
      ? c.json({
          tool: call.tool,
          args: call.args,
          reply: call.reply,
          title: call.title,
          changes: call.changes,
        })
      : fail(c, "not_found");
  });

  // The person's computer answers something an agent asked of it.
  app.post("/api/app/conversations/:id/device/:call", async (c) => {
    const conversation = await mine(c, c.req.param("id"));
    if (!conversation) return fail(c, "not_found");
    const body = await parse(
      c,
      z.strictObject({ ok: z.boolean(), text: z.string().max(400_000) }),
      "invalid_request",
    );
    return runs.deviceAnswered(
      conversation.id,
      c.req.param("call"),
      c.get("session").sessionId,
      body.ok,
      storable(body.text),
    )
      ? c.json({ ok: true })
      : fail(c, "not_found");
  });

  // The person compacts the conversation: its messages so far are summarised for its agents
  // (docs/design/context-panel.md).
  app.post("/api/app/conversations/:id/compact", async (c) => {
    const conversation = await mine(c, c.req.param("id"));
    if (!conversation) return fail(c, "not_found");
    if (!config.model) return fail(c, "model_unavailable");
    // Making a summary asks the model, so it is held to the same allowances as a message.
    if (
      config.dailyTokensPerUser > 0 &&
      (await usedToday(org(c), me(c))) >= config.dailyTokensPerUser
    )
      return fail(c, "budget_reached");
    const over = await runs.budgets.reached(org(c), me(c));
    if (over) return fail(c, BUDGET_REFUSAL[over]);
    const done = await runs.compact({
      conversationId: conversation.id,
      orgId: org(c),
      userId: me(c),
    });
    if (done === "busy") return fail(c, "run_in_progress");
    if (done === "short") return fail(c, "nothing_to_compact");
    if (done === "failed") return fail(c, "compact_failed");
    if (done === "not_found") return fail(c, "not_found");
    return c.json({ ok: true, summarySeq: done.summarySeq });
  });

  app.post("/api/app/conversations/:id/stop", async (c) => {
    const conversation = await mine(c, c.req.param("id"));
    if (!conversation) return fail(c, "not_found");
    await runs.stop(conversation.id);
    return c.json({ ok: true });
  });

  // One step of a reply, opened: what the agent asked for and what came back, as they are
  // on the run's record. It is the person's own conversation, and what an agent read or
  // made for them is theirs to see; the line in the list stays a title, never content.
  app.get("/api/app/conversations/:id/steps/:call", async (c) => {
    const conversation = await mine(c, c.req.param("id"));
    if (!conversation) return fail(c, "not_found");
    const call = c.req.param("call");
    if (!call || call.length > 200) return fail(c, "not_found");
    const span = (
      await db.query<{
        id: string;
        name: string;
        status: string;
        input: string;
        output: string;
        ms: number;
        level: string | null;
      }>(
        `select s.id, s.name, s.status, s.input, s.output, s.duration_ms as ms, s.attributes->>'actionLevel' as level
           from spans s join traces t on t.id = s.trace_id
          where t.conversation_id = $1 and t.org_id = $2 and t.user_id = $3
            and s.kind in ('tool', 'retriever') and s.attributes->>'callId' = $4
          order by t.started_at desc, s.seq desc limit 1`,
        [conversation.id, org(c), me(c), call],
      )
    )[0];
    // A step still running, or one from before steps could be opened, has nothing on record.
    if (!span) return fail(c, "not_found");
    const judged = (
      await db.query<{ effect: string | null; mode: string | null }>(
        `select attributes->>'effect' as effect, attributes->>'mode' as mode
           from spans where parent_id = $1 and kind = 'policy' order by seq limit 1`,
        [span.id],
      )
    )[0];
    return c.json({
      tool: span.name,
      status: span.status,
      asked: span.input,
      returned: span.output,
      ms: span.ms,
      level: span.level,
      effect: judged?.effect ?? null,
      mode: judged?.mode ?? null,
      // What is kept of a step is cut at this length: said, so a long answer is not taken for the whole.
      limit: SPAN_TEXT,
    });
  });

  // Live events of the conversation's current run: text as it is written, each step, approvals, the end.
  app.get("/api/app/conversations/:id/events", async (c) => {
    const conversation = await mine(c, c.req.param("id"));
    if (!conversation) return fail(c, "not_found");
    return streamSSE(c, async (stream) => {
      const feed = runs.subscribe(conversation.id);
      stream.onAbort(() => feed.close());
      for await (const event of feed) {
        await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
      }
    });
  });

  // Clears the person's history: every conversation leaves their list. The record of what
  // the agents did stays with the administrators.
  app.delete("/api/app/conversations", async (c) => {
    const rows = await db.query<{ id: string }>(
      "select id from conversations where org_id = $1 and user_id = $2 and archived_at is null",
      [org(c), me(c)],
    );
    await Promise.all(rows.map((row) => runs.stop(row.id)));
    await db.query(
      "update conversations set archived_at = now() where org_id = $1 and user_id = $2 and archived_at is null",
      [org(c), me(c)],
    );
    return c.json({ removed: rows.length });
  });

  // ---- the person's own account: where they are signed in, and what they have used ----

  app.get("/api/app/sessions", async (c) => {
    const s = c.get("session");
    const rows = await db.query<{ id: string }>(
      `select public_id as id, provider, kind, created_at as "createdAt", last_seen_at as "lastSeenAt",
              user_agent as "userAgent"
         from sessions
        where user_id = $1 and org_id = $2 and revoked_at is null and expires_at > now()
        order by last_seen_at desc limit 50`,
      [s.user.id, s.org.id],
    );
    return c.json(rows.map((row) => ({ ...row, current: row.id === s.sessionId })));
  });

  // Signs one of the person's own devices out. Ending the current one signs this device out.
  app.delete("/api/app/sessions/:id", async (c) => {
    const id = c.req.param("id");
    if (!isId(id)) return fail(c, "not_found");
    const s = c.get("session");
    return inTx(c, async (tx) => {
      const ended = await tx.query(
        "update sessions set revoked_at = now() where public_id = $1 and user_id = $2 and org_id = $3 and revoked_at is null returning public_id",
        [id, s.user.id, s.org.id],
      );
      if (ended.length === 0) throw new Refusal("not_found");
      await recordEvent(tx, {
        orgId: s.org.id,
        actor: actorOf(c),
        action: "session.revoked",
        target: { type: "session", id, label: s.user.email },
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    });
  });

  // What the person's own conversations have used. Days are UTC, as on the administrators' dashboard.
  app.get("/api/app/usage", async (c) => {
    const ranges: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 };
    const range = c.req.query("range") ?? "30d";
    // Only the three names: "constructor" is a name every object answers to.
    const days = Object.hasOwn(ranges, range) ? ranges[range] : undefined;
    if (!days) return fail(c, "invalid_request");
    const scope =
      "t.org_id = $1 and t.user_id = $2 and t.started_at > now() - ($3 || ' days')::interval";
    const args = [org(c), me(c), String(days)];
    // `tokens` is everything; what went in and what came out are its two parts, and what
    // the model's service read from its cache is part of what went in.
    const sums = `count(*) as runs, coalesce(sum(t.prompt_tokens + t.completion_tokens), 0) as tokens,
                  coalesce(sum(t.prompt_tokens), 0) as "inputTokens",
                  coalesce(sum(t.completion_tokens), 0) as "outputTokens",
                  coalesce(sum(t.cached_tokens), 0) as "cachedTokens",
                  coalesce(sum(t.cost_micros), 0) as "costMicros"`;
    const numbers = <T extends Record<string, unknown>>(row: T) => ({
      ...row,
      runs: Number(row.runs),
      tokens: Number(row.tokens),
      inputTokens: Number(row.inputTokens ?? 0),
      outputTokens: Number(row.outputTokens ?? 0),
      cachedTokens: Number(row.cachedTokens ?? 0),
      costMicros: Number(row.costMicros),
    });
    const [totals, byAgent, byDay, byConversation] = await Promise.all([
      db.query(`select ${sums} from traces t where ${scope}`, args),
      db.query(
        `select ${shownSql("a")} as agent, ${sums} from traces t join agents a on a.id = t.agent_id
          where ${scope} group by 1 order by tokens desc, 1 limit 20`,
        args,
      ),
      db.query(
        `select to_char(date_trunc('day', t.started_at at time zone 'UTC'), 'YYYY-MM-DD') as day, ${sums}
           from traces t where ${scope} group by 1 order by 1`,
        args,
      ),
      // The conversations that used the most: the person's own, so by their titles.
      db.query(
        `select v.id, v.title, ${sums} from traces t join conversations v on v.id = t.conversation_id
          where ${scope} and v.user_id = $2 group by v.id, v.title order by tokens desc, v.id limit 10`,
        args,
      ),
    ]);
    return c.json({
      range: `${days}d`,
      today: { tokens: await usedToday(org(c), me(c)), limit: config.dailyTokensPerUser },
      // Code run today against the day's allowance. Null where the server has no sandbox.
      code: runs.hasSandbox ? await runs.sandboxUse.today(org(c), me(c)) : null,
      // This month against each limit that holds for the person. Their own in money; the
      // company's and their department's only as how far gone it is: what the company
      // spends is not every member's to know, that their agents are about to stop is.
      month: (await runs.budgets.standing(org(c), me(c))).map((s) => ({
        scope: s.scope,
        share: s.limitMicros > 0 ? Math.min(1, s.spentMicros / s.limitMicros) : 0,
        ...(s.scope === "person" ? { limitMicros: s.limitMicros, spentMicros: s.spentMicros } : {}),
      })),
      totals: numbers(totals[0] ?? { runs: 0, tokens: 0, costMicros: 0 }),
      byAgent: byAgent.map(numbers),
      byDay: byDay.map(numbers),
      byConversation: byConversation.map(numbers),
    });
  });

  // ---- approvals: the person who started a run confirms what it is about to do ----

  app.get("/api/app/approvals", async (c) => {
    const rows = await db.query(
      `select p.id, p.tool, p.level, p.summary, p.status, p.requested_at as "requestedAt", p.decided_at as "decidedAt",
              p.requested_at + interval '${APPROVAL_MINUTES} minutes' as "expiresAt",
              p.conversation_id as "conversationId", ${shownSql("a")} as "agentName"
         from approvals p join agents a on a.id = p.agent_id
         join conversations v on v.id = p.conversation_id
        where p.org_id = $1 and p.user_id = $2
          -- Of conversations that are still there: one that was deleted has nothing to open.
          and v.archived_at is null
        order by (p.status = 'pending') desc, p.requested_at desc limit 100`,
      [org(c), me(c)],
    );
    return c.json(rows);
  });

  app.post("/api/app/approvals/:id", async (c) => {
    const id = c.req.param("id");
    const body = await parse(
      c,
      // `remember` allows the rest of the same site for this conversation; it applies to reading a page only.
      z.strictObject({ decision: z.enum(["approve", "reject"]), remember: z.boolean().optional() }),
      "invalid_request",
    );
    if (!isId(id)) return fail(c, "not_found");
    const status = body.decision === "approve" ? "approved" : "rejected";
    const response = await inTx(c, async (tx) => {
      const approval = (
        await tx.query<{
          status: string;
          tool: string;
          agent_name: string;
          usable: boolean;
          conversation_id: string;
          destination: string | null;
        }>(
          `select p.status, p.tool, a.name as agent_name, p.conversation_id, p.summary->>'destination' as destination,
                  (a.state = 'published' and a.deleted_at is null) as usable
             from approvals p join agents a on a.id = p.agent_id
            where p.id = $1 and p.org_id = $2 and p.user_id = $3 for update of p`,
          [id, org(c), me(c)],
        )
      )[0];
      if (!approval) throw new Refusal("not_found");
      if (approval.status !== "pending") throw new Refusal("already_decided");
      // An agent that was suspended or deleted while it waited does nothing more.
      if (body.decision === "approve" && !approval.usable) throw new Refusal("agent_unavailable");
      await tx.query(
        "update approvals set status = $2, decided_at = now(), decided_by = $3 where id = $1",
        [id, status, me(c)],
      );
      let site = "";
      if (body.decision === "approve" && body.remember && approval.tool === "web.fetch") {
        try {
          const asked = new URL(approval.destination ?? "");
          if (asked.protocol === "https:") site = asked.host.toLowerCase();
        } catch {}
        if (site) {
          const kept = await tx.query(
            `update conversations set allowed_hosts = case when $2 = any(allowed_hosts) then allowed_hosts else array_append(allowed_hosts, $2) end
              where id = $1 and ($2 = any(allowed_hosts) or cardinality(allowed_hosts) < 50) returning id`,
            [approval.conversation_id, site],
          );
          // Past the limit the page is still allowed this once; the site is not, and the record does not say it is.
          if (kept.length === 0) site = "";
        }
      }
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: `approval.${status}`,
        target: { type: "approval", id, label: `${approval.agent_name} · ${approval.tool}` },
        detail: site ? { siteAllowedForConversation: site } : {},
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    });
    // Only once the decision is committed does the waiting run continue.
    if (response.status === 200) runs.decided(id, status);
    return response;
  });

  // What needed someone's confirmation is the person's own. Until 2026-11-21 an
  // administrator could list everyone's (`GET /api/approvals`, the console's Approvals
  // page): removed at the owner's word. That something was allowed or refused is still in
  // the activity log, and in the record of the run.
}
