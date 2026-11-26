import type { Queryable } from "./db.js";
import { legacySql, shownSql } from "./runtime/catalog.js";
import { sharedWith } from "./sharing.js";

/**
 * A project's notes: where its work stands, for whoever picks it up next. They are what
 * carries a project from one conversation to the next: every conversation in it reads
 * them first, an agent brings them up to date when something is concluded, and the person
 * can write in them themself.
 *
 * Added 2026-11-22. The owner, of a project with three conversations in it: "既然是一个项
 * 目，是否有一个这个项目的概览". Until then each conversation in a project began knowing
 * only the project's name and its instructions, and what an earlier one had concluded
 * stayed in that conversation.
 */
export const PROJECT_NOTES_CHARS = 6000;

/** The notes were changed since the person's page read them: theirs would overwrite that. */
export class NotesChanged extends Error {}

/**
 * Keeps a project's notes, the whole of them. `by` is the agent that wrote them, or null
 * for the person. `seen` is the count of the notes the writer started from, for a
 * person's page, which may be minutes old: if they have been changed since, nothing is
 * kept and NotesChanged is thrown. False when the project is not the person's.
 *
 * What the notes were is remembered once, so that a change can be taken back: the notes
 * as the person last left them, or as they stood before agents began changing them. One
 * agent's change after another's does not move it, or two changes by agents would leave
 * nothing of the person's own to go back to.
 */
export async function keepProjectNotes(
  db: Queryable,
  at: { orgId: string; userId: string; projectId: string },
  notes: string,
  by: string | null,
  seen?: number,
): Promise<boolean> {
  const text = notes.replace(/\r\n/g, "\n").split("\u0000").join("").trim();
  if (text.length > PROJECT_NOTES_CHARS)
    throw new Error(
      `A project's notes are ${PROJECT_NOTES_CHARS} characters at most. Keep what still matters and say it shorter.`,
    );
  const checked = seen !== undefined;
  const saved = await db.query(
    `update projects
        set notes_before = case when $5::text is not null and notes_by is not null and notes_before is not null
                                then notes_before else notes end,
            notes = $4, notes_at = now(), notes_by = $5, notes_rev = notes_rev + 1
      where id = $1 and org_id = $2 and user_id = $3 and notes is distinct from $4
        and (not $6::boolean or notes_rev = $7::integer) returning id`,
    [at.projectId, at.orgId, at.userId, text, by, checked, checked ? seen : 0],
  );
  if (saved.length) return true;
  const there = await db.query<{ same: boolean }>(
    "select (notes is not distinct from $4) as same from projects where id = $1 and org_id = $2 and user_id = $3",
    [at.projectId, at.orgId, at.userId, text],
  );
  // Not the person's is said to be not there; unchanged is kept as it is.
  if (there.length === 0) return false;
  if (!there[0]?.same) throw new NotesChanged();
  return true;
}

/**
 * A project's steps: what is still to do in it, each a row of its own with a state, who
 * has it, when it is due, the conversation working on it and what came of it.
 *
 * Added 2026-11-23. Until then a step was a line "- [ ] …" in the notes: it could be
 * ticked, and nothing more. It could not say that an agent was on it, that it waited for
 * the person, when it was due or which conversation did it, and nothing could count how
 * far the project had come. The owner, asked what a project's page needs: "你进去后 UI 上
 * 你需要看到啥呢？需要管理啥呢？比如进度看板吗？一个完整的 PM 需要的东西？".
 *
 * It is still not a board for a team: one person, working with agents. A step is the
 * person's ("todo"), being worked on in a conversation ("doing"), stopped until the
 * person says or does something ("waiting"), or finished ("done").
 */
export const STEP_STATES = ["todo", "doing", "waiting", "done"] as const;
export type StepState = (typeof STEP_STATES)[number];
export const STEP_TITLE_CHARS = 200;
export const STEP_RESULT_CHARS = 600;
export const STEPS_PER_PROJECT = 200;
/** A day, as a step's due date is kept: 2026-11-30. */
export const DAY = /^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export type Step = {
  id: string;
  /** Its number in the project: how an agent, and a person in words, names it. */
  n: number;
  title: string;
  state: StepState;
  due: string | null;
  /** The agent it was given to; null when it is the person's own. */
  agentId: string | null;
  agentName: string | null;
  /** The conversation working on it, or that finished it. */
  conversationId: string | null;
  conversationTitle: string | null;
  /** What came of it, in a sentence or two. */
  result: string;
  /** The agent that last changed it; null when the person did. */
  by: string | null;
  updatedAt: Date;
  doneAt: Date | null;
  /** Whose conversation is working on it. Not sent to a page: see `stepFor`. */
  conversationUserId?: string | null;
};

