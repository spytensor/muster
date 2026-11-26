/**
 * The company's directory at the service its people already work in: Feishu or Lark,
 * WeCom, DingTalk. An owner names the application the company registered there; from
 * then on its people sign in with the account they already have, and who is in the
 * organization, and in which department, follows the directory.
 * docs/features/platform.md, "Company directories".
 *
 * It is the organization's own way in, as single sign-on is (sso.ts), and held to the
 * same rules: it is switched on only after someone got in through it; an owner or an
 * administrator is never matched by an address, they connect their own account signed
 * in; and what the directory takes away it alone gives back.
 *
 * Many people have no mail address at these services. Such a person is known here by an
 * address that can never receive mail, under the reserved ".invalid": see `addressFor`.
 */
import { createHash, randomBytes } from "node:crypto";
import { newId } from "@muster/protocol";
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { type AppKit, type Ctx, type Env, fail } from "./app.js";
import { recordEvent } from "./audit.js";
import { AdmissionConflict, admit, type DenyReason, type Identity } from "./auth/admission.js";
import { APP_LOGIN_COOKIE, pendingAppLogin } from "./auth/app-login.js";
import {
  createSession,
  resolveSession,
  revokeSessionByToken,
  revokeSessionsOfUser,
  SESSION_COOKIE,
} from "./auth/session.js";
import type { Config } from "./config.js";
import { openText, sealText } from "./connections.js";
import type { Db, Queryable } from "./db.js";
import { dingtalkClient } from "./directory/dingtalk.js";
import { feishuClient } from "./directory/feishu.js";
import {
  DIRECTORY_KINDS,
  type DirectoryApp,
  type DirectoryClient,
  type DirectoryKind,
  type DirectoryListing,
  type DirectoryPerson,
  DirectoryProblem,
} from "./directory/types.js";
import { wecomClient } from "./directory/wecom.js";
import { Refusal } from "./errors.js";
import type { Net } from "./runtime/net.js";

/** What review asked for: why a try from the console did not work, for the console to say. */
export const DIRECTORY_TRIED_SCHEMA = ["alter table org_directories add column tried jsonb"];

export const DIRECTORY_SCHEMA = [
  // The application an organization registered at its directory's service. The secret is
  // sealed. `verified_at`: when someone last got in through it as it is set now; it
  // cannot be switched on before that. One application answers for one organization.
  `create table org_directories (
    org_id uuid primary key references organizations(id) on delete cascade,
    kind text not null check (kind in ('feishu', 'lark', 'wecom', 'dingtalk')),
    app_id text not null,
    agent_id text,
    secret_sealed text not null,
    secret_tail text not null,
    enabled boolean not null default false,
    enabled_by uuid references users(id) on delete set null,
    verified_at timestamptz,
    synced_at timestamptz,
    sync_result jsonb,
    updated_by uuid references users(id) on delete set null,
    updated_at timestamptz not null default now(),
    unique (kind, app_id)
  )`,
  // A sign-in on its way. `state` and `binding` are hashes: of what the service is sent
  // and sends back, and of what only the browser that began holds.
  `create table directory_attempts (
    state text primary key,
    org_id uuid not null references organizations(id) on delete cascade,
    binding text not null,
    verifier text not null,
    connect_user uuid references users(id) on delete cascade,
    created_at timestamptz not null default now()
  )`,
  "create index directory_attempts_created on directory_attempts (created_at)",
  // Which department here is which one in the directory.
  `create table directory_departments (
    org_id uuid not null references organizations(id) on delete cascade,
    external_id text not null,
    department_id uuid not null references departments(id) on delete cascade,
    primary key (org_id, external_id)
  )`,
];

const ATTEMPT_COOKIE = "muster_directory";
const ASKING_MINUTES = 10;
/** How often the directory is read again. */
export const SYNC_EVERY_MS = 60 * 60 * 1000;
export const DIRECTORY_LIMITS = { beginPerMinute: 20, waiting: 5000 };
/** A department's name here holds this much (see the departments page). */
const NAME_MOST = 60;

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
/** One line of plain text. */
const words = (value: string, most: number): string =>
  [...value]
    .filter((ch) => ch >= " " && ch !== "\u007f")
    .join("")
    .trim()
    .slice(0, most);
const ADDRESS = /^[\x21-\x7e]+@[\x21-\x7e]+$/;

type Settings = {
  orgId: string;
  kind: DirectoryKind;
  appId: string;
  agentId: string | null;
  secretSealed: string;
  secretTail: string;
  enabled: boolean;
  verifiedAt: Date | null;
  syncedAt: Date | null;
  syncResult: SyncResult | null;
  tried: { reason: string; hint: string } | null;
  updatedAt: Date;
};
const COLUMNS = `org_id as "orgId", kind, app_id as "appId", agent_id as "agentId",
  secret_sealed as "secretSealed", secret_tail as "secretTail", enabled,
  verified_at as "verifiedAt", synced_at as "syncedAt", sync_result as "syncResult", tried,
  updated_at as "updatedAt"`;

