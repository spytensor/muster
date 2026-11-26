/**
 * A project's steps and the team's tickets as one list (MUS-14).
 *
 * An administrator connects the company's tracker once. A project's owner links the
 * project to one project there. From then on a step added or changed here is sent to the
 * tracker as a work item, and what is changed there comes back. The first tracker is
 * Plane; another is one more `TrackerApi`.
 *
 * Nothing of this is said to an agent: `project.step` writes a step as before, and what
 * follows from that happens here, after the step is kept (docs/features/workspace.md,
 * "Steps and the tracker").
 */
import { isId } from "@muster/protocol";
import type { Hono } from "hono";
import { z } from "zod";
import { type AppKit, type Ctx, type Env, fail } from "./app.js";
import { recordEvent } from "./audit.js";
import { openText, sealText } from "./connections.js";
import type { Db, Queryable } from "./db.js";
import { DAY, projectAccess, STEP_TITLE_CHARS, type StepState } from "./projects.js";
import { checkUrl, type Net, NetError, publicNet } from "./runtime/net.js";

export const TRACKER_SCHEMA = [
  // The company's tracker: one, set by an administrator. The key is sealed.
  `create table trackers (
    org_id uuid primary key references organizations(id) on delete cascade,
    kind text not null check (kind in ('plane')),
    base_url text not null,
    workspace text not null,
    key_sealed text not null,
    key_tail text not null default '',
    updated_by uuid references users(id) on delete set null,
    updated_at timestamptz not null default now()
  )`,
  // A project linked to one project in the tracker, and how reading from it is going.
  `create table project_trackers (
    project_id uuid primary key references projects(id) on delete cascade,
    org_id uuid not null references organizations(id) on delete cascade,
    external_project text not null,
    identifier text not null,
    name text not null,
    states jsonb not null default '[]',
    linked_by uuid references users(id) on delete set null,
    linked_at timestamptz not null default now(),
    seen_through timestamptz,
    pulled_at timestamptz,
    checked_at timestamptz,
    next_pull_at timestamptz not null default now(),
    failures integer not null default 0,
    last_error text
  )`,
  // A step's ticket: which work item it is, and what both sides last agreed on.
  `create table step_tickets (
    step_id uuid primary key references project_steps(id) on delete cascade,
    project_id uuid not null references projects(id) on delete cascade,
    external_id text not null,
    key text not null,
    sent jsonb not null,
    unique (project_id, external_id)
  )`,
  // Steps whose ticket is to be brought up to date. One row a step; `seq` says whether it
  // changed again while it was being sent.
  `create table tracker_outbox (
    step_id uuid primary key,
    project_id uuid not null references projects(id) on delete cascade,
    org_id uuid not null,
    seq bigint not null default 1,
    tries integer not null default 0,
    next_at timestamptz not null default now(),
    last_error text
  )`,
  `create index tracker_outbox_due on tracker_outbox (next_at)`,
  // Whoever writes a step (a person, an agent, the notes being adopted) need not know of
  // the tracker: the step's own table says that its ticket is behind.
  `create function tracker_step_changed() returns trigger language plpgsql as $$
   begin
     if exists (select 1 from project_trackers t where t.project_id = new.project_id) then
       insert into tracker_outbox (step_id, project_id, org_id)
       values (new.id, new.project_id, new.org_id)
       on conflict (step_id) do update
         set seq = tracker_outbox.seq + 1, next_at = now(), tries = 0, last_error = null;
     end if;
     return new;
   end $$`,
  `create trigger project_steps_to_tracker
     after insert or update of title, state, due, result on project_steps
     for each row execute function tracker_step_changed()`,
];

/** What review asked for (MUS-14): appended as a step of its own, after `TRACKER_SCHEMA`. */
export const TRACKER_FIXES_SCHEMA = [
  // A ticket whose item was deleted in the tracker is remembered as gone, not forgotten.
  `alter table step_tickets add column gone_at timestamptz`,
  // A step that cannot be sent is set aside after enough tries.
  `alter table tracker_outbox add column parked_at timestamptz`,
  // A reading cut short at its bound is gone on with from where it stopped.
  `alter table project_trackers add column resume_cursor text, add column resume_newest timestamptz`,
  // The tracker's projects an administrator lets projects here be linked to. None: none.
  `alter table trackers add column allowed jsonb not null default '[]'`,
  // A step changed again is sent again, set aside or not.
  `create or replace function tracker_step_changed() returns trigger language plpgsql as $$
   begin
     if exists (select 1 from project_trackers t where t.project_id = new.project_id) then
       insert into tracker_outbox (step_id, project_id, org_id)
       values (new.id, new.project_id, new.org_id)
       on conflict (step_id) do update
         set seq = tracker_outbox.seq + 1, next_at = now(), tries = 0, last_error = null,
             parked_at = null;
     end if;
     return new;
   end $$`,
];

/** The groups every tracker's states fall into (Plane's own names). */
type Group = "backlog" | "unstarted" | "started" | "completed" | "cancelled";
const GROUPS: readonly Group[] = ["backlog", "unstarted", "started", "completed", "cancelled"];

/** Which group a step's state is sent as. "Waiting" has no like there: it is still under way. */
export const GROUP_FOR: Record<StepState, Group> = {
  todo: "unstarted",
  doing: "started",
  waiting: "started",
  done: "completed",
};
/** The groups a step's state already agrees with: nothing is sent while it is in one of them. */
const AGREES: Record<StepState, readonly Group[]> = {
  todo: ["backlog", "unstarted"],
  doing: ["started"],
  waiting: ["started"],
  done: ["completed", "cancelled"],
};
/** What a group means for a step when it was changed in the tracker. */
export const STATE_FOR: Record<Group, StepState> = {
  backlog: "todo",
  unstarted: "todo",
  started: "doing",
  completed: "done",
  cancelled: "done",
};

