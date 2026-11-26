import type { Queryable } from "./db.js";
import type { ProjectDoc } from "./projects.js";

/**
 * What lives in a project: the things that stay there from one conversation to the next
 * and that anyone working in it, a person or an agent, needs to know of. A repository, a
 * guide to follow, an environment and what runs in it, a link to a board or a dashboard,
 * someone to reach, a fact that fits nowhere else.
 *
 * Added 2026-11-24 (MUS-59). The owner, of a project's page that showed steps, updates
 * and notes: "这个 UI 肯定不符合一个项目该有的东西吧，一个是 PM，如果是 devops 呢？肯定项目下面有很多
 * 仓库和指引吧", and then: "你要知道这里停留着啥，需要 muster 知道啥，不同的人他们常驻在这里的都是啥，既要
 * AI 可以操作，也可以用户手动编辑". A project manager, an engineer who runs services and a
 * salesperson keep different things in a project, so the page has no shape of its own
 * for each of them: it has kinds of things, and shows the kinds a project has.
 *
 * Each thing can be added, changed, moved and removed by hand on the project's page and
 * by an agent working in the project (`project.keep`, `project.drop`), under one rule:
 * the project's owner and whoever was brought in to work in it. Every conversation in
 * the project is told what lives there, with the message and never in the instructions
 * (runs.ts, `turnParts`), so an agent begins knowing where the code is and how things
 * are deployed without the person saying so again.
 */
export const ITEM_KINDS = ["repo", "guide", "environment", "link", "contact", "fact"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export const ITEMS_PER_PROJECT = 60;
export const ITEMS_PER_KIND = 20;
export const ITEM_TITLE_CHARS = 120;
export const ITEM_DETAIL_CHARS = 2000;
export const ITEM_URL_CHARS = 2000;
const VERSION_CHARS = 60;
const BRANCH_CHARS = 100;

/**
 * 55: what lives in a project. A guide may also be a file of the library: those are the
 * project's "key documents" (`project_docs`, step 35), which stay where they are kept,
 * because what protects a pinned file from being cleared away reads them there
 * (retention.ts, files/service.ts). A page and an agent are given the two as one list
 * (`listLives`).
 */
export const PROJECT_ITEMS_SCHEMA = [
  `create table if not exists project_items (
    id uuid primary key,
    org_id uuid not null references organizations(id) on delete cascade,
    project_id uuid not null references projects(id) on delete cascade,
    n integer not null,
    kind text not null check (kind in ('repo', 'guide', 'environment', 'link', 'contact', 'fact')),
    title text not null default '',
    detail text not null default '',
    url text,
    ref text,
    state jsonb not null default '{}'::jsonb,
    position integer not null default 0,
    created_by uuid references users(id) on delete set null,
    updated_by uuid references users(id) on delete set null,
    by_agent text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (project_id, n)
  )`,
  `create index if not exists project_items_project on project_items (project_id, kind, position)`,
  `create unique index if not exists project_items_ref on project_items (project_id, lower(ref)) where ref is not null`,
];

/**
 * 56: a project counts the things ever kept in it, so a number once given is never given
 * to another thing: an agent that names "[4]" from an earlier answer cannot reach what
 * took a removed thing's place.
 */
export const PROJECT_ITEMS_NUMBERS_SCHEMA = [
  "alter table projects add column if not exists item_seq integer not null default 0",
  `update projects p set item_seq = greatest(p.item_seq,
     coalesce((select max(i.n) from project_items i where i.project_id = p.id), 0))
    where exists (select 1 from project_items i where i.project_id = p.id)`,
];

export type ItemState = {
  version?: string;
  versionAt?: string;
  branch?: string;
  doc?: string;
  /** Someone to reach: how. */
  email?: string;
  phone?: string;
  /** A day that matters for it (a milestone, a renewal, when a report is due): YYYY-MM-DD. */
  due?: string;
};
export type ProjectItem = {
  id: string;
  /** Its number in the project: how an agent names it. */
  n: number;
  kind: ItemKind;
  title: string;
  /** What it is and how it is used: what an agent is told of it. */
  detail: string;
  url: string | null;
  /** A repository as its code host names it: "owner/name". */
  ref: string | null;
  /** A guide that is a file of the library. */
  file: {
    id: string;
    name: string;
    kind: string;
    size: number;
    version: number;
    shadowed: boolean;
  } | null;
  state: ItemState;
  position: number;
  /** Who last changed it: an agent's name, or a person's. */
  by: string | null;
  byAgent: boolean;
  updatedAt: Date;
};

type At = { orgId: string; userId: string; projectId: string; actorId?: string };

/** A thing that cannot be kept as asked, in words an agent can act on and a code a page can word. */
export class ItemProblem extends Error {
  constructor(
    readonly code: "invalid_item" | "too_many_items" | "item_exists" | "item_secret",
    message: string,
  ) {
    super(message);
  }
}

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9._-]{1,100}$/;
const line = (value: unknown, most: number) =>
  (typeof value === "string" ? value : "")
    .replace(/\s+/g, " ")
    .split("\u0000")
    .join("")
    .trim()
    .slice(0, most);