export interface SyncResult {
  /** What kept the directory from being read, when it was not. */
  problem?: { reason: string; hint: string };
  /** People and departments the directory holds, as the application may see them. */
  people: number;
  departments: number;
  added: number;
  /** Members already here who were found in the directory by their address. */
  linked: number;
  suspended: number;
  restored: number;
  /** In the directory, and not theirs to become: the address is an administrator's, or someone's elsewhere. */
  skipped: number;
  /** People who would have lost access in a pass nobody asked for: left for a person to confirm. */
  held: number;
}

/**
 * What a record of who signed in with what calls an organization's directory. Feishu
 * names a person the same for every application of one company; WeCom and DingTalk name
 * them within the company, so another company's application is another name.
 */
export const providerOf = (settings: Pick<Settings, "orgId" | "kind" | "appId">) =>
  settings.kind === "feishu" || settings.kind === "lark"
    ? `${settings.kind}:${settings.orgId}`
    : `${settings.kind}:${settings.orgId}:${settings.appId}`;

/** Whether an address is one made up here for someone who has none. */
export const isNoAddress = (email: string) => email.endsWith(".invalid");

/**
 * The address a person from the directory is known by: the one the company gave them,
 * where it is in a domain the organization named as its own; otherwise one that says who
 * they are there and can never be written to (".invalid" is reserved for that, RFC 2606).
 */
export function addressFor(
  settings: Pick<Settings, "kind" | "appId">,
  person: Pick<DirectoryPerson, "subject" | "email">,
  /** The mail domains the organization has named as its own. */
  domains: ReadonlySet<string>,
): string {
  const given = (person.email ?? "").trim().toLowerCase();
  // An address is believed only in a domain the organization named as its own, as with
  // single sign-on: whoever keeps the directory cannot name an outside address, or an
  // invitation's, and so become that person.
  if (
    ADDRESS.test(given) &&
    given.length <= 320 &&
    domains.has(given.slice(given.lastIndexOf("@") + 1))
  )
    return given;
  const plain = (value: string) => value.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  const local = plain(person.subject).slice(0, 64);
  // Where making it plain lost something, what was lost is told apart by a few letters.
  const tail = local === person.subject ? "" : `-${hash(person.subject).slice(0, 8)}`;
  return `${local}${tail}@${plain(settings.appId).slice(0, 64)}.${settings.kind}.invalid`;
}

const pictureOf = (url: string | null) =>
  url && url.length <= 1000 && url.startsWith("https://") ? url : null;

/**
 * Whether the directory's word is enough to let this person in. Someone it has named
 * before comes in as before. Anyone else is new to this server, or is already here under
 * the same address: a plain member of this organization becomes that member; an owner,
 * an administrator or anyone with another role is never matched by an address (they
 * connect their own account from the console, signed in); and an address that belongs to
 * someone in another organization lets nobody in.
 */
async function mayEnter(
  tx: Queryable,
  orgId: string,
  identity: Identity,
): Promise<DenyReason | null> {
  const known = await tx.query("select 1 from identities where provider = $1 and subject = $2", [
    identity.provider,
    identity.subject,
  ]);
  if (known.length > 0) return null;
  const here = (
    await tx.query<{ orgId: string | null; role: string | null }>(
      `select m.org_id as "orgId", m.role from users u left join memberships m on m.user_id = u.id
        where u.email = $1`,
      [identity.email],
    )
  )[0];
  if (!here) return null;
  return here.orgId === orgId && here.role === "member" ? null : "identity_conflict";
}

/** The mail domains an organization has named as its own. */
async function domainsOf(db: Queryable, orgId: string): Promise<Set<string>> {
  const rows = await db.query<{ domain: string }>(
    "select domain from org_domains where org_id = $1",
    [orgId],
  );
  return new Set(rows.map((row) => row.domain.toLowerCase()));
}

/** What someone the directory gives no name for is called: who they are there, cut short. */
const nameOf = (person: Pick<DirectoryPerson, "name" | "subject">) =>
  words(person.name, 200) || words(person.subject, 24);

/** Whether it was the directory that last took this person's access away: only then may it give it back. */
async function ownDoing(tx: Queryable, orgId: string, userId: string): Promise<boolean> {
  const last = (
    await tx.query<{ action: string; via: string | null }>(
      `select action, detail->>'via' as via from admin_events
        where org_id = $1 and target_type = 'member' and target_id = $2
          and action in ('member.suspended', 'member.removed', 'member.reactivated', 'member.joined')
        order by seq desc limit 1`,
      [orgId, userId],
    )
  )[0];
  return last?.via === "directory" && last.action === "member.suspended";
}

/** Each department's name here: where it sits, top down, so two of one name stay two. */
export function departmentNames(listing: DirectoryListing): Map<string, string> {
  const byId = new Map(listing.departments.map((one) => [one.id, one]));
  const names = new Map<string, string>();
  for (const department of listing.departments) {
    const path: string[] = [];
    const seen = new Set<string>();
    let at: typeof department | undefined = department;
    while (at && !seen.has(at.id) && path.length < 12) {
      seen.add(at.id);
      const name = words(at.name, NAME_MOST);
      if (name) path.unshift(name);
      at = at.parentId ? byId.get(at.parentId) : undefined;
    }
    let name = path.join(" / ");
    // Too long: the end says the most, so the top is what goes.
    while (name.length > NAME_MOST && path.length > 1) {
      path.shift();
      name = `… / ${path.join(" / ")}`;
    }
    if (name) names.set(department.id, name.slice(0, NAME_MOST));
  }
  return names;
}