/**
 * A step as one person is shown it. The conversation working on a step is its person's
 * alone: to anyone else in the project the step says that it is being worked on, and by
 * whom is not a link they could open, nor a title they were not told.
 */
export function stepFor(step: Step, viewerId: string): Step & { conversationMine: boolean } {
  const { conversationUserId, ...shown } = step;
  const mine = conversationUserId === viewerId;
  return {
    ...shown,
    conversationId: mine ? step.conversationId : null,
    conversationTitle: mine ? step.conversationTitle : null,
    conversationMine: mine,
  };
}
export interface StepChange {
  title?: string;
  state?: StepState;
  due?: string | null;
  agentId?: string | null;
  conversationId?: string | null;
  result?: string;
  /** Put it before this step; null puts it last. */
  before?: string | null;
}
/**
 * Where something of a project is kept: the project, and the person whose it is. `userId`
 * is always the project's owner, found by `projectAccess` when someone else is asking;
 * `actorId` is that someone else, a member working in it, where it matters who acted.
 */
type At = { orgId: string; userId: string; projectId: string; actorId?: string };

/** A step that cannot be kept as asked, in words an agent can act on and a code a page can word. */
export class StepProblem extends Error {
  constructor(
    readonly code:
      | "invalid_step"
      | "step_agent"
      | "too_many_steps"
      | "invalid_update"
      | "invalid_doc"
      | "too_many_docs"
      | "invalid_member"
      | "too_many_members",
    message: string,
  ) {
    super(message);
  }
}

const STEP_COLUMNS = `s.id, s.n, s.title, s.state, s.due, s.agent_id as "agentId", ${shownSql("a")} as "agentName",
  s.conversation_id as "conversationId", v.title as "conversationTitle", v.user_id as "conversationUserId", s.result, ${legacySql("s.by")} as "by",
  s.updated_at as "updatedAt", s.done_at as "doneAt"`;
const STEP_FROM = `project_steps s left join agents a on a.id = s.agent_id and a.deleted_at is null
  left join conversations v on v.id = s.conversation_id and v.archived_at is null`;

const line = (text: string, most: number) =>
  text.replace(/\s+/g, " ").split("\u0000").join("").trim().slice(0, most);

/** A project's steps in their order: open ones first as the person arranged them. */
export async function listSteps(db: Queryable, at: At): Promise<Step[]> {
  return db.query<Step>(
    `select ${STEP_COLUMNS} from ${STEP_FROM}
      where s.project_id = $1 and s.org_id = $2 and s.user_id = $3 order by s.position, s.n`,
    [at.projectId, at.orgId, at.userId],
  );
}

/**
 * Whether an agent is one this person may give a step to: the organization's published
 * ones, their own, and what a colleague shared with them. The same agents their list of
 * agents shows as usable.
 */
async function usable(db: Queryable, at: At, agentId: string): Promise<boolean> {
  return (
    (
      await db.query(
        `select 1 from agents a where a.id = $1 and a.org_id = $2 and a.state = 'published'
            and a.deleted_at is null
            and (a.source <> 'user' or a.owner_user_id = $3 or ${sharedWith("agent", "a", "$2", "$3")})`,
        [agentId, at.orgId, at.actorId ?? at.userId],
      )
    ).length > 0
  );
}

/**
 * Adds a step, last in the project. Null when the project is not the person's. `by` is
 * the agent that added it, or null for the person.
 */