interface TrackerState {
  id: string;
  group: Group;
}
interface TrackerItem {
  id: string;
  /** Its number in the tracker's project. */
  n: number;
  title: string;
  stateId: string | null;
  due: string | null;
  updatedAt: Date;
}
/** What a tracker must be able to do. One implementation a kind. */
export interface TrackerApi {
  projects(): Promise<{ id: string; identifier: string; name: string }[]>;
  /** One project as it is called now; null when it is no longer there. */
  project(id: string): Promise<{ identifier: string; name: string } | null>;
  states(project: string): Promise<TrackerState[]>;
  /** The item already made for this step, if one was: asked before making one. */
  find(project: string, stepId: string): Promise<{ id: string; n: number } | null>;
  /** Makes the item, or finds the one already made for this step. */
  create(
    project: string,
    item: { stepId: string; title: string; stateId: string | null; due: string | null },
  ): Promise<{ id: string; n: number }>;
  /** False when the item is no longer there. */
  update(
    project: string,
    id: string,
    change: { title?: string; stateId?: string; due?: string | null },
  ): Promise<boolean>;
  comment(project: string, id: string, text: string): Promise<void>;
  /**
   * The items changed since `since`, newest first, read from `from` (where an earlier
   * reading stopped) or from the top. How it ended says what may be concluded:
   * "seen" when it came to items already seen, "last" when it read to the true end (with
   * `all`, every item of the project is then in `items`), and "capped" when it stopped
   * at its bound with more to read: `next` is where to go on from.
   */
  changed(
    project: string,
    since: Date | null,
    all: boolean,
    from?: string | null,
  ): Promise<{ items: TrackerItem[]; ended: "seen" | "last" | "capped"; next: string | null }>;
}

/** A tracker that could not be asked, in words for the page and a kind for what to do next. */
export class TrackerProblem extends Error {
  constructor(
    readonly kind: "key" | "missing" | "busy" | "unreachable" | "refused",
    message: string,
  ) {
    super(message);
  }
}

const html = (text: string) =>
  `<p>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>")}</p>`;

const PAGES = 10;
/** How far before what was last seen a reading starts again. */
const OVERLAP_MS = 5_000;

