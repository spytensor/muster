import { createHash } from "node:crypto";
import { newId } from "@muster/protocol";
import { recordEvent } from "../audit.js";
import type { Db, Queryable } from "../db.js";
import { Refusal } from "../errors.js";
import { Unreadable } from "./extract.js";
import { cleanName, type FileKind, identify, isProtected } from "./kind.js";
import { CannotMake, type FileRecipe, makeFile } from "./make.js";
import { readProfile, readQuery, readSheets, readText } from "./reading.js";
import { CannotChange, change, type FileChange, kept, outline, RECIPE_BYTES } from "./revise.js";
import type { FileStore } from "./store.js";
import type { Query } from "./table.js";

/** The largest image shown to a model, and how many one message may show. */
// Kept under the smallest limit among model providers once the image is encoded for sending.
const IMAGE_BYTES = 3.5 * 1024 * 1024;
export const IMAGES_PER_MESSAGE = 4;

/** What one person may keep in total. */
export const QUOTA_BYTES = 1024 * 1024 * 1024;

export const FILE_COLUMNS = `id, name, kind, mime, size, source, conversation_id as "conversationId", created_at as "createdAt", version`;

/**
 * Migration 21: a file an agent makes keeps what it was made from, version by version.
 * The file's row stays the same file through its versions; each version holds the recipe,
 * so any of them can be made again, and a change is made to the latest.
 */
export const FILE_VERSIONS_SCHEMA = [
  `alter table files add column version integer not null default 1`,
  `create table file_versions (
    id uuid primary key,
    file_id uuid not null references files(id) on delete cascade,
    org_id uuid not null references organizations(id) on delete cascade,
    user_id uuid references users(id) on delete set null,
    n integer not null,
    recipe jsonb not null,
    size bigint not null,
    note text not null default '',
    conversation_id uuid,
    created_at timestamptz not null default now(),
    unique (file_id, n)
  )`,
];
/** The file moved on to another version between being read and being written. */
class Moved extends Error {}
/** How many versions of one file are kept. The oldest go first. */
const VERSIONS_KEPT = 50;

export type FileRow = {
  id: string;
  name: string;
  kind: FileKind;
  mime: string;
  size: number;
  source: "upload" | "agent";
  conversationId: string | null;
  createdAt: Date;
  /** Which version of the file this is. 1 for a file that was never changed. */
  version: number;
  /** Whether the file is the person's own. Absent on a row that was just made, which is. */
  mine?: boolean;
  /** Whether the person may change it: their own, or shared with them to change. */
  canChange?: boolean;
  /** Whose it is, when it is a colleague's that was shared with the person. */
  sharedBy?: { name: string; email: string } | null;
};
/**
 * The key documents of the projects the person ($3 of organization $2) was brought into.
 * Pinning a file in a project is what lets its people read it, and only read it: it is
 * what the project rests on, and a page that named it without opening it would be no use.
 */
const PINNED_IDS = `(select d.file_id from project_docs d
     join project_members pm on pm.project_id = d.project_id
    where pm.org_id = $2 and pm.user_id = $3)`;
/**
 * SQL that is true when the file in `f` was shared with the person ($3 of organization
 * $2), directly or through their department. `change` asks for a share to change it.
 */
const sharedFile = (change = false) => `(exists (
  select 1 from shares s
   where s.org_id = $2 and s.kind = 'file' and s.item_id = f.id ${change ? "and s.can_change" : ""}
     and ((s.to_kind = 'user' and s.to_id = $3)
       or (s.to_kind = 'department' and s.to_id = (
            select m.department_id from memberships m
             where m.org_id = $2 and m.user_id = $3 and m.status = 'active'))))${
               change ? "" : ` or f.id in ${PINNED_IDS}`
             })`;
/** A file as the person may reach it: theirs, or one shared with them. */
/** The files shared with the person ($3 of organization $2), found from the shares, not by reading every file. */
const SHARED_IDS = `(select s.item_id from shares s
   where s.org_id = $2 and s.kind = 'file'
     and ((s.to_kind = 'user' and s.to_id = $3)
       or (s.to_kind = 'department' and s.to_id = (
            select m.department_id from memberships m
             where m.org_id = $2 and m.user_id = $3 and m.status = 'active')))
   union select d.file_id from project_docs d
     join project_members pm on pm.project_id = d.project_id
    where pm.org_id = $2 and pm.user_id = $3)`;
const REACH_COLUMNS = `f.id, f.name, f.kind, f.mime, f.size, f.source, f.conversation_id as "conversationId",
  f.created_at as "createdAt", f.version, f.sha256, f.user_id as "ownerId",
  (f.user_id = $3) as mine, (f.user_id = $3 or ${sharedFile(true)}) as "canChange",
  case when f.user_id <> $3 then json_build_object('name', o.name, 'email', o.email) end as "sharedBy"`;