export async function addStep(
  db: Queryable,
  at: At,
  step: { id: string; title: string; due?: string | null; agentId?: string | null },
  by: string | null,
): Promise<Step | null> {
  const title = line(step.title, STEP_TITLE_CHARS);
  if (!title)
    throw new StepProblem(
      "invalid_step",
      "A step needs a title: what is to be done, in a few words.",
    );
  if (step.due != null && !DAY.test(step.due))
    throw new StepProblem("invalid_step", "A step's due date is a day, written 2026-11-30.");
  if (step.agentId && !(await usable(db, at, step.agentId)))
    throw new StepProblem("step_agent", "That agent cannot be given a step.");
  const insertStep = () =>
    db.query<{ id: string }>(
      `insert into project_steps (id, org_id, project_id, user_id, n, title, due, agent_id, position, by)
     select $1, p.org_id, p.id, p.user_id,
            coalesce((select max(n) from project_steps where project_id = p.id), 0) + 1,
            $5, $6, $7,
            coalesce((select max(position) from project_steps where project_id = p.id), 0) + 1, $8
       from projects p
      where p.id = $2 and p.org_id = $3 and p.user_id = $4
        and (select count(*) from project_steps where project_id = p.id) < $9
     returning id`,
      [
        step.id,
        at.projectId,
        at.orgId,
        at.userId,
        title,
        step.due ?? null,
        step.agentId ?? null,
        by,
        STEPS_PER_PROJECT,
      ],
    );
  // Two added at the same moment (the person and an agent) would take the same number:
  // the second is tried again, with the number after.
  let made: { id: string }[] = [];
  for (let attempt = 0; ; attempt++) {
    try {
      made = await insertStep();
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== "23505" || attempt >= 4) throw error;
    }
  }
  if (made.length === 0) {
    const there = await db.query<{ count: string }>(
      `select (select count(*) from project_steps where project_id = p.id) as count
         from projects p where p.id = $1 and p.org_id = $2 and p.user_id = $3`,
      [at.projectId, at.orgId, at.userId],
    );
    if (there.length === 0) return null;
    throw new StepProblem(
      "too_many_steps",
      `A project holds ${STEPS_PER_PROJECT} steps at most. Remove ones that are done and no longer matter.`,
    );
  }
  return (await listSteps(db, at)).find((one) => one.id === step.id) ?? null;
}

/**
 * Changes a step, named by its id or by its number in the project. Null when there is no
 * such step in a project of the person's.
 */
export async function changeStep(
  db: Queryable,
  at: At,
  which: { id: string } | { n: number },
  change: StepChange,
  by: string | null,
): Promise<Step | null> {
  const steps = await listSteps(db, at);
  const step = steps.find((one) => ("id" in which ? one.id === which.id : one.n === which.n));
  if (!step) return null;
  const title = change.title === undefined ? step.title : line(change.title, STEP_TITLE_CHARS);
  if (!title) throw new StepProblem("invalid_step", "A step needs a title.");
  if (change.due != null && !DAY.test(change.due))
    throw new StepProblem("invalid_step", "A step's due date is a day, written 2026-11-30.");
  if (change.agentId && !(await usable(db, at, change.agentId)))
    throw new StepProblem("step_agent", "That agent cannot be given a step.");
  const state = change.state ?? step.state;
  const position: number | null = null;
  if (change.before !== undefined) {
    const others = steps.filter((one) => one.id !== step.id);
    const place =
      change.before === null ? others.length : others.findIndex((o) => o.id === change.before);
    if (place === -1)
      throw new StepProblem("invalid_step", "The step to put it before is not in this project.");
    // Every step is given its place anew: no halving of gaps that would one day run out.
    const order = [...others.slice(0, place), step, ...others.slice(place)].map((one) => one.id);
    await db.query(
      `update project_steps s set position = o.at
         from unnest($1::uuid[]) with ordinality as o(id, at)
        where s.id = o.id and s.project_id = $2`,
      [order, at.projectId],
    );
  }
  await db.query(
    `update project_steps
        set title = $2, state = $3,
            due = case when $4::boolean then $5 else due end,
            agent_id = case when $6::boolean then $7::uuid else agent_id end,
            conversation_id = case when $8::boolean then $9::uuid else conversation_id end,
            result = case when $10::boolean then $11 else result end,
            position = coalesce($12::double precision, position),
            -- Who last wrote its words. A person who only ticks, dates or moves a step an
            -- agent finished has not written what came of it.
            by = case when $14::boolean then $13 else by end, updated_at = now(),
            done_at = case when $3 = 'done' then coalesce(done_at, now()) else null end
      where id = $1`,
    [
      step.id,
      title,
      state,
      change.due !== undefined,
      change.due ?? null,
      change.agentId !== undefined,
      change.agentId ?? null,
      change.conversationId !== undefined,
      change.conversationId ?? null,
      change.result !== undefined,
      line(change.result ?? "", STEP_RESULT_CHARS),
      position,
      by,
      by !== null ||
        (change.title !== undefined && title !== step.title) ||
        (change.result !== undefined && line(change.result, STEP_RESULT_CHARS) !== step.result),
    ],
  );
  return (await listSteps(db, at)).find((one) => one.id === step.id) ?? null;
}

