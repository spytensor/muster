import { isId, newId } from "@muster/protocol";
import type { Hono } from "hono";
import { z } from "zod";
import { type AppKit, type Ctx, type Env, fail } from "./app.js";
import { recordEvent } from "./audit.js";
import type { Config, ModelConfig } from "./config.js";
import { openText, sealText } from "./connections.js";
import type { Db } from "./db.js";
import { Refusal } from "./errors.js";

/**
 * The model agents run on, set in the admin console: the services the company buys models
 * from (an address and a key), the models of each with their prices, and which one agents
 * run on. What is set here replaces the model named in the server's settings
 * (`MUSTER_MODEL_*`), which stays in use while nothing is chosen here. A key is sealed with
 * the server's key and never leaves the server again. See docs/features/admin-console.md.
 *
 * A deployment is one company, so there is one choice for the whole server.
 */

/** See schema.ts, step 37. */
export const MODEL_SETTINGS_SCHEMA = [
  `create table model_services (
    id uuid primary key,
    org_id uuid not null references organizations(id) on delete cascade,
    name text not null,
    api text not null check (api in ('anthropic', 'openai')),
    base_url text not null,
    key_sealed text,
    -- The last four characters of the key, so an administrator can tell which one is in use.
    key_tail text not null default '',
    key_set_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    deleted_at timestamptz
  )`,
  `create table model_choices (
    id uuid primary key,
    org_id uuid not null references organizations(id) on delete cascade,
    service_id uuid not null references model_services(id) on delete cascade,
    model text not null,
    -- Millionths of a US dollar per million tokens: whole numbers, so sums are exact.
    input_micros bigint not null default 0 check (input_micros >= 0),
    output_micros bigint not null default 0 check (output_micros >= 0),
    -- What part of a prompt the service already held costs, and what keeping it there costs.
    -- Not set: the price of input.
    cached_input_micros bigint check (cached_input_micros >= 0),
    cache_write_micros bigint check (cache_write_micros >= 0),
    vision boolean not null default false,
    context_window integer,
    max_output_tokens integer,
    reasoning_effort text,
    -- 'first': agents run on it. 'second': asked when the first cannot answer at all.
    role text check (role in ('first', 'second')),
    tested_at timestamptz,
    tested_ok boolean,
    tested_note text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    deleted_at timestamptz
  )`,
  `create unique index model_choices_role on model_choices (role) where role is not null and deleted_at is null`,
  `create index model_choices_service on model_choices (service_id) where deleted_at is null`,
];

const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
/** What a key can be made of: no space, quote or line break, which a paste brings along. */
const KEY = /^[\x21\x23-\x26\x28-\x7e]{8,400}$/;
/** The most a price can be: a thousand dollars a million tokens. */
const PRICE_MICROS = 1_000_000_000;
const TEST_MS = 20_000;

const ServiceBody = z.object({
  name: z.string().trim().min(1).max(60),
  api: z.enum(["anthropic", "openai"]),
  baseUrl: z.string().trim().min(1).max(300),
  /** Left out: the key kept stays. */
  key: z.string().trim().optional(),
});
const micros = z.number().int().min(0).max(PRICE_MICROS);
const ChoiceBody = z.object({
  serviceId: z.string().refine(isId),
  model: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[\x21-\x7e]+$/),
  inputMicros: micros,
  outputMicros: micros,
  cachedInputMicros: micros.nullable().default(null),
  cacheWriteMicros: micros.nullable().default(null),
  vision: z.boolean().default(false),
  contextWindow: z.number().int().min(8000).max(4_000_000).nullable().default(null),
  maxOutputTokens: z.number().int().min(1024).max(200_000).nullable().default(null),
  reasoningEffort: z.enum(EFFORTS).nullable().default(null),
});
const RolesBody = z.object({
  first: z.string().refine(isId).nullable(),
  second: z.string().refine(isId).nullable(),
});

/** The address of a service as it is kept: http or https, no user name, no trailing slash. */
function addressOf(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash)
    return null;
  return url.toString().replace(/\/+$/, "");
}