export class Directories {
  private readonly clients: Record<DirectoryKind, DirectoryClient>;
  /** Told when the directory takes someone's access away, so what they had in progress ends. */
  blocked: (userId: string) => Promise<void> = async () => undefined;
  private running = false;
  /** Organizations whose directory is being read now: one reading each at a time. */
  private readonly reading = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly secretKey: string,
    net: Net,
  ) {
    const feishu = feishuClient(net);
    this.clients = {
      feishu,
      lark: feishu,
      wecom: wecomClient(net),
      dingtalk: dingtalkClient(net),
    };
  }

  get canSeal(): boolean {
    return this.secretKey.length > 0;
  }
  seal(secret: string): string {
    return sealText(this.secretKey, secret);
  }
  client(kind: DirectoryKind): DirectoryClient {
    return this.clients[kind];
  }
  /** The application as the service knows it, or null when its secret can no longer be opened. */
  appOf(settings: Settings): DirectoryApp | null {
    const secret = openText(this.secretKey, settings.secretSealed);
    return secret === null
      ? null
      : { kind: settings.kind, appId: settings.appId, secret, agentId: settings.agentId };
  }

  async settingsFor(orgId?: string, db: Queryable = this.db): Promise<Settings | null> {
    const rows = orgId
      ? await db.query<Settings>(`select ${COLUMNS} from org_directories where org_id = $1`, [
          orgId,
        ])
      : await db.query<Settings>(`select ${COLUMNS} from org_directories limit 2`);
    return rows.length === 1 ? (rows[0] as Settings) : null;
  }

  /** Reads every directory that is on and has not been read for an hour. One pass at a time. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const due = await this.db.query<{ orgId: string }>(
        `select org_id as "orgId" from org_directories
          where enabled and (synced_at is null or synced_at < now() - interval '${Math.floor(SYNC_EVERY_MS / 1000)} seconds')`,
      );
      for (const { orgId } of due)
        await this.sync(orgId, false).catch((error) =>
          console.error("reading a company's directory failed:", error),
        );
    } finally {
      this.running = false;
    }
  }

  /**
   * Makes the organization's people and departments what the directory says.
   * `confirmed`: an owner looked at how many would lose access and said to go on, so
   * nothing is held back. Returns null where no directory is on, "busy" while another
   * reading of the same organization is under way.
   */
  async sync(orgId: string, confirmed: boolean): Promise<SyncResult | "busy" | null> {
    if (this.reading.has(orgId)) return "busy";
    this.reading.add(orgId);
    try {
      return await this.read(orgId, confirmed);
    } finally {
      this.reading.delete(orgId);
    }
  }

  private async read(orgId: string, confirmed: boolean): Promise<SyncResult | null> {
    const settings = await this.settingsFor(orgId);
    if (!settings?.enabled) return null;
    const result: SyncResult = {
      people: 0,
      departments: 0,
      added: 0,
      linked: 0,
      suspended: 0,
      restored: 0,
      skipped: 0,
      held: 0,
    };
    const keep = () =>
      this.db.query(
        "update org_directories set synced_at = now(), sync_result = $2::jsonb where org_id = $1",
        [orgId, JSON.stringify(result)],
      );
    const app = this.appOf(settings);
    let listing: DirectoryListing;
    try {
      if (!app) throw new DirectoryProblem("credentials");
      listing = await this.client(settings.kind).list(app);
    } catch (error) {
      if (!(error instanceof DirectoryProblem)) throw error;
      // Not read: nothing here changes, and the console says why.
      result.problem = { reason: error.reason, hint: error.hint };
      await keep();
      return result;
    }
    result.people = listing.people.length;
    result.departments = listing.departments.length;
    // A directory that names nobody is not believed: it is a mistake at the service far
    // more often than a company that emptied itself.
    if (listing.people.length === 0) {
      result.problem = { reason: "empty", hint: "" };
      await keep();
      return result;
    }

    const provider = providerOf(settings);
    const names = departmentNames(listing);
    const blocked: string[] = [];
    await this.db.tx(async (tx) => {
      // One at a time for an organization, as every change to its people is.
      await tx.query("select 1 from organizations where id = $1 for update", [orgId]);
      const still = await this.settingsFor(orgId, tx);
      if (!still?.enabled || providerOf(still) !== provider) return;
      const record = (
        action: string,
        target: { type: string; id: string; label: string },
        detail: Record<string, unknown> = {},
      ) =>
        recordEvent(tx, {
          orgId,
          actor: { userId: null, email: "directory" },
          action,
          target,
          detail: { ...detail, via: "directory", kind: settings.kind },
        });

      // ---- departments ----
      const mapped = new Map(
        (
          await tx.query<{ externalId: string; id: string; name: string }>(
            `select x.external_id as "externalId", d.id, d.name
               from directory_departments x join departments d on d.id = x.department_id
              where x.org_id = $1`,
            [orgId],
          )
        ).map((row) => [row.externalId, row]),
      );
      const byName = new Map(
        (
          await tx.query<{ id: string; name: string }>(
            "select id, name from departments where org_id = $1",
            [orgId],
          )
        ).map((row) => [row.name, row.id]),
      );
      const departmentOf = new Map<string, string>();
      for (const [externalId, name] of [...names].sort((a, b) => a[1].localeCompare(b[1]))) {
        const had = mapped.get(externalId);
        if (had) {
          departmentOf.set(externalId, had.id);
          // Renamed or moved there: renamed here, unless the name is taken.
          if (had.name !== name && !byName.has(name)) {
            await tx.query("update departments set name = $2 where id = $1", [had.id, name]);
            byName.delete(had.name);
            byName.set(name, had.id);
            await record(
              "department.renamed",
              { type: "department", id: had.id, label: name },
              { from: had.name },
            );
          }
          continue;
        }
        let id = byName.get(name);
        if (!id) {
          id = newId();
          await tx.query("insert into departments (id, org_id, name) values ($1, $2, $3)", [
            id,
            orgId,
            name,
          ]);
          byName.set(name, id);
          await record("department.created", { type: "department", id, label: name });
        }
        await tx.query(
          `insert into directory_departments (org_id, external_id, department_id) values ($1, $2, $3)
           on conflict (org_id, external_id) do update set department_id = excluded.department_id`,
          [orgId, externalId, id],
        );
        departmentOf.set(externalId, id);
      }
      // One the directory no longer has is no longer the directory's: it stays here, with
      // whatever was set on it, for an administrator to keep or delete.
      for (const externalId of mapped.keys())
        if (!names.has(externalId))
          await tx.query(
            "delete from directory_departments where org_id = $1 and external_id = $2",
            [orgId, externalId],
          );

      // ---- people ----
      type Known = {
        subject: string;
        id: string;
        email: string;
        name: string;
        role: string;
        status: "active" | "suspended" | "removed";
        departmentId: string | null;
      };
      const known = new Map(
        (
          await tx.query<Known>(
            `select i.subject, u.id, u.email, u.name, m.role, m.status, m.department_id as "departmentId"
               from identities i join users u on u.id = i.user_id
               join memberships m on m.user_id = u.id and m.org_id = $2
              where i.provider = $1`,
            [provider, orgId],
          )
        ).map((row) => [row.subject, row]),
      );
      const domains = await domainsOf(tx, orgId);
      const present = new Set<string>();
      for (const person of listing.people) {
        if (!person.active) continue;
        present.add(person.subject);
        const name = nameOf(person);
        const email = addressFor(settings, person, domains);
        const departmentId =
          person.departments.map((id) => departmentOf.get(id)).find(Boolean) ?? null;
        const had = known.get(person.subject);
        if (had) {
          // Owners, administrators and the other roles are managed here, not by the directory.
          if (had.role !== "member" || had.status === "removed") continue;
          if (name && name !== had.name)
            await tx.query("update users set name = $2 where id = $1", [had.id, name]);
          if (departmentId !== had.departmentId)
            await tx.query(
              "update memberships set department_id = $3 where org_id = $1 and user_id = $2",
              [orgId, had.id, departmentId],
            );
          // Someone who had no address and now has one is known by it, where it is free.
          if (isNoAddress(had.email) && !isNoAddress(email)) {
            const taken = await tx.query("select 1 from users where email = $1", [email]);
            if (taken.length === 0) {
              await tx.query("update users set email = $2 where id = $1", [had.id, email]);
              await record(
                "member.address_changed",
                { type: "member", id: had.id, label: email },
                { from: had.email, to: email },
              );
            }
          }
          if (had.status === "suspended" && (await ownDoing(tx, orgId, had.id))) {
            // WeCom and DingTalk let a company give a leaver's ID to someone new. Access is
            // given back only to the same person, as far as a name can say.
            if (had.name && had.name !== name) {
              result.skipped++;
              continue;
            }
            await tx.query(
              "update memberships set status = 'active' where org_id = $1 and user_id = $2",
              [orgId, had.id],
            );
            await record(
              "member.reactivated",
              { type: "member", id: had.id, label: name || had.email },
              { from: "suspended" },
            );
            result.restored++;
          }
          continue;
        }
        const taken = (
          await tx.query<{
            id: string;
            orgId: string | null;
            role: string | null;
            status: string | null;
            linked: boolean;
          }>(
            `select u.id, m.org_id as "orgId", m.role, m.status,
                    exists (select 1 from identities i where i.user_id = u.id and i.provider = $2) as linked
               from users u left join memberships m on m.user_id = u.id where u.email = $1`,
            [email, provider],
          )
        )[0];
        if (taken) {
          // The address is somebody's already. A plain member here, not yet tied to the
          // directory, is that person; anyone else is left alone.
          if (
            taken.orgId !== orgId ||
            taken.role !== "member" ||
            taken.status === "removed" ||
            taken.linked
          ) {
            result.skipped++;
            continue;
          }
          await tx.query(
            "insert into identities (provider, subject, user_id) values ($1, $2, $3) on conflict do nothing",
            [provider, person.subject, taken.id],
          );
          if (departmentId)
            await tx.query(
              "update memberships set department_id = $3 where org_id = $1 and user_id = $2",
              [orgId, taken.id, departmentId],
            );
          result.linked++;
          continue;
        }
        const id = newId();
        // Someone signing in at this moment may have made the same person: then they are
        // left to that sign-in, and one refusal does not undo the whole reading.
        const made = await tx.query(
          `insert into users (id, email, name, avatar_url) values ($1, $2, $3, $4)
           on conflict (email) do nothing returning id`,
          [id, email, name, pictureOf(person.avatarUrl)],
        );
        const tied =
          made.length > 0 &&
          (
            await tx.query(
              `insert into identities (provider, subject, user_id) values ($1, $2, $3)
               on conflict (provider, subject) do nothing returning user_id`,
              [provider, person.subject, id],
            )
          ).length > 0;
        if (!tied) {
          if (made.length > 0) await tx.query("delete from users where id = $1", [id]);
          result.skipped++;
          continue;
        }
        await tx.query(
          `insert into memberships (org_id, user_id, role, department_id, joined_via)
           values ($1, $2, 'member', $3, 'directory')`,
          [orgId, id, departmentId],
        );
        await record(
          "member.joined",
          { type: "member", id, label: name || email },
          { role: "member" },
        );
        result.added++;
      }

      // ---- people the directory no longer has ----
      const gone = [...known.values()].filter(
        (one) => one.role === "member" && one.status === "active" && !present.has(one.subject),
      );
      const active = [...known.values()].filter((one) => one.status === "active").length;
      // Access is not taken from many at once on the directory's word alone: the
      // application may have been given sight of less by mistake. An owner confirms.
      if (!confirmed && gone.length > Math.max(5, active / 2)) result.held = gone.length;
      else
        for (const one of gone) {
          await tx.query(
            "update memberships set status = 'suspended' where org_id = $1 and user_id = $2",
            [orgId, one.id],
          );
          const ended = await revokeSessionsOfUser(tx, one.id);
          await record(
            "member.suspended",
            { type: "member", id: one.id, label: one.name || one.email },
            { sessionsEnded: ended },
          );
          blocked.push(one.id);
          result.suspended++;
        }
      // An owner, an administrator or anyone with another role is not the directory's to
      // suspend. One who left it is signed out everywhere, and the owners can see it.
      for (const one of known.values()) {
        if (one.role === "member" || one.status !== "active" || present.has(one.subject)) continue;
        const ended = await revokeSessionsOfUser(tx, one.id);
        if (ended > 0)
          await record(
            "directory.left",
            { type: "member", id: one.id, label: one.name || one.email },
            { sessionsEnded: ended, role: one.role },
          );
      }
      await tx.query(
        "update org_directories set synced_at = now(), sync_result = $2::jsonb where org_id = $1",
        [orgId, JSON.stringify(result)],
      );
    });
    // What they had in progress ends with their access, as when an administrator does it.
    for (const id of blocked) await this.blocked(id);
    return result;
  }
}

