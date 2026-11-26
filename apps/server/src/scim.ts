/**
 * SCIM 2.0 (RFC 7643, 7644), the part the company's directory uses to say who is in the
 * organization: Microsoft Entra ID and Okta were read for what they send. People are
 * Users; departments are Groups. docs/features/platform.md, "Provisioning".
 *
 * The directory acts with a token an administrator made in the console (sso.ts). What it
 * does here is what an administrator does on the members page, by the same rules: taking
 * someone's access away suspends or removes them, ends their sessions and what their
 * agents were doing, and deletes nothing of theirs; the last owner is never taken out.
 * Every change is on the activity log as made through SCIM.
 */
import { createHash } from "node:crypto";
import { isId, newId } from "@muster/protocol";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppKit, Env } from "./app.js";
import { recordEvent } from "./audit.js";
import { revokeSessionsOfUser } from "./auth/session.js";
import type { Config } from "./config.js";
import type { Db, Queryable } from "./db.js";

const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
const LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";

/** How many requests one token may make in a minute. A directory's full sync stays well under. */
export const SCIM_PER_MINUTE = 600;
const PAGE = 100;
const MOST = 200;
const START_MOST = 1_000_000;

class ScimError extends Error {
  constructor(
    readonly status: number,
    detail: string,
    readonly scimType?: string,
  ) {
    super(detail);
  }
}

interface Who {
  orgId: string;
  tokenId: string;
  tail: string;
  ip: string | null;
}
type Status = "active" | "suspended" | "removed";
type Person = {
  id: string;
  email: string;
  name: string;
  status: Status;
  role: string;
  joinedAt: Date;
  externalId: string | null;
  /** They have signed in at some time: their address is how they are known. */
  signedIn: boolean;
};

/** Printable ASCII only, as at sign-in: folding other scripts can turn one address into another. */
const address = (value: unknown): string => {
  if (typeof value !== "string" || !/^[\x21-\x7e]+@[\x21-\x7e]+$/.test(value.trim()))
    throw new ScimError(400, "userName must be a mail address.", "invalidValue");
  return value.trim().toLowerCase();
};
const words = (value: unknown, most: number): string | undefined =>
  typeof value === "string"
    ? // One line of plain text: no control characters.
      [...value]
        .filter((ch) => ch >= " " && ch !== "\u007f")
        .join("")
        .trim()
        .slice(0, most)
    : undefined;
/** Entra sends "False" where the standard says false. */
const truth = (value: unknown): boolean | undefined =>
  typeof value === "boolean"
    ? value
    : typeof value === "string" && /^(true|false)$/i.test(value)
      ? value.toLowerCase() === "true"
      : undefined;