export async function removeStep(db: Queryable, at: At, id: string): Promise<boolean> {
  return (
    (
      await db.query(
        "delete from project_steps where id = $1 and project_id = $2 and org_id = $3 and user_id = $4 returning id",
        [id, at.projectId, at.orgId, at.userId],
      )
    ).length > 0
  );
}

/** How a step reads to an agent: its number, how it stands, and what is known of it. */
export function stepForAgent(one: Step, today: string): string {
  const words: Record<StepState, string> = {
    todo: "to do",
    doing: "being done",
    waiting: "waiting for the person",
    done: "done",
  };
  const result = one.result.length > 160 ? `${one.result.slice(0, 160)}…` : one.result;
  return `${one.n}. [${words[one.state]}] ${one.title}${one.agentName ? ` (given to ${one.agentName})` : ""}${one.due ? ` (due ${one.due}${one.state !== "done" && one.due < today ? ", overdue" : ""})` : ""}${result ? ` — ${result}` : ""}`;
}

/** Open steps an agent is shown in full; a project with more is told how many more. */
export const STEPS_SHOWN = 40;

/**
 * A project's steps as an agent is shown them: numbered, the open ones in full (the first
 * forty), the last twelve done ones in a line. Bounded, since it is in every prompt.
 */
export function stepsForAgent(steps: readonly Step[], today: string): string {
  if (steps.length === 0) return "(no steps yet)";
  const open = steps.filter((one) => one.state !== "done");
  const done = steps.filter((one) => one.state === "done");
  return [
    ...open.slice(0, STEPS_SHOWN).map((one) => stepForAgent(one, today)),
    ...(open.length > STEPS_SHOWN ? [`(and ${open.length - STEPS_SHOWN} more open steps)`] : []),
    ...(done.length
      ? [
          `Done: ${done
            .slice(-12)
            .map((one) => `${one.n}. ${one.title.slice(0, 80)}`)
            .join("; ")}${done.length > 12 ? `; and ${done.length - 12} earlier` : ""}`,
        ]
      : []),
  ].join("\n");
}