/** Plane, over its public API (v1): a key in a header, pages with a cursor. */
export function planeApi(
  net: Net,
  at: { baseUrl: string; workspace: string; key: string },
): TrackerApi {
  const root = `${at.baseUrl.replace(/\/+$/, "")}/api/v1/workspaces/${encodeURIComponent(at.workspace)}`;
  const call = async (
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> => {
    let answer: Awaited<ReturnType<Net["request"]>>;
    try {
      answer = await net.request(`${root}${path}`, {
        method,
        headers: { "x-api-key": at.key, "user-agent": "Muster-Tracker/1" },
        ...(body === undefined
          ? {}
          : { body: JSON.stringify(body), contentType: "application/json" }),
        // The key is for the address it was entered for and no other.
        noRedirect: true,
        timeoutMs: 20_000,
      });
    } catch (error) {
      throw new TrackerProblem(
        "unreachable",
        error instanceof NetError ? error.message : "The tracker could not be reached.",
      );
    }
    if (answer.status === 401 || answer.status === 403)
      throw new TrackerProblem("key", "The tracker refused the key.");
    if (answer.status === 429)
      throw new TrackerProblem("busy", "The tracker asks for fewer requests.");
    if (answer.status >= 500 || (answer.status >= 300 && answer.status < 400))
      throw new TrackerProblem("unreachable", `The tracker answered ${answer.status}.`);
    let json: unknown = null;
    try {
      json = answer.text ? JSON.parse(answer.text) : null;
    } catch {
      if (answer.status < 300)
        throw new TrackerProblem("refused", "The tracker's answer could not be read.");
    }
    return { status: answer.status, json };
  };
  const refused = (status: number) =>
    new TrackerProblem(
      status === 404 ? "missing" : "refused",
      status === 404
        ? "The tracker has no such project or item."
        : `The tracker answered ${status}.`,
    );
  /**
   * The pages of a list from `from` (or the top), up to a bound. `ended` says why it
   * stopped: the true last page, `enough` said so, or the bound; `next` is the page after.
   */
  const pages = async (
    path: string,
    most: number,
    enough?: (page: Record<string, unknown>[]) => boolean,
    from: string | null = null,
  ): Promise<{
    rows: Record<string, unknown>[];
    more: boolean;
    ended: "last" | "enough" | "capped";
    next: string | null;
  }> => {
    const rows: Record<string, unknown>[] = [];
    let cursor: string | null = from;
    for (let page = 0; page < most; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const got = await call(
        "GET",
        `${path}${sep}per_page=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      if (got.status >= 300) throw refused(got.status);
      if (Array.isArray(got.json))
        return {
          rows: got.json as Record<string, unknown>[],
          more: false,
          ended: "last",
          next: null,
        };
      const body = (got.json ?? {}) as {
        results?: Record<string, unknown>[];
        next_page_results?: boolean;
        next_cursor?: string;
      };
      const here = body.results ?? [];
      rows.push(...here);
      if (!body.next_page_results || !body.next_cursor)
        return { rows, more: false, ended: "last", next: null };
      if (enough?.(here)) return { rows, more: true, ended: "enough", next: body.next_cursor };
      cursor = body.next_cursor;
    }
    return { rows, more: true, ended: "capped", next: cursor };
  };
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const item = (row: Record<string, unknown>): TrackerItem => ({
    id: text(row.id),
    n: Number(row.sequence_id) || 0,
    title: text(row.name),
    stateId: text(row.state) || null,
    due: text(row.target_date).slice(0, 10) || null,
    updatedAt: new Date(text(row.updated_at) || 0),
  });
  return {
    async projects() {
      return (await pages("/projects/", PAGES)).rows
        .map((row) => ({
          id: text(row.id),
          identifier: text(row.identifier),
          name: text(row.name),
        }))
        .filter((one) => one.id && one.identifier);
    },
    async project(id) {
      const got = await call("GET", `/projects/${id}/`);
      if (got.status === 404) return null;
      if (got.status >= 300) throw refused(got.status);
      const row = (got.json ?? {}) as Record<string, unknown>;
      return text(row.identifier)
        ? { identifier: text(row.identifier), name: text(row.name) }
        : null;
    },
    async find(project, stepId) {
      // Plane answers a list asked for by both of these with the one item, or with 404.
      // A tracker that ignores them answers with a list: only an item that says it was
      // made for this step is taken from it.
      const got = await call(
        "GET",
        `/projects/${project}/work-items/?external_source=muster&external_id=${encodeURIComponent(stepId)}`,
      );
      if (got.status === 404) return null;
      if (got.status >= 300) throw refused(got.status);
      const body = (got.json ?? {}) as Record<string, unknown>;
      const rows = Array.isArray(got.json)
        ? (got.json as Record<string, unknown>[])
        : Array.isArray(body.results)
          ? (body.results as Record<string, unknown>[])
          : [body];
      const found = rows.find(
        (row) =>
          text(row.id) &&
          text(row.external_id) === stepId &&
          text(row.external_source) === "muster",
      );
      return found ? { id: text(found.id), n: Number(found.sequence_id) || 0 } : null;
    },
    async states(project) {
      return (await pages(`/projects/${project}/states/`, 2)).rows
        .map((row) => ({ row, group: text(row.group) as Group }))
        .filter((one) => GROUPS.includes(one.group) && text(one.row.id))
        .sort(
          (a, b) =>
            // The project's own first choice, then the order it shows them in.
            Number(Boolean(b.row.default)) - Number(Boolean(a.row.default)) ||
            (Number(a.row.sequence) || 0) - (Number(b.row.sequence) || 0),
        )
        .map((one) => ({ id: text(one.row.id), group: one.group }));
    },
    async create(project, made) {
      const got = await call("POST", `/projects/${project}/work-items/`, {
        name: made.title,
        ...(made.stateId ? { state: made.stateId } : {}),
        ...(made.due ? { target_date: made.due } : {}),
        // Asked twice (the answer to the first was lost), the tracker says it has it already.
        external_source: "muster",
        external_id: made.stepId,
      });
      const body = (got.json ?? {}) as Record<string, unknown>;
      if (got.status === 409 && text(body.id)) {
        const found = await call("GET", `/projects/${project}/work-items/${text(body.id)}/`);
        if (found.status >= 300) throw refused(found.status);
        const one = item(found.json as Record<string, unknown>);
        return { id: one.id, n: one.n };
      }
      if (got.status >= 300 || !text(body.id)) throw refused(got.status);
      return { id: text(body.id), n: Number(body.sequence_id) || 0 };
    },
    async update(project, id, change) {
      const got = await call("PATCH", `/projects/${project}/work-items/${id}/`, {
        ...(change.title === undefined ? {} : { name: change.title }),
        ...(change.stateId === undefined ? {} : { state: change.stateId }),
        ...(change.due === undefined ? {} : { target_date: change.due }),
      });
      if (got.status === 404) return false;
      if (got.status >= 300) throw refused(got.status);
      return true;
    },
    async comment(project, id, said) {
      const got = await call("POST", `/projects/${project}/work-items/${id}/comments/`, {
        comment_html: html(said),
      });
      if (got.status >= 300) throw refused(got.status);
    },
    async changed(project, since, all, from = null) {
      const path = `/projects/${project}/work-items/?order_by=-updated_at`;
      // Read a little past what was seen: two changes in the same instant, or a clock
      // that stepped, are read twice sooner than missed. Taking an item in is harmless
      // when nothing of it differs.
      const edge = since ? since.getTime() - OVERLAP_MS : 0;
      // A page that is newest first and wholly older than what was already seen ends the
      // reading. A tracker that does not sort as asked is read to the end instead.
      const old = (page: Record<string, unknown>[]) => {
        if (all || !since) return false;
        const times = page.map((row) => new Date(text(row.updated_at) || 0).getTime());
        const sorted = times.every((time, index) => index === 0 || time <= (times[index - 1] ?? 0));
        return sorted && times.every((time) => time < edge);
      };
      const got = await pages(path, PAGES, old, from);
      const items = got.rows.map(item).filter((one) => one.id);
      return {
        items: since && !all ? items.filter((one) => one.updatedAt.getTime() >= edge) : items,
        ended: got.ended === "enough" ? "seen" : got.ended,
        next: got.ended === "capped" ? got.next : null,
      };
    },
  };
}

/** What both sides last agreed a step's ticket says. */
interface Sent {
  title: string;
  group: Group | null;
  due: string | null;
  result: string;
}

const PULL_EVERY_MS = 2 * 60_000;
const CHECK_EVERY_MS = 24 * 60 * 60_000;
/**
 * How long a row is held by the pass that took it. Nothing in the database is locked
 * while the tracker is asked: the row is marked as taken until then, and another pass
 * (or another process) leaves it alone.
 */
const LEASE_MS = 5 * 60_000;
/** Minutes to wait after the first, second… failure in a row. */
const BACKOFF_MINUTES = [1, 5, 30, 120];
const backoff = (tries: number) =>
  (BACKOFF_MINUTES[Math.min(tries, BACKOFF_MINUTES.length) - 1] ?? 120) * 60_000;
/** Said in the record once, when it has failed this many times in a row. */
const TOLD_AT = 3;
/** A step that could not be sent this many times is set aside until it or the connection changes. */
const PARK_AT = 8;
const oneLine = (text: string, most: number) => text.replace(/\s+/g, " ").trim().slice(0, most);
/** Why something failed, in words for the page. What was not expected is not shown as it was. */
const reasonOf = (error: unknown) =>
  error instanceof TrackerProblem ? error.message : "Something went wrong keeping this in step.";

type LinkRow = {
  org_id: string;
  external_project: string;
  identifier: string;
  name: string;
  states: TrackerState[];
  seen_through: Date | null;
  checked_at: Date | null;
  failures: number;
  resume_cursor: string | null;
  resume_newest: Date | null;
};

export class Tracker {
  private readonly net: Net;
  private busy = false;
  constructor(
    private readonly db: Db,
    private readonly secretKey: string,
    options: { net?: Net } = {},
  ) {
    this.net = options.net ?? publicNet;
  }

  get canSeal(): boolean {
    return Boolean(this.secretKey);
  }
  seal(key: string): string {
    return sealText(this.secretKey, key);
  }
  open(sealed: string): string | null {
    return openText(this.secretKey, sealed);
  }

  /** The company's tracker, ready to be asked; null when there is none or its key cannot be opened. */
  async api(
    db: Queryable,
    orgId: string,
  ): Promise<{ api: TrackerApi; baseUrl: string; workspace: string; allowed: string[] } | null> {
    const row = (
      await db.query<{
        base_url: string;
        workspace: string;
        key_sealed: string;
        allowed: string[];
      }>("select base_url, workspace, key_sealed, allowed from trackers where org_id = $1", [orgId])
    )[0];
    if (!row) return null;
    const key = openText(this.secretKey, row.key_sealed);
    if (!key) return null;
    return {
      api: this.with({ baseUrl: row.base_url, workspace: row.workspace, key }),
      baseUrl: row.base_url,
      workspace: row.workspace,
      allowed: row.allowed ?? [],
    };
  }
  with(at: { baseUrl: string; workspace: string; key: string }): TrackerApi {
    return planeApi(this.net, at);
  }

  /**
   * One pass: what changed in the tracker is read first, then what changed here is sent.
   * In that order, so that where both sides changed the same thing the tracker's word
   * stands: it is where the team works, and it is not written over unseen.
   */
  async tick(now = new Date()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.pullDue(now);
      await this.pushDue(now);
    } finally {
      this.busy = false;
    }
  }

  private async pullDue(now: Date): Promise<void> {
    const due = await this.db.query<{ project_id: string }>(
      "select project_id from project_trackers where next_pull_at <= $1 order by next_pull_at limit 20",
      [now],
    );
    for (const one of due) await this.pull(one.project_id, now);
  }

  /**
   * Reads what changed in the tracker for one linked project and brings its steps up to
   * date. Three parts: the project is taken (a moment, in the database), the tracker is
   * asked (with nothing held), and what it said is written (a moment again).
   */
  async pull(projectId: string, now = new Date()): Promise<void> {
    const link = await this.db.tx(async (tx) => {
      const row = (
        await tx.query<LinkRow>(
          `select org_id, external_project, identifier, name, states, seen_through, checked_at, failures,
                  resume_cursor, resume_newest
             from project_trackers where project_id = $1 and next_pull_at <= $2 for update skip locked`,
          [projectId, now],
        )
      )[0];
      if (row)
        await tx.query("update project_trackers set next_pull_at = $2 where project_id = $1", [
          projectId,
          new Date(now.getTime() + LEASE_MS),
        ]);
      return row;
    });
    if (!link) return;
    try {
      const tracker = await this.api(this.db, link.org_id);
      if (!tracker) throw new TrackerProblem("key", "The tracker is not connected.");
      const named = await tracker.api.project(link.external_project);
      if (!named) throw new TrackerProblem("missing", "The tracker's project is no longer there.");
      // Everything is read once a day, to find what was deleted; not while an earlier
      // reading is still being gone on with.
      const all =
        !link.resume_cursor &&
        (!link.checked_at || now.getTime() - link.checked_at.getTime() >= CHECK_EVERY_MS);
      let states = all ? await tracker.api.states(link.external_project) : link.states;
      const read = await tracker.api.changed(
        link.external_project,
        link.seen_through,
        all,
        link.resume_cursor,
      );
      if (read.items.some((item) => item.stateId && !states.some((s) => s.id === item.stateId)))
        states = await tracker.api.states(link.external_project);
      await this.db.tx(async (tx) => {
        // Unlinked, or linked to something else, while the tracker was being asked.
        const still = (
          await tx.query<{ external_project: string }>(
            "select external_project from project_trackers where project_id = $1 for update",
            [projectId],
          )
        )[0];
        if (still?.external_project !== link.external_project) return;
        const tickets = await tx.query<{ step_id: string; external_id: string; sent: Sent }>(
          "select step_id, external_id, sent from step_tickets where project_id = $1 and gone_at is null",
          [projectId],
        );
        const byItem = new Map(tickets.map((ticket) => [ticket.external_id, ticket]));
        let newest = link.resume_newest ?? link.seen_through;
        for (const item of read.items) {
          if (!newest || item.updatedAt > newest) newest = item.updatedAt;
          const ticket = byItem.get(item.id);
          if (ticket) await this.take(tx, named.identifier, ticket, item, states);
        }
        // Read to the true end: an item that is not there was deleted. Its step stays,
        // and its ticket is remembered as gone, so that it is not made a second time.
        const whole = all && read.ended === "last";
        if (whole) {
          const there = new Set(read.items.map((item) => item.id));
          const gone = tickets.filter((ticket) => !there.has(ticket.external_id));
          if (gone.length > 0)
            await tx.query("update step_tickets set gone_at = $2 where step_id = any($1::uuid[])", [
              gone.map((ticket) => ticket.step_id),
              now,
            ]);
        }
        // The project is called something else there now: every key says so.
        if (named.identifier !== link.identifier)
          await tx.query(
            `update step_tickets set key = $2 || '-' || regexp_replace(key, '^.*-', '')
              where project_id = $1`,
            [projectId, named.identifier],
          );
        // Cut short at its bound: what was seen so far is not yet "seen through". The
        // next pass goes on from where this one stopped, and only when a reading comes
        // to what was already seen, or to the end, is the mark moved.
        const capped = read.ended === "capped";
        await tx.query(
          `update project_trackers
              set states = $2::jsonb, identifier = $3, name = $4,
                  seen_through = case when $5::boolean then seen_through else $6 end,
                  resume_cursor = $7, resume_newest = case when $5::boolean then $6 else null end,
                  pulled_at = $8, next_pull_at = $9,
                  checked_at = case when $10::boolean then $8 else checked_at end,
                  failures = 0, last_error = null
            where project_id = $1`,
          [
            projectId,
            JSON.stringify(states),
            named.identifier,
            named.name || link.name,
            capped,
            newest,
            capped ? read.next : null,
            now,
            capped ? now : new Date(now.getTime() + PULL_EVERY_MS),
            // A project too large to read whole in one go is not read whole again and
            // again: what was deleted there is then found only when its step is next sent.
            all,
          ],
        );
      });
    } catch (error) {
      if (!(error instanceof TrackerProblem)) console.error("reading the tracker failed:", error);
      const failures = link.failures + 1;
      await this.db.tx(async (tx) => {
        await tx.query(
          "update project_trackers set failures = $2, last_error = $3, next_pull_at = $4 where project_id = $1",
          [projectId, failures, reasonOf(error), new Date(now.getTime() + backoff(failures))],
        );
        if (failures === TOLD_AT) await this.tell(tx, link.org_id, projectId, reasonOf(error));
      });
    }
  }

  /** One item changed in the tracker: what differs from what was agreed is taken into its step. */
  private async take(
    tx: Queryable,
    identifier: string,
    ticket: { step_id: string; sent: Sent },
    item: TrackerItem,
    states: TrackerState[],
  ): Promise<void> {
    const sent = ticket.sent;
    const group = states.find((state) => state.id === item.stateId)?.group ?? sent.group;
    const title = oneLine(item.title, STEP_TITLE_CHARS);
    const due = item.due && DAY.test(item.due) ? item.due : null;
    const step = (
      await tx.query<{ state: StepState; result: string }>(
        "select state, result from project_steps where id = $1 for update",
        [ticket.step_id],
      )
    )[0];
    if (!step) return;
    const set: string[] = [];
    const args: unknown[] = [ticket.step_id];
    const put = (column: string, value: unknown) => {
      args.push(value);
      set.push(`${column} = $${args.length}`);
    };
    let result = sent.result;
    if (title && title !== sent.title) put("title", title);
    if (due !== sent.due) put("due", due);
    if (group && group !== sent.group && !AGREES[step.state].includes(group)) {
      const state = STATE_FOR[group];
      put("state", state);
      set.push(state === "done" ? "done_at = coalesce(done_at, now())" : "done_at = null");
      // A step that was called off is done with, and says why it has nothing to show.
      // The tracker said it, so it is not told back to the tracker as news.
      if (group === "cancelled" && !step.result) {
        result = `Cancelled in ${identifier}-${item.n}.`;
        put("result", result);
      }
    }
    if (set.length > 0)
      await tx.query(
        `update project_steps set ${set.join(", ")}, updated_at = now() where id = $1`,
        args,
      );
    await tx.query("update step_tickets set sent = $2::jsonb where step_id = $1", [
      ticket.step_id,
      JSON.stringify({ title: title || sent.title, due, group, result } satisfies Sent),
    ]);
  }

  private async pushDue(now: Date): Promise<void> {
    // The longest waiting first, by when each is due: one that keeps failing is due later
    // each time and then set aside, so it never stands in front of the rest.
    const due = await this.db.query<{ step_id: string }>(
      "select step_id from tracker_outbox where next_at <= $1 and parked_at is null order by next_at limit 20",
      [now],
    );
    for (const one of due) await this.push(one.step_id, now);
  }

  /**
   * Brings one step's ticket up to date: made if it has none, changed where it differs.
   * The step is taken (a moment, in the database), the tracker is asked with nothing
   * held, and the outcome is written only if the step did not change meanwhile; if it
   * did, it stays to be sent again.
   */
  async push(stepId: string, now = new Date()): Promise<void> {
    const waiting = await this.db.tx(async (tx) => {
      const row = (
        await tx.query<{ seq: string; tries: number; org_id: string; project_id: string }>(
          `select seq, tries, org_id, project_id from tracker_outbox
            where step_id = $1 and next_at <= $2 and parked_at is null for update skip locked`,
          [stepId, now],
        )
      )[0];
      if (row)
        await tx.query("update tracker_outbox set next_at = $2 where step_id = $1 and seq = $3", [
          stepId,
          new Date(now.getTime() + LEASE_MS),
          row.seq,
        ]);
      return row;
    });
    if (!waiting) return;
    /** Nothing more is owed for the step as it was when it was taken. */
    const done = () =>
      this.db.query("delete from tracker_outbox where step_id = $1 and seq = $2", [
        stepId,
        waiting.seq,
      ]);
    try {
      const link = (
        await this.db.query<{
          external_project: string;
          identifier: string;
          states: TrackerState[];
        }>(
          "select external_project, identifier, states from project_trackers where project_id = $1",
          [waiting.project_id],
        )
      )[0];
      const step = (
        await this.db.query<{
          title: string;
          state: StepState;
          due: string | null;
          result: string;
        }>("select title, state, due, result from project_steps where id = $1", [stepId])
      )[0];
      // The step was removed, or the project is no longer linked: nothing is owed.
      if (!link || !step) return void (await done());
      const ticket = (
        await this.db.query<{ external_id: string; sent: Sent; gone_at: Date | null }>(
          "select external_id, sent, gone_at from step_tickets where step_id = $1",
          [stepId],
        )
      )[0];
      // Its item was deleted in the tracker: the step is the person's alone from then on.
      if (ticket?.gone_at) return void (await done());
      const tracker = await this.api(this.db, waiting.org_id);
      if (!tracker) throw new TrackerProblem("key", "The tracker is not connected.");
      const stateFor = (group: Group) =>
        link.states.find((state) => state.group === group)?.id ??
        (group === "unstarted"
          ? link.states.find((state) => state.group === "backlog")?.id
          : undefined);
      const keep = (sent: Sent) =>
        this.db.query("update step_tickets set sent = $2::jsonb where step_id = $1", [
          stepId,
          JSON.stringify(sent),
        ]);
      if (!ticket) {
        const stateId = stateFor(GROUP_FOR[step.state]) ?? null;
        // Asked for first: an earlier try may have made it and never heard so.
        const made =
          (await tracker.api.find(link.external_project, stepId)) ??
          (await tracker.api.create(link.external_project, {
            stepId,
            title: step.title,
            stateId,
            due: step.due,
          }));
        // What an item found from an earlier try says is not known: nothing is taken as
        // agreed, so everything of the step is sent to it below, once.
        const sent: Sent = {
          title: step.title,
          group: stateId ? (link.states.find((s) => s.id === stateId)?.group ?? null) : null,
          due: step.due,
          result: "",
        };
        await this.db.query(
          `insert into step_tickets (step_id, project_id, external_id, key, sent)
           values ($1, $2, $3, $4, $5::jsonb)
           on conflict (step_id) do nothing`,
          [
            stepId,
            waiting.project_id,
            made.id,
            `${link.identifier}-${made.n}`,
            JSON.stringify(sent),
          ],
        );
        if (step.result) {
          await tracker.api.comment(link.external_project, made.id, step.result);
          await keep({ ...sent, result: step.result });
        }
        return void (await done());
      }
      const sent = ticket.sent;
      const change: { title?: string; stateId?: string; due?: string | null } = {};
      const next: Sent = { ...sent };
      if (step.title !== sent.title) {
        change.title = step.title;
        next.title = step.title;
      }
      if (step.due !== sent.due) {
        change.due = step.due;
        next.due = step.due;
      }
      if (!sent.group || !AGREES[step.state].includes(sent.group)) {
        const stateId = stateFor(GROUP_FOR[step.state]);
        if (stateId) {
          change.stateId = stateId;
          next.group = link.states.find((s) => s.id === stateId)?.group ?? null;
        }
      }
      if (Object.keys(change).length > 0) {
        const there = await tracker.api.update(link.external_project, ticket.external_id, change);
        // Deleted in the tracker: the step stays, and its ticket is remembered as gone,
        // so that it is not made a second time and nothing is tried for ever.
        if (!there) {
          await this.db.query("update step_tickets set gone_at = $2 where step_id = $1", [
            stepId,
            now,
          ]);
          return void (await done());
        }
        await keep({ ...next, result: sent.result });
      }
      if (step.result && step.result !== sent.result) {
        await tracker.api.comment(link.external_project, ticket.external_id, step.result);
        next.result = step.result;
        await keep(next);
      }
      await done();
    } catch (error) {
      // Whatever went wrong, it waits longer before the next try, and after enough of
      // them is set aside: one step that cannot be sent never holds up the others.
      if (!(error instanceof TrackerProblem))
        console.error("sending a step to the tracker failed:", error);
      const tries = waiting.tries + 1;
      await this.db
        .tx(async (tx) => {
          const kept = await tx.query(
            `update tracker_outbox
                set tries = $3::int, last_error = $4, next_at = $5,
                    parked_at = case when $3::int >= $6::int then $7::timestamptz else null end
              where step_id = $1 and seq = $2 returning step_id`,
            [
              stepId,
              waiting.seq,
              tries,
              reasonOf(error),
              new Date(now.getTime() + backoff(tries)),
              PARK_AT,
              now,
            ],
          );
          if (kept.length > 0 && tries === TOLD_AT)
            await this.tell(tx, waiting.org_id, waiting.project_id, reasonOf(error));
        })
        .catch((failed) => console.error("recording a tracker failure failed:", failed));
    }
  }

  /** Said once in the activity log when a project's tracker keeps failing. */
  private async tell(tx: Queryable, orgId: string, projectId: string, reason: string) {
    const name = (
      await tx.query<{ name: string }>("select name from projects where id = $1", [projectId])
    )[0]?.name;
    await recordEvent(tx, {
      orgId,
      actor: { userId: null, email: "muster (tracker)" },
      action: "tracker.failing",
      target: { type: "project", id: projectId, label: name ?? "" },
      detail: { reason },
    });
  }

  /** Where a project stands with the tracker, for its page. */
  async standing(
    db: Queryable,
    orgId: string,
    projectId: string,
  ): Promise<{
    available: boolean;
    link: { identifier: string; name: string; url: string } | null;
    waiting: number;
    /** Steps set aside after failing too often: sent again when they or the connection change. */
    parked: number;
    failed: string | null;
    pulledAt: Date | null;
  }> {
    const [company, link, outbox] = await Promise.all([
      db.query<{ base_url: string; workspace: string; allowed: string[] }>(
        "select base_url, workspace, allowed from trackers where org_id = $1",
        [orgId],
      ),
      db.query<{
        identifier: string;
        name: string;
        external_project: string;
        last_error: string | null;
        failures: number;
        pulled_at: Date | null;
      }>(
        `select identifier, name, external_project, last_error, failures, pulled_at
           from project_trackers where project_id = $1 and org_id = $2`,
        [projectId, orgId],
      ),
      db.query<{ waiting: number; parked: number; failed: string | null }>(
        `select (count(*) filter (where parked_at is null))::int as waiting,
                (count(*) filter (where parked_at is not null))::int as parked,
                max(last_error) filter (where tries >= 2) as failed
           from tracker_outbox where project_id = $1`,
        [projectId],
      ),
    ]);
    const one = link[0];
    const at = company[0];
    return {
      // Offered only where an administrator has said which projects there may be linked.
      available: Boolean(at) && (Boolean(one) || (at?.allowed ?? []).length > 0),
      link:
        one && at
          ? {
              identifier: one.identifier,
              name: one.name,
              url: `${at.base_url.replace(/\/+$/, "")}/${at.workspace}/projects/${one.external_project}/issues/`,
            }
          : null,
      waiting: outbox[0]?.waiting ?? 0,
      parked: outbox[0]?.parked ?? 0,
      failed: one
        ? ((one.failures >= 2 ? one.last_error : null) ?? outbox[0]?.failed ?? null)
        : null,
      pulledAt: one?.pulled_at ?? null,
    };
  }
}

/** Each step's ticket, by the step: its key and where it opens. One deleted there has none. */
export async function ticketsOf(
  db: Queryable,
  orgId: string,
  projectId: string,
): Promise<Map<string, { key: string; url: string }>> {
  const rows = await db.query<{
    step_id: string;
    key: string;
    base_url: string;
    workspace: string;
  }>(
    `select s.step_id, s.key, t.base_url, t.workspace
       from step_tickets s join trackers t on t.org_id = $1
      where s.project_id = $2 and s.gone_at is null`,
    [orgId, projectId],
  );
  return new Map(
    rows.map((row) => [
      row.step_id,
      {
        key: row.key,
        url: `${row.base_url.replace(/\/+$/, "")}/${row.workspace}/browse/${row.key}/`,
      },
    ]),
  );
}

const Connection = z.strictObject({
  baseUrl: z.string().trim().min(1).max(300),
  workspace: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  /** Left out to keep the key already there, which only the same address may do. */
  key: z.string().trim().min(8).max(400).optional(),
});

export function registerTracker(app: Hono<Env>, kit: AppKit, db: Db, tracker: Tracker): void {
  const { need, actorOf, clientIp, inTx } = kit;
  const org = (c: Ctx) => c.get("session").org.id;
  const me = (c: Ctx) => c.get("session").user.id;
  const said = (error: unknown) =>
    error instanceof TrackerProblem ? { kind: error.kind, message: error.message } : null;

  // ---- the company's tracker: an administrator's ----

  app.get("/api/tracker", async (c) => {
    const denied = need(c, "settings.read");
    if (denied) return denied;
    const row = (
      await db.query(
        `select kind, base_url as "baseUrl", workspace, key_tail as "keyTail", updated_at as "updatedAt", allowed,
                (select count(*)::int from project_trackers p where p.org_id = t.org_id) as projects
           from trackers t where org_id = $1`,
        [org(c)],
      )
    )[0];
    return c.json({ canSeal: tracker.canSeal, tracker: row ?? null });
  });

  app.put("/api/tracker", async (c) => {
    const denied = need(c, "settings.manage");
    if (denied) return denied;
    const parsed = Connection.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, "invalid_tracker");
    if (!tracker.canSeal) return fail(c, "connector_unsealed");
    let url: URL;
    try {
      url = checkUrl(parsed.data.baseUrl);
    } catch {
      return fail(c, "invalid_tracker");
    }
    if (url.protocol !== "https:" || url.search || url.hash) return fail(c, "invalid_tracker");
    const baseUrl = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    const had = (
      await db.query<{ base_url: string; workspace: string; key_sealed: string }>(
        "select base_url, workspace, key_sealed from trackers where org_id = $1",
        [org(c)],
      )
    )[0];
    // A key goes only to the address it was entered for: another address needs it typed again.
    const kept = had && new URL(had.base_url).origin === url.origin ? had.key_sealed : null;
    const key = parsed.data.key ?? (kept ? tracker.open(kept) : null);
    if (!key) return fail(c, "tracker_key_again");
    // Tried before it is kept: a connection that does not work is not saved.
    let projects = 0;
    try {
      projects = (await tracker.with({ baseUrl, workspace: parsed.data.workspace, key }).projects())
        .length;
    } catch (error) {
      const problem = said(error);
      if (!problem) throw error;
      return c.json({ ok: false, problem });
    }
    return inTx(c, async (tx) => {
      await tx.query(
        `insert into trackers (org_id, kind, base_url, workspace, key_sealed, key_tail, updated_by)
         values ($1, 'plane', $2, $3, $4, $5, $6)
         on conflict (org_id) do update set base_url = excluded.base_url, workspace = excluded.workspace,
           key_sealed = excluded.key_sealed, key_tail = excluded.key_tail,
           updated_by = excluded.updated_by, updated_at = now()`,
        [
          org(c),
          baseUrl,
          parsed.data.workspace,
          tracker.seal(key),
          key.length >= 20 ? key.slice(-4) : "",
          me(c),
        ],
      );
      // The connection works again, or works differently: what was set aside is tried anew.
      await tx.query(
        "update tracker_outbox set parked_at = null, tries = 0, next_at = now() where org_id = $1",
        [org(c)],
      );
      // Another address or workspace is another tracker: what was linked there is not
      // here, and which of its projects may be linked is to be said again.
      if (had && (had.base_url !== baseUrl || had.workspace !== parsed.data.workspace || !kept)) {
        await tx.query("update trackers set allowed = '[]' where org_id = $1", [org(c)]);
        await tx.query(
          "delete from step_tickets where project_id in (select project_id from project_trackers where org_id = $1)",
          [org(c)],
        );
        await tx.query("delete from tracker_outbox where org_id = $1", [org(c)]);
        await tx.query("delete from project_trackers where org_id = $1", [org(c)]);
      }
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: had ? "tracker.changed" : "tracker.set",
        target: { type: "tracker", id: org(c), label: url.host },
        detail: { host: url.host, workspace: parsed.data.workspace },
        ip: clientIp(c),
      });
      return c.json({ ok: true, projects });
    });
  });

  app.post("/api/tracker/test", async (c) => {
    const denied = need(c, "settings.manage");
    if (denied) return denied;
    const at = await tracker.api(db, org(c));
    if (!at) return fail(c, "tracker_unavailable");
    try {
      return c.json({ ok: true, projects: (await at.api.projects()).length });
    } catch (error) {
      const problem = said(error);
      if (!problem) throw error;
      return c.json({ ok: false, problem });
    }
  });

  // The tracker's projects, each with whether projects here may be linked to it.
  app.get("/api/tracker/projects", async (c) => {
    const denied = need(c, "settings.read");
    if (denied) return denied;
    const at = await tracker.api(db, org(c));
    if (!at) return fail(c, "tracker_unavailable");
    try {
      const allowed = new Set(at.allowed);
      return c.json({
        ok: true,
        projects: (await at.api.projects()).map((one) => ({
          ...one,
          allowed: allowed.has(one.id),
        })),
      });
    } catch (error) {
      const problem = said(error);
      if (!problem) throw error;
      return c.json({ ok: false, problem });
    }
  });

  app.put("/api/tracker/projects", async (c) => {
    const denied = need(c, "settings.manage");
    if (denied) return denied;
    const parsed = z
      .strictObject({ allowed: z.array(z.string().trim().min(1).max(80)).max(200) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, "invalid_tracker");
    const at = await tracker.api(db, org(c));
    if (!at) return fail(c, "tracker_unavailable");
    // Only projects the tracker has: a name is kept with the id for the record.
    let there: { id: string; identifier: string }[];
    try {
      there = await at.api.projects();
    } catch (error) {
      const problem = said(error);
      if (!problem) throw error;
      return c.json({ ok: false, problem });
    }
    const chosen = there.filter((one) => parsed.data.allowed.includes(one.id));
    if (chosen.length !== new Set(parsed.data.allowed).size) return fail(c, "invalid_tracker");
    return inTx(c, async (tx) => {
      await tx.query("update trackers set allowed = $2::jsonb where org_id = $1", [
        org(c),
        JSON.stringify(chosen.map((one) => one.id)),
      ]);
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "tracker.projects_changed",
        target: { type: "tracker", id: org(c), label: "" },
        detail: { allowed: chosen.map((one) => one.identifier) },
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    });
  });

  app.delete("/api/tracker", async (c) => {
    const denied = need(c, "settings.manage");
    if (denied) return denied;
    return inTx(c, async (tx) => {
      const had = await tx.query<{ base_url: string }>(
        "delete from trackers where org_id = $1 returning base_url",
        [org(c)],
      );
      if (had.length === 0) return fail(c, "not_found");
      // Steps and work items both stay as they are; only what tied them goes.
      await tx.query(
        "delete from step_tickets where project_id in (select project_id from project_trackers where org_id = $1)",
        [org(c)],
      );
      await tx.query("delete from tracker_outbox where org_id = $1", [org(c)]);
      await tx.query("delete from project_trackers where org_id = $1", [org(c)]);
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "tracker.removed",
        target: { type: "tracker", id: org(c), label: new URL(had[0]?.base_url ?? "").host },
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    });
  });

  // ---- a project's link: its owner's ----

  /** The project, for someone who reaches it; `owner` when only its owner may do this. */
  const project = async (c: Ctx, owner: boolean) => {
    const id = c.req.param("id") ?? "";
    const access = isId(id) ? await projectAccess(db, org(c), me(c), id) : null;
    if (!access) return { refusal: fail(c, "not_found") } as const;
    if (owner && access.reach !== "owner")
      return { refusal: fail(c, "project_owner_only") } as const;
    return { id, name: access.name, reach: access.reach } as const;
  };

  app.get("/api/app/projects/:id/tracker", async (c) => {
    const at = await project(c, false);
    if ("refusal" in at) return at.refusal;
    return c.json({ ...(await tracker.standing(db, org(c), at.id)), mine: at.reach === "owner" });
  });

  // The tracker's projects, to choose one from.
  app.get("/api/app/projects/:id/tracker/projects", async (c) => {
    const at = await project(c, true);
    if ("refusal" in at) return at.refusal;
    const company = await tracker.api(db, org(c));
    if (!company) return fail(c, "tracker_unavailable");
    try {
      // Only those an administrator said may be linked.
      const allowed = new Set(company.allowed);
      return c.json({
        ok: true,
        projects: (await company.api.projects()).filter((one) => allowed.has(one.id)),
      });
    } catch (error) {
      const problem = said(error);
      if (!problem) throw error;
      return c.json({ ok: false, problem });
    }
  });

  app.put("/api/app/projects/:id/tracker", async (c) => {
    const parsed = z
      .strictObject({
        project: z.string().trim().min(1).max(80),
        /** Whether the steps already here are sent too. */
        send: z.boolean().default(true),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, "invalid_tracker");
    const at = await project(c, true);
    if ("refusal" in at) return at.refusal;
    const company = await tracker.api(db, org(c));
    if (!company) return fail(c, "tracker_unavailable");
    let chosen: { id: string; identifier: string; name: string } | undefined;
    let states: TrackerState[] = [];
    try {
      // Which projects there may be linked is an administrator's to say, not the owner's:
      // the company's key reaches all of them.
      if (!company.allowed.includes(parsed.data.project)) return fail(c, "tracker_not_allowed");
      chosen = (await company.api.projects()).find((one) => one.id === parsed.data.project);
      if (!chosen) return fail(c, "invalid_tracker");
      states = await company.api.states(chosen.id);
    } catch (error) {
      const problem = said(error);
      if (!problem) throw error;
      return c.json({ ok: false, problem });
    }
    const to = chosen;
    return inTx(c, async (tx) => {
      const had = await tx.query(
        "select 1 from project_trackers where project_id = $1 for update",
        [at.id],
      );
      if (had.length > 0) return fail(c, "tracker_linked");
      // Nothing of the tracker's is brought in: only steps sent from here are tied to it.
      await tx.query(
        `insert into project_trackers (project_id, org_id, external_project, identifier, name, states, linked_by, seen_through)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7, null)`,
        [at.id, org(c), to.id, to.identifier, to.name, JSON.stringify(states), me(c)],
      );
      if (parsed.data.send)
        await tx.query(
          `insert into tracker_outbox (step_id, project_id, org_id)
           select id, project_id, org_id from project_steps where project_id = $1
           on conflict (step_id) do nothing`,
          [at.id],
        );
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "project.tracker_linked",
        target: { type: "project", id: at.id, label: at.name },
        detail: { to: `${to.identifier} ${to.name}`, send: parsed.data.send },
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    });
  });

  app.delete("/api/app/projects/:id/tracker", async (c) => {
    const at = await project(c, true);
    if ("refusal" in at) return at.refusal;
    return inTx(c, async (tx) => {
      const had = await tx.query<{ identifier: string }>(
        "delete from project_trackers where project_id = $1 and org_id = $2 returning identifier",
        [at.id, org(c)],
      );
      if (had.length === 0) return fail(c, "not_found");
      // Both sides stay as they are.
      await tx.query("delete from step_tickets where project_id = $1", [at.id]);
      await tx.query("delete from tracker_outbox where project_id = $1", [at.id]);
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "project.tracker_unlinked",
        target: { type: "project", id: at.id, label: at.name },
        detail: { from: had[0]?.identifier },
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    });
  });
}