export function registerScim(app: Hono<Env>, kit: AppKit, db: Db, config: Config): void {
  const base = `${config.publicUrl}/scim/v2`;
  const hits = new Map<string, { since: number; n: number }>();
  const auth = new WeakMap<Context, Who>();
  const who = (c: Context) => auth.get(c) as Who;

  const answer = (c: Context, status: number, value: unknown) =>
    c.body(JSON.stringify(value), status as 200, {
      "content-type": "application/scim+json; charset=utf-8",
      "cache-control": "no-store",
    });
  const refuse = (c: Context, status: number, detail: string, scimType?: string) =>
    answer(c, status, {
      schemas: [ERROR],
      status: String(status),
      ...(scimType ? { scimType } : {}),
      detail,
    });

  app.use(
    "/scim/v2/*",
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) => refuse(c, 413, "That is too much to send at once."),
    }),
  );
  app.use("/scim/v2/*", async (c, next) => {
    const token = c.req.header("authorization")?.match(/^Bearer (.+)$/)?.[1];
    const row = token
      ? (
          await db.query<{ id: string; orgId: string; tail: string; stale: boolean }>(
            `select id, org_id as "orgId", tail,
                    (last_used_at is null or last_used_at < now() - interval '1 minute') as stale
               from scim_tokens where token_hash = $1 and revoked_at is null`,
            [createHash("sha256").update(token).digest("hex")],
          )
        )[0]
      : undefined;
    if (!row) {
      c.header("www-authenticate", 'Bearer realm="scim"');
      return refuse(c, 401, "A provisioning token is needed.");
    }
    const now = Date.now();
    const hit = hits.get(row.id);
    if (!hit || now - hit.since >= 60_000) hits.set(row.id, { since: now, n: 1 });
    else if (++hit.n > SCIM_PER_MINUTE) {
      c.header("retry-after", String(Math.ceil((hit.since + 60_000 - now) / 1000)));
      return refuse(c, 429, "Too many requests. Try again shortly.");
    }
    if (row.stale)
      await db.query("update scim_tokens set last_used_at = now() where id = $1", [row.id]);
    auth.set(c, { orgId: row.orgId, tokenId: row.id, tail: row.tail, ip: kit.clientIp(c) });
    try {
      await next();
    } catch (error) {
      if (error instanceof ScimError) {
        c.res = refuse(c, error.status, error.message, error.scimType);
        return;
      }
      throw error;
    }
  });
  // Hono hands a thrown error to the app's handler before the middleware above sees it.
  const guarded =
    (fn: (c: Context) => Promise<Response>) =>
    async (c: Context): Promise<Response> => {
      try {
        return await fn(c);
      } catch (error) {
        if (error instanceof ScimError)
          return refuse(c, error.status, error.message, error.scimType);
        throw error;
      }
    };
  const bodyOf = async (c: Context): Promise<Record<string, unknown>> => {
    const value = await c.req.json().catch(() => null);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ScimError(400, "The body must be a JSON object.", "invalidSyntax");
    // Text no database column holds.
    if (JSON.stringify(value).includes("\\u0000"))
      throw new ScimError(400, "The body holds a character that cannot be kept.", "invalidValue");
    return value as Record<string, unknown>;
  };
  const record = (
    tx: Queryable,
    c: Context,
    action: string,
    target: { type: string; id: string; label: string },
    detail: Record<string, unknown> = {},
  ) =>
    recordEvent(tx, {
      orgId: who(c).orgId,
      actor: { userId: null, email: "scim" },
      action,
      target,
      detail: { ...detail, via: "scim", token: `…${who(c).tail}` },
      ip: who(c).ip,
    });
  const paging = (c: Context) => {
    const whole = (name: string, otherwise: number) => {
      const raw = c.req.query(name);
      if (raw === undefined) return otherwise;
      if (!/^-?\d{1,9}$/.test(raw.trim()))
        throw new ScimError(400, `${name} is a whole number.`, "invalidValue");
      return Number(raw);
    };
    // Below 1 is 1, as the standard says; and no further in than anyone has people.
    const start = Math.min(START_MOST, Math.max(1, whole("startIndex", 1)));
    return { start, count: Math.min(MOST, Math.max(0, whole("count", PAGE))) };
  };
  /** One at a time for an organization: the count of owners and the change agree. */
  const alone = (tx: Queryable, orgId: string) =>
    tx.query("select 1 from organizations where id = $1 for update", [orgId]);
  /** Whether an address is in a domain the organization has named as its own. */
  const ours = async (tx: Queryable, orgId: string, email: string) =>
    (
      await tx.query("select 1 from org_domains where org_id = $1 and domain = $2", [
        orgId,
        email.slice(email.lastIndexOf("@") + 1),
      ])
    ).length > 0;
  const OUTSIDE =
    "This address is not in a domain of the organization. Add the domain under Sign-in first.";
  /**
   * Whether it was the directory that last took this person's access away. Only then may
   * the directory give it back: someone an administrator suspended or removed stays so
   * until an administrator says otherwise. Read from the activity log, which is only
   * ever added to; where it no longer says, the answer is no.
   */
  const ownDoing = async (tx: Queryable, orgId: string, id: string) => {
    const last = (
      await tx.query<{ action: string; via: string | null }>(
        `select action, detail->>'via' as via from admin_events
          where org_id = $1 and target_type = 'member' and target_id = $2
            and action in ('member.suspended', 'member.removed', 'member.reactivated', 'member.joined')
          order by seq desc limit 1`,
        [orgId, id],
      )
    )[0];
    return last?.via === "scim" && last.action !== "member.reactivated";
  };
  const NOT_THE_DIRECTORYS =
    "An administrator took this person's access away. Only an administrator gives it back.";
  /** Owners, administrators and the other roles are an owner's to manage, in Muster. */
  const RESERVED = "This person's role is managed in Muster, not by the directory.";
  /** `attribute eq "value"`, the one kind of filter the directories send. */
  const filterOf = (c: Context, allowed: string[]) => {
    const raw = c.req.query("filter");
    if (!raw) return null;
    const match = /^\s*([A-Za-z.]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(raw);
    const name = allowed.find((one) => one.toLowerCase() === match?.[1]?.toLowerCase());
    if (!match || !name) throw new ScimError(400, "This filter is not supported.", "invalidFilter");
    return { name, value: (match[2] as string).replace(/\\(.)/g, "$1") };
  };

  // ---- what this server speaks ----

  app.get("/scim/v2/ServiceProviderConfig", (c) =>
    answer(c, 200, {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: MOST },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: "oauthbearertoken",
          name: "Bearer token",
          description: "A token made in Muster's console, under Sign-in.",
        },
      ],
      meta: { resourceType: "ServiceProviderConfig", location: `${base}/ServiceProviderConfig` },
    }),
  );
  const TYPES = [
    { id: "User", name: "User", endpoint: "/Users", schema: USER },
    { id: "Group", name: "Group", endpoint: "/Groups", schema: GROUP },
  ].map((type) => ({
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
    ...type,
    meta: { resourceType: "ResourceType", location: `${base}/ResourceTypes/${type.id}` },
  }));
  const attribute = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    type: "string",
    multiValued: false,
    required: false,
    caseExact: false,
    mutability: "readWrite",
    returned: "default",
    uniqueness: "none",
    ...extra,
  });
  const SCHEMAS = [
    {
      id: USER,
      name: "User",
      attributes: [
        attribute("userName", { required: true, uniqueness: "server" }),
        attribute("displayName"),
        attribute("active", { type: "boolean" }),
        attribute("externalId", { caseExact: true }),
        attribute("name", {
          type: "complex",
          subAttributes: [attribute("formatted"), attribute("givenName"), attribute("familyName")],
        }),
        attribute("emails", {
          type: "complex",
          multiValued: true,
          subAttributes: [attribute("value"), attribute("primary", { type: "boolean" })],
        }),
      ],
    },
    {
      id: GROUP,
      name: "Group",
      attributes: [
        attribute("displayName", { required: true, uniqueness: "server" }),
        attribute("externalId", { caseExact: true }),
        attribute("members", {
          type: "complex",
          multiValued: true,
          subAttributes: [attribute("value"), attribute("display", { mutability: "readOnly" })],
        }),
      ],
    },
  ].map((schema) => ({
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"],
    ...schema,
    meta: { resourceType: "Schema", location: `${base}/Schemas/${schema.id}` },
  }));
  const listOf = (c: Context, all: unknown[]) =>
    answer(c, 200, {
      schemas: [LIST],
      totalResults: all.length,
      startIndex: 1,
      itemsPerPage: all.length,
      Resources: all,
    });
  app.get("/scim/v2/ResourceTypes", (c) => listOf(c, TYPES));
  app.get("/scim/v2/Schemas", (c) => listOf(c, SCHEMAS));

  // ---- people ----

  const PERSON = `select u.id, u.email, u.name, m.status, m.role, m.joined_at as "joinedAt",
      (u.last_login_at is not null or exists (select 1 from identities i where i.user_id = u.id)) as "signedIn",
      (select s.external_id from scim_ids s where s.org_id = m.org_id and s.kind = 'user' and s.id = u.id) as "externalId"
    from memberships m join users u on u.id = m.user_id`;
  /** Someone removed is no longer the directory's to see: asking for them finds nothing. */
  const personOf = async (tx: Queryable, orgId: string, id: string, lock = false) =>
    isId(id)
      ? ((
          await tx.query<Person>(
            `${PERSON} where m.org_id = $1 and u.id = $2 and m.status <> 'removed'${lock ? " for update of m" : ""}`,
            [orgId, id],
          )
        )[0] ?? null)
      : null;
  const userOf = (person: Person) => ({
    schemas: [USER],
    id: person.id,
    ...(person.externalId ? { externalId: person.externalId } : {}),
    userName: person.email,
    displayName: person.name,
    name: { formatted: person.name },
    emails: [{ value: person.email, primary: true }],
    active: person.status === "active",
    meta: {
      resourceType: "User",
      created: person.joinedAt,
      location: `${base}/Users/${person.id}`,
    },
  });
  const nameIn = (value: Record<string, unknown>): string | undefined => {
    const name = (value.name ?? {}) as Record<string, unknown>;
    return (
      words(value.displayName, 200) ||
      words(name.formatted, 200) ||
      [words(name.givenName, 100), words(name.familyName, 100)].filter(Boolean).join(" ") ||
      undefined
    );
  };
  const setExternal = async (
    tx: Queryable,
    orgId: string,
    kind: "user" | "group",
    id: string,
    externalId: unknown,
  ) => {
    const value = words(externalId, 256);
    if (!value) return;
    await tx.query(
      `insert into scim_ids (org_id, kind, id, external_id) values ($1, $2, $3, $4)
       on conflict (org_id, kind, id) do update set external_id = excluded.external_id`,
      [orgId, kind, id, value],
    );
  };
  const keepAnOwner = async (tx: Queryable, orgId: string, person: Person) => {
    if (person.role !== "owner" || person.status !== "active") return;
    const others = await tx.query(
      "select 1 from memberships where org_id = $1 and role = 'owner' and status = 'active' and user_id <> $2 limit 1",
      [orgId, person.id],
    );
    if (others.length === 0)
      throw new ScimError(409, "The organization must keep at least one owner.", "mutability");
  };
  /** Makes a person what the directory says they are. Returns whether their access ended. */
  const change = async (
    tx: Queryable,
    c: Context,
    person: Person,
    to: { email?: string; name?: string; active?: boolean; externalId?: unknown },
  ): Promise<boolean> => {
    const { orgId } = who(c);
    const target = { type: "member", id: person.id, label: person.email };
    let blocked = false;
    const changes =
      (to.email !== undefined && to.email !== person.email) ||
      (to.name !== undefined && to.name !== person.name) ||
      (to.active !== undefined && to.active !== (person.status === "active"));
    // Saying again what is already so changes nothing and is let through.
    if (changes && person.role !== "member") throw new ScimError(403, RESERVED, "mutability");
    if (to.email !== undefined && to.email !== person.email) {
      if (!(await ours(tx, orgId, to.email))) throw new ScimError(400, OUTSIDE, "invalidValue");
      // Someone who has signed in is known by their address. It changes only where the
      // organization's own provider says who they are, whatever their address.
      if (
        person.signedIn &&
        (await tx.query("select 1 from saml_settings where org_id = $1 and enabled", [orgId]))
          .length === 0
      )
        throw new ScimError(
          403,
          "This person has signed in: their address is changed in Muster, or once single sign-on is on.",
          "mutability",
        );
      const taken = await tx.query("select 1 from users where email = $1 and id <> $2", [
        to.email,
        person.id,
      ]);
      if (taken.length > 0)
        throw new ScimError(409, "This address already belongs to someone.", "uniqueness");
      await tx.query("update users set email = $2 where id = $1", [person.id, to.email]);
      await record(tx, c, "member.address_changed", target, { from: person.email, to: to.email });
    }
    if (to.name !== undefined && to.name !== person.name)
      await tx.query("update users set name = $2 where id = $1", [person.id, to.name]);
    if (to.active !== undefined && to.active !== (person.status === "active")) {
      if (!to.active) await keepAnOwner(tx, orgId, person);
      else if (!(await ownDoing(tx, orgId, person.id)))
        throw new ScimError(403, NOT_THE_DIRECTORYS, "mutability");
      await tx.query("update memberships set status = $3 where org_id = $1 and user_id = $2", [
        orgId,
        person.id,
        to.active ? "active" : "suspended",
      ]);
      if (to.active) await record(tx, c, "member.reactivated", target, { from: person.status });
      else {
        const ended = await revokeSessionsOfUser(tx, person.id);
        await record(tx, c, "member.suspended", target, { sessionsEnded: ended });
        blocked = true;
      }
    }
    await setExternal(tx, orgId, "user", person.id, to.externalId);
    return blocked;
  };

  app.get(
    "/scim/v2/Users",
    guarded(async (c) => {
      const { orgId } = who(c);
      const filter = filterOf(c, ["userName", "externalId"]);
      const { start, count } = paging(c);
      const where =
        filter?.name === "userName"
          ? "and u.email = $2"
          : filter
            ? "and exists (select 1 from scim_ids s where s.org_id = m.org_id and s.kind = 'user' and s.id = u.id and s.external_id = $2)"
            : "";
      const args = filter
        ? [orgId, filter.name === "userName" ? filter.value.toLowerCase() : filter.value]
        : [orgId];
      const from = `where m.org_id = $1 and m.status <> 'removed' ${where}`;
      const total = Number(
        (
          await db.query<{ n: string }>(
            `select count(*) as n from memberships m join users u on u.id = m.user_id ${from}`,
            args,
          )
        )[0]?.n ?? 0,
      );
      const rows = await db.query<Person>(
        `${PERSON} ${from} order by m.joined_at, u.id limit ${count} offset ${start - 1}`,
        args,
      );
      return answer(c, 200, {
        schemas: [LIST],
        totalResults: total,
        startIndex: start,
        itemsPerPage: rows.length,
        Resources: rows.map(userOf),
      });
    }),
  );

  app.get(
    "/scim/v2/Users/:id",
    guarded(async (c) => {
      const person = await personOf(db, who(c).orgId, c.req.param("id") ?? "");
      if (!person) throw new ScimError(404, "There is no such user.");
      return answer(c, 200, userOf(person));
    }),
  );

  app.post(
    "/scim/v2/Users",
    guarded(async (c) => {
      const { orgId } = who(c);
      const value = await bodyOf(c);
      const email = address(value.userName);
      const active = truth(value.active) ?? true;
      const made = await db.tx(async (tx) => {
        await alone(tx, orgId);
        // Before anything is looked up: an address outside the organization's domains is
        // answered the same whether or not somebody anywhere has it.
        if (!(await ours(tx, orgId, email))) throw new ScimError(400, OUTSIDE, "invalidValue");
        await tx.query(
          "insert into users (id, email, name) values ($1, $2, $3) on conflict (email) do nothing",
          [newId(), email, nameIn(value) ?? ""],
        );
        const id = (
          await tx.query<{ id: string }>("select id from users where email = $1", [email])
        )[0]?.id as string;
        const held = (
          await tx.query<{ orgId: string; status: Status }>(
            `select org_id as "orgId", status from memberships where user_id = $1 for update`,
            [id],
          )
        )[0];
        // Already in, here or in another organization: one person, one place.
        if (held && (held.orgId !== orgId || held.status !== "removed"))
          throw new ScimError(409, "This address already belongs to a member.", "uniqueness");
        // Someone the directory itself removed comes back when it says so. Someone an
        // administrator removed does not.
        if (held && !(await ownDoing(tx, orgId, id)))
          throw new ScimError(409, NOT_THE_DIRECTORYS, "uniqueness");
        await tx.query(
          `insert into memberships (org_id, user_id, role, joined_via, status)
           values ($1, $2, 'member', 'scim', $3)
           on conflict (user_id) do update set status = excluded.status, role = 'member',
             department_id = null, joined_via = 'scim', joined_at = now()`,
          [orgId, id, active ? "active" : "suspended"],
        );
        const name = nameIn(value);
        if (name) await tx.query("update users set name = $2 where id = $1", [id, name]);
        await setExternal(tx, orgId, "user", id, value.externalId);
        await record(
          tx,
          c,
          held ? "member.reactivated" : "member.joined",
          { type: "member", id, label: email },
          held ? { from: "removed" } : { role: "member" },
        );
        return (await personOf(tx, orgId, id)) as Person;
      });
      c.header("location", `${base}/Users/${made.id}`);
      return answer(c, 201, userOf(made));
    }),
  );

  /** One step of a PATCH as the attributes it sets. What is not understood is left alone. */
  const stepOf = (operation: Record<string, unknown>): Record<string, unknown> => {
    const op = String(operation.op ?? "").toLowerCase();
    if (!["add", "replace", "remove"].includes(op))
      throw new ScimError(400, "An operation is add, replace or remove.", "invalidSyntax");
    const path = typeof operation.path === "string" ? operation.path.trim() : "";
    if (!path) {
      if (op === "remove") throw new ScimError(400, "remove needs a path.", "noTarget");
      const value = operation.value;
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new ScimError(400, "Without a path, the value is an object.", "invalidValue");
      return value as Record<string, unknown>;
    }
    // "urn:…:User:active" is "active".
    const plain = path.startsWith(`${USER}:`) ? path.slice(USER.length + 1) : path;
    const value = op === "remove" ? undefined : operation.value;
    const key = plain.toLowerCase();
    if (key === "active") return { active: op === "remove" ? false : value };
    if (key === "username") return { userName: value };
    if (key === "displayname") return { displayName: value };
    if (key === "externalid") return { externalId: value };
    if (key === "name.formatted") return { name: { formatted: value } };
    if (key === "name.givenname") return { name: { givenName: value } };
    if (key === "name.familyname") return { name: { familyName: value } };
    if (key === "name" && value && typeof value === "object") return { name: value };
    return {};
  };

  const update = (replace: boolean) =>
    guarded(async (c) => {
      const { orgId } = who(c);
      const value = await bodyOf(c);
      let set: Record<string, unknown> = {};
      if (replace) set = value;
      else {
        const schemas = Array.isArray(value.schemas) ? value.schemas : [];
        if (!schemas.includes(PATCH) || !Array.isArray(value.Operations))
          throw new ScimError(400, "This is not a patch.", "invalidSyntax");
        for (const operation of value.Operations.slice(0, 50)) {
          const step = stepOf((operation ?? {}) as Record<string, unknown>);
          // A given name and a family name arrive in two steps and are one name.
          const name = { ...(set.name as object), ...(step.name as object) };
          set = { ...set, ...step, ...(Object.keys(name).length ? { name } : {}) };
        }
      }
      const result = await db.tx(async (tx) => {
        await alone(tx, orgId);
        const person = await personOf(tx, orgId, c.req.param("id") ?? "", true);
        if (!person) throw new ScimError(404, "There is no such user.");
        const active = truth(set.active);
        if (set.active !== undefined && active === undefined)
          throw new ScimError(400, "active is true or false.", "invalidValue");
        const blocked = await change(tx, c, person, {
          ...(set.userName !== undefined ? { email: address(set.userName) } : {}),
          ...(nameIn(set) !== undefined ? { name: nameIn(set) } : {}),
          // Replacing someone without saying they are active leaves them as they are.
          ...(active !== undefined ? { active } : {}),
          externalId: set.externalId,
        });
        return { person: (await personOf(tx, orgId, person.id)) as Person, blocked };
      });
      // What they had in progress ends with their access, as when an administrator does it.
      if (result.blocked) await kit.memberBlocked(result.person.id);
      return answer(c, 200, userOf(result.person));
    });
  app.put("/scim/v2/Users/:id", update(true));
  app.patch("/scim/v2/Users/:id", update(false));

  // Deleting someone in the directory removes them from the organization. Nothing of
  // theirs is deleted: how long that is kept is the organization's own decision.
  app.delete(
    "/scim/v2/Users/:id",
    guarded(async (c) => {
      const { orgId } = who(c);
      const id = await db.tx(async (tx) => {
        await alone(tx, orgId);
        const person = await personOf(tx, orgId, c.req.param("id") ?? "", true);
        if (!person) throw new ScimError(404, "There is no such user.");
        if (person.role !== "member") throw new ScimError(403, RESERVED, "mutability");
        await keepAnOwner(tx, orgId, person);
        const ended = await revokeSessionsOfUser(tx, person.id);
        await tx.query(
          "update memberships set status = 'removed', role = 'member', department_id = null where org_id = $1 and user_id = $2",
          [orgId, person.id],
        );
        await tx.query("delete from scim_ids where org_id = $1 and kind = 'user' and id = $2", [
          orgId,
          person.id,
        ]);
        await record(
          tx,
          c,
          "member.removed",
          { type: "member", id: person.id, label: person.email },
          {
            role: person.role,
            sessionsEnded: ended,
          },
        );
        return person.id;
      });
      await kit.memberBlocked(id);
      return c.body(null, 204);
    }),
  );

  // ---- departments ----

  type Department = {
    id: string;
    name: string;
    createdAt: Date;
    externalId: string | null;
  };
  const DEPARTMENT = `select d.id, d.name, d.created_at as "createdAt",
      (select s.external_id from scim_ids s where s.org_id = d.org_id and s.kind = 'group' and s.id = d.id) as "externalId"
    from departments d`;
  const departmentOf = async (tx: Queryable, orgId: string, id: string, lock = false) =>
    isId(id)
      ? ((
          await tx.query<Department>(
            `${DEPARTMENT} where d.org_id = $1 and d.id = $2${lock ? " for update of d" : ""}`,
            [orgId, id],
          )
        )[0] ?? null)
      : null;
  const groupOf = async (tx: Queryable, orgId: string, department: Department, bare = false) => ({
    schemas: [GROUP],
    id: department.id,
    ...(department.externalId ? { externalId: department.externalId } : {}),
    displayName: department.name,
    ...(bare
      ? {}
      : {
          members: (
            await tx.query<{ id: string; email: string }>(
              `select u.id, u.email from memberships m join users u on u.id = m.user_id
                where m.org_id = $1 and m.department_id = $2 and m.status <> 'removed' order by u.email`,
              [orgId, department.id],
            )
          ).map((member) => ({
            value: member.id,
            display: member.email,
            $ref: `${base}/Users/${member.id}`,
          })),
        }),
    meta: {
      resourceType: "Group",
      created: department.createdAt,
      location: `${base}/Groups/${department.id}`,
    },
  });
  const bare = (c: Context) =>
    (c.req.query("excludedAttributes") ?? "")
      .split(",")
      .some((one) => one.trim().toLowerCase() === "members");
  const departmentName = (value: unknown): string => {
    const name = words(value, 200);
    if (!name || name.length > 60)
      throw new ScimError(400, "A department name needs 1 to 60 characters.", "invalidValue");
    return name;
  };
  const idsIn = (value: unknown): string[] =>
    (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value])
      .map((one) => (one && typeof one === "object" ? (one as { value?: unknown }).value : one))
      .filter((one): one is string => typeof one === "string" && isId(one))
      .slice(0, 5000);
  /** Puts people in a department, or takes them out of it: a person is in one at most. */
  const place = async (
    tx: Queryable,
    c: Context,
    department: Department,
    ids: string[],
    into: boolean,
  ) => {
    const { orgId } = who(c);
    if (ids.length === 0) return;
    const moved = await tx.query<{ id: string; email: string }>(
      into
        ? `update memberships m set department_id = $2 from users u
            where u.id = m.user_id and m.org_id = $1 and m.user_id = any($3::uuid[])
              and m.status <> 'removed' and m.department_id is distinct from $2
            returning u.id, u.email`
        : `update memberships m set department_id = null from users u
            where u.id = m.user_id and m.org_id = $1 and m.user_id = any($3::uuid[]) and m.department_id = $2
            returning u.id, u.email`,
      [orgId, department.id, ids],
    );
    for (const person of moved)
      await record(
        tx,
        c,
        "member.department_changed",
        { type: "member", id: person.id, label: person.email },
        into ? { to: department.name } : { from: department.name, to: null },
      );
  };
  const rename = async (tx: Queryable, c: Context, department: Department, name: string) => {
    const { orgId } = who(c);
    if (name === department.name) return;
    const clash = await tx.query(
      "select 1 from departments where org_id = $1 and name = $2 and id <> $3",
      [orgId, name, department.id],
    );
    if (clash.length > 0)
      throw new ScimError(409, "A department with this name already exists.", "uniqueness");
    await tx.query("update departments set name = $3 where id = $1 and org_id = $2", [
      department.id,
      orgId,
      name,
    ]);
    await record(
      tx,
      c,
      "department.renamed",
      { type: "department", id: department.id, label: name },
      { from: department.name, to: name },
    );
  };

  app.get(
    "/scim/v2/Groups",
    guarded(async (c) => {
      const { orgId } = who(c);
      const filter = filterOf(c, ["displayName", "externalId"]);
      const { start, count } = paging(c);
      const where =
        filter?.name === "displayName"
          ? "and d.name = $2"
          : filter
            ? "and exists (select 1 from scim_ids s where s.org_id = d.org_id and s.kind = 'group' and s.id = d.id and s.external_id = $2)"
            : "";
      const args = filter ? [orgId, filter.value] : [orgId];
      const total = Number(
        (
          await db.query<{ n: string }>(
            `select count(*) as n from departments d where d.org_id = $1 ${where}`,
            args,
          )
        )[0]?.n ?? 0,
      );
      const rows = await db.query<Department>(
        `${DEPARTMENT} where d.org_id = $1 ${where} order by d.name limit ${count} offset ${start - 1}`,
        args,
      );
      const groups = [];
      for (const row of rows) groups.push(await groupOf(db, orgId, row, bare(c)));
      return answer(c, 200, {
        schemas: [LIST],
        totalResults: total,
        startIndex: start,
        itemsPerPage: groups.length,
        Resources: groups,
      });
    }),
  );

  app.get(
    "/scim/v2/Groups/:id",
    guarded(async (c) => {
      const department = await departmentOf(db, who(c).orgId, c.req.param("id") ?? "");
      if (!department) throw new ScimError(404, "There is no such group.");
      return answer(c, 200, await groupOf(db, who(c).orgId, department, bare(c)));
    }),
  );

  app.post(
    "/scim/v2/Groups",
    guarded(async (c) => {
      const { orgId } = who(c);
      const value = await bodyOf(c);
      const name = departmentName(value.displayName);
      const group = await db.tx(async (tx) => {
        const id = newId();
        const created = await tx.query(
          "insert into departments (id, org_id, name) values ($1, $2, $3) on conflict (org_id, name) do nothing returning id",
          [id, orgId, name],
        );
        if (created.length === 0)
          throw new ScimError(409, "A department with this name already exists.", "uniqueness");
        await setExternal(tx, orgId, "group", id, value.externalId);
        await record(tx, c, "department.created", { type: "department", id, label: name });
        const department = (await departmentOf(tx, orgId, id)) as Department;
        await place(tx, c, department, idsIn(value.members), true);
        return groupOf(tx, orgId, department);
      });
      c.header("location", `${base}/Groups/${group.id}`);
      return answer(c, 201, group);
    }),
  );

  app.put(
    "/scim/v2/Groups/:id",
    guarded(async (c) => {
      const { orgId } = who(c);
      const value = await bodyOf(c);
      const group = await db.tx(async (tx) => {
        const department = await departmentOf(tx, orgId, c.req.param("id") ?? "", true);
        if (!department) throw new ScimError(404, "There is no such group.");
        await rename(tx, c, department, departmentName(value.displayName));
        await setExternal(tx, orgId, "group", department.id, value.externalId);
        // Replaced: who is not named is no longer in it.
        const named = idsIn(value.members);
        const now = (
          await tx.query<{ id: string }>(
            "select user_id as id from memberships where org_id = $1 and department_id = $2",
            [orgId, department.id],
          )
        ).map((row) => row.id);
        await place(
          tx,
          c,
          department,
          now.filter((id) => !named.includes(id)),
          false,
        );
        await place(tx, c, department, named, true);
        return groupOf(tx, orgId, (await departmentOf(tx, orgId, department.id)) as Department);
      });
      return answer(c, 200, group);
    }),
  );

  app.patch(
    "/scim/v2/Groups/:id",
    guarded(async (c) => {
      const { orgId } = who(c);
      const value = await bodyOf(c);
      const schemas = Array.isArray(value.schemas) ? value.schemas : [];
      if (!schemas.includes(PATCH) || !Array.isArray(value.Operations))
        throw new ScimError(400, "This is not a patch.", "invalidSyntax");
      const operations = value.Operations.slice(0, 50) as Record<string, unknown>[];
      const group = await db.tx(async (tx) => {
        let department = await departmentOf(tx, orgId, c.req.param("id") ?? "", true);
        if (!department) throw new ScimError(404, "There is no such group.");
        for (const operation of operations) {
          const op = String(operation?.op ?? "").toLowerCase();
          const path = typeof operation?.path === "string" ? operation.path.trim() : "";
          const key = path.toLowerCase();
          const given = operation?.value;
          if (!["add", "replace", "remove"].includes(op))
            throw new ScimError(400, "An operation is add, replace or remove.", "invalidSyntax");
          // members[value eq "id"]: one person, named in the path.
          const one = /^members\[\s*value\s+eq\s+"([^"]+)"\s*\]$/i.exec(path)?.[1];
          if (one) {
            if (op === "remove") await place(tx, c, department, idsIn([one]), false);
          } else if (key === "members") {
            if (op === "remove") {
              const ids = idsIn(given);
              const all = (
                await tx.query<{ id: string }>(
                  "select user_id as id from memberships where org_id = $1 and department_id = $2",
                  [orgId, department.id],
                )
              ).map((row) => row.id);
              // With nobody named, everybody.
              await place(tx, c, department, ids.length ? ids : all, false);
            } else {
              if (op === "replace") {
                const named = idsIn(given);
                const all = (
                  await tx.query<{ id: string }>(
                    "select user_id as id from memberships where org_id = $1 and department_id = $2",
                    [orgId, department.id],
                  )
                ).map((row) => row.id);
                await place(
                  tx,
                  c,
                  department,
                  all.filter((id) => !named.includes(id)),
                  false,
                );
              }
              await place(tx, c, department, idsIn(given), true);
            }
          } else if (key === "displayname") {
            if (op !== "remove") await rename(tx, c, department, departmentName(given));
          } else if (key === "externalid") {
            await setExternal(tx, orgId, "group", department.id, given);
          } else if (!path && given && typeof given === "object" && !Array.isArray(given)) {
            const set = given as Record<string, unknown>;
            if (set.displayName !== undefined)
              await rename(tx, c, department, departmentName(set.displayName));
            await setExternal(tx, orgId, "group", department.id, set.externalId);
            if (set.members !== undefined) await place(tx, c, department, idsIn(set.members), true);
          }
          department = (await departmentOf(tx, orgId, department.id)) as Department;
        }
        return groupOf(tx, orgId, department);
      });
      return answer(c, 200, group);
    }),
  );

  // As on the departments page: the people in it are in no department afterwards, and
  // what was shared with the department as such is shared with nobody.
  app.delete(
    "/scim/v2/Groups/:id",
    guarded(async (c) => {
      const { orgId } = who(c);
      await db.tx(async (tx) => {
        const department = await departmentOf(tx, orgId, c.req.param("id") ?? "", true);
        if (!department) throw new ScimError(404, "There is no such group.");
        const members = await tx.query<{ email: string }>(
          "select u.email from memberships m join users u on u.id = m.user_id where m.org_id = $1 and m.department_id = $2 order by u.email",
          [orgId, department.id],
        );
        await tx.query("delete from departments where id = $1 and org_id = $2", [
          department.id,
          orgId,
        ]);
        await tx.query("delete from shares where to_kind = 'department' and to_id = $1", [
          department.id,
        ]);
        await tx.query("delete from scim_ids where org_id = $1 and kind = 'group' and id = $2", [
          orgId,
          department.id,
        ]);
        await record(
          tx,
          c,
          "department.deleted",
          { type: "department", id: department.id, label: department.name },
          { count: members.length, members: members.slice(0, 20).map((member) => member.email) },
        );
      });
      return c.body(null, 204);
    }),
  );
}