const words = (value: unknown, most: number) =>
  (typeof value === "string" ? value : "")
    .replace(/\r\n/g, "\n")
    .split("\u0000")
    .join("")
    .trim()
    .slice(0, most);

/** A number a thing in a project can have: anything else names nothing. */
const numbered = (n: unknown): n is number =>
  typeof n === "number" && Number.isInteger(n) && n > 0 && n <= 2_000_000_000;

const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;.]{2,}$/;
const PHONE = /^\+?\d[\d -]{1,28}$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** A real day of the calendar, written YYYY-MM-DD. */
const isDay = (text: string) => {
  if (!DAY.test(text)) return false;
  const at = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === text;
};

/**
 * Whether a text holds what looks like a key or a password. What lives in a project is
 * told to a model with every conversation in it, and shown to everyone in the project:
 * a secret kept there is a secret spread. The shapes are those the repository's own scan
 * refuses (automation/check-no-secrets.sh), and a word for a secret followed by a value.
 * A commit's name (forty letters and digits of sixteen) is not one.
 */
const SECRET_SHAPES = [
  /AKIA[0-9A-Z]{16}/,
  /gh[pousr]_[0-9A-Za-z]{36,}/,
  /github_pat_[0-9A-Za-z_]{22,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
];
const SECRET_WORD =
  /(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[ _-]?key|access[ _-]?key|密码|口令|密钥)\s*(?:is|=|:|：|是|为)\s*["'`]?([^\s"'`，。；;]{8,})/gi;
// Where a secret is kept, said in place of the secret, is what should be written.
const KEPT_ELSEWHERE =
  /password|vault|keychain|bitwarden|lastpass|keeper|secrets?manager|密码管理|保险库/i;
export function looksSecret(text: string): boolean {
  if (!text) return false;
  if (SECRET_SHAPES.some((shape) => shape.test(text))) return true;
  for (const found of text.matchAll(SECRET_WORD)) {
    const value = found[1] ?? "";
    if (KEPT_ELSEWHERE.test(value) || /^https?:/i.test(value)) continue;
    if (/\d/.test(value) && /[A-Za-z]/.test(value)) return true;
  }
  return false;
}
const secret = () =>
  new ItemProblem(
    "item_secret",
    "That looks like a key or a password; keep where it is found, not the secret itself.",
  );

/** An address a thing may point at: http or https, with nobody's name or password in it. */
export function itemUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  if (value.length > ITEM_URL_CHARS) return null;
  try {
    const found = new URL(value.trim());
    if (found.protocol !== "https:" && found.protocol !== "http:") return null;
    if (found.username || found.password) return null;
    return found.toString();
  } catch {
    return null;
  }
}

const COLUMNS = `i.id, i.n, i.kind, i.title, i.detail, i.url, i.ref, i.state, i.position,
  i.by_agent is not null as "byAgent",
  coalesce(i.by_agent, w.name) as "by", i.updated_at as "updatedAt"`;
const FROM = `project_items i join projects p on p.id = i.project_id
  left join users w on w.id = i.updated_by`;
// The kinds in the order a page shows them and an agent is told them.
const ORDER = `array_position(array['repo','guide','environment','link','contact','fact'], i.kind), i.position, i.n`;

type Row = Omit<ProjectItem, "file" | "state"> & { state: unknown };
const shaped = (row: Row): ProjectItem => {
  const { state, ...rest } = row;
  const kept = (state && typeof state === "object" ? state : {}) as Record<string, unknown>;
  const text = (key: string) => (typeof kept[key] === "string" ? (kept[key] as string) : undefined);
  return {
    ...rest,
    n: Number(rest.n),
    position: Number(rest.position),
    file: null,
    state: {
      ...(text("version") ? { version: text("version") } : {}),
      ...(text("versionAt") ? { versionAt: text("versionAt") } : {}),
      ...(text("branch") ? { branch: text("branch") } : {}),
      ...(text("doc") ? { doc: text("doc") } : {}),
      ...(text("email") ? { email: text("email") } : {}),
      ...(text("phone") ? { phone: text("phone") } : {}),
      ...(text("due") ? { due: text("due") } : {}),
    },
  };
};

/** What was put in a project, kind by kind in the order of the page; its pinned files are not among these. */
export async function listItems(db: Queryable, at: At): Promise<ProjectItem[]> {
  const rows = await db.query<Row>(
    `select ${COLUMNS} from ${FROM}
      where i.project_id = $1 and i.org_id = $2 and p.user_id = $3
      order by ${ORDER}`,
    [at.projectId, at.orgId, at.userId],
  );
  return rows.map(shaped);
}

async function one(db: Queryable, at: At, id: string): Promise<ProjectItem | null> {
  const row = (
    await db.query<Row>(
      `select ${COLUMNS} from ${FROM}
        where i.id = $4 and i.project_id = $1 and i.org_id = $2 and p.user_id = $3`,
      [at.projectId, at.orgId, at.userId, id],
    )
  )[0];
  return row ? shaped(row) : null;
}

export interface ItemInput {
  /** The thing to change, by its id or its number; neither: a new one. */
  id?: string;
  n?: number;
  kind?: unknown;
  title?: unknown;
  detail?: unknown;
  url?: unknown;
  ref?: unknown;
  /** An environment's version, a repository's branch. */
  version?: unknown;
  branch?: unknown;
  /** Someone to reach: an address for mail, a number to call. */
  email?: unknown;
  phone?: unknown;
  /** A day that matters for it, YYYY-MM-DD; "" takes it away. */
  due?: unknown;
}

/**
 * Holds the project while what lives in it is counted, numbered or moved, so two who
 * change it at once do so one after the other. False when it is not there for them.
 * (Inside a transaction; outside one it holds nothing and harms nothing.)
 */
async function held(db: Queryable, at: At): Promise<boolean> {
  return (
    (
      await db.query(
        "select 1 from projects where id = $1 and org_id = $2 and user_id = $3 for update",
        [at.projectId, at.orgId, at.userId],
      )
    ).length > 0
  );
}

/**
 * Adds a thing to a project, or changes one: only what is given is changed. `by` is the
 * agent that did it, or null for the person (`at.actorId`). Null when the project is not
 * there for them, or the thing named is not in it.
 */
export async function keepItem(
  db: Queryable,
  at: At,
  input: ItemInput,
  by: string | null,
  freshId: () => string,
  now: Date = new Date(),
): Promise<{ item: ProjectItem; made: boolean } | null> {
  const actor = at.actorId ?? at.userId;
  // A number that no thing can have names nothing: said so, not handed to the database.
  if (input.n !== undefined && !numbered(input.n)) return null;
  if (!(await held(db, at))) return null;
  const existing =
    input.id !== undefined || input.n !== undefined
      ? (
          await db.query<{ id: string; kind: ItemKind; state: unknown }>(
            `select i.id, i.kind, i.state from project_items i join projects p on p.id = i.project_id
              where i.project_id = $1 and i.org_id = $2 and p.user_id = $3
                and (i.id = $4::uuid or i.n = $5::integer)`,
            [at.projectId, at.orgId, at.userId, input.id ?? null, input.n ?? null],
          )
        )[0]
      : undefined;
  if ((input.id !== undefined || input.n !== undefined) && !existing) return null;
  const kind = existing?.kind ?? ITEM_KINDS.find((one) => one === input.kind);
  if (!kind)
    throw new ItemProblem(
      "invalid_item",
      `kind is one of: ${ITEM_KINDS.join(", ")}. A repository on the code host is "repo", something to follow is "guide", where something runs is "environment", an address to open is "link", someone to reach is "contact", and anything else worth knowing is "fact".`,
    );
  if (existing && input.kind !== undefined && input.kind !== existing.kind)
    throw new ItemProblem(
      "invalid_item",
      "What kind of thing it is cannot be changed. Remove it and add the other.",
    );
  const given = <T>(value: unknown, make: () => T): T | undefined =>
    value === undefined ? undefined : make();
  let title = given(input.title, () => line(input.title, ITEM_TITLE_CHARS + 1));
  const detail = given(input.detail, () => words(input.detail, ITEM_DETAIL_CHARS + 1));
  if ((title?.length ?? 0) > ITEM_TITLE_CHARS)
    throw new ItemProblem("invalid_item", `A name is ${ITEM_TITLE_CHARS} characters at most.`);
  if ((detail?.length ?? 0) > ITEM_DETAIL_CHARS)
    throw new ItemProblem(
      "invalid_item",
      `What is said of it is ${ITEM_DETAIL_CHARS} characters at most. Say it shorter, or keep the rest in a guide.`,
    );
  // An address given and not usable is said, not dropped: "" takes one away.
  let url: string | null | undefined;
  if (input.url !== undefined) {
    const asked = typeof input.url === "string" ? input.url.trim() : "";
    url = asked ? itemUrl(asked) : null;
    if (asked && !url)
      throw new ItemProblem(
        "invalid_item",
        "An address begins with https:// or http:// and carries no name or password.",
      );
  }
  let ref: string | undefined;
  if (kind === "repo") {
    if (input.ref !== undefined) {
      ref = typeof input.ref === "string" ? input.ref.trim() : "";
      if (!REPOSITORY.test(ref))
        throw new ItemProblem(
          "invalid_item",
          'A repository is named as its code host names it: "owner/name".',
        );
    } else if (!existing)
      throw new ItemProblem(
        "invalid_item",
        'A repository needs "ref": its name on the code host, "owner/name".',
      );
    if (!existing && !title) title = ref;
    // Looked for before it is written: a statement that fails would take the rest of
    // what is being done with it. The index is what holds when two are added at once.
    if (
      ref !== undefined &&
      (
        await db.query(
          "select 1 from project_items where project_id = $1 and lower(ref) = lower($2) and id is distinct from $3::uuid",
          [at.projectId, ref, existing?.id ?? null],
        )
      ).length > 0
    )
      throw exists();
  } else if (input.ref !== undefined && input.ref !== null && input.ref !== "")
    throw new ItemProblem("invalid_item", "Only a repository has a ref.");
  if (!existing && !title)
    throw new ItemProblem("invalid_item", "It needs a name: what a person would call it.");
  if (existing && title === "")
    throw new ItemProblem("invalid_item", "It needs a name: what a person would call it.");
  if (looksSecret(title ?? "") || looksSecret(detail ?? "")) throw secret();

  const before = (
    existing?.state && typeof existing.state === "object" ? existing.state : {}
  ) as Record<string, unknown>;
  const state: Record<string, unknown> = { ...before };
  if (kind === "environment" && input.version !== undefined) {
    const version = line(input.version, VERSION_CHARS);
    if (version !== (typeof before.version === "string" ? before.version : "")) {
      if (version) {
        state.version = version;
        // Since when: the moment it was said, which is all that is known here.
        state.versionAt = now.toISOString();
      } else {
        delete state.version;
        delete state.versionAt;
      }
    }
  }
  if (kind === "repo" && input.branch !== undefined) {
    const branch = line(input.branch, BRANCH_CHARS);
    if (branch) state.branch = branch;
    else delete state.branch;
  }
  if (input.email !== undefined || input.phone !== undefined) {
    if (kind !== "contact")
      throw new ItemProblem(
        "invalid_item",
        'Only someone to reach ("contact") has an email or a phone.',
      );
    if (input.email !== undefined) {
      const email = line(input.email, 255);
      if (email && (email.length > 254 || !EMAIL.test(email)))
        throw new ItemProblem("invalid_item", "An email is written name@example.com.");
      if (email) state.email = email;
      else delete state.email;
    }
    if (input.phone !== undefined) {
      const phone = line(input.phone, 40);
      if (phone && !PHONE.test(phone))
        throw new ItemProblem(
          "invalid_item",
          "A phone is digits, with spaces or dashes between them and a + before a country's code: 30 characters at most.",
        );
      if (phone) state.phone = phone;
      else delete state.phone;
    }
  }
  if (input.due !== undefined) {
    const due = line(input.due, 20);
    if (due && !isDay(due))
      throw new ItemProblem("invalid_item", "A day is written YYYY-MM-DD, for example 2026-12-15.");
    if (due) state.due = due;
    else delete state.due;
  }
  if (
    [state.version, state.branch].some((value) => typeof value === "string" && looksSecret(value))
  )
    throw secret();

  if (existing) {
    try {
      await db.query(
        `update project_items set
            title = coalesce($2, title), detail = coalesce($3, detail),
            url = case when $4::boolean then $5 else url end,
            ref = coalesce($6, ref), state = $7::jsonb,
            updated_by = $8, by_agent = $9, updated_at = $10::timestamptz
          where id = $1`,
        [
          existing.id,
          title ?? null,
          detail ?? null,
          url !== undefined,
          url ?? null,
          ref ?? null,
          JSON.stringify(state),
          actor,
          by,
          now.toISOString(),
        ],
      );
    } catch (error) {
      if (clash(error)) throw exists();
      throw error;
    }
    const item = await one(db, at, existing.id);
    return item ? { item, made: false } : null;
  }

  // Counted and numbered while the project is held (above): two added at once take
  // different numbers and cannot both take the last place.
  const counted = (
    await db.query<{ all: string; kind: string }>(
      `select count(*) as "all", count(*) filter (where kind = $2) as kind
         from project_items where project_id = $1`,
      [at.projectId, kind],
    )
  )[0];
  const ofKind = Number(counted?.kind ?? 0);
  if (ofKind >= ITEMS_PER_KIND || Number(counted?.all ?? 0) >= ITEMS_PER_PROJECT)
    throw new ItemProblem(
      "too_many_items",
      ofKind >= ITEMS_PER_KIND
        ? `A project keeps ${ITEMS_PER_KIND} of a kind at most. Remove one that no longer matters, or say several in one.`
        : `A project keeps ${ITEMS_PER_PROJECT} things at most. Remove what no longer matters.`,
    );
  // The next number the project has never given: one that was removed is not given again.
  const n = Number(
    (
      await db.query<{ n: number }>(
        `update projects set item_seq = greatest(item_seq,
             coalesce((select max(i.n) from project_items i where i.project_id = projects.id), 0)) + 1
          where id = $1 returning item_seq as n`,
        [at.projectId],
      )
    )[0]?.n,
  );
  const id = freshId();
  try {
    await db.query(
      `insert into project_items (id, org_id, project_id, n, kind, title, detail, url, ref, state, position, created_by, updated_by, by_agent, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb,
               coalesce((select max(position) from project_items where project_id = $3 and kind = $5), 0) + 1,
               $11, $11, $12, $13::timestamptz, $13::timestamptz)`,
      [
        id,
        at.orgId,
        at.projectId,
        n,
        kind,
        title ?? "",
        detail ?? "",
        url ?? null,
        ref ?? null,
        JSON.stringify(state),
        actor,
        by,
        now.toISOString(),
      ],
    );
  } catch (error) {
    if (clash(error)) throw exists();
    throw error;
  }
  const item = await one(db, at, id);
  return item ? { item, made: true } : null;
}

/**
 * Whether a write failed because the repository is already in the project: that rule's
 * own name, and no other. Anything else that fails is not that, and is not said to be.
 */
const clash = (error: unknown) => {
  if (typeof error !== "object" || error === null) return false;
  const failed = error as { code?: unknown; constraint?: unknown; message?: unknown };
  return (
    failed.code === "23505" &&
    (failed.constraint === "project_items_ref" ||
      (failed.constraint === undefined && /project_items_ref/.test(String(failed.message ?? ""))))
  );
};
const exists = () => new ItemProblem("item_exists", "That repository is already in the project.");

/** Takes a thing out of a project. What it was, or null when it is not there for them. */
export async function dropItem(
  db: Queryable,
  at: At,
  which: { id?: string; n?: number },
): Promise<ProjectItem | null> {
  if (which.n !== undefined && !numbered(which.n)) return null;
  const found = (
    await db.query<{ id: string }>(
      `select i.id from project_items i join projects p on p.id = i.project_id
        where i.project_id = $1 and i.org_id = $2 and p.user_id = $3
          and (i.id = $4::uuid or i.n = $5::integer)`,
      [at.projectId, at.orgId, at.userId, which.id ?? null, which.n ?? null],
    )
  )[0];
  if (!found) return null;
  const was = await one(db, at, found.id);
  await db.query("delete from project_items where id = $1", [found.id]);
  return was;
}

/**
 * Moves a thing among those of its kind: `to` is the place it takes, counted from 0.
 * The others close up around it. False when it is not there for them.
 */
export async function moveItem(db: Queryable, at: At, id: string, to: number): Promise<boolean> {
  // Held while places are read and written: two moves at once leave no two in one place.
  if (!(await held(db, at))) return false;
  const all = await listItems(db, at);
  const moved = all.find((item) => item.id === id);
  if (!moved) return false;
  const same = all.filter((item) => item.kind === moved.kind && item.id !== id);
  const place = Math.max(0, Math.min(same.length, Math.floor(Number.isFinite(to) ? to : 0)));
  same.splice(place, 0, moved);
  for (const [index, item] of same.entries())
    if (item.position !== index + 1)
      await db.query("update project_items set position = $2 where id = $1", [item.id, index + 1]);
  return true;
}

/**
 * A project's pinned files as guides: the same things, shown and told in the one list.
 * They are pinned and unpinned as before (projects.ts, `pinDoc`), by the project's owner,
 * whose files they are.
 */
export function guidesOf(docs: readonly ProjectDoc[]): ProjectItem[] {
  return docs.map((doc, index) => ({
    id: doc.fileId,
    n: 0,
    kind: "guide" as const,
    title: doc.name,
    detail: "",
    url: null,
    ref: null,
    file: {
      id: doc.fileId,
      name: doc.name,
      kind: doc.fileKind,
      size: doc.size,
      version: doc.version,
      shadowed: doc.shadowed,
    },
    state: { doc: doc.kind },
    position: index,
    by: null,
    byAgent: false,
    updatedAt: new Date(0),
  }));
}

/** Everything that lives in a project, as one list: what was put there and its pinned files. */
export function lives(items: readonly ProjectItem[], docs: readonly ProjectDoc[]): ProjectItem[] {
  const pinned = guidesOf(docs);
  return ITEM_KINDS.flatMap((kind) => [
    ...(kind === "guide" ? pinned : []),
    ...items.filter((item) => item.kind === kind),
  ]);
}

/** The kinds as the project's page names them: an agent and a person use the same words. */
const KIND_WORDS: Record<ItemKind, string> = {
  repo: "Repositories",
  guide: "Guides",
  environment: "Environments",
  link: "Links",
  contact: "Contacts",
  fact: "Facts",
};

/** One line: no break of any kind, so what a person wrote cannot begin a line of its own. */
// Every white space that is not a plain space (a return alone, a line or paragraph
// separator, a tab) and the "next line" mark, which is none to the language but breaks
// a line where it is read.
const flat = (text: string) => text.replace(/(?:[^\S ]|\u0085)+/g, " ").trim();

/** How a repository was last known to stand on its code host. */
export type RepoStanding = { branch?: string; pulls?: number | null; checks?: string | null };

/**
 * What lives in a project as an agent is told of it: each thing with its number, its
 * name as a quoted string (a name cannot close its own quotes), where it is, and what
 * was said of it, on one line whatever was written. Pinned files are not among them: the
 * list of key documents names those, and says how such a file is read.
 *
 * `standing` is how the repositories were last known to stand (their main branch, whether
 * the last checks passed, how many pull requests are open), by name in small letters. Only
 * what changes when the repository does is said, never when it was asked: this is told
 * again only when it differs from what was told before.
 */
export function itemsForAgent(
  items: readonly ProjectItem[],
  standing: Readonly<Record<string, RepoStanding>> = {},
): string {
  const out: string[] = [];
  for (const kind of ITEM_KINDS) {
    const of = items.filter((item) => item.kind === kind && !item.file);
    if (!of.length) continue;
    out.push(`${KIND_WORDS[kind]}:`);
    for (const item of of) {
      const known = item.ref ? standing[item.ref.toLowerCase()] : undefined;
      const facts = [
        item.ref && item.ref !== item.title ? JSON.stringify(item.ref) : "",
        item.state.branch
          ? `branch ${JSON.stringify(flat(item.state.branch))}`
          : known?.branch
            ? `main branch ${JSON.stringify(flat(known.branch))}`
            : "",
        known?.checks === "passing" || known?.checks === "failing"
          ? `last checks ${known.checks}`
          : "",
        typeof known?.pulls === "number" && known.pulls > 0
          ? `${known.pulls} pull request${known.pulls === 1 ? "" : "s"} open`
          : "",
        item.state.version
          ? `now at ${JSON.stringify(flat(item.state.version))}${item.state.versionAt ? ` since ${item.state.versionAt.slice(0, 10)}` : ""}`
          : "",
        item.state.email ? `mail ${flat(item.state.email)}` : "",
        item.state.phone ? `phone ${flat(item.state.phone)}` : "",
        item.state.due && DAY.test(item.state.due) ? `due ${item.state.due}` : "",
        item.url ? flat(item.url) : "",
      ].filter(Boolean);
      out.push(
        `- [${item.n}] ${JSON.stringify(flat(item.title))}${facts.length ? ` (${facts.join("; ")})` : ""}${
          item.detail ? `: ${flat(item.detail)}` : ""
        }`,
      );
    }
  }
  return out.join("\n");
}

/** How many of each a project's page counts at its top. */
export async function itemCounts(db: Queryable, at: At): Promise<{ items: number; repos: number }> {
  const row = (
    await db.query<{ items: string; repos: string }>(
      `select count(*) as items, count(*) filter (where i.kind = 'repo') as repos
         from project_items i join projects p on p.id = i.project_id
        where i.project_id = $1 and i.org_id = $2 and p.user_id = $3`,
      [at.projectId, at.orgId, at.userId],
    )
  )[0];
  return { items: Number(row?.items ?? 0), repos: Number(row?.repos ?? 0) };
}
