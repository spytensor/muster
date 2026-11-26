import { isId, newId } from "@muster/protocol";
import type { Hono } from "hono";
import { z } from "zod";
import { type AppKit, type Ctx, type Env, fail } from "./app.js";
import { recordEvent } from "./audit.js";
import { ownAllowed, slugOf } from "./company.js";
import { openText, sealText } from "./connections.js";
import type { Db } from "./db.js";
import { Refusal } from "./errors.js";
import { plainName } from "./names.js";
import {
  listTools,
  MCP_LIMITS,
  McpProblem,
  type McpTool,
  mcpAuth,
  mergeTools,
  offered,
} from "./runtime/mcp.js";
import { checkUrl, type Net } from "./runtime/net.js";

/**
 * Setting up an MCP server as a connector: the company's, by an administrator, or a
 * person's own, where an administrator lets people have them. The server is asked what
 * tools it has when it is added and whenever somebody presses "Check again"; a tool
 * reaches agents only once a person has read it and switched it on, and stops reaching
 * them when the server changes it. See docs/features/marketplace.md, section 6.
 */

const Common = {
  name: plainName(40),
  description: z.string().trim().max(300),
  url: z.string().trim().max(300),
  authName: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{1,64}$/),
  /** Left out: the credential stays as it is. Empty: there is none. */
  credential: z
    .string()
    .max(4000)
    .regex(/^[^\r\n]*$/),
  departments: z.array(z.string().refine(isId)).max(50),
  enabled: z.boolean(),
};
const Create = z.strictObject({
  name: Common.name,
  description: Common.description.default(""),
  url: Common.url,
  authName: Common.authName.default("Authorization"),
  credential: Common.credential.optional(),
  departments: Common.departments.default([]),
  enabled: Common.enabled.default(true),
});
const Change = z.strictObject({
  name: Common.name.optional(),
  description: Common.description.optional(),
  url: Common.url.optional(),
  authName: Common.authName.optional(),
  credential: Common.credential.optional(),
  departments: Common.departments.optional(),
  enabled: Common.enabled.optional(),
  /** What is decided about tools. `hash` is the tool as the person read it: a tool that changed since is not switched on. */
  tools: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(128),
        hash: z.string().max(64),
        on: z.boolean(),
        level: z.enum(["ask", "reads"]).default("ask"),
      }),
    )
    .max(MCP_LIMITS.tools)
    .optional(),
});

type Row = {
  id: string;
  name: string;
  slug: string;
  description: string;
  baseUrl: string;
  authName: string;
  authSealed: string | null;
  departments: string[];
  enabled: boolean;
  tools: McpTool[];
  ownerId: string | null;
};
const ROW = `k.id, k.name, k.slug, k.description, k.base_url as "baseUrl", k.auth_name as "authName",
  k.auth_sealed as "authSealed", k.departments, k.enabled, k.tools, k.owner_id as "ownerId"`;
/** A connector as the page that sets it up reads it. Never the credential. */
const VIEW = `k.id, k.name, k.description, k.base_url as "baseUrl", k.auth_name as "authName",
  (k.auth_sealed is not null) as "hasCredential", k.departments, k.enabled, k.updated_at as "updatedAt",
  k.kind, k.tools, k.server, k.more, k.checked_at as "checkedAt", k.check_failed as "checkFailed",
  (select count(*)::int from agent_parts p join agents a on a.id = p.agent_id and a.deleted_at is null
    where p.kind = 'connector' and p.item_id = k.id) as agents`;