/** A line of a project's notes that is a step to take: "- [ ] …" or "- [x] …". */
const STEP_LINE = /^(\s*)[-*]\s*\[( |x|X)\]\s+(.*)$/;
/** A line that names a list: a Markdown heading, or a few words with no sentence in them. */
const HEADING = /^(#{1,6}\s+\S.*|[^.!?。！？,，;；]{1,30}[:：]?)$/;

/**
 * The steps written in a project's notes as lines of text, and the notes without them.
 * A heading that stood over nothing but steps ("Next") goes with them; a sentence above
 * them stays, and so does everything else. What is indented under a step line is part of
 * that step and goes with it.
 */
export function stepsInNotes(notes: string): {
  steps: { title: string; done: boolean }[];
  rest: string;
} {
  const lines = notes.split(/\r?\n/);
  const steps: { title: string; done: boolean }[] = [];
  const kept: string[] = [];
  const item = (text: string) => /^\s*[-*]\s/.test(text);
  const indent = (text: string) => text.length - text.trimStart().length;
  for (let at = 0; at < lines.length; at++) {
    const text = lines[at] as string;
    const step = text.match(STEP_LINE);
    if (step) {
      const title = (step[3] as string).trim();
      if (title) steps.push({ title, done: step[2] !== " " });
      // What hangs under it is its own: it does not stay behind without it.
      while (
        at + 1 < lines.length &&
        (lines[at + 1] as string).trim() &&
        indent(lines[at + 1] as string) > indent(text)
      )
        at++;
      continue;
    }
    // A heading with nothing under it but steps (and what hangs under them).
    if (text.trim() && !item(text) && HEADING.test(text.trim())) {
      let next = at + 1;
      let own = 0;
      let other = false;
      for (; next < lines.length && (lines[next] as string).trim(); next++) {
        const under = lines[next] as string;
        if (STEP_LINE.test(under)) own++;
        else if (!(own > 0 && indent(under) > 0)) other = true;
      }
      if (own > 0 && !other) continue;
    }
    kept.push(text);
  }
  return {
    steps,
    rest: kept
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  };
}

/**
 * Makes the step lines of a project's notes steps of their own and takes them out of the
 * notes, in one go: either both happen or neither. `seen` is the count of the notes the
 * page started from. Null when the project is not the person's.
 */
export async function adoptSteps(
  db: { tx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> },
  at: At,
  ids: () => string,
  seen: number,
): Promise<number | null> {
  return db.tx(async (tx) => {
    const project = (
      await tx.query<{ notes: string; notes_rev: number }>(
        "select notes, notes_rev from projects where id = $1 and org_id = $2 and user_id = $3 for update",
        [at.projectId, at.orgId, at.userId],
      )
    )[0];
    if (!project) return null;
    if (project.notes_rev !== seen) throw new NotesChanged();
    const { steps, rest } = stepsInNotes(project.notes);
    if (steps.length === 0) return 0;
    for (const one of steps) {
      const made = await addStep(tx, at, { id: ids(), title: one.title }, null);
      if (made && one.done) await changeStep(tx, at, { id: made.id }, { state: "done" }, null);
    }
    await keepProjectNotes(tx, at, rest, null, seen);
    return steps.length;
  });
}

/**
 * A project's updates: how it is going, said at a moment and kept. Each is a line of
 * health (on track, at risk, off track) and a few sentences, written by the person or
 * drafted by an agent working in the project. They are only ever added to: an update is
 * what was true when it was written, so the list is the project's history as it was
 * told, and the newest says how it is going now.
 *
 * Added 2026-11-23, with the steps. The notes say where the work stands and are
 * rewritten; nothing there could be sent upward or looked back on.
 */
export const HEALTHS = ["on_track", "at_risk", "off_track"] as const;
export type Health = (typeof HEALTHS)[number];
export const UPDATE_CHARS = 2000;
/** Updates kept for a project; the oldest go when there are more. */
export const UPDATES_KEPT = 50;

export type ProjectUpdate = {
  id: string;
  health: Health;
  text: string;
  /** The agent that wrote it; null when the person did. */
  by: string | null;
  /** Who posted it, or in whose conversation the agent wrote it. Null when they are gone. */
  author: { id: string; name: string } | null;
  createdAt: Date;
};
const UPDATE_COLUMNS = `u.id, u.health, u.text, ${legacySql("u.by")} as "by", u.created_at as "createdAt",
  (select json_build_object('id', w.id, 'name', w.name) from users w
    where w.id = coalesce(u.author_id, u.user_id)) as author`;

export async function listUpdates(
  db: Queryable,
  at: At,
  most = UPDATES_KEPT,
): Promise<ProjectUpdate[]> {
  return db.query<ProjectUpdate>(
    `select ${UPDATE_COLUMNS} from project_updates u
      where u.project_id = $1 and u.org_id = $2 and u.user_id = $3
      order by u.created_at desc, u.id desc limit $4`,
    [at.projectId, at.orgId, at.userId, most],
  );
}

/** Adds an update. Null when the project is not the person's. */
export async function addUpdate(
  db: Queryable,
  at: At,
  update: { id: string; health: string; text: string },
  by: string | null,
): Promise<ProjectUpdate | null> {
  const health = HEALTHS.find((one) => one === update.health);
  if (!health)
    throw new StepProblem("invalid_update", 'health is "on_track", "at_risk" or "off_track".');
  const text = update.text.replace(/\r\n/g, "\n").split("\u0000").join("").trim();
  if (!text) throw new StepProblem("invalid_update", "An update says how the project is going.");
  if (text.length > UPDATE_CHARS)
    throw new StepProblem(
      "invalid_update",
      `An update is ${UPDATE_CHARS} characters at most. Say what changed, what is at risk and what is next, shorter.`,
    );
  const added = await db.query(
    `insert into project_updates (id, org_id, project_id, user_id, health, text, by, author_id)
     select $1, p.org_id, p.id, p.user_id, $5, $6, $7, $8 from projects p
      where p.id = $2 and p.org_id = $3 and p.user_id = $4
     returning id`,
    [update.id, at.projectId, at.orgId, at.userId, health, text, by, at.actorId ?? at.userId],
  );
  if (added.length === 0) return null;
  const made = await db.query<ProjectUpdate>(
    `select ${UPDATE_COLUMNS} from project_updates u where u.id = $1`,
    [update.id],
  );
  await db.query(
    `delete from project_updates where project_id = $1 and id not in
       (select id from project_updates where project_id = $1 order by created_at desc, id desc limit $2)`,
    [at.projectId, UPDATES_KEPT],
  );
  return made[0] as ProjectUpdate;
}

/**
 * Removes an update. The owner removes any; a member working in the project only one
 * posted by them or in their conversation, so that nobody takes back another's word.
 */
export async function removeUpdate(db: Queryable, at: At, id: string): Promise<boolean> {
  const own = at.actorId && at.actorId !== at.userId ? at.actorId : null;
  return (
    (
      await db.query(
        `delete from project_updates where id = $1 and project_id = $2 and org_id = $3 and user_id = $4
            and ($5::uuid is null or author_id = $5) returning id`,
        [id, at.projectId, at.orgId, at.userId, own],
      )
    ).length > 0
  );
}

/**
 * A project's key documents: the few files everything else in it rests on, each named
 * for what it is (the spec, the decisions, the research, the release notes). The person
 * pins them on the project's page; every conversation in the project is told which they
 * are, so an agent reads the spec before it works from it.
 *
 * Added 2026-11-23. Until then a project's files were the newest eight made in it, with
 * nothing to say which of them mattered.
 */
export const DOC_KINDS = ["spec", "decisions", "research", "release", "other"] as const;
export type DocKind = (typeof DOC_KINDS)[number];
export const DOCS_PER_PROJECT = 12;

export type ProjectDoc = {
  fileId: string;
  kind: DocKind;
  name: string;
  /**
   * The person has a newer file of the same name. A file is read by its name, and the
   * newest of a name is the one read: an agent told only the name would read the other.
   */
  shadowed: boolean;
  fileKind: string;
  size: number;
  version: number;
};

/** A project's key documents, in the order of their kinds. Files since deleted are left out. */
export async function listDocs(db: Queryable, at: At): Promise<ProjectDoc[]> {
  const rows = await db.query<ProjectDoc>(
    `select d.file_id as "fileId", d.kind, f.name, f.kind as "fileKind", f.size, f.version,
            exists (select 1 from files n where n.org_id = f.org_id and n.user_id = f.user_id
                     and n.name = f.name and n.deleted_at is null and n.created_at > f.created_at) as shadowed
       from project_docs d join files f on f.id = d.file_id and f.deleted_at is null
      where d.project_id = $1 and d.org_id = $2 and d.user_id = $3
      order by array_position(array['spec','decisions','research','release','other'], d.kind), d.created_at`,
    [at.projectId, at.orgId, at.userId],
  );
  return rows.map((row) => ({ ...row, size: Number(row.size) }));
}

/**
 * Pins a file as one of a project's key documents, or changes what it is pinned as.
 * False when the project or the file is not the person's to use.
 */
export async function pinDoc(
  db: Queryable,
  at: At,
  doc: { id: string; fileId: string; kind: string },
): Promise<boolean> {
  const kind = DOC_KINDS.find((one) => one === doc.kind);
  if (!kind)
    throw new StepProblem(
      "invalid_doc",
      "A key document is a spec, decisions, research, release notes or other.",
    );
  // The file must be the person's own and still there, in a project of theirs: said
  // before anything is counted, so that a full project does not answer for a file that
  // was never theirs to pin.
  const theirs = await db.query(
    `select 1 from projects p, files f
      where p.id = $1 and p.org_id = $2 and p.user_id = $3
        and f.id = $4 and f.org_id = p.org_id and f.user_id = p.user_id and f.deleted_at is null`,
    [at.projectId, at.orgId, at.userId, doc.fileId],
  );
  if (theirs.length === 0) return false;
  // A pinned file that was deleted since is no longer a key document: it is not left to
  // take one of the twelve places unseen.
  await db.query(
    `delete from project_docs d using files f
      where d.project_id = $1 and f.id = d.file_id and f.deleted_at is not null`,
    [at.projectId],
  );
  const made = await db.query(
    `insert into project_docs (id, org_id, project_id, user_id, file_id, kind)
     select $1, p.org_id, p.id, p.user_id, f.id, $6 from projects p, files f
      where p.id = $2 and p.org_id = $3 and p.user_id = $4
        and f.id = $5 and f.org_id = p.org_id and f.user_id = p.user_id and f.deleted_at is null
        and ((select count(*) from project_docs where project_id = p.id) < $7
          or exists (select 1 from project_docs where project_id = p.id and file_id = f.id))
     on conflict (project_id, file_id) do update set kind = excluded.kind
     returning id`,
    [doc.id, at.projectId, at.orgId, at.userId, doc.fileId, kind, DOCS_PER_PROJECT],
  );
  if (made.length > 0) return true;
  const full = await db.query<{ count: string }>(
    `select count(*) as count from project_docs d join projects p on p.id = d.project_id
      where p.id = $1 and p.org_id = $2 and p.user_id = $3`,
    [at.projectId, at.orgId, at.userId],
  );
  if (Number(full[0]?.count ?? 0) >= DOCS_PER_PROJECT)
    throw new StepProblem(
      "too_many_docs",
      `A project has ${DOCS_PER_PROJECT} key documents at most. Unpin one that no longer matters.`,
    );
  return false;
}

export async function unpinDoc(db: Queryable, at: At, fileId: string): Promise<boolean> {
  return (
    (
      await db.query(
        "delete from project_docs where file_id = $1 and project_id = $2 and org_id = $3 and user_id = $4 returning id",
        [fileId, at.projectId, at.orgId, at.userId],
      )
    ).length > 0
  );
}

/** A project's key documents as an agent is told of them: what each is, and its name. */
export function docsForAgent(docs: readonly ProjectDoc[]): string {
  const words: Record<DocKind, string> = {
    spec: "The spec",
    decisions: "Decisions",
    research: "Research",
    release: "Release notes",
    other: "Also",
  };
  return docs
    .map(
      (doc) =>
        // The name as a quoted string, whatever is in it: a name cannot close its own quotes.
        `- ${words[doc.kind]}: ${JSON.stringify(doc.name)}${doc.shadowed ? " (the person has a newer file of this same name, and files.read gives the newer one: say so to them before relying on it)" : ""}`,
    )
    .join("\n");
}

/**
 * A project's people. A project is one person's, and they can bring colleagues into it:
 * to see it (its instructions, notes, steps, updates and key documents) or to work in it
 * (also keep its notes and steps, post updates, and start conversations of their own
 * there). Its name, instructions, key documents and people stay the owner's to change.
 *
 * A conversation in the project is its person's alone, whoever else is in the project:
 * what is shared is the project's own page, not what anyone said to an agent in it.
 *
 * Added 2026-11-24 (MUS-13). Until then a project could be shown to nobody: someone
 * asking how it stood had to be sent a picture of the page.
 */
export const PROJECT_ROLES = ["view", "work"] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];
export const MEMBERS_PER_PROJECT = 50;
/** What a person is to a project they can reach. */
export type ProjectReach = "owner" | ProjectRole;