type ChoiceRow = {
  id: string;
  model: string;
  api: "anthropic" | "openai";
  baseUrl: string;
  keySealed: string | null;
  inputMicros: string;
  outputMicros: string;
  cachedInputMicros: string | null;
  cacheWriteMicros: string | null;
  vision: boolean;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  reasoningEffort: string | null;
  role: "first" | "second" | null;
};
const CHOICE = `m.id, m.model, s.api, s.base_url as "baseUrl", s.key_sealed as "keySealed",
  m.input_micros as "inputMicros", m.output_micros as "outputMicros", m.cached_input_micros as "cachedInputMicros",
  m.cache_write_micros as "cacheWriteMicros", m.vision,
  m.context_window as "contextWindow", m.max_output_tokens as "maxOutputTokens",
  m.reasoning_effort as "reasoningEffort", m.role
  from model_choices m join model_services s on s.id = m.service_id and s.deleted_at is null
 where m.deleted_at is null`;

/** What a test of a model found. `code` is what the page says; `detail` is the service's own words, cut short. */
export interface TestResult {
  ok: boolean;
  code:
    | "ok"
    | "no_key"
    | "key_unreadable"
    | "refused_key"
    | "not_found"
    | "over_limit"
    | "error"
    | "unreachable"
    | "timeout";
  status: number | null;
  detail: string;
  ms: number;
}

/**
 * Why what is chosen in the console cannot be used, when it cannot: the key was sealed with
 * another server key, or was never entered. Agents then do not run, and the console says
 * why: the server never quietly goes back to a model the company chose to leave.
 */
export type ModelProblem = "key_unreadable" | "no_key" | "second_unusable" | null;