type Reached = FileRow & { sha256: string; ownerId: string; mine: boolean; canChange: boolean };
export type LibraryShow = "all" | "made" | "uploaded" | "notes";
export interface LibraryQuery {
  q: string;
  show: LibraryShow;
  kind: string | null;
  projectId: string | null;
  sort: "recent" | "name" | "size";
  offset: number;
  limit: number;
}
/** One thing in a person's library: a file, or a note. */
export type LibraryRow = {
  type: "file" | "note";
  id: string;
  name: string;
  kind: string;
  mime: string;
  size: number;
  source: "upload" | "agent" | "note";
  at: Date;
  version: number;
  mine: boolean;
  sharedBy: { name: string; email: string } | null;
  /** The conversation it was made or sent in, when that conversation is the person's. */
  conversationId: string | null;
  conversationTitle: string | null;
  projectId: string | null;
  projectName: string | null;
  /** The words around what was looked for, when it was found in the file and not in its name. */
  found: string | null;
};
export interface LibraryPage {
  rows: LibraryRow[];
  /** How many there are under what was asked for, of which `rows` is a page. */
  total: number;
  counts: Record<LibraryShow, number>;
  usedBytes: number;
  /** Where the next page begins, or null at the end. */
  next: number | null;
}
/** What someone said about a file: on which part, and whether it has been dealt with. */
export type FileComment = {
  n: number;
  part: string;
  body: string;
  status: "open" | "resolved";
  by: string | null;
  mine: boolean;
  createdAt: Date;
  resolvedBy: string | null;
  resolvedVersion: number | null;
};
/** The most comments one file holds, and the most one may say. */
const COMMENTS = 200;
/** How many open comments an agent is shown with a file's parts. */
const OUTLINE_COMMENTS = 20;
export const COMMENT_CHARS = 2000;
/** One version of a file: what changed, when, by whom. */
export type FileVersion = {
  n: number;
  note: string;
  size: number;
  createdAt: Date;
  by: string | null;
};
/** A file as a message carries it: enough to show it and to find it again. */
export interface Attachment {
  id: string;
  name: string;
  kind: FileKind;
  size: number;
}
interface Owner {
  orgId: string;
  userId: string;
  email: string;
}

const ending = (name: string) => name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";

/**
 * Everything the server does with people's files, in one place: the routes and the
 * agents' tools both go through here, so the same rules hold for both.
 */
export class Files {
  constructor(
    private readonly db: Db,
    private readonly store: FileStore,
    readonly maxBytes: number,
  ) {}

  private key(orgId: string, id: string) {
    return `${orgId}/${id}`;
  }

