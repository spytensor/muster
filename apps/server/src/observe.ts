import { isId, newId } from "@muster/protocol";
import type { Hono } from "hono";
import { z } from "zod";
import { type AppKit, type Ctx, type Env, fail } from "./app.js";
import { recordEvent } from "./audit.js";
import type { Db } from "./db.js";
import { Refusal } from "./errors.js";
import { can } from "./roles.js";
import { legacySql, shownSql } from "./runtime/catalog.js";

const RANGES = {
  "15m": 15,
  "1h": 60,
  "12h": 720,
  "24h": 1440,
  "7d": 10_080,
  "30d": 43_200,
  "90d": 129_600,
} as const;
type Range = keyof typeof RANGES;
const STATUSES = ["ok", "error", "blocked", "stopped", "awaiting_approval", "running"] as const;
const LEVELS = ["A0", "A1", "A2", "A3", "A4"] as const;
const KINDS = ["agent", "llm", "tool", "retriever", "policy", "approval"] as const;
const SORTS = {
  started: "t.started_at",
  duration: "t.duration_ms",
  tokens: "(t.prompt_tokens + t.completion_tokens)",
  cost: "t.cost_micros",
} as const;

const list = <T extends string>(allowed: readonly T[]) =>
  z
    .string()
    .optional()
    .transform((raw) => (raw ? raw.split(",") : []))
    .pipe(z.array(z.enum(allowed as [T, ...T[]])));

/** The filters every trace listing, export and saved view shares. */
export const TraceFilters = z.strictObject({
  range: z.enum(Object.keys(RANGES) as [Range, ...Range[]]).default("7d"),
  status: list(STATUSES),
  level: list(LEVELS),
  venue: z.enum(["cloud", "device"]).optional(),
  agent: z.string().refine(isId).optional(),
  user: z.string().trim().max(120).optional(),
  q: z.string().trim().max(200).optional(),
  minMs: z.preprocess(
    (raw) =>
      raw === undefined ? undefined : /^\d{1,9}$/.test(String(raw)) ? Number(raw) : Number.NaN,
    z.number().int().min(0).max(86_400_000).optional(),
  ),
});
type TraceFilters = z.infer<typeof TraceFilters>;

/**
 * A whole number in a query, written in digits: "1e2", "0x10" and "+5" are not numbers
 * here. One left empty is refused like any other that is not a number.
 */
const whole = (min: number, max: number, fallback: number) =>
  z.preprocess(
    (raw) =>
      raw === undefined ? undefined : /^\d{1,9}$/.test(String(raw)) ? Number(raw) : Number.NaN,
    z.number().int().min(min).max(max).default(fallback),
  );
const Paging = z.object({
  sort: z
    .enum(Object.keys(SORTS) as [keyof typeof SORTS, ...(keyof typeof SORTS)[]])
    .default("started"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  limit: whole(1, 100, 50),
  offset: whole(0, 100_000, 0),
});

/** Builds the WHERE clause shared by the trace list, its summary, the export and the dashboard. */
function traceWhere(orgId: string, f: TraceFilters) {
  const params: unknown[] = [orgId, String(RANGES[f.range])];
  const clauses = ["t.org_id = $1", "t.started_at > now() - ($2 || ' minutes')::interval"];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    clauses.push(sql.replace("?", `$${params.length}`));
  };
  if (f.status.length) add("t.status = any(?::text[])", f.status);
  if (f.level.length) add("t.max_action = any(?::text[])", f.level);
  if (f.venue) add("t.venue = ?", f.venue);
  if (f.agent) add("t.agent_id = ?::uuid", f.agent);
  if (f.user) add("(u.email || ' ' || u.name) ilike '%' || ? || '%'", escapeLike(f.user));
  if (f.minMs !== undefined) add("t.duration_ms >= ?", f.minMs);
  if (f.q) {
    params.push(escapeLike(f.q));
    const p = `$${params.length}`;
    clauses.push(
      `(t.input ilike '%' || ${p} || '%' or t.output ilike '%' || ${p} || '%' or ${shownSql("a")} ilike '%' || ${p} || '%' or t.id::text ilike ${p} || '%')`,
    );
  }
  return { where: clauses.join(" and "), params };
}
const escapeLike = (text: string) => text.replace(/[\\%_]/g, (ch) => `\\${ch}`);