export class ModelSettings {
  /** The model named in the server's settings, kept from the start: what holds while nothing is chosen in the console. */
  readonly env: ModelConfig | null;
  source: "console" | "env" | "none";
  problem: ModelProblem = null;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.env = config.model;
    this.source = config.model ? "env" : "none";
  }

  get canSeal(): boolean {
    return Boolean(this.config.secretKey);
  }
  /** What agents run on at this moment. */
  current(): ModelConfig | null {
    return this.config.model;
  }
  /** Seals a key with the server's own. */
  seal(key: string): string {
    return sealText(this.config.secretKey, key);
  }

  private toConfig(row: ChoiceRow, key: string): ModelConfig {
    return {
      api: row.api,
      id: row.model,
      baseUrl: row.baseUrl,
      apiKey: key,
      inputPrice: Number(row.inputMicros) / 1e6,
      outputPrice: Number(row.outputMicros) / 1e6,
      ...(row.cachedInputMicros === null
        ? {}
        : { cachedInputPrice: Number(row.cachedInputMicros) / 1e6 }),
      ...(row.cacheWriteMicros === null
        ? {}
        : { cacheWritePrice: Number(row.cacheWriteMicros) / 1e6 }),
      vision: row.vision,
      // How long to wait is a setting of the deployment: the server's own holds for any model.
      ...(this.env?.firstWordSeconds ? { firstWordSeconds: this.env.firstWordSeconds } : {}),
      ...(this.env?.silenceSeconds ? { silenceSeconds: this.env.silenceSeconds } : {}),
      ...(row.maxOutputTokens ? { maxOutputTokens: row.maxOutputTokens } : {}),
      ...(row.contextWindow ? { contextWindow: row.contextWindow } : {}),
      ...(row.reasoningEffort ? { reasoningEffort: row.reasoningEffort } : {}),
    };
  }

  private keyOf(row: { keySealed: string | null }): string | null {
    return row.keySealed && this.config.secretKey
      ? openText(this.config.secretKey, row.keySealed)
      : null;
  }

  /**
   * Makes the server use what is chosen now. Called at start and after every change, once
   * the change is kept. `config.model` is what every run reads, so it is set here and
   * nowhere else: a run already going keeps the model it began with.
   */
  async apply(): Promise<void> {
    const rows = await this.db.query<ChoiceRow>(`select ${CHOICE} and m.role is not null`);
    const first = rows.find((row) => row.role === "first");
    if (!first) {
      this.config.model = this.env;
      this.source = this.env ? "env" : "none";
      this.problem = null;
      return;
    }
    this.source = "console";
    const key = this.keyOf(first);
    if (!key) {
      this.config.model = null;
      this.problem = first.keySealed ? "key_unreadable" : "no_key";
      return;
    }
    const model = this.toConfig(first, key);
    this.problem = null;
    const second = rows.find((row) => row.role === "second");
    if (second) {
      const secondKey = this.keyOf(second);
      if (secondKey) {
        model.fallback = this.toConfig(second, secondKey);
      } else this.problem = "second_unusable";
    }
    this.config.model = model;
  }

  /** Asks the model for one word, with the key kept for its service. Nothing of the key is in what comes back. */
  async test(choiceId: string): Promise<TestResult | null> {
    const row = (await this.db.query<ChoiceRow>(`select ${CHOICE} and m.id = $1`, [choiceId]))[0];
    if (!row) return null;
    const began = Date.now();
    const done = (
      code: TestResult["code"],
      status: number | null = null,
      detail = "",
    ): TestResult => ({ ok: code === "ok", code, status, detail, ms: Date.now() - began });
    if (!row.keySealed) return done("no_key");
    const key = this.keyOf(row);
    if (!key) return done("key_unreadable");
    const messages = [{ role: "user", content: "Reply with the single word OK." }];
    const [url, headers] =
      row.api === "anthropic"
        ? [`${row.baseUrl}/v1/messages`, { "x-api-key": key, "anthropic-version": "2023-06-01" }]
        : [`${row.baseUrl}/chat/completions`, { authorization: `Bearer ${key}` }];
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers } as Record<string, string>,
        body: JSON.stringify({ model: row.model, max_tokens: 16, messages }),
        signal: AbortSignal.timeout(TEST_MS),
        redirect: "error",
      });
    } catch (error) {
      return done((error as Error)?.name === "TimeoutError" ? "timeout" : "unreachable");
    }
    if (response.ok) {
      await response.body?.cancel().catch(() => {});
      return done("ok", response.status);
    }
    // What the service said, short and without the key should it have been echoed.
    const said = (await response.text().catch(() => ""))
      .replaceAll(key, "…")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
    const status = response.status;
    if (status === 401 || status === 403) return done("refused_key", status, said);
    if (status === 404) return done("not_found", status, said);
    if (status === 429) return done("over_limit", status, said);
    return done("error", status, said);
  }
}