/**
 * SQL that is true when the person `user` reaches the project in `alias`: it is theirs,
 * or they were brought into it.
 */
export const reaches = (alias: string, user: string) =>
  `(${alias}.user_id = ${user} or exists (select 1 from project_members pm
      where pm.project_id = ${alias}.id and pm.user_id = ${user}))`;
/** SQL giving what the person `user` is to the project in `alias`: 'owner', 'work', 'view' or null. */
export const reachOf = (alias: string, user: string) =>
  `(case when ${alias}.user_id = ${user} then 'owner' else (select pm.role from project_members pm
      where pm.project_id = ${alias}.id and pm.user_id = ${user}) end)`;

/** Whose the project is and what this person is to it. Null when they cannot reach it. */
export async function projectAccess(
  db: Queryable,
  orgId: string,
  userId: string,
  projectId: string,
): Promise<{ ownerId: string; name: string; reach: ProjectReach } | null> {
  const row = (
    await db.query<{ ownerId: string; name: string; reach: ProjectReach | null }>(
      `select p.user_id as "ownerId", p.name, ${reachOf("p", "$3")} as reach
         from projects p where p.id = $1 and p.org_id = $2`,
      [projectId, orgId, userId],
    )
  )[0];
  return row?.reach ? { ownerId: row.ownerId, name: row.name, reach: row.reach } : null;
}