export function registerDirectory(
  app: Hono<Env>,
  kit: AppKit,
  db: Db,
  config: Config,
  directories: Directories,
): void {
  const { need, actorOf, clientIp, inTx } = kit;
  directories.blocked = kit.memberBlocked;
  const secure = config.publicUrl.startsWith("https://");
  const cookie = { httpOnly: true, secure, sameSite: "Lax" as const, path: "/auth" };
  const org = (c: Ctx) => c.get("session").org.id;
  const redirectUri = (kind: DirectoryKind) => `${config.publicUrl}/auth/callback/${kind}`;
  const denied = (c: Context, reason: DenyReason | "failed") =>
    c.redirect(`${config.publicUrl}/?error=${reason}`);

  const begun = new Map<string, { since: number; n: number }>();
  const tooOften = (ip: string | null) => {
    const key = ip ?? "";
    const now = Date.now();
    if (begun.size > 10_000) begun.clear();
    const hit = begun.get(key);
    if (!hit || now - hit.since >= 60_000) {
      begun.set(key, { since: now, n: 1 });
      return false;
    }
    return ++hit.n > DIRECTORY_LIMITS.beginPerMinute;
  };

  /** Stores a sign-in on its way and says where to send the person. */
  const ask = async (c: Context, settings: Settings, connect: string | null) => {
    const application = directories.appOf(settings);
    if (!application) return null;
    await db.query(
      `delete from directory_attempts where created_at < now() - interval '${ASKING_MINUTES} minutes'`,
    );
    const waiting = (
      await db.query<{ n: number }>("select count(*)::int as n from directory_attempts")
    )[0]?.n;
    if ((waiting ?? 0) >= DIRECTORY_LIMITS.waiting) return null;
    // Letters and digits only: WeCom takes nothing else.
    const state = randomBytes(32).toString("hex");
    const binding = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    await db.query(
      "insert into directory_attempts (state, org_id, binding, verifier, connect_user) values ($1, $2, $3, $4, $5)",
      [hash(state), settings.orgId, hash(binding), verifier, connect],
    );
    // Ties the attempt to this browser: a link back sent to someone else is useless.
    setCookie(c, ATTEMPT_COOKIE, binding, { ...cookie, maxAge: ASKING_MINUTES * 60 });
    return directories.client(settings.kind).authorizeUrl(application, {
      redirectUri: redirectUri(settings.kind),
      state,
      challenge: createHash("sha256").update(verifier).digest("base64url"),
      inApp: /wxwork/i.test(c.req.header("user-agent") ?? ""),
    });
  };

  /** The person back from the service, in the browser that began. */
  const complete = async (c: Context, kind: DirectoryKind): Promise<Response> => {
    const binding = getCookie(c, ATTEMPT_COOKIE);
    deleteCookie(c, ATTEMPT_COOKIE, cookie);
    const state = c.req.query("state") ?? "";
    // DingTalk calls it `authCode`.
    const code = c.req.query("code") ?? c.req.query("authCode") ?? "";
    if (!binding || !state || !code || code.length > 2000) return denied(c, "failed");
    const attempt = (
      await db.query<{ orgId: string; verifier: string; connect: string | null }>(
        `delete from directory_attempts
          where state = $1 and binding = $2
            and created_at > now() - interval '${ASKING_MINUTES} minutes'
          returning org_id as "orgId", verifier, connect_user as connect`,
        [hash(state), hash(binding)],
      )
    )[0];
    if (!attempt) return denied(c, "failed");
    const settings = await directories.settingsFor(attempt.orgId);
    const application = settings && directories.appOf(settings);
    if (!settings || !application || settings.kind !== kind) return denied(c, "failed");
    const ip = clientIp(c);
    const refused = async (why: string, hint = "") => {
      // Tried from the console: the person is sent back there and told why.
      if (attempt.connect) {
        await db.query("update org_directories set tried = $2::jsonb where org_id = $1", [
          settings.orgId,
          JSON.stringify({ reason: why, hint }),
        ]);
        return c.redirect(`${config.publicUrl}/#/admin/security`);
      }
      await recordEvent(db, {
        orgId: settings.orgId,
        actor: { userId: null, email: "" },
        action: "auth.login_denied",
        detail: { reason: "directory", problem: why, ...(hint ? { hint } : {}), provider: kind },
        ip,
      });
      return denied(c, "failed");
    };
    let person: DirectoryPerson | null;
    try {
      person = await directories.client(kind).identify(application, {
        code,
        redirectUri: redirectUri(kind),
        verifier: attempt.verifier,
      });
    } catch (error) {
      if (!(error instanceof DirectoryProblem)) throw error;
      return refused(error.reason, error.hint);
    }
    // Not one of the company's own, as far as its application may see.
    if (!person) return refused("not_in_directory");
    if (!person.active) return refused("inactive");
    if (!person.subject || person.subject.length > 200) return refused("answer");
    const provider = providerOf(settings);
    const previous = getCookie(c, SESSION_COOKIE);

    // Begun in the console by someone signed in: the account at the directory becomes
    // theirs. Who they are is their session, never what the directory said; nobody is
    // made a member this way, and no new session begins.
    if (attempt.connect) {
      const session = previous ? await resolveSession(db, previous) : null;
      if (!session || session.user.id !== attempt.connect || session.org.id !== settings.orgId)
        return denied(c, "failed");
      const subject = person.subject;
      const linked = await db.tx(async (tx) => {
        const holder = (
          await tx.query<{ user_id: string }>(
            "select user_id from identities where provider = $1 and subject = $2",
            [provider, subject],
          )
        )[0]?.user_id;
        if (holder && holder !== session.user.id) return false;
        await tx.query("delete from identities where provider = $1 and user_id = $2", [
          provider,
          session.user.id,
        ]);
        await tx.query("insert into identities (provider, subject, user_id) values ($1, $2, $3)", [
          provider,
          subject,
          session.user.id,
        ]);
        await tx.query(
          // To the millisecond: see the same line in sso.ts.
          "update org_directories set tried = null, verified_at = now() where org_id = $1 and date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', $2::timestamptz)",
          [settings.orgId, settings.updatedAt],
        );
        await recordEvent(tx, {
          orgId: settings.orgId,
          actor: { userId: session.user.id, email: session.user.email },
          action: "directory.connected",
          target: { type: "directory", id: settings.orgId, label: settings.kind },
          ip,
        });
        return true;
      });
      return linked
        ? c.redirect(`${config.publicUrl}/#/admin/security`)
        : denied(c, "identity_conflict");
    }

    // Anyone else comes in only while it is switched on.
    if (!settings.enabled) return denied(c, "failed");
    const identity: Identity = {
      provider,
      subject: person.subject,
      email: addressFor(settings, person, await domainsOf(db, settings.orgId)),
      emailVerified: true,
      domainProven: true,
      fromDirectory: true,
      name: nameOf(person),
      avatarUrl: pictureOf(person.avatarUrl),
    };
    const result = await db
      .tx(async (tx) => {
        const barred = await mayEnter(tx, settings.orgId, identity);
        if (barred) {
          await recordEvent(tx, {
            orgId: settings.orgId,
            actor: { userId: null, email: identity.email },
            action: "auth.login_denied",
            detail: { reason: barred, provider: kind },
            ip,
          });
          return { ok: false as const, reason: barred };
        }
        const admission = await admit(tx, config, identity, ip);
        if (!admission.ok) return admission;
        // One organization's directory lets nobody into another.
        if (admission.orgId !== settings.orgId) throw new AdmissionConflict();
        if (previous) await revokeSessionByToken(tx, previous);
        const session = await createSession(tx, {
          userId: admission.userId,
          orgId: admission.orgId,
          provider: kind,
          days: config.sessionDays,
          ip,
          userAgent: c.req.header("user-agent") ?? null,
        });
        await recordEvent(tx, {
          orgId: admission.orgId,
          actor: { userId: admission.userId, email: identity.email },
          action: "auth.login",
          detail: { provider: kind },
          ip,
        });
        return { ok: true as const, session };
      })
      .catch((error: unknown) => {
        if (error instanceof AdmissionConflict)
          return { ok: false as const, reason: "not_member" as const };
        throw error;
      });
    if (!result.ok) return denied(c, result.reason);
    setCookie(c, SESSION_COOKIE, result.session.token, {
      httpOnly: true,
      secure,
      sameSite: "Lax",
      path: "/",
      expires: result.session.expiresAt,
    });
    if (await pendingAppLogin(db, getCookie(c, APP_LOGIN_COOKIE)))
      return c.redirect(`${config.publicUrl}/auth/app/confirm`);
    return c.redirect(`${config.publicUrl}/`);
  };

  // Each service is a way in of its own on the sign-in page, under its own name.
  for (const kind of DIRECTORY_KINDS)
    kit.signInWith({
      id: kind,
      offered: async () => {
        // As with single sign-on: only where the server has one organization.
        const orgs = await db.query("select 1 from organizations limit 2");
        if (orgs.length !== 1) return null;
        const on = await db.query("select 1 from org_directories where enabled and kind = $1", [
          kind,
        ]);
        return on.length === 1 ? { id: kind, label: LABELS[kind] } : null;
      },
      begin: async (c) => {
        if (tooOften(clientIp(c)))
          return c.text("Too many sign-ins begun. Try again in a minute.", 429);
        const orgs = await db.query("select 1 from organizations limit 2");
        const settings = orgs.length === 1 ? await directories.settingsFor() : null;
        if (!settings?.enabled || settings.kind !== kind) return c.notFound();
        const url = await ask(c, settings, null);
        return url ? c.redirect(url) : denied(c, "failed");
      },
      complete: (c) => complete(c, kind),
    });

  // ---- the console ----

  /** Which directory lets people in decides who can get into every account: an owner's to say. */
  const ownerOnly = (c: Ctx) =>
    need(c, "settings.manage") ??
    (c.get("session").role === "owner" ? null : fail(c, "owner_only"));

  const shown = (settings: Settings | null) =>
    settings && {
      kind: settings.kind,
      appId: settings.appId,
      agentId: settings.agentId,
      secretTail: settings.secretTail,
      enabled: settings.enabled,
      verified: Boolean(settings.verifiedAt && settings.verifiedAt >= settings.updatedAt),
      redirectUrl: redirectUri(settings.kind),
      syncedAt: settings.syncedAt,
      sync: settings.syncResult,
      /** Why the last try from the console did not work, until one does. */
      tried: settings.tried,
    };

  app.get("/api/settings/directory", async (c) => {
    const refused = need(c, "settings.read");
    if (refused) return refused;
    return c.json({
      directory: shown(await directories.settingsFor(org(c))),
      owner: c.get("session").role === "owner",
      // Where each service is told to send people back to.
      redirectUrls: Object.fromEntries(DIRECTORY_KINDS.map((kind) => [kind, redirectUri(kind)])),
    });
  });

  const plain = (most: number) =>
    z
      .string()
      .trim()
      .min(1)
      .max(most)
      .regex(/^[\x21-\x7e]+$/);
  const Body = z.strictObject({
    kind: z.enum(DIRECTORY_KINDS),
    appId: plain(100),
    /** Left out to keep the one already held, where the application is the same. */
    secret: plain(300).optional(),
    agentId: plain(40).optional(),
  });

  // Naming another application switches it off until someone has got in through it. The
  // same one with a new secret, which the service has just accepted, stays as it was.
  app.put("/api/settings/directory", async (c) => {
    const refused = ownerOnly(c);
    if (refused) return refused;
    if (!directories.canSeal) return fail(c, "connector_unsealed");
    const parsed = Body.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, "invalid_directory");
    const { kind, appId } = parsed.data;
    const agentId = kind === "wecom" ? (parsed.data.agentId ?? null) : null;
    if (kind === "wecom" && !agentId) return fail(c, "invalid_directory");
    const had = await directories.settingsFor(org(c));
    const same = had && had.kind === kind && had.appId === appId;
    const secret = parsed.data.secret ?? (same ? directories.appOf(had)?.secret : undefined);
    if (!secret) return fail(c, "invalid_directory");
    try {
      await directories.client(kind).check({ kind, appId, secret, agentId });
    } catch (error) {
      if (!(error instanceof DirectoryProblem)) throw error;
      return fail(
        c,
        error.reason === "credentials"
          ? "directory_refused"
          : error.reason === "permission"
            ? "directory_not_allowed"
            : "directory_unreachable",
      );
    }
    return inTx(c, async (tx) => {
      const other = await tx.query(
        "select 1 from org_directories where kind = $1 and app_id = $2 and org_id <> $3",
        [kind, appId, org(c)],
      );
      if (other.length > 0) throw new Refusal("directory_taken");
      await tx.query(
        `insert into org_directories (org_id, kind, app_id, agent_id, secret_sealed, secret_tail, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (org_id) do update set kind = excluded.kind, app_id = excluded.app_id,
           agent_id = excluded.agent_id, secret_sealed = excluded.secret_sealed,
           secret_tail = excluded.secret_tail, updated_by = excluded.updated_by, tried = null,
           updated_at = case when $8 then org_directories.updated_at else now() end,
           enabled = org_directories.enabled and $8,
           enabled_by = case when $8 then org_directories.enabled_by end,
           verified_at = case when $8 then org_directories.verified_at end,
           synced_at = case when $8 then org_directories.synced_at end,
           sync_result = case when $8 then org_directories.sync_result end`,
        [
          org(c),
          kind,
          appId,
          agentId,
          directories.seal(secret),
          secret.slice(-4),
          actorOf(c).userId,
          // The same application with a new secret stays as it was: tried, and on.
          Boolean(same && had.agentId === agentId),
        ],
      );
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "directory.set",
        target: { type: "directory", id: org(c), label: kind },
        detail: { kind, appId },
        ip: clientIp(c),
      });
      return c.json(shown(await directories.settingsFor(org(c), tx)));
    });
  });

  // Trying it out, and making the account at the directory one's own: see sso.ts.
  app.post("/api/settings/directory/try", async (c) => {
    const refused = need(c, "settings.manage");
    if (refused) return refused;
    const settings = await directories.settingsFor(org(c));
    if (!settings) return fail(c, "not_found");
    if (!settings.enabled && c.get("session").role !== "owner") return fail(c, "owner_only");
    const url = await ask(c, settings, actorOf(c).userId);
    if (!url) return fail(c, "directory_unreachable");
    return c.json({ url });
  });

  app.put("/api/settings/directory/enabled", async (c) => {
    const refused = ownerOnly(c);
    if (refused) return refused;
    const parsed = z
      .strictObject({ on: z.boolean() })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, "invalid_request");
    const { on } = parsed.data;
    const answer = await inTx(c, async (tx) => {
      const settings = (
        await tx.query<Settings>(
          `select ${COLUMNS} from org_directories where org_id = $1 for update`,
          [org(c)],
        )
      )[0];
      if (!settings) throw new Refusal("not_found");
      if (on && !(settings.verifiedAt && settings.verifiedAt >= settings.updatedAt))
        throw new Refusal("directory_untried");
      if (settings.enabled !== on) {
        await tx.query(
          "update org_directories set enabled = $2, enabled_by = $3 where org_id = $1",
          [org(c), on, on ? actorOf(c).userId : null],
        );
        await recordEvent(tx, {
          orgId: org(c),
          actor: actorOf(c),
          action: on ? "directory.on" : "directory.off",
          target: { type: "directory", id: org(c), label: settings.kind },
          ip: clientIp(c),
        });
      }
      return c.json({ ok: true });
    });
    // Switched on: its people are read at once, not at the next hour.
    if (on && answer.status === 200)
      void directories
        .sync(org(c), false)
        .catch((error) => console.error("reading a company's directory failed:", error));
    return answer;
  });

  // Reads the directory now. Taking access from many at once is held back as on the hour,
  // until an owner who saw how many says to go on.
  app.post("/api/settings/directory/sync", async (c) => {
    const parsed = z
      .strictObject({ confirm: z.boolean().optional() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, "invalid_request");
    const confirm = parsed.data.confirm === true;
    const refused = confirm ? ownerOnly(c) : need(c, "settings.manage");
    if (refused) return refused;
    const result = await directories.sync(org(c), confirm);
    if (result === "busy") return fail(c, "directory_busy");
    if (!result) return fail(c, "not_found");
    await recordEvent(db, {
      orgId: org(c),
      actor: actorOf(c),
      action: "directory.synced",
      target: {
        type: "directory",
        id: org(c),
        label: (await directories.settingsFor(org(c)))?.kind ?? "",
      },
      detail: { ...result },
      ip: clientIp(c),
    });
    return c.json(result);
  });

  app.delete("/api/settings/directory", async (c) => {
    const refused = ownerOnly(c);
    if (refused) return refused;
    return inTx(c, async (tx) => {
      const gone = await tx.query<{ kind: string }>(
        "delete from org_directories where org_id = $1 returning kind",
        [org(c)],
      );
      if (!gone[0]) throw new Refusal("not_found");
      await tx.query("delete from directory_departments where org_id = $1", [org(c)]);
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "directory.removed",
        target: { type: "directory", id: org(c), label: gone[0].kind },
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    });
  });
}

/** What the sign-in page calls each, where the app has no word of its own for it. */
const LABELS: Record<DirectoryKind, string> = {
  feishu: "Feishu",
  lark: "Lark",
  wecom: "WeCom",
  dingtalk: "DingTalk",
};