/** Where an MCP server is: public, over https, with nothing of its own carried in the address. */
function addressOf(value: string): string | null {
  try {
    const url = checkUrl(value);
    // A key in the address would be kept in the open and shown on every page: it goes in the credential.
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function registerMcpConnectors(
  app: Hono<Env>,
  kit: AppKit,
  db: Db,
  secretKey: string,
  net: Net,
): void {
  const { actorOf, clientIp, inTx, need } = kit;
  const org = (c: Ctx) => c.get("session").org.id;
  const me = (c: Ctx) => c.get("session").user.id;
  /** Whose connector a request is about: null for the company's, the person for their own. */
  type Whose = string | null;

  /** Who may: an administrator for the company's; anyone for their own, while the company allows it. */
  const allowed = async (c: Ctx, whose: Whose, permission: "settings.read" | "settings.manage") => {
    if (whose === null) return need(c, permission);
    return (await ownAllowed(db, org(c))) ? null : fail(c, "connectors_own_off");
  };
  const find = async (c: Ctx, whose: Whose, id: string) =>
    isId(id)
      ? (
          await db.query<Row>(
            `select ${ROW} from org_connectors k
              where k.id = $1 and k.org_id = $2 and k.deleted_at is null and k.kind = 'mcp'
                and k.owner_id is not distinct from $3`,
            [id, org(c), whose],
          )
        )[0]
      : undefined;
  /** Why a server could not be talked to, for the page to say in the person's language. */
  const notConnected = (c: Ctx, problem: McpProblem) =>
    c.json({ connected: false, reason: problem.reason, said: problem.said });
  const detailOf = (address: string, tools: McpTool[], whose: Whose) => ({
    kind: "mcp",
    address: new URL(address).origin,
    // What agents are given, and which of it somebody said only reads, so runs without asking.
    on: tools
      .filter(offered)
      .map((tool) => `${tool.name}${tool.level === "reads" ? " (said to only read)" : ""}`),
    ...(whose ? { own: true } : {}),
  });

  const view = async (c: Ctx, whose: Whose) =>
    db.query(
      `select ${VIEW} from org_connectors k
        where k.org_id = $1 and k.deleted_at is null and k.kind = 'mcp'
          and k.owner_id is not distinct from $2 order by k.name`,
      [org(c), whose],
    );

  /** A name as part of a tool's name that nothing else in the company has. */
  const slugFor = async (
    c: Ctx,
    whose: Whose,
    id: string,
    name: string,
  ): Promise<string | null> => {
    const tail = id.replaceAll("-", "").slice(-10);
    const plain = slugOf(name);
    const taken = async (slug: string) =>
      (
        await db.query(
          "select 1 from org_connectors where org_id = $1 and slug = $2 and deleted_at is null and id <> $3",
          [org(c), slug, id],
        )
      ).length > 0;
    if (whose === null) {
      const slug = plain || `sys_${tail}`;
      return (await taken(slug)) ? null : slug;
    }
    // A person's own never takes a name from the company or from a colleague: it gets a
    // mark of its own instead of an error about a connector they cannot see.
    const slug = `my_${plain.slice(0, 20) || tail}`;
    return (await taken(slug)) ? `${slug.slice(0, 19)}_${tail.slice(-4)}` : slug;
  };

  const create = async (c: Ctx, whose: Whose) => {
    const denied = await allowed(c, whose, "settings.manage");
    if (denied) return denied;
    const parsed = Create.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, "invalid_mcp_connector");
    const body = parsed.data;
    const address = addressOf(body.url);
    if (!address) return fail(c, "invalid_mcp_connector");
    if (body.credential && !secretKey) return fail(c, "connector_unsealed");
    // A person's own is theirs alone: it is not opened to departments.
    if (whose && body.departments.length) return fail(c, "invalid_mcp_connector");
    if (whose) {
      const mine = await db.query(
        "select 1 from org_connectors where org_id = $1 and owner_id = $2 and deleted_at is null",
        [org(c), whose],
      );
      if (mine.length >= 10) return fail(c, "connector_too_many");
    }
    const id = newId();
    const slug = await slugFor(c, whose, id, body.name);
    if (!slug) return fail(c, "connector_name_taken");
    if (body.departments.length) {
      const known = await db.query(
        "select id from departments where org_id = $1 and id = any($2::uuid[])",
        [org(c), body.departments],
      );
      if (known.length !== new Set(body.departments).size) return fail(c, "invalid_mcp_connector");
    }
    // The server is asked before anything is kept: one that does not answer is not added.
    let found: Awaited<ReturnType<typeof listTools>>;
    try {
      found = await listTools(
        net,
        address,
        mcpAuth({ authName: body.authName }, body.credential || null),
      );
    } catch (error) {
      if (error instanceof McpProblem) return notConnected(c, error);
      throw error;
    }
    // Everything it lists starts off: a person reads a tool before an agent is given it.
    const { tools } = mergeTools([], found.tools);
    return inTx(c, async (tx) => {
      await tx.query(
        `insert into org_connectors (id, org_id, owner_id, kind, name, slug, description, base_url, auth_name,
                                     auth_sealed, actions, tools, server, more, checked_at, departments, enabled)
         values ($1, $2, $3, 'mcp', $4, $5, $6, $7, $8, $9, '[]'::jsonb, $10::jsonb, $11::jsonb, $12, now(), $13, $14)`,
        [
          id,
          org(c),
          whose,
          body.name,
          slug,
          body.description,
          address,
          body.authName,
          body.credential ? sealText(secretKey, body.credential) : null,
          JSON.stringify(tools),
          JSON.stringify(found.server),
          found.more,
          body.departments,
          body.enabled,
        ],
      );
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "company_connector.created",
        target: { type: "company_connector", id, label: body.name },
        detail: {
          ...detailOf(address, tools, whose),
          server: found.server,
          listed: tools.length,
          departments: body.departments,
          enabled: body.enabled,
          credentialChanged: Boolean(body.credential),
        },
        ip: clientIp(c),
      });
      return c.json({ connected: true, id });
    });
  };

  const change = async (c: Ctx, whose: Whose, id: string) => {
    const denied = await allowed(c, whose, "settings.manage");
    if (denied) return denied;
    const row = await find(c, whose, id);
    if (!row) return fail(c, "not_found");
    const parsed = Change.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, "invalid_mcp_connector");
    const body = parsed.data;
    if (whose && body.departments?.length) return fail(c, "invalid_mcp_connector");
    const address = body.url === undefined ? row.baseUrl : addressOf(body.url);
    if (!address) return fail(c, "invalid_mcp_connector");
    const moved = address !== row.baseUrl;
    if (body.credential && !secretKey) return fail(c, "connector_unsealed");
    // A credential was entered for one address. It does not follow the connector to another.
    if (moved && row.authSealed && body.credential === undefined)
      return fail(c, "connector_credential_again");
    const authName = body.authName ?? row.authName;
    const name = body.name ?? row.name;
    const slug = name === row.name ? row.slug : await slugFor(c, whose, row.id, name);
    if (!slug) return fail(c, "connector_name_taken");
    if (body.departments?.length) {
      const known = await db.query(
        "select id from departments where org_id = $1 and id = any($2::uuid[])",
        [org(c), body.departments],
      );
      if (known.length !== new Set(body.departments).size) return fail(c, "invalid_mcp_connector");
    }

    let looked: Awaited<ReturnType<typeof listTools>> | null = null;
    // Another address, or another way in: the server is asked again before it is kept,
    // so what is saved is known to work.
    if (moved || body.credential !== undefined || authName !== row.authName) {
      const secret =
        body.credential !== undefined
          ? body.credential || null
          : row.authSealed
            ? openText(secretKey, row.authSealed)
            : null;
      try {
        looked = await listTools(net, address, mcpAuth({ authName }, secret));
      } catch (error) {
        if (error instanceof McpProblem) return notConnected(c, error);
        throw error;
      }
    }
    /** What is decided about tools, laid over the tools as they are kept now. */
    const decide = (kept: McpTool[]): McpTool[] => {
      // At another address it is another server: nothing switched on for the old one carries over.
      let tools = looked ? mergeTools(moved ? [] : kept, looked.tools).tools : kept;
      if (!body.tools) return tools;
      const decided = new Map(body.tools.map((tool) => [tool.name, tool]));
      for (const [toolName, wanted] of decided) {
        const tool = tools.find((item) => item.name === toolName);
        // Switched on as it was read: one that changed meanwhile is read again first.
        if (!tool || (wanted.on && tool.hash !== wanted.hash))
          throw new Refusal("connector_tool_changed");
        if (wanted.on && tool.refused) throw new Refusal("invalid_mcp_connector");
        // A person's own tools always ask: saying a tool only reads is the company's to do.
        if (whose && wanted.on && wanted.level === "reads")
          throw new Refusal("invalid_mcp_connector");
      }
      tools = tools.map((tool) => {
        const wanted = decided.get(tool.name);
        if (!wanted) return tool;
        return wanted.on
          ? { ...tool, on: true, level: wanted.level, approved: tool.hash, changed: false }
          : { ...tool, on: false, level: wanted.level };
      });
      if (tools.filter(offered).length > MCP_LIMITS.on)
        throw new Refusal("connector_too_many_tools");
      return tools;
    };
    const sealed =
      body.credential === undefined
        ? undefined
        : body.credential
          ? sealText(secretKey, body.credential)
          : null;
    return inTx(c, async (tx) => {
      // Read again and held: a "Check again" that finished meanwhile is built on, not written over.
      const now = await tx.query<{ tools: McpTool[] }>(
        "select tools from org_connectors where id = $1 and org_id = $2 and deleted_at is null and kind = 'mcp' for update",
        [row.id, org(c)],
      );
      if (!now[0]) throw new Refusal("not_found");
      const tools = decide(now[0].tools);
      const changed = await tx.query(
        `update org_connectors set name = $3, slug = $4, description = $5, base_url = $6, auth_name = $7,
                tools = $8::jsonb, departments = coalesce($9::uuid[], departments),
                enabled = coalesce($10::boolean, enabled), updated_at = now(),
                server = coalesce($11::jsonb, server), more = coalesce($12::boolean, more),
                checked_at = case when $11::jsonb is null then checked_at else now() end,
                check_failed = case when $11::jsonb is null then check_failed else null end
          where id = $1 and org_id = $2 and deleted_at is null and kind = 'mcp' returning id`,
        [
          row.id,
          org(c),
          name,
          slug,
          body.description ?? row.description,
          address,
          authName,
          JSON.stringify(tools),
          body.departments ?? null,
          body.enabled ?? null,
          looked ? JSON.stringify(looked.server) : null,
          looked ? looked.more : null,
        ],
      );
      if (changed.length === 0) throw new Refusal("not_found");
      if (sealed !== undefined)
        await tx.query("update org_connectors set auth_sealed = $2 where id = $1", [
          row.id,
          sealed,
        ]);
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "company_connector.changed",
        target: { type: "company_connector", id: row.id, label: name },
        detail: {
          ...detailOf(address, tools, whose),
          departments: body.departments ?? row.departments,
          enabled: body.enabled ?? row.enabled,
          credentialChanged: sealed !== undefined,
        },
        ip: clientIp(c),
      });
      return c.json({ connected: true, id: row.id });
    });
  };

  /** Asks the server again what it has, and keeps what came of it. */
  const check = async (c: Ctx, whose: Whose, id: string) => {
    const denied = await allowed(c, whose, "settings.manage");
    if (denied) return denied;
    const row = await find(c, whose, id);
    if (!row) return fail(c, "not_found");
    const secret = row.authSealed ? openText(secretKey, row.authSealed) : null;
    let problem: McpProblem | null = null;
    let found: Awaited<ReturnType<typeof listTools>> | null = null;
    if (row.authSealed && secret === null)
      problem = new McpProblem("credential", "the credential kept here can no longer be opened");
    else
      try {
        found = await listTools(net, row.baseUrl, mcpAuth(row, secret));
      } catch (error) {
        if (!(error instanceof McpProblem)) throw error;
        problem = error;
      }
    return inTx(c, async (tx) => {
      if (!found) {
        // Not reached now is not the same as changed: what was switched on stays as it is.
        const failure = { reason: problem?.reason ?? "unreachable", said: problem?.said ?? "" };
        await tx.query(
          "update org_connectors set check_failed = $2::jsonb, checked_at = now() where id = $1",
          [row.id, JSON.stringify(failure)],
        );
        await recordEvent(tx, {
          orgId: org(c),
          actor: actorOf(c),
          action: "company_connector.check_failed",
          target: { type: "company_connector", id: row.id, label: row.name },
          detail: { kind: "mcp", ...failure, ...(whose ? { own: true } : {}) },
          ip: clientIp(c),
        });
        return c.json({ connected: false, ...failure });
      }
      // Read again inside the transaction: what somebody decided meanwhile is not undone.
      const now = await tx.query<{ tools: McpTool[] }>(
        "select tools from org_connectors where id = $1 and deleted_at is null for update",
        [row.id],
      );
      if (!now[0]) throw new Refusal("not_found");
      const merged = mergeTools(now[0].tools, found.tools);
      await tx.query(
        `update org_connectors set tools = $2::jsonb, server = $3::jsonb, more = $4, checked_at = now(),
                check_failed = null where id = $1`,
        [row.id, JSON.stringify(merged.tools), JSON.stringify(found.server), found.more],
      );
      const stopped = now[0].tools
        .filter((tool) => offered(tool) && merged.removed.includes(tool.name))
        .map((tool) => tool.name);
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "company_connector.checked",
        target: { type: "company_connector", id: row.id, label: row.name },
        detail: {
          ...detailOf(row.baseUrl, merged.tools, whose),
          added: merged.added,
          removed: merged.removed,
          // Tools agents had until now and no longer have: changed by the server, or gone from it.
          switchedOff: [...merged.changed, ...stopped],
        },
        ip: clientIp(c),
      });
      return c.json({
        connected: true,
        added: merged.added.length,
        removed: merged.removed.length,
        changed: merged.changed.length,
      });
    });
  };

  const remove = async (c: Ctx, whose: Whose, id: string) => {
    // Taking one's own away is allowed even after the company stopped people adding them.
    const denied = whose === null ? need(c, "settings.manage") : null;
    if (denied) return denied;
    const row = await find(c, whose, id);
    if (!row) return fail(c, "not_found");
    return inTx(c, async (tx) => {
      // The credential goes with it: nothing is kept that could still open the system.
      await tx.query(
        "update org_connectors set deleted_at = now(), auth_sealed = null where id = $1",
        [row.id],
      );
      await tx.query("delete from agent_parts where kind = 'connector' and item_id = $1", [row.id]);
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "company_connector.deleted",
        target: { type: "company_connector", id: row.id, label: row.name },
        detail: { kind: "mcp", ...(whose ? { own: true } : {}) },
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    });
  };

  // The company's, for administrators. They are listed with the other company connectors
  // (GET /api/company-connectors) and deleted the same way.
  app.post("/api/company-connectors/mcp", (c) => create(c, null));
  app.patch("/api/company-connectors/mcp/:id", (c) => change(c, null, c.req.param("id")));
  app.post("/api/company-connectors/mcp/:id/check", (c) => check(c, null, c.req.param("id")));

  // Whether people may set up their own.
  app.put("/api/company-connectors/own", async (c) => {
    const denied = need(c, "settings.manage");
    if (denied) return denied;
    const parsed = z
      .strictObject({ allowed: z.boolean() })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, "invalid_request");
    return inTx(c, async (tx) => {
      const before = await ownAllowed(tx, org(c));
      await tx.query(
        `insert into org_settings (org_id, own_connectors) values ($1, $2)
         on conflict (org_id) do update set own_connectors = excluded.own_connectors`,
        [org(c), parsed.data.allowed],
      );
      if (before !== parsed.data.allowed)
        await recordEvent(tx, {
          orgId: org(c),
          actor: actorOf(c),
          action: parsed.data.allowed ? "connector.own_allowed" : "connector.own_stopped",
          target: { type: "connector", id: "mcp", label: "MCP connectors of people's own" },
          ip: clientIp(c),
        });
      return c.json({ allowed: parsed.data.allowed });
    });
  });

  // A person's own. Seen even when the company has stopped them, so they can be taken away.
  app.get("/api/app/my-connectors", async (c) =>
    c.json({
      allowed: await ownAllowed(db, org(c)),
      canSeal: Boolean(secretKey),
      connectors: await view(c, me(c)),
    }),
  );
  app.post("/api/app/my-connectors", (c) => create(c, me(c)));
  app.patch("/api/app/my-connectors/:id", (c) => change(c, me(c), c.req.param("id")));
  app.post("/api/app/my-connectors/:id/check", (c) => check(c, me(c), c.req.param("id")));
  app.delete("/api/app/my-connectors/:id", (c) => remove(c, me(c), c.req.param("id")));
}