const FROM = `from traces t join agents a on a.id = t.agent_id left join users u on u.id = t.user_id`;
const TRACE_COLUMNS = `t.id, t.status, t.started_at as "startedAt", t.duration_ms as "durationMs", t.venue,
  t.input, t.output, t.prompt_tokens as "promptTokens", t.completion_tokens as "completionTokens",
  t.cached_tokens as "cachedTokens",
  t.cost_micros as "costMicros", t.span_count as "spanCount", t.max_action as "maxAction",
  t.conversation_id as "conversationId", t.agent_version as "agentVersion",
  a.id as "agentId", ${shownSql("a")} as "agentName", a.risk as "agentRisk",
  u.email as "userEmail", u.name as "userName",
  (select count(*) from annotations n where n.trace_id = t.id) as annotations`;

const num = <T extends Record<string, unknown>>(row: T, keys: string[]) => {
  const out: Record<string, unknown> = { ...row };
  for (const key of keys)
    out[key] = row[key] === null || row[key] === undefined ? row[key] : Number(row[key]);
  return out;
};
const traceRow = (row: Record<string, unknown>) => num(row, ["costMicros", "annotations"]);
const cut = (text: unknown, max: number) =>
  typeof text === "string" && text.length > max ? `${text.slice(0, max)}…` : text;