export type ProjectMember = {
  id: string;
  name: string;
  email: string;
  role: ProjectReach;
  /** False for someone no longer with the company: listed until removed, and reaching nothing. */
  active: boolean;
};

/** Everyone in the project: the owner first, then the others by name. */
export async function listMembers(db: Queryable, at: At): Promise<ProjectMember[]> {
  return db.query<ProjectMember>(
    `select u.id, u.name, u.email, x.role,
            exists (select 1 from memberships m
                     where m.org_id = $2 and m.user_id = u.id and m.status = 'active') as active
       from (select p.user_id, 'owner' as role, 0 as place from projects p
              where p.id = $1 and p.org_id = $2 and p.user_id = $3
             union all
             select pm.user_id, pm.role, 1 from project_members pm
               join projects p on p.id = pm.project_id
              where p.id = $1 and p.org_id = $2 and p.user_id = $3) x
       join users u on u.id = x.user_id
      order by x.place, lower(u.name), u.email`,
    [at.projectId, at.orgId, at.userId],
  );
}

/**
 * Brings a colleague into the project, or changes what they may do in it. Says what
 * happened; null when the project is not this owner's. Throws when the person is not an
 * active colleague, or the project holds as many people as it can.
 */
export async function setMember(
  db: Queryable,
  at: At,
  userId: string,
  role: ProjectRole,
): Promise<{ did: "added" | "changed" | "same"; name: string } | null> {
  if (userId === at.userId)
    throw new StepProblem("invalid_member", "The project is already theirs.");
  const person = (
    await db.query<{ name: string }>(
      `select u.name from memberships m join users u on u.id = m.user_id
        where m.org_id = $1 and m.user_id = $2 and m.status = 'active'`,
      [at.orgId, userId],
    )
  )[0];
  if (!person) throw new StepProblem("invalid_member", "There is no such colleague.");
  const before = (
    await db.query<{ role: ProjectRole }>(
      `select pm.role from project_members pm join projects p on p.id = pm.project_id
        where pm.project_id = $1 and pm.user_id = $4 and p.org_id = $2 and p.user_id = $3`,
      [at.projectId, at.orgId, at.userId, userId],
    )
  )[0];
  if (before?.role === role) return { did: "same", name: person.name };
  // One at a time for a project: two added at once each count the others before adding,
  // and would both be the last. (Callers run this in a transaction; the lock ends with it.)
  await db.query("select 1 from projects where id = $1 and org_id = $2 for update", [
    at.projectId,
    at.orgId,
  ]);
  const kept = await db.query(
    `insert into project_members (project_id, org_id, user_id, role, added_by)
     select p.id, p.org_id, $4, $5, p.user_id from projects p
      where p.id = $1 and p.org_id = $2 and p.user_id = $3
        and ($6 or (select count(*) from project_members pm where pm.project_id = p.id) < $7)
     on conflict (project_id, user_id) do update set role = excluded.role
     returning user_id`,
    [at.projectId, at.orgId, at.userId, userId, role, before !== undefined, MEMBERS_PER_PROJECT],
  );
  if (kept.length > 0) return { did: before ? "changed" : "added", name: person.name };
  const there = await db.query(
    "select 1 from projects where id = $1 and org_id = $2 and user_id = $3",
    [at.projectId, at.orgId, at.userId],
  );
  if (there.length === 0) return null;
  throw new StepProblem(
    "too_many_members",
    `A project holds ${MEMBERS_PER_PROJECT} people. Remove someone who no longer needs it.`,
  );
}

/**
 * Takes someone out of the project; their name, or null when they were not in it. Their
 * conversations there stay theirs and stop being told anything of the project: a run
 * looks up what its person reaches each time (runs.ts), so nothing has to be undone here,
 * and bringing them back puts their conversations back where they were.
 */
export async function removeMember(db: Queryable, at: At, userId: string): Promise<string | null> {
  const gone = await db.query<{ name: string }>(
    `delete from project_members pm using projects p, users u
      where pm.project_id = $1 and pm.user_id = $4 and p.id = pm.project_id
        and p.org_id = $2 and p.user_id = $3 and u.id = pm.user_id
      returning u.name`,
    [at.projectId, at.orgId, at.userId, userId],
  );
  return gone[0]?.name ?? null;
}