  async list(owner: Pick<Owner, "orgId" | "userId">): Promise<FileRow[]> {
    const columns = REACH_COLUMNS.replace("f.sha256, ", "").replace('f.user_id as "ownerId",', "");
    // The person's own files, and those colleagues shared with them: each found by its
    // own index, never by reading every file of the organization.
    const [own, shared] = await Promise.all(
      ["f.user_id = $3", `f.user_id <> $3 and f.id in ${SHARED_IDS}`].map((which) =>
        this.db.query<FileRow>(
          `select ${columns} from files f join users o on o.id = f.user_id
            where f.org_id = $2 and f.deleted_at is null and $1::text = '' and ${which}
            order by f.created_at desc limit 500`,
          ["", owner.orgId, owner.userId],
        ),
      ),
    );
    return [...(own ?? []), ...(shared ?? [])]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 500)
      .map((row) => ({ ...row, size: Number(row.size) }));
  }

  /**
   * A page of the person's library: their files, those shared with them and their notes
   * in one list, found by a word in the name or in what they say, narrowed by where they
   * came from, their kind and their project, in the order asked for. Written for a
   * library of thousands: the database finds, sorts and counts, and a page is handed over.
   */
  async library(
    owner: Pick<Owner, "orgId" | "userId">,
    wanted: LibraryQuery,
  ): Promise<LibraryPage> {
    const params: unknown[] = ["", owner.orgId, owner.userId];
    const put = (value: unknown) => `$${params.push(value)}`;
    const rows = `(
      select 'file' as type, f.id, f.name, f.kind, f.mime, f.size, f.source,
             f.created_at as at, f.version, (f.user_id = $3) as mine,
             case when f.user_id <> $3 then json_build_object('name', o.name, 'email', o.email) end as shared_by,
             c.id as conversation_id, c.title as conversation_title,
             p.id as project_id, p.name as project_name, coalesce(f.search_text, '') as body
        from files f join users o on o.id = f.user_id
        -- Where it came from is said only of the person's own conversations.
        left join conversations c on c.id = f.conversation_id and c.user_id = $3
        left join projects p on p.id = c.project_id
       where f.org_id = $2 and f.deleted_at is null and $1::text = ''
         and (f.user_id = $3 or f.id in ${SHARED_IDS})
      union all
      select 'note', d.id, d.title, 'note', 'text/markdown', length(d.content)::bigint, 'note',
             d.updated_at, 1, true, null, null, null, null, null, d.content
        from documents d where d.org_id = $2 and d.user_id = $3
    ) r`;
    const narrowed: string[] = [];
    const q = wanted.q.trim().slice(0, 200);
    // A word typed is a word looked for: % and _ mean themselves.
    const like = q ? put(`%${q.replace(/[\\%_]/g, "\\$&")}%`) : "";
    if (q) narrowed.push(`(r.name ilike ${like} or r.body ilike ${like})`);
    if (wanted.kind) narrowed.push(`r.kind = ${put(wanted.kind)}`);
    if (wanted.projectId) narrowed.push(`r.project_id = ${put(wanted.projectId)}`);
    const shows: Record<LibraryShow, string> = {
      all: "true",
      made: "r.source = 'agent'",
      uploaded: "r.source = 'upload'",
      notes: "r.type = 'note'",
    };
    const where = narrowed.length ? `where ${narrowed.join(" and ")}` : "";
    const [counted] = await this.db.query<Record<LibraryShow, string>>(
      `select ${(Object.keys(shows) as LibraryShow[])
        .map((key) => `count(*) filter (where ${shows[key]}) as "${key}"`)
        .join(", ")} from ${rows} ${where}`,
      params,
    );
    const counts = Object.fromEntries(
      (Object.keys(shows) as LibraryShow[]).map((key) => [key, Number(counted?.[key] ?? 0)]),
    ) as Record<LibraryShow, number>;
    const order = {
      recent: "r.at desc, r.id",
      name: "lower(r.name), r.id",
      size: "r.size desc, r.id",
    }[wanted.sort];
    const limit = Math.min(100, Math.max(1, Math.floor(wanted.limit)));
    const offset = Math.min(1_000_000_000, Math.max(0, Math.floor(wanted.offset)));
    // Where a word was found in what a file says and not in its name, the words around it.
    const found = q
      ? `case when r.name ilike ${like} then null
              else substring(r.body from greatest(1, position(lower(${put(q)}) in lower(r.body)) - 40) for 160) end`
      : "null";
    const page = await this.db.query<LibraryRow & { size: string }>(
      `select r.type, r.id, r.name, r.kind, r.mime, r.size, r.source, r.at, r.version, r.mine,
              r.shared_by as "sharedBy", r.conversation_id as "conversationId",
              r.conversation_title as "conversationTitle", r.project_id as "projectId",
              r.project_name as "projectName", ${found} as found
         from ${rows} ${where ? `${where} and` : "where"} ${shows[wanted.show]}
        order by ${order} limit ${limit} offset ${offset}`,
      params,
    );
    const [used] = await this.db.query<{ bytes: string }>(
      "select coalesce(sum(size), 0) as bytes from files where org_id = $1 and user_id = $2 and deleted_at is null",
      [owner.orgId, owner.userId],
    );
    const total = counts[wanted.show];
    return {
      rows: page.map((row) => ({
        ...row,
        size: Number(row.size),
        found: row.found ? row.found.replace(/\s+/g, " ").trim() : null,
      })),
      total,
      counts,
      usedBytes: Number(used?.bytes ?? 0),
      next: offset + page.length < total ? offset + page.length : null,
    };
  }

  /** Deletes the person's own notes among these. Returns how many went. */
  async removeNotes(owner: Pick<Owner, "orgId" | "userId">, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    return (
      await this.db.query(
        "delete from documents where id = any($1::uuid[]) and org_id = $2 and user_id = $3 returning id",
        [ids, owner.orgId, owner.userId],
      )
    ).length;
  }

  /**
   * Reads what a few files say and keeps it, so they can be found by their words. Called
   * again and again: a file just made or changed is read within a few seconds, and files
   * kept before this was written are read in turn. Returns how many it read.
   */
  /** How often reading a file for search has failed for a reason that may pass. */
  private unread = new Map<string, number>();
  async indexPending(most = 5): Promise<number> {
    const waiting = await this.db.query<FileRow & { sha256: string; orgId: string }>(
      `select id, org_id as "orgId", name, kind, mime, size, sha256 from files
        where search_text is null and deleted_at is null order by created_at desc limit $1`,
      [most],
    );
    for (const file of waiting) {
      let text = "";
      try {
        // An image says nothing.
        if (file.kind !== "image") text = (await this.longText(file.orgId, file, 100_000)).text;
        this.unread.delete(file.id);
      } catch (error) {
        // A file that cannot be read says nothing, for good. Anything else (the store or
        // the reader failing for a moment) is tried again on a later pass, three times,
        // so that a passing fault does not leave a file unfound for ever, and one that
        // always fails does not keep the files after it waiting.
        const tries = (this.unread.get(file.id) ?? 0) + 1;
        if (!(error instanceof Unreadable) && tries < 3) {
          this.unread.set(file.id, tries);
          continue;
        }
        this.unread.delete(file.id);
      }
      // Characters the database cannot hold are taken out.
      await this.db.query("update files set search_text = $2 where id = $1 and sha256 = $3", [
        file.id,
        text.split("\u0000").join("").slice(0, 100_000),
        file.sha256,
      ]);
    }
    return waiting.length;
  }

  /** Keeps a file. Refuses with a reason when its name, kind, size or the person's remaining space does not allow it. */
  async add(
    owner: Owner,
    input: {
      name: string;
      bytes: Uint8Array;
      source: "upload" | "agent";
      conversationId?: string | null;
      /** Replace the person's earlier file of the same name that an agent made. */
      replace?: boolean;
      /**
       * Take the place of what an earlier run of code in the same conversation kept under
       * this name, and of nothing else: not a file made from a recipe, which has versions
       * and may be shared, and not a file of another conversation.
       */
      replaceRun?: boolean;
      ip?: string | null;
    },
  ): Promise<FileRow> {
    const name = cleanName(input.name);
    if (!name) throw new Refusal("invalid_file_name");
    if (input.bytes.byteLength > this.maxBytes) throw new Refusal("file_too_large");
    if (input.bytes.byteLength === 0) throw new Refusal("empty_file");
    const what = identify(name, input.bytes);
    if (!what)
      throw new Refusal(isProtected(name, input.bytes) ? "protected_file" : "unsupported_file");
    const id = newId();
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const replaced: string[] = [];
    const row = await this.db.tx(async (tx) => {
      // One person's files are counted one at a time, so two at once cannot both slip under the limit.
      await tx.query("select pg_advisory_xact_lock(hashtext($1))", [owner.userId]);
      if (input.replace) {
        const old = await tx.query<{ id: string }>(
          `update files set deleted_at = now() where org_id = $1 and user_id = $2 and name = $3
              and source = 'agent' and deleted_at is null returning id`,
          [owner.orgId, owner.userId, name],
        );
        replaced.push(...old.map((item) => item.id));
      }
      if (input.replaceRun && input.conversationId) {
        const old = await tx.query<{ id: string }>(
          `update files set deleted_at = now() where org_id = $1 and user_id = $2 and name = $3
              and source = 'agent' and deleted_at is null and conversation_id = $4
              and not exists (select 1 from file_versions v where v.file_id = files.id)
              and not exists (select 1 from shares s where s.kind = 'file' and s.item_id = files.id)
              and not exists (select 1 from project_docs d where d.file_id = files.id)
            returning id`,
          [owner.orgId, owner.userId, name, input.conversationId],
        );
        replaced.push(...old.map((item) => item.id));
      }
      const used = Number(
        (
          await tx.query<{ used: string }>(
            "select coalesce(sum(size), 0) as used from files where org_id = $1 and user_id = $2 and deleted_at is null",
            [owner.orgId, owner.userId],
          )
        )[0]?.used ?? 0,
      );
      if (used + input.bytes.byteLength > QUOTA_BYTES) throw new Refusal("file_quota");
      const made = (
        await tx.query<FileRow>(
          `insert into files (id, org_id, user_id, name, kind, mime, size, sha256, source, conversation_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning ${FILE_COLUMNS}`,
          [
            id,
            owner.orgId,
            owner.userId,
            name,
            what.kind,
            what.mime,
            input.bytes.byteLength,
            sha256,
            input.source,
            input.conversationId ?? null,
          ],
        )
      )[0] as FileRow;
      await recordEvent(tx, {
        orgId: owner.orgId,
        actor: { userId: owner.userId, email: owner.email },
        action: input.source === "agent" ? "file.created" : "file.uploaded",
        target: { type: "file", id, label: name },
        detail: { kind: what.kind, size: input.bytes.byteLength, sha256 },
        ip: input.ip ?? null,
      });
      // Written inside the transaction: if the bytes cannot be kept, neither is the record.
      await this.store.put(this.key(owner.orgId, id), input.bytes);
      return made;
    });
    for (const old of replaced) await this.store.remove(this.key(owner.orgId, old));
    return { ...row, size: Number(row.size) };
  }

  /** A file the person may open, by id: their own, or one shared with them. */
  async find(owner: Pick<Owner, "orgId" | "userId">, id: string) {
    return (
      await this.db.query<Reached>(
        `select ${REACH_COLUMNS} from files f join users o on o.id = f.user_id
          where f.id = $1 and f.org_id = $2 and f.deleted_at is null
            and (f.user_id = $3 or ${sharedFile()})`,
        [id, owner.orgId, owner.userId],
      )
    )[0];
  }
  /** The newest of the person's files with this exact name. */
  private async byName(
    owner: Pick<Owner, "orgId" | "userId">,
    name: string,
    /** Only a file an agent made: the one a recipe belongs to, whatever was uploaded under that name since. */
    made = false,
    /** Also a file a colleague shared with the person, when they have none of the name. */
    shared = true,
  ) {
    const look = (which: string) =>
      this.db.query<Reached>(
        `select ${REACH_COLUMNS} from files f join users o on o.id = f.user_id
          where f.name = $1 and f.org_id = $2 and f.deleted_at is null and ${which}
            and ($4 = false or f.source = 'agent')
          -- Of files an agent made, one made from a recipe before one a run of code kept:
          -- only the first can be changed in place.
          order by ($4 and exists (select 1 from file_versions v where v.file_id = f.id)) desc,
                   f.created_at desc limit 1`,
        [name, owner.orgId, owner.userId, made],
      );
    // The person's own first. A colleague's of the same name only when they have none.
    return (
      (await look("f.user_id = $3"))[0] ??
      (shared ? (await look(`f.user_id <> $3 and f.id in ${SHARED_IDS}`))[0] : undefined)
    );
  }

  /** The files a message brings along, or null when any of them is not the person's. */
  async attachments(
    owner: Pick<Owner, "orgId" | "userId">,
    ids: string[],
  ): Promise<Attachment[] | null> {
    const found: Attachment[] = [];
    for (const id of new Set(ids)) {
      const file = await this.find(owner, id);
      if (!file) return null;
      found.push({ id: file.id, name: file.name, kind: file.kind, size: Number(file.size) });
    }
    return found;
  }

  /** The bytes of one of the person's images, for a model that can see them. Null when it is too large to show. */
  async image(orgId: string, file: Attachment): Promise<{ data: string; mimeType: string } | null> {
    if (file.kind !== "image" || file.size > IMAGE_BYTES) return null;
    const bytes = await this.store.read(this.key(orgId, file.id));
    const what = bytes && identify(file.name, bytes);
    return bytes && what
      ? { data: Buffer.from(bytes).toString("base64"), mimeType: what.mime }
      : null;
  }

  content(orgId: string, id: string) {
    return this.store.get(this.key(orgId, id));
  }

  /**
   * Something worked out from a file's content — its PDF, its text, its grids — kept
   * under the content's own hash, so it is worked out once however often it is asked
   * for. A failure is kept too: a file that could not be read is not tried again.
   */
  private async derived<T>(
    orgId: string,
    sha256: string,
    what: "text" | "sheets",
    compute: () => Promise<T>,
  ): Promise<T> {
    const key = `${orgId}/derived/${sha256}.${what}.json`;
    const kept = await this.store.read(key);
    if (kept) {
      const saved = JSON.parse(new TextDecoder().decode(kept)) as { value?: T; problem?: string };
      if (saved.problem !== undefined) throw new Unreadable(saved.problem);
      return saved.value as T;
    }
    const save = (body: object) =>
      this.store.put(key, new TextEncoder().encode(JSON.stringify(body)));
    try {
      const value = await compute();
      await save({ value });
      return value;
    } catch (error) {
      if (error instanceof Unreadable) await save({ problem: error.message });
      throw error;
    }
  }

  /** The text of a file, as an agent or the viewer's fallback reads it. Throws Unreadable with a reason a person can read. */
  async text(orgId: string, file: FileRow & { sha256: string }) {
    return this.derived(orgId, file.sha256, "text", async () => {
      const bytes = await this.store.read(this.key(orgId, file.id));
      if (!bytes) throw new Unreadable("That file's content is gone.");
      return readText(file, bytes);
    });
  }
  /** More of a file's text than an agent is handed at once: for what is kept and searched, not read in one go. */
  async longText(orgId: string, file: FileRow & { sha256: string }, limit: number) {
    const bytes = await this.store.read(this.key(orgId, file.id));
    if (!bytes) throw new Unreadable("That file's content is gone.");
    return readText(file, bytes, limit);
  }
  /** A workbook's sheets as grids, for showing it as a spreadsheet. */
  async sheets(orgId: string, file: FileRow & { sha256: string }) {
    return this.derived(orgId, file.sha256, "sheets", async () => {
      const bytes = await this.store.read(this.key(orgId, file.id));
      if (!bytes) throw new Unreadable("That file's content is gone.");
      return readSheets(file, bytes);
    });
  }
  async textByName(owner: Pick<Owner, "orgId" | "userId">, name: string): Promise<string> {
    const file = await this.byName(owner, name.trim());
    if (!file)
      throw new Error(`There is no file named "${name}". Use files.list to see the exact names.`);
    try {
      const { text, truncated } = await this.text(owner.orgId, file);
      return `${text || "(This file has no text.)"}${truncated ? "\n\n[The file continues; only the beginning is shown.]" : ""}`;
    } catch (error) {
      throw error instanceof Unreadable ? new Error(error.message) : error;
    }
  }

  /** A file's own bytes, by its exact name: what a sandbox is handed to work on. */
  async bytesByName(
    owner: Pick<Owner, "orgId" | "userId">,
    name: string,
  ): Promise<{ name: string; bytes: Uint8Array }> {
    const file = await this.byName(owner, name.trim());
    if (!file)
      throw new Error(`There is no file named "${name}". Use files.list to see the exact names.`);
    const bytes = await this.store.read(this.key(owner.orgId, file.id));
    if (!bytes) throw new Error("That file's content is gone.");
    return { name: file.name, bytes };
  }

  /**
   * Makes a file for the person from an agent's recipe. A file of that name the agent made
   * before is the same file, in its next version.
   */
  async make(
    owner: Owner,
    name: string,
    recipe: FileRecipe,
    conversationId: string,
    /** What could not be made as asked and was left out. */
    left: string[] = [],
  ): Promise<FileRow> {
    const cleaned = cleanName(name);
    // The content is made first, then judged like any other file: by its name and its bytes.
    const probe = cleaned ? identify(cleaned, this.sample(cleaned)) : null;
    if (!cleaned || !probe)
      throw new Error("A file needs a name ending in docx, xlsx, pptx, html, md, txt or csv.");
    // A file made anew is the person's own, whatever a colleague shared under that name.
    const before = (await this.byName(owner, cleaned, true, false)) ?? null;
    return this.put(owner, before, cleaned, recipe, {
      conversationId,
      note: before ? "Made again, whole" : "Made",
      left,
    });
  }

  /** Makes the bytes from a recipe and keeps them: a new file, or the next version of one. */
  private async put(
    owner: Owner,
    before: (FileRow & { sha256: string; ownerId?: string }) | null,
    name: string,
    recipe: FileRecipe,
    how: { conversationId: string | null; note: string; ip?: string | null; left?: string[] },
  ): Promise<FileRow> {
    const probe = identify(name, this.sample(name));
    if (!probe) throw new Error("That kind of file cannot be made.");
    const source = kept(name, recipe);
    if (JSON.stringify(source).length > RECIPE_BYTES)
      throw new Error(
        "This file has grown too large to keep building here. Split it into two files.",
      );
    let bytes: Uint8Array;
    try {
      bytes = await makeFile(name, probe.kind, source, how.left);
    } catch (error) {
      throw error instanceof CannotMake ? new Error(error.message) : error;
    }
    const refused = (error: unknown) => {
      if (error instanceof Moved)
        return new Error(
          `"${name}" was changed in another conversation while you were working. Look at it again with files.outline and make your change to what is there now.`,
        );
      if (error instanceof Refusal)
        return new Error(
          error.code === "file_quota"
            ? "The person has no space left for this file."
            : error.code === "file_too_large"
              ? "That file would be larger than this server accepts."
              : "That file could not be kept.",
        );
      return error;
    };
    if (!before) {
      try {
        const made = await this.add(owner, {
          name,
          bytes,
          source: "agent",
          conversationId: how.conversationId,
        });
        await this.db.query(
          `insert into file_versions (id, file_id, org_id, user_id, n, recipe, size, note, conversation_id)
           values ($1, $2, $3, $4, 1, $5::jsonb, $6, $7, $8)`,
          [
            newId(),
            made.id,
            owner.orgId,
            owner.userId,
            JSON.stringify(source),
            bytes.byteLength,
            how.note,
            how.conversationId,
          ],
        );
        return made;
      } catch (error) {
        throw refused(error);
      }
    }
    if (bytes.byteLength > this.maxBytes) throw refused(new Refusal("file_too_large"));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    try {
      // A colleague's file takes its space from its owner's, whoever changes it.
      const holder = before.ownerId ?? owner.userId;
      const row = await this.db.tx(async (tx) => {
        await tx.query("select pg_advisory_xact_lock(hashtext($1))", [holder]);
        const used = Number(
          (
            await tx.query<{ used: string }>(
              "select coalesce(sum(size), 0) as used from files where org_id = $1 and user_id = $2 and deleted_at is null and id <> $3",
              [owner.orgId, holder, before.id],
            )
          )[0]?.used ?? 0,
        );
        if (used + bytes.byteLength > QUOTA_BYTES) throw new Refusal("file_quota");
        const next = (
          await tx.query<FileRow>(
            `update files set size = $2, sha256 = $3, version = version + 1, search_text = null, conversation_id = coalesce($4, conversation_id)
              where id = $1 and deleted_at is null and version = $5 returning ${FILE_COLUMNS}`,
            [before.id, bytes.byteLength, sha256, how.conversationId, before.version],
          )
        )[0];
        // Somebody changed it since it was read: this change was worked out from a version
        // that is no longer the latest, and writing it would undo theirs.
        if (!next) throw new Moved();
        await tx.query(
          `insert into file_versions (id, file_id, org_id, user_id, n, recipe, size, note, conversation_id)
           values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
          [
            newId(),
            before.id,
            owner.orgId,
            owner.userId,
            next.version,
            JSON.stringify(source),
            bytes.byteLength,
            how.note.slice(0, 300),
            how.conversationId,
          ],
        );
        // The oldest go, but never the first, nor the newest the file's owner made: a
        // colleague who may change it cannot take the owner's way back away.
        await tx.query(
          `delete from file_versions v where v.file_id = $1 and v.n <= $2 and v.n > 1
              and v.n <> coalesce((select max(k.n) from file_versions k where k.file_id = $1 and k.user_id = $3), 0)`,
          [before.id, next.version - VERSIONS_KEPT, holder],
        );
        await recordEvent(tx, {
          orgId: owner.orgId,
          actor: { userId: owner.userId, email: owner.email },
          action: "file.changed",
          target: { type: "file", id: before.id, label: name },
          detail: { version: next.version, note: how.note.slice(0, 300), size: bytes.byteLength },
          ip: how.ip ?? null,
        });
        await this.store.put(this.key(owner.orgId, before.id), bytes);
        return next;
      });
      // What was worked out from the content it had is of no use to anyone now, unless
      // another file in the organization still has that very content.
      if (before.sha256 !== sha256) {
        const others = await this.db.query(
          "select 1 from files where org_id = $1 and sha256 = $2 and deleted_at is null limit 1",
          [owner.orgId, before.sha256],
        );
        if (others.length === 0)
          for (const kind of ["pdf", "text.json", "sheets.json"])
            await this.store.remove(`${owner.orgId}/derived/${before.sha256}.${kind}`);
      }
      return { ...row, size: Number(row.size) };
    } catch (error) {
      throw refused(error);
    }
  }

  /** A file an agent made, with the recipe of its latest version. */
  private async source(owner: Pick<Owner, "orgId" | "userId">, name: string) {
    const wanted = cleanName(name) ?? name.trim();
    // The person's own file of this name, made here or uploaded, before any colleague's:
    // a file shared under a name the person already uses never takes its place.
    const file =
      (await this.byName(owner, wanted, true, false)) ??
      (await this.byName(owner, wanted, false, false)) ??
      (await this.byName(owner, wanted, true)) ??
      (await this.byName(owner, wanted));
    if (!file)
      throw new Error(`There is no file named "${name}". Use files.list to see the exact names.`);
    const latest = (
      await this.db.query<{ recipe: FileRecipe }>(
        "select recipe from file_versions where file_id = $1 order by n desc limit 1",
        [file.id],
      )
    )[0];
    if (file.source !== "agent" || !latest)
      throw new Error(
        file.source === "agent"
          ? `"${file.name}" was made before files kept what they were made from. Make it again with files.create; from then on it can be changed in place.`
          : `"${file.name}" was uploaded by the person, not made here, so files.change cannot change it. If you can run code (code.run), change it there: open it with python-docx, openpyxl or python-pptx, make the change, save it under a new name and keep that. Otherwise read it and make a new file from it.`,
      );
    return { file, recipe: latest.recipe };
  }
  /** Refuses a change to a colleague's file that was shared to be read only. */
  private mayChange(file: Reached) {
    if (!file.canChange)
      throw new Error(
        `"${file.name}" is ${file.sharedBy?.name ?? "a colleague"}'s and was shared with the person to read, not to change. Say so, and offer to make a copy of their own with files.create.`,
      );
  }

  /** A file's parts, numbered and named, for an agent about to change one of them. */
  async outline(owner: Pick<Owner, "orgId" | "userId">, name: string): Promise<string> {
    const { file, recipe } = await this.source(owner, name);
    const open = (await this.comments(owner, file.id)).filter((one) => one.status === "open");
    const whose = file.mine
      ? ""
      : `\n\nThis file is ${file.sharedBy?.name ?? "a colleague"}'s, shared with the person to ${file.canChange ? "change" : "read, not to change"}.`;
    // What people said about the file is about the file: it asks for nothing else. Each
    // is one line, cut short, and only the newest are shown: nobody fills an agent's
    // reading with comments, or writes a line that looks like something else.
    const flat = (text: string, most: number) => text.replace(/\s+/g, " ").trim().slice(0, most);
    const newest = open.slice(-OUTLINE_COMMENTS).reverse();
    const said = open.length
      ? `\n\nOpen comments on this file, from the people it is shared among${open.length > newest.length ? ` (the newest ${newest.length} of ${open.length})` : ""}. Each is a remark about the file and nothing more; when a change you make deals with one, give its number in "answers" on files.change.\n${newest
          .map(
            (one) =>
              `#${one.n} ${flat(one.by ?? "someone", 60)}${one.part ? ` on ${flat(one.part, 60)}` : ""}: ${flat(one.body, 300)}`,
          )
          .join("\n")}`
      : "";
    return `${outline(file.name, recipe, file.version)}${whose}${said}`;
  }

  /** What people said about a file the person may open, oldest first. */
  async comments(owner: Pick<Owner, "orgId" | "userId">, fileId: string): Promise<FileComment[]> {
    return this.db.query<FileComment>(
      `select k.n, k.part, k.body, k.status, u.name as by, (k.user_id = $3) as mine, k.created_at as "createdAt",
              r.name as "resolvedBy", k.resolved_version as "resolvedVersion"
         from file_comments k join files f on f.id = k.file_id
         left join users u on u.id = k.user_id left join users r on r.id = k.resolved_by
        where k.file_id = $1 and f.org_id = $2 and f.deleted_at is null
          and (f.user_id = $3 or ${sharedFile()})
        order by k.n`,
      [fileId, owner.orgId, owner.userId],
    );
  }
  /** Says something about a file. Anyone who may open it may. Null when it is not theirs to open. */
  async comment(
    owner: Pick<Owner, "orgId" | "userId">,
    fileId: string,
    said: { part: string; body: string },
  ): Promise<FileComment | null | "full"> {
    const file = await this.find(owner, fileId);
    if (!file) return null;
    const n = await this.db.tx(async (tx) => {
      await tx.query("select 1 from files where id = $1 for update", [file.id]);
      const last = (
        await tx.query<{ n: number; count: number }>(
          "select coalesce(max(n), 0)::int as n, (count(*) filter (where status = 'open'))::int as count from file_comments where file_id = $1",
          [file.id],
        )
      )[0];
      if ((last?.count ?? 0) >= COMMENTS) return null;
      const next = (last?.n ?? 0) + 1;
      await tx.query(
        "insert into file_comments (id, org_id, file_id, n, user_id, part, body) values ($1, $2, $3, $4, $5, $6, $7)",
        [newId(), owner.orgId, file.id, next, owner.userId, said.part, said.body],
      );
      return next;
    });
    if (n === null) return "full";
    return (await this.comments(owner, file.id)).find((one) => one.n === n) ?? null;
  }
  /**
   * Marks comments dealt with, or open again. For whoever may change the file, and for
   * the person who made the comment. Returns how many were changed.
   */
  async settle(
    owner: Pick<Owner, "orgId" | "userId">,
    fileId: string,
    numbers: number[],
    status: "open" | "resolved",
    version: number | null = null,
  ): Promise<number> {
    const file = await this.find(owner, fileId);
    if (!file || numbers.length === 0) return 0;
    const changed = await this.db.query(
      `update file_comments set status = $3, resolved_by = case when $3 = 'resolved' then $4::uuid end,
              resolved_version = case when $3 = 'resolved' then $5::int end,
              resolved_at = case when $3 = 'resolved' then now() end
        where file_id = $1 and n = any($2::int[]) and status <> $3 and ($6 or user_id = $4)
        returning n`,
      [file.id, numbers, status, owner.userId, version, file.canChange],
    );
    return changed.length;
  }

  /** Changes one part of a file an agent made. The result is the file's next version. */
  async change(
    owner: Owner,
    name: string,
    wanted: FileChange,
    conversationId: string,
    left: string[] = [],
    /** The numbers of the comments this change deals with. */
    answers: number[] = [],
  ): Promise<{ file: FileRow; note: string }> {
    const { file, recipe } = await this.source(owner, name);
    this.mayChange(file);
    let next: { recipe: FileRecipe; note: string };
    try {
      next = change(file.name, recipe, wanted);
    } catch (error) {
      throw error instanceof CannotChange ? new Error(error.message) : error;
    }
    // Which comments it answers is part of what the version says of itself.
    const open = answers.length
      ? (await this.comments(owner, file.id)).filter(
          (one) => one.status === "open" && answers.includes(one.n),
        )
      : [];
    const note = open.length
      ? `${next.note}; answers ${open.map((one) => `#${one.n}${one.by ? ` (${one.by})` : ""}`).join(", ")}`
      : next.note;
    const made = await this.put(owner, file, file.name, next.recipe, {
      conversationId,
      note,
      left,
    });
    if (open.length)
      await this.settle(
        owner,
        file.id,
        open.map((one) => one.n),
        "resolved",
        made.version,
      );
    return { file: made, note };
  }

  /** The versions of one of the person's files, newest first. */
  async versions(owner: Pick<Owner, "orgId" | "userId">, fileId: string): Promise<FileVersion[]> {
    return this.db.query<FileVersion>(
      `select v.n, v.note, v.size::int as size, v.created_at as "createdAt", u.name as by
         from file_versions v join files f on f.id = v.file_id left join users u on u.id = v.user_id
        where v.file_id = $1 and f.org_id = $2 and f.deleted_at is null
          and (f.user_id = $3 or ${sharedFile()})
        order by v.n desc`,
      [fileId, owner.orgId, owner.userId],
    );
  }
  private async versionOf(owner: Pick<Owner, "orgId" | "userId">, fileId: string, n: number) {
    const file = await this.find(owner, fileId);
    const found = file
      ? (
          await this.db.query<{ recipe: FileRecipe }>(
            "select recipe from file_versions where file_id = $1 and n = $2",
            [file.id, n],
          )
        )[0]
      : undefined;
    return file && found ? { file, recipe: found.recipe } : null;
  }
  /** An earlier version, made again from what it was made from. */
  async versionBytes(owner: Pick<Owner, "orgId" | "userId">, fileId: string, n: number) {
    const found = await this.versionOf(owner, fileId, n);
    if (!found) return null;
    try {
      return {
        file: found.file,
        bytes: await makeFile(found.file.name, found.file.kind, found.recipe),
      };
    } catch (error) {
      // Kept by an older version of the code and no longer makeable: said as not there.
      if (error instanceof CannotMake) return null;
      throw error;
    }
  }
  /** Brings an earlier version back as the newest. Nothing is lost: what it replaces stays in the list. */
  async restore(
    owner: Owner,
    fileId: string,
    n: number,
    ip: string | null,
  ): Promise<FileRow | null> {
    const found = await this.versionOf(owner, fileId, n);
    // Bringing a version back changes the file: for whoever may change it.
    if (!found || found.file.version === n || !found.file.canChange) return null;
    return this.put(owner, found.file, found.file.name, found.recipe, {
      conversationId: null,
      note: `Version ${n} brought back`,
      ip,
    });
  }

  /** What a spreadsheet or CSV file holds, worked out over every row. */
  async tableByName(
    owner: Pick<Owner, "orgId" | "userId">,
    name: string,
    job: { sheet?: string } | { query: Query },
  ): Promise<string> {
    const file = await this.byName(owner, name.trim());
    if (!file)
      throw new Error(`There is no file named "${name}". Use files.list to see the exact names.`);
    const bytes = await this.store.read(this.key(owner.orgId, file.id));
    if (!bytes) throw new Error("That file's content is gone.");
    try {
      return "query" in job
        ? await readQuery(file, bytes, job.query)
        : await readProfile(file, bytes, job.sheet);
    } catch (error) {
      throw error instanceof Unreadable ? new Error(error.message) : error;
    }
  }

  /** The first bytes a file of this name must have, to learn its kind before it exists. */
  private sample(name: string): Uint8Array {
    const heads: Record<string, number[]> = {
      docx: [0x50, 0x4b, 0x03, 0x04],
      xlsx: [0x50, 0x4b, 0x03, 0x04],
      pptx: [0x50, 0x4b, 0x03, 0x04],
    };
    return new Uint8Array(heads[ending(name)] ?? [0x61]);
  }

  /**
   * Takes files away for good, record and content: for the end of their keeping and for
   * erasing a person, never for a person's own delete (which keeps the record). The rows
   * go in the caller's transaction; `contents` then removes the bytes, once that holds.
   */
  async erase(
    tx: Queryable,
    orgId: string,
    ids: string[],
  ): Promise<{ erased: number; contents(): Promise<void> }> {
    if (ids.length === 0) return { erased: 0, contents: async () => {} };
    await tx.query(
      "delete from shares where org_id = $1 and kind = 'file' and item_id = any($2::uuid[])",
      [orgId, ids],
    );
    const gone = await tx.query<{ id: string; sha256: string }>(
      "delete from files where org_id = $1 and id = any($2::uuid[]) returning id, sha256",
      [orgId, ids],
    );
    return {
      erased: gone.length,
      contents: async () => {
        for (const file of gone) {
          await this.store.remove(this.key(orgId, file.id));
          // What was worked out from the content stays while another file has the very same content.
          const others = await this.db.query(
            "select 1 from files where org_id = $1 and sha256 = $2 and deleted_at is null limit 1",
            [orgId, file.sha256],
          );
          if (others.length === 0)
            for (const kind of ["pdf", "text.json", "sheets.json"])
              await this.store.remove(`${orgId}/derived/${file.sha256}.${kind}`);
        }
      },
    };
  }

  /** Deletes one of the person's files. Returns false when it was already gone. */
  async remove(
    owner: Owner,
    file: { id: string; name: string; sha256: string },
    ip: string | null,
  ): Promise<boolean> {
    const others = await this.db.tx(async (tx) => {
      const gone = await tx.query(
        // Only its owner's: whoever calls this was checked, and it is checked again here.
        "update files set deleted_at = now() where id = $1 and user_id = $2 and deleted_at is null returning id",
        [file.id, owner.userId],
      );
      if (gone.length === 0) return null;
      await recordEvent(tx, {
        orgId: owner.orgId,
        actor: { userId: owner.userId, email: owner.email },
        action: "file.deleted",
        target: { type: "file", id: file.id, label: file.name },
        ip,
      });
      return tx.query(
        "select 1 from files where org_id = $1 and sha256 = $2 and deleted_at is null limit 1",
        [owner.orgId, file.sha256],
      );
    });
    if (others === null) return false;
    // Under a legal hold the file leaves the person's list and its content is kept: it goes
    // when the file's record does, at the end of its keeping once the hold is lifted.
    const held = await this.db.query("select 1 from retention where org_id = $1 and hold limit 1", [
      owner.orgId,
    ]);
    if (held.length > 0) return true;
    // The record of the file stays; its content goes, and so does everything worked out
    // from that content unless another file in the organization has the very same content.
    await this.store.remove(this.key(owner.orgId, file.id));
    if (others.length === 0)
      for (const kind of ["pdf", "text.json", "sheets.json"])
        await this.store.remove(`${owner.orgId}/derived/${file.sha256}.${kind}`);
    return true;
  }
}