const csvCell = (value: unknown) => {
  let text = value === null || value === undefined ? "" : String(value);
  // A cell starting with one of these is run as a formula by spreadsheet programs.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export function registerObserve(app: Hono<Env>, kit: AppKit, db: Db): void {
  const { need, actorOf, clientIp, inTx } = kit;
  const org = (c: Ctx) => c.get("session").org.id;
  const NOT_FILTERS = new Set(["sort", "dir", "limit", "offset", "kind"]);
  const filtersOf = (c: Ctx) => {
    const parsed = TraceFilters.safeParse(
      Object.fromEntries(Object.entries(c.req.query()).filter(([key]) => !NOT_FILTERS.has(key))),
    );
    if (!parsed.success) throw new Refusal("invalid_request");
    return parsed.data;
  };

  // ---- agents ----

  app.get("/api/agents", async (c) => {
    const denied = need(c, "agents.read");
    if (denied) return denied;
    const rows = await db.query(
      `select a.id, a.name, a.description, a.source, a.risk, a.state, a.version, a.model, a.created_at as "createdAt",
              a.instructions, a.tools, a.deleted_at as "deletedAt",
              o.name as "ownerName", o.email as "ownerEmail",
              count(t.id) as runs, count(distinct t.user_id) as users,
              count(t.id) filter (where t.status = 'error') as errors,
              count(t.id) filter (where t.status = 'blocked') as blocked,
              max(t.started_at) as "lastRunAt"
         from agents a
         left join users o on o.id = a.owner_user_id
         left join traces t on t.org_id = a.org_id and t.agent_id = a.id and t.started_at > now() - interval '7 days'
        where a.org_id = $1
        group by a.id, o.name, o.email
        order by a.name`,
      [org(c)],
    );
    return c.json(rows.map((r) => num(r, ["runs", "users", "errors", "blocked"])));
  });

  // ---- traces ----

  app.get("/api/traces", async (c) => {
    const denied = need(c, "traces.read");
    if (denied) return denied;
    const filters = filtersOf(c);
    const paging = Paging.safeParse(c.req.query());
    if (!paging.success) return fail(c, "invalid_request");
    const { where, params } = traceWhere(org(c), filters);
    const { sort, dir, limit, offset } = paging.data;
    const rows = await db.query(
      `select ${TRACE_COLUMNS} ${FROM} where ${where}
        order by ${SORTS[sort]} ${dir}, t.id ${dir} limit ${limit} offset ${offset}`,
      params,
    );
    const summary = (
      await db.query(
        `select count(*) as total,
                count(*) filter (where t.status = 'error') as errors,
                count(*) filter (where t.status = 'blocked') as blocked,
                count(*) filter (where t.status = 'awaiting_approval') as awaiting,
                coalesce(percentile_cont(0.5) within group (order by t.duration_ms), 0) as p50,
                coalesce(percentile_cont(0.95) within group (order by t.duration_ms), 0) as p95,
                coalesce(sum(t.prompt_tokens + t.completion_tokens), 0) as tokens,
                coalesce(sum(t.cost_micros), 0) as "costMicros"
           ${FROM} where ${where}`,
        params,
      )
    )[0] as Record<string, unknown>;
    return c.json({
      rows: rows.map((r) =>
        traceRow({ ...r, input: cut(r.input, 240), output: cut(r.output, 240) }),
      ),
      summary: num(summary, [
        "total",
        "errors",
        "blocked",
        "awaiting",
        "p50",
        "p95",
        "tokens",
        "costMicros",
      ]),
    });
  });

  app.get("/api/traces/export.csv", async (c) => {
    const denied = need(c, "traces.read");
    if (denied) return denied;
    const filters = filtersOf(c);
    const { where, params } = traceWhere(org(c), filters);
    const rows = await db.query(
      `select ${TRACE_COLUMNS} ${FROM} where ${where} order by t.started_at desc limit 10000`,
      params,
    );
    const columns = [
      "id",
      "startedAt",
      "status",
      "agentName",
      "agentVersion",
      "userEmail",
      "venue",
      "maxAction",
      "durationMs",
      "promptTokens",
      "completionTokens",
      "costMicros",
      "spanCount",
      "conversationId",
      "input",
      "output",
    ];
    const lines = [
      columns.join(","),
      ...rows.map((row) =>
        columns
          .map((key) =>
            csvCell(row[key] instanceof Date ? (row[key] as Date).toISOString() : row[key]),
          )
          .join(","),
      ),
    ];
    // Exporting takes content out of Muster, so it is recorded.
    await recordEvent(db, {
      orgId: org(c),
      actor: actorOf(c),
      action: "traces.exported",
      detail: {
        rows: rows.length,
        truncated: rows.length === 10_000,
        filters: Object.fromEntries(
          Object.entries(filters).filter(([, v]) =>
            Array.isArray(v) ? v.length : v !== undefined,
          ),
        ),
      },
      ip: clientIp(c),
    });
    return c.body(`${lines.join("\r\n")}\r\n`, 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="muster-traces-${new Date().toISOString().slice(0, 10)}.csv"`,
    });
  });

  app.get("/api/traces/:id", async (c) => {
    const denied = need(c, "traces.read");
    if (denied) return denied;
    const id = c.req.param("id");
    if (!isId(id)) return fail(c, "not_found");
    const trace = (
      await db.query(`select ${TRACE_COLUMNS} ${FROM} where t.org_id = $1 and t.id = $2`, [
        org(c),
        id,
      ])
    )[0];
    if (!trace) return fail(c, "not_found");
    // A run holds what a person asked and was told. Someone else opening it is on the
    // record: once an hour for each reader and run, so the record says who read what
    // without filling with repeats.
    const reader = actorOf(c);
    const owner = (trace as { userEmail?: string | null }).userEmail ?? null;
    if (owner !== reader.email) {
      const seen = await db.query(
        `select 1 from admin_events where org_id = $1 and action = 'trace.viewed'
            and actor_user_id = $2 and target_id = $3 and time > now() - interval '1 hour' limit 1`,
        [org(c), reader.userId, id],
      );
      if (seen.length === 0)
        await recordEvent(db, {
          orgId: org(c),
          actor: reader,
          action: "trace.viewed",
          target: { type: "trace", id, label: owner ?? "" },
          // Which run was read: the record answers that, not only whose it was.
          detail: { traceId: id },
          ip: clientIp(c),
        });
    }
    const spans = await db.query(
      // An agent's span is named after the agent: in rows written before its shown name was
      // the one kept, "Assistant" is read as Muster.
      `select id, parent_id as "parentId", seq, kind, (case when kind = 'agent' then ${legacySql("name")} else name end) as name, status, start_offset_ms as "startOffsetMs",
              duration_ms as "durationMs", input, output, attributes, events,
              prompt_tokens as "promptTokens", completion_tokens as "completionTokens", cost_micros as "costMicros",
              cached_tokens as "cachedTokens"
         from spans where trace_id = $1 and org_id = $2 order by seq`,
      [id, org(c)],
    );
    return c.json({
      trace: traceRow(trace),
      spans: spans.map((s) => num(s, ["costMicros"])),
      annotations: await annotationsOf(id, org(c)),
    });
  });

  const annotationsOf = async (traceId: string, orgId: string) =>
    (
      await db.query(
        `select n.id, n.span_id as "spanId", n.label, n.score, n.note, n.created_at as "createdAt",
                u.email as "authorEmail", u.name as "authorName", n.author_user_id as "authorId"
           from annotations n join users u on u.id = n.author_user_id
          where n.trace_id = $1 and n.org_id = $2 order by n.created_at`,
        [traceId, orgId],
      )
    ).map((n) => num(n, ["score"]));

  const AnnotationBody = z.strictObject({
    spanId: z.string().refine(isId).nullable().optional(),
    label: z.string().trim().min(1).max(40),
    score: z.number().min(0).max(1).nullable().optional(),
    note: z.string().trim().max(2000).optional(),
  });

  app.post("/api/traces/:id/annotations", async (c) => {
    const denied = need(c, "traces.annotate");
    if (denied) return denied;
    const id = c.req.param("id");
    const parsed = AnnotationBody.safeParse(await c.req.json().catch(() => null));
    if (!isId(id) || !parsed.success) return fail(c, "invalid_request");
    const { spanId = null, label, score = null, note = "" } = parsed.data;
    return inTx(c, async (tx) => {
      const trace = await tx.query("select 1 from traces where id = $1 and org_id = $2", [
        id,
        org(c),
      ]);
      if (trace.length === 0) throw new Refusal("not_found");
      if (spanId) {
        const span = await tx.query("select 1 from spans where id = $1 and trace_id = $2", [
          spanId,
          id,
        ]);
        if (span.length === 0) throw new Refusal("not_found");
      }
      const annotationId = newId();
      await tx.query(
        `insert into annotations (id, org_id, trace_id, span_id, author_user_id, label, score, note)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [annotationId, org(c), id, spanId, c.get("session").user.id, label, score, note],
      );
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "trace.annotated",
        target: { type: "trace", id, label: id.slice(0, 13) },
        detail: { label },
        ip: clientIp(c),
      });
      return c.json({ id: annotationId });
    });
  });

  app.delete("/api/annotations/:id", async (c) => {
    const denied = need(c, "traces.annotate");
    if (denied) return denied;
    const id = c.req.param("id");
    if (!isId(id)) return fail(c, "not_found");
    return inTx(c, async (tx) => {
      // People remove their own annotations; an owner may remove anyone's.
      const removed = await tx.query<{ trace_id: string; label: string }>(
        `delete from annotations where id = $1 and org_id = $2 and (author_user_id = $3 or $4)
         returning trace_id, label`,
        [id, org(c), c.get("session").user.id, c.get("session").role === "owner"],
      );
      if (!removed[0]) throw new Refusal("not_found");
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "trace.annotation_removed",
        target: { type: "trace", id: removed[0].trace_id, label: removed[0].trace_id.slice(0, 13) },
        detail: { label: removed[0].label },
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    });
  });

  // ---- spans across traces ----

  app.get("/api/spans", async (c) => {
    const denied = need(c, "traces.read");
    if (denied) return denied;
    const filters = filtersOf(c);
    const extra = z
      .object({
        kind: list(KINDS),
        limit: whole(1, 100, 50),
        offset: whole(0, 100_000, 0),
      })
      .safeParse(c.req.query());
    if (!extra.success) return fail(c, "invalid_request");
    const { where, params } = traceWhere(org(c), filters);
    let kindClause = "";
    if (extra.data.kind.length) {
      params.push(extra.data.kind);
      kindClause = ` and s.kind = any($${params.length}::text[])`;
    }
    const rows = await db.query(
      `select s.id, s.trace_id as "traceId", s.kind, (case when s.kind = 'agent' then ${legacySql("s.name")} else s.name end) as name, s.status, s.duration_ms as "durationMs",
              s.prompt_tokens as "promptTokens", s.completion_tokens as "completionTokens", s.cost_micros as "costMicros",
              s.cached_tokens as "cachedTokens",
              s.attributes, left(s.input, 200) as input, left(s.output, 200) as output,
              t.started_at + (s.start_offset_ms || ' milliseconds')::interval as "startedAt",
              ${shownSql("a")} as "agentName"
         from spans s join traces t on t.id = s.trace_id join agents a on a.id = t.agent_id left join users u on u.id = t.user_id
        where ${where}${kindClause}
        order by t.started_at desc, s.seq limit ${extra.data.limit} offset ${extra.data.offset}`,
      params,
    );
    const total = (
      await db.query<{ n: string }>(
        `select count(*) as n from spans s join traces t on t.id = s.trace_id join agents a on a.id = t.agent_id left join users u on u.id = t.user_id where ${where}${kindClause}`,
        params,
      )
    )[0];
    return c.json({ rows: rows.map((r) => num(r, ["costMicros"])), total: Number(total?.n ?? 0) });
  });

  // ---- conversations (traces grouped into a thread) ----

  app.get("/api/conversations", async (c) => {
    const denied = need(c, "traces.read");
    if (denied) return denied;
    const filters = filtersOf(c);
    const { where, params } = traceWhere(org(c), filters);
    const rows = await db.query(
      `select t.conversation_id as id, count(*) as traces, min(t.started_at) as "startedAt", max(t.started_at) as "lastAt",
              sum(t.duration_ms) as "durationMs", sum(t.prompt_tokens + t.completion_tokens) as tokens,
              sum(t.cost_micros) as "costMicros", max(${shownSql("a")}) as "agentName", max(u.email) as "userEmail",
              count(*) filter (where t.status <> 'ok') as problems,
              (array_agg(t.input order by t.started_at))[1] as "firstInput"
         ${FROM} where ${where}
        group by t.conversation_id order by max(t.started_at) desc limit 100`,
      params,
    );
    return c.json(
      rows.map((r) =>
        num({ ...r, firstInput: cut(r.firstInput, 200) }, [
          "traces",
          "durationMs",
          "tokens",
          "costMicros",
          "problems",
        ]),
      ),
    );
  });

  app.get("/api/conversations/:id", async (c) => {
    const denied = need(c, "traces.read");
    if (denied) return denied;
    const id = c.req.param("id");
    if (!isId(id)) return fail(c, "not_found");
    const rows = await db.query(
      `select ${TRACE_COLUMNS} ${FROM} where t.org_id = $1 and t.conversation_id = $2 order by t.started_at`,
      [org(c), id],
    );
    if (rows.length === 0) return fail(c, "not_found");
    return c.json(rows.map(traceRow));
  });

  // ---- saved views (per person) ----

  app.get("/api/views", async (c) => {
    const denied = need(c, "traces.read");
    if (denied) return denied;
    return c.json(
      await db.query(
        "select id, name, filters from saved_views where user_id = $1 and org_id = $2 order by name",
        [c.get("session").user.id, org(c)],
      ),
    );
  });

  app.post("/api/views", async (c) => {
    const denied = need(c, "traces.read");
    if (denied) return denied;
    const parsed = z
      .strictObject({
        name: z.string().trim().min(1).max(40),
        filters: z.record(z.string().max(20), z.string().max(300)),
      })
      .safeParse(await c.req.json().catch(() => null));
    // Only filters the list itself understands may be saved, so a view can never break a page.
    if (
      !parsed.success ||
      Object.keys(parsed.data.filters).length > 12 ||
      !TraceFilters.safeParse(parsed.data.filters).success
    ) {
      return fail(c, "invalid_request");
    }
    const owned = await db.query<{ name: string }>(
      "select name from saved_views where user_id = $1",
      [c.get("session").user.id],
    );
    if (owned.length >= 50 && !owned.some((view) => view.name === parsed.data.name))
      return fail(c, "invalid_request");
    const id = newId();
    // Saving under an existing name replaces that view.
    const saved = await db.query<{ id: string }>(
      `insert into saved_views (id, org_id, user_id, name, filters) values ($1, $2, $3, $4, $5::jsonb)
       on conflict (user_id, name) do update set filters = excluded.filters returning id`,
      [id, org(c), c.get("session").user.id, parsed.data.name, JSON.stringify(parsed.data.filters)],
    );
    return c.json({ id: saved[0]?.id });
  });

  app.delete("/api/views/:id", async (c) => {
    const denied = need(c, "traces.read");
    if (denied) return denied;
    const id = c.req.param("id");
    const removed = isId(id)
      ? await db.query("delete from saved_views where id = $1 and user_id = $2 returning id", [
          id,
          c.get("session").user.id,
        ])
      : [];
    return removed.length ? c.json({ ok: true }) : fail(c, "not_found");
  });

  // ---- dashboard ----

  app.get("/api/dashboard", async (c) => {
    const denied = need(c, "console.access");
    if (denied) return denied;
    const s = c.get("session");
    const range = z
      .enum(["24h", "7d", "30d", "90d"])
      .default("30d")
      .safeParse(c.req.query("range"));
    if (!range.success) return fail(c, "invalid_request");
    const minutes = String(RANGES[range.data]);
    const p = [s.org.id, minutes];
    const within = "t.org_id = $1 and t.started_at > now() - ($2 || ' minutes')::interval";
    const one = async (sql: string, params: unknown[] = [s.org.id]) =>
      Number((await db.query<{ n: string }>(sql, params))[0]?.n ?? 0);
    const rows = (sql: string, params: unknown[] = p) => db.query(sql, params);
    const bucket = range.data === "24h" ? "hour" : "day";

    const totalsSql = (window: string) => `select count(*) as runs,
        count(*) filter (where t.status = 'ok') as ok,
        count(*) filter (where t.status = 'error') as errors,
        count(*) filter (where t.status = 'blocked') as blocked,
        count(*) filter (where t.status = 'stopped') as stopped,
        count(*) filter (where t.status = 'awaiting_approval') as awaiting,
        count(distinct t.user_id) as users,
        coalesce(percentile_cont(0.5) within group (order by t.duration_ms), 0) as p50,
        coalesce(percentile_cont(0.95) within group (order by t.duration_ms), 0) as p95,
        coalesce(sum(t.prompt_tokens + t.completion_tokens), 0) as tokens,
        coalesce(sum(t.cost_micros), 0) as "costMicros"
      from traces t where t.org_id = $1 and ${window}`;
    const totalKeys = [
      "runs",
      "ok",
      "errors",
      "blocked",
      "stopped",
      "awaiting",
      "users",
      "p50",
      "p95",
      "tokens",
      "costMicros",
    ];
    const canTraces = can(s.role, "traces.read") || s.role === "billing";

    const people = {
      members: await one(
        "select count(*) as n from memberships where org_id = $1 and status = 'active'",
      ),
      suspended: await one(
        "select count(*) as n from memberships where org_id = $1 and status = 'suspended'",
      ),
      invitations: await one(
        "select count(*) as n from invitations where org_id = $1 and accepted_at is null and revoked_at is null and expires_at > now()",
      ),
      sessions: await one(
        "select count(*) as n from sessions where org_id = $1 and revoked_at is null and expires_at > now()",
      ),
      departments: await one("select count(*) as n from departments where org_id = $1"),
      byRole: (
        await rows(
          "select role as key, count(*) as value from memberships where org_id = $1 and status = 'active' group by role",
          [s.org.id],
        )
      ).map((r) => num(r, ["value"])),
    };
    if (!canTraces) return c.json({ range: range.data, bucket, people, activity: null });
    // The billing role sees cost, not who is in the organization.
    const shownPeople = can(s.role, "members.read") ? people : null;

    const n = (list: Record<string, unknown>[], keys: string[]) => list.map((r) => num(r, keys));
    return c.json({
      range: range.data,
      bucket,
      people: shownPeople,
      activity: {
        totals: num(
          (await rows(totalsSql("t.started_at > now() - ($2 || ' minutes')::interval")))[0] ?? {},
          totalKeys,
        ),
        previous: num(
          (
            await rows(
              totalsSql(
                "t.started_at <= now() - ($2 || ' minutes')::interval and t.started_at > now() - (($2::int * 2) || ' minutes')::interval",
              ),
            )
          )[0] ?? {},
          totalKeys,
        ),
        agents: {
          total: await one("select count(*) as n from agents where org_id = $1"),
          pending: await one(
            "select count(*) as n from agents where org_id = $1 and state = 'pending'",
          ),
          byRisk: n(
            await rows(
              "select risk as key, count(*) as value from agents where org_id = $1 group by risk order by risk",
              [s.org.id],
            ),
            ["value"],
          ),
        },
        series: n(
          await rows(
            `select date_trunc('${bucket}', t.started_at at time zone 'UTC') at time zone 'UTC' as at,
                    count(*) filter (where t.status = 'ok') as ok,
                    count(*) filter (where t.status = 'error') as error,
                    count(*) filter (where t.status = 'blocked') as blocked,
                    count(*) filter (where t.status = 'stopped') as stopped,
                    count(*) filter (where t.status = 'awaiting_approval') as awaiting,
                    percentile_cont(0.5) within group (order by t.duration_ms) as p50,
                    percentile_cont(0.95) within group (order by t.duration_ms) as p95,
                    sum(t.cost_micros) as "costMicros",
                    sum(t.prompt_tokens + t.completion_tokens) as tokens,
                    count(distinct t.user_id) as users
               from traces t where ${within} group by 1 order by 1`,
          ),
          [
            "ok",
            "error",
            "blocked",
            "stopped",
            "awaiting",
            "p50",
            "p95",
            "costMicros",
            "tokens",
            "users",
          ],
        ),
        byAgent: n(
          await rows(
            `select ${shownSql("a")} as key, a.risk, count(*) as runs, count(*) filter (where t.status = 'error') as errors,
                    sum(t.cost_micros) as "costMicros"
               from traces t join agents a on a.id = t.agent_id where ${within}
              group by a.id order by count(*) desc limit 8`,
          ),
          ["runs", "errors", "costMicros"],
        ),
        byDepartment: n(
          await rows(
            `select coalesce(d.name, '') as key, count(*) as runs, count(distinct t.user_id) as users, sum(t.cost_micros) as "costMicros"
               from traces t left join memberships m on m.user_id = t.user_id and m.org_id = t.org_id
               left join departments d on d.id = m.department_id
              where ${within} group by d.name order by sum(t.cost_micros) desc`,
          ),
          ["runs", "users", "costMicros"],
        ),
        byModel: n(
          await rows(
            `select s.attributes->>'model' as key, count(*) as calls, sum(s.prompt_tokens + s.completion_tokens) as tokens, sum(s.cost_micros) as "costMicros"
               from spans s join traces t on t.id = s.trace_id
              where ${within} and s.kind = 'llm' group by 1 order by sum(s.cost_micros) desc`,
          ),
          ["calls", "tokens", "costMicros"],
        ),
        byLevel: n(
          await rows(
            `select s.attributes->>'actionLevel' as key, count(*) as value,
                    count(*) filter (where s.status = 'blocked') as blocked
               from spans s join traces t on t.id = s.trace_id
              where ${within} and s.kind = 'tool' group by 1 order by 1`,
          ),
          ["value", "blocked"],
        ),
        byTool: n(
          await rows(
            `select s.name as key, count(*) as calls, count(*) filter (where s.status = 'error') as errors,
                    percentile_cont(0.5) within group (order by s.duration_ms) as p50
               from spans s join traces t on t.id = s.trace_id
              where ${within} and s.kind = 'tool' group by 1 order by count(*) desc limit 8`,
          ),
          ["calls", "errors", "p50"],
        ),
        byVenue: n(
          await rows(
            `select t.venue as key, count(*) as value from traces t where ${within} group by 1 order by 1`,
          ),
          ["value"],
        ),
        heat: n(
          await rows(
            `select extract(dow from t.started_at at time zone 'UTC')::int as dow, extract(hour from t.started_at at time zone 'UTC')::int as hour, count(*) as value
               from traces t where ${within} group by 1, 2`,
          ),
          ["value"],
        ),
      },
    });
  });
}