export function registerModels(app: Hono<Env>, kit: AppKit, db: Db, settings: ModelSettings): void {
  const { actorOf, clientIp, inTx, need } = kit;
  const org = (c: Ctx) => c.get("session").org.id;
  const host = (address: string) => new URL(address).host;
  /** A model as the page may see it: where it is, never its key. */
  const shown = (model: ModelConfig | null) =>
    model && {
      id: model.id,
      api: model.api,
      host: host(model.baseUrl),
      inputMicros: Math.round(model.inputPrice * 1e6),
      outputMicros: Math.round(model.outputPrice * 1e6),
      cachedInputMicros:
        model.cachedInputPrice === undefined ? null : Math.round(model.cachedInputPrice * 1e6),
      cacheWriteMicros:
        model.cacheWritePrice === undefined ? null : Math.round(model.cacheWritePrice * 1e6),
      vision: model.vision,
      second: model.fallback ? { id: model.fallback.id, host: host(model.fallback.baseUrl) } : null,
    };
  /** After a change is kept, the server uses it; a change that was refused changes nothing. */
  const applied = async (response: Response) => {
    if (response.status === 200) await settings.apply();
    return response;
  };

  // Everything about models an administrator sees. No key is ever in it.
  app.get("/api/models", async (c) => {
    const denied = need(c, "settings.read");
    if (denied) return denied;
    const [services, choices] = await Promise.all([
      db.query(
        `select s.id, s.name, s.api, s.base_url as "baseUrl", (s.key_sealed is not null) as "hasKey",
                s.key_tail as "keyTail", s.key_set_at as "keySetAt",
                (select count(*)::int from model_choices m where m.service_id = s.id and m.deleted_at is null) as models
           from model_services s where s.org_id = $1 and s.deleted_at is null order by s.name, s.created_at`,
        [org(c)],
      ),
      db.query<{
        inputMicros: string;
        outputMicros: string;
        cachedInputMicros: string | null;
        cacheWriteMicros: string | null;
      }>(
        `select m.id, m.service_id as "serviceId", m.model, m.input_micros as "inputMicros",
                m.output_micros as "outputMicros", m.cached_input_micros as "cachedInputMicros",
                m.cache_write_micros as "cacheWriteMicros", m.vision, m.context_window as "contextWindow",
                m.max_output_tokens as "maxOutputTokens", m.reasoning_effort as "reasoningEffort", m.role,
                m.tested_at as "testedAt", m.tested_ok as "testedOk", m.tested_note as "testedNote"
           from model_choices m join model_services s on s.id = m.service_id and s.deleted_at is null
          where m.org_id = $1 and m.deleted_at is null order by s.name, m.model, m.created_at`,
        [org(c)],
      ),
    ]);
    return c.json({
      canSeal: settings.canSeal,
      canManage: !need(c, "settings.manage"),
      source: settings.source,
      problem: settings.problem,
      // What agents run on at this moment, and what the server's own settings name.
      inEffect: shown(settings.current()),
      env: shown(settings.env),
      services,
      models: choices.map((row) => ({
        ...row,
        inputMicros: Number(row.inputMicros),
        outputMicros: Number(row.outputMicros),
        cachedInputMicros: row.cachedInputMicros === null ? null : Number(row.cachedInputMicros),
        cacheWriteMicros: row.cacheWriteMicros === null ? null : Number(row.cacheWriteMicros),
      })),
    });
  });

  const saveService = async (c: Ctx, id: string | null) => {
    const denied = need(c, "settings.manage");
    if (denied) return denied;
    const parsed = ServiceBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, "invalid_model");
    const body = parsed.data;
    const address = addressOf(body.baseUrl);
    if (!address) return fail(c, "invalid_model");
    if (body.key !== undefined && !KEY.test(body.key)) return fail(c, "invalid_model_key");
    if (body.key && !settings.canSeal) return fail(c, "model_unsealed");
    const serviceId = id ?? newId();
    return applied(
      await inTx(c, async (tx) => {
        if (id) {
          const kept = (
            await tx.query<{ base_url: string; has: boolean }>(
              `select base_url, (key_sealed is not null) as has from model_services
                where id = $1 and org_id = $2 and deleted_at is null for update`,
              [id, org(c)],
            )
          )[0];
          if (!kept) throw new Refusal("not_found");
          // A key was entered for one address. It is not sent to another.
          if (kept.has && kept.base_url !== address && body.key === undefined)
            throw new Refusal("model_key_again");
          await tx.query(
            "update model_services set name = $3, api = $4, base_url = $5, updated_at = now() where id = $1 and org_id = $2",
            [id, org(c), body.name, body.api, address],
          );
        } else
          await tx.query(
            "insert into model_services (id, org_id, name, api, base_url) values ($1, $2, $3, $4, $5)",
            [serviceId, org(c), body.name, body.api, address],
          );
        if (body.key !== undefined)
          await tx.query(
            "update model_services set key_sealed = $2, key_tail = $3, key_set_at = now() where id = $1",
            [
              serviceId,
              settings.seal(body.key),
              // Four characters of a long key tell keys apart and give nothing away.
              body.key.length >= 20 ? body.key.slice(-4) : "",
            ],
          );
        await recordEvent(tx, {
          orgId: org(c),
          actor: actorOf(c),
          action: id ? "model_service.changed" : "model_service.created",
          target: { type: "model_service", id: serviceId, label: body.name },
          // Where it is and how it is spoken to, never the key.
          detail: { api: body.api, host: host(address), keyChanged: body.key !== undefined },
          ip: clientIp(c),
        });
        return c.json({ id: serviceId });
      }),
    );
  };
  app.post("/api/models/services", (c) => saveService(c, null));
  app.patch("/api/models/services/:id", (c) => {
    const id = c.req.param("id");
    return isId(id) ? saveService(c, id) : Promise.resolve(fail(c, "not_found"));
  });
  app.delete("/api/models/services/:id", async (c) => {
    const denied = need(c, "settings.manage");
    if (denied) return denied;
    const id = c.req.param("id");
    if (!isId(id)) return fail(c, "not_found");
    return inTx(c, async (tx) => {
      const service = (
        await tx.query<{ name: string }>(
          "select name from model_services where id = $1 and org_id = $2 and deleted_at is null for update",
          [id, org(c)],
        )
      )[0];
      if (!service) throw new Refusal("not_found");
      const used = await tx.query(
        "select 1 from model_choices where service_id = $1 and deleted_at is null limit 1",
        [id],
      );
      if (used.length > 0) throw new Refusal("model_service_in_use");
      // The key goes with it: nothing sealed is kept for a service that is gone.
      await tx.query(
        "update model_services set deleted_at = now(), key_sealed = null, key_tail = '' where id = $1",
        [id],
      );
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "model_service.removed",
        target: { type: "model_service", id, label: service.name },
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    });
  });

  const saveChoice = async (c: Ctx, id: string | null) => {
    const denied = need(c, "settings.manage");
    if (denied) return denied;
    const parsed = ChoiceBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, "invalid_model");
    const body = parsed.data;
    const choiceId = id ?? newId();
    return applied(
      await inTx(c, async (tx) => {
        const service = (
          await tx.query<{ name: string }>(
            "select name from model_services where id = $1 and org_id = $2 and deleted_at is null",
            [body.serviceId, org(c)],
          )
        )[0];
        if (!service) throw new Refusal("invalid_model");
        const values = [
          body.serviceId,
          body.model,
          body.inputMicros,
          body.outputMicros,
          body.cachedInputMicros,
          body.cacheWriteMicros,
          body.vision,
          body.contextWindow,
          body.maxOutputTokens,
          body.reasoningEffort,
        ];
        if (id) {
          const kept = (
            await tx.query<{ service_id: string; model: string }>(
              "select service_id, model from model_choices where id = $1 and org_id = $2 and deleted_at is null for update",
              [id, org(c)],
            )
          )[0];
          if (!kept) throw new Refusal("not_found");
          // A test was of one model at one service: it says nothing of another.
          const same = kept.service_id === body.serviceId && kept.model === body.model;
          await tx.query(
            `update model_choices set service_id = $3, model = $4, input_micros = $5, output_micros = $6,
                    cached_input_micros = $7, cache_write_micros = $8, vision = $9,
                    context_window = $10, max_output_tokens = $11, reasoning_effort = $12, updated_at = now(),
                    tested_at = case when $13 then tested_at end, tested_ok = case when $13 then tested_ok end,
                    tested_note = case when $13 then tested_note end
              where id = $1 and org_id = $2`,
            [id, org(c), ...values, same],
          );
        } else
          await tx.query(
            `insert into model_choices (id, org_id, service_id, model, input_micros, output_micros,
                                        cached_input_micros, cache_write_micros, vision,
                                        context_window, max_output_tokens, reasoning_effort)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [choiceId, org(c), ...values],
          );
        await recordEvent(tx, {
          orgId: org(c),
          actor: actorOf(c),
          action: id ? "model.changed" : "model.created",
          target: { type: "model", id: choiceId, label: body.model },
          detail: {
            service: service.name,
            inputMicros: body.inputMicros,
            outputMicros: body.outputMicros,
            cachedInputMicros: body.cachedInputMicros,
            cacheWriteMicros: body.cacheWriteMicros,
            vision: body.vision,
          },
          ip: clientIp(c),
        });
        return c.json({ id: choiceId });
      }),
    );
  };
  app.post("/api/models/choices", (c) => saveChoice(c, null));
  app.patch("/api/models/choices/:id", (c) => {
    const id = c.req.param("id");
    return isId(id) ? saveChoice(c, id) : Promise.resolve(fail(c, "not_found"));
  });
  app.delete("/api/models/choices/:id", async (c) => {
    const denied = need(c, "settings.manage");
    if (denied) return denied;
    const id = c.req.param("id");
    if (!isId(id)) return fail(c, "not_found");
    return inTx(c, async (tx) => {
      const choice = (
        await tx.query<{ model: string; role: string | null }>(
          "select model, role from model_choices where id = $1 and org_id = $2 and deleted_at is null for update",
          [id, org(c)],
        )
      )[0];
      if (!choice) throw new Refusal("not_found");
      // What agents run on is changed by choosing another, not by its going missing.
      if (choice.role) throw new Refusal("model_in_use");
      await tx.query("update model_choices set deleted_at = now() where id = $1", [id]);
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "model.removed",
        target: { type: "model", id, label: choice.model },
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    });
  });

  // Which model agents run on, and which is asked when it cannot answer. Both at once, so
  // the two are never the same model for a moment. `first: null` goes back to the server's settings.
  app.put("/api/models/roles", async (c) => {
    const denied = need(c, "settings.manage");
    if (denied) return denied;
    const parsed = RolesBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, "invalid_model");
    const { first, second } = parsed.data;
    if ((second && !first) || (first && first === second)) return fail(c, "invalid_model");
    return applied(
      await inTx(c, async (tx) => {
        const wanted = [first, second].filter((id): id is string => Boolean(id));
        const found = await tx.query<{ id: string; model: string; has: boolean }>(
          `select m.id, m.model, (s.key_sealed is not null) as has
             from model_choices m join model_services s on s.id = m.service_id and s.deleted_at is null
            where m.org_id = $1 and m.deleted_at is null and m.id = any($2::uuid[]) for update of m`,
          [org(c), wanted],
        );
        if (found.length !== wanted.length) throw new Refusal("not_found");
        // A model whose service has no key cannot answer anyone.
        if (found.some((row) => !row.has)) throw new Refusal("model_no_key");
        const before = await tx.query<{ model: string; role: string }>(
          "select model, role from model_choices where role is not null and deleted_at is null",
        );
        await tx.query("update model_choices set role = null where role is not null");
        if (first) await tx.query("update model_choices set role = 'first' where id = $1", [first]);
        if (second)
          await tx.query("update model_choices set role = 'second' where id = $1", [second]);
        const name = (id: string | null) => found.find((row) => row.id === id)?.model ?? null;
        await recordEvent(tx, {
          orgId: org(c),
          actor: actorOf(c),
          action: "model.chosen",
          detail: {
            first: name(first),
            second: name(second),
            before: {
              first: before.find((row) => row.role === "first")?.model ?? null,
              second: before.find((row) => row.role === "second")?.model ?? null,
            },
            // What holds when nothing is chosen here.
            ...(first ? {} : { serverSettings: settings.env?.id ?? null }),
          },
          ip: clientIp(c),
        });
        return c.json({ ok: true });
      }),
    );
  });

  // One small question to the model, with the key that is kept: does it answer?
  app.post("/api/models/choices/:id/test", async (c) => {
    const denied = need(c, "settings.manage");
    if (denied) return denied;
    const id = c.req.param("id");
    if (!isId(id)) return fail(c, "not_found");
    const choice = (
      await db.query<{ model: string }>(
        "select model from model_choices where id = $1 and org_id = $2 and deleted_at is null",
        [id, org(c)],
      )
    )[0];
    if (!choice) return fail(c, "not_found");
    const result = await settings.test(id);
    if (!result) return fail(c, "not_found");
    await db.tx(async (tx) => {
      await tx.query(
        "update model_choices set tested_at = now(), tested_ok = $2, tested_note = $3 where id = $1",
        [id, result.ok, result.code],
      );
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "model.tested",
        target: { type: "model", id, label: choice.model },
        detail: { ok: result.ok, result: result.code, status: result.status },
        ip: clientIp(c),
      });
    });
    return c.json(result);
  });
}
