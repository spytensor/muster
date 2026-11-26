import { newId } from "@muster/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import {
  addStep,
  addUpdate,
  keepProjectNotes,
  listSteps,
  listUpdates,
  PROJECT_NOTES_CHARS,
  stepsForAgent,
} from "./projects.js";
import { type Harness, harness } from "./test-support.js";

const json = async <T = unknown>(response: Response): Promise<T> => (await response.json()) as T;
interface Listed {
  id: string;
  name: string;
  notes: string;
  notesAt: string | null;
  notesRev: number;
  notesBy: string | null;
  notesEarlier: boolean;
}

describe("a project's notes", () => {
  let h: Harness;
  let owner: string;
  let mo: string;
  let id: string;
  beforeAll(async () => {
    h = await harness();
    owner = (await h.signIn("owner@acme.test")).cookie as string;
    await h.api(owner, "POST", "/api/invitations", { email: "mo@acme.test", role: "member" });
    mo = (await h.signIn("mo@acme.test")).cookie as string;
    id = (
      await json<{ id: string }>(await h.api(owner, "POST", "/api/app/projects", { name: "Quant" }))
    ).id;
  });
  const listed = async (as: string) =>
    (await json<Listed[]>(await h.api(as, "GET", "/api/app/projects"))).find(
      (one) => one.id === id,
    );

  it("begin empty, are written by the person, and say when and by whom", async () => {
    expect(await listed(owner)).toMatchObject({
      notes: "",
      notesAt: null,
      notesBy: null,
      notesEarlier: false,
    });
    const notes = "Where it stands\n- Three signals tested.\n\nNext\n- [ ] Freeze the parameters";
    expect((await h.api(owner, "PUT", `/api/app/projects/${id}/notes`, { notes })).status).toBe(
      200,
    );
    const now = await listed(owner);
    expect(now).toMatchObject({ notes, notesBy: null, notesEarlier: true });
    expect(now?.notesAt).toBeTruthy();
    // Another person neither sees the project nor writes in it.
    expect(await listed(mo)).toBeUndefined();
    expect((await h.api(mo, "PUT", `/api/app/projects/${id}/notes`, { notes: "x" })).status).toBe(
      404,
    );
    expect((await h.api(mo, "POST", `/api/app/projects/${id}/notes/restore`)).status).toBe(404);
    expect((await listed(owner))?.notes).toBe(notes);
    // Too long, or not notes at all, is refused.
    expect(
      (
        await h.api(owner, "PUT", `/api/app/projects/${id}/notes`, {
          notes: "x".repeat(PROJECT_NOTES_CHARS + 1),
        })
      ).status,
    ).toBe(400);
    expect((await h.api(owner, "PUT", `/api/app/projects/${id}/notes`, { text: "x" })).status).toBe(
      400,
    );
    expect(
      (await h.api(owner, "PUT", "/api/app/projects/not-an-id/notes", { notes: "x" })).status,
    ).toBe(404);
  });

  it("are brought up to date by an agent, and what they were can be brought back", async () => {
    const before = (await listed(owner))?.notes as string;
    const session = await h.db.query<{ org_id: string; user_id: string }>(
      "select org_id, user_id from projects where id = $1",
      [id],
    );
    const at = {
      orgId: session[0]?.org_id as string,
      userId: session[0]?.user_id as string,
      projectId: id,
    };
    const after = "Where it stands\n- Parameters frozen.\n\nNext\n- [x] Freeze the parameters";
    expect(await keepProjectNotes(h.db, at, `  ${after}\r\n`, "Assistant")).toBe(true);
    expect(await listed(owner)).toMatchObject({
      notes: after,
      // Kept under the old name by a row written before the shown one was kept: read as Muster.
      notesBy: "Muster",
      notesEarlier: true,
    });
    // The same again changes nothing, and does not lose what was there before.
    expect(await keepProjectNotes(h.db, at, after, "Assistant")).toBe(true);
    // Too long is said to the agent, in words it can act on.
    await expect(
      keepProjectNotes(h.db, at, "x".repeat(PROJECT_NOTES_CHARS + 1), "Assistant"),
    ).rejects.toThrow(/characters at most/);
    // Not the person's project: nothing is kept.
    expect(
      await keepProjectNotes(
        h.db,
        { ...at, userId: "00000000-0000-7000-8000-000000000000" },
        "x",
        "A",
      ),
    ).toBe(false);
    expect((await h.api(owner, "POST", `/api/app/projects/${id}/notes/restore`)).status).toBe(200);
    expect(await listed(owner)).toMatchObject({ notes: before, notesBy: null });
    // And forward again: one step either way.
    expect((await h.api(owner, "POST", `/api/app/projects/${id}/notes/restore`)).status).toBe(200);
    expect((await listed(owner))?.notes).toBe(after);
  });

  it("say Muster for the general agent: on a step given to it, and on what was kept under its old name", async () => {
    const [row] = await h.db.query<{ org_id: string; user_id: string }>(
      "select org_id, user_id from projects where id = $1",
      [id],
    );
    const at = { orgId: row?.org_id as string, userId: row?.user_id as string, projectId: id };
    // The company's agents are there once someone has looked for them.
    await h.api(owner, "GET", "/api/app/agents");
    const [general] = await h.db.query<{ id: string }>(
      "select id from agents where org_id = $1 and source = 'platform' and name = 'Assistant'",
      [at.orgId],
    );
    // A person's own agent of that name, from before the name was kept: theirs, as named.
    const mine = newId();
    await h.db.query(
      `insert into agents (id, org_id, name, description, source, owner_user_id, risk, state, version, model, instructions, tools)
       values ($1, $2, 'Assistant', '', 'user', $3, 'R1', 'published', 'v', 'm', 'x', '{}')`,
      [mine, at.orgId, at.userId],
    );
    // Rows as they were written before the shown name was the one kept.
    await addStep(h.db, at, { id: newId(), title: "Ask legal", agentId: general?.id }, "Assistant");
    await addStep(h.db, at, { id: newId(), title: "Draft it", agentId: mine }, "Researcher");
    await addUpdate(
      h.db,
      at,
      { id: newId(), health: "on_track", text: "Going well." },
      "Assistant",
    );

    const steps = await listSteps(h.db, at);
    expect(steps.map((step) => [step.title, step.agentName, step.by])).toEqual([
      ["Ask legal", "Muster", "Muster"],
      ["Draft it", "Assistant", "Researcher"],
    ]);
    // What an agent is told of the steps names them the same.
    expect(stepsForAgent(steps, "2026-11-24")).toContain("(given to Muster)");
    expect(stepsForAgent(steps, "2026-11-24")).toContain("(given to Assistant)");
    expect((await listUpdates(h.db, at, 1))[0]).toMatchObject({ by: "Muster" });
    // And what the pages are sent.
    const sent = await json<{
      steps: { title: string; agentName: string | null; by: string | null }[];
    }>(await h.api(owner, "GET", `/api/app/projects/${id}/steps`));
    expect(JSON.stringify(sent)).not.toContain('"by":"Assistant"');
  });

  it("do not write over a change the page has not seen, and keep the person's own to go back to", async () => {
    const mine = "Where it stands\n- Written by the person.";
    expect(
      (await h.api(owner, "PUT", `/api/app/projects/${id}/notes`, { notes: mine })).status,
    ).toBe(200);
    const seen = (await listed(owner))?.notesRev;
    const session = await h.db.query<{ org_id: string; user_id: string }>(
      "select org_id, user_id from projects where id = $1",
      [id],
    );
    const at = {
      orgId: session[0]?.org_id as string,
      userId: session[0]?.user_id as string,
      projectId: id,
    };
    // Two agents write, one after the other.
    await keepProjectNotes(h.db, at, "First agent.", "Assistant");
    await keepProjectNotes(h.db, at, "Second agent.", "Researcher");
    // The page, which read the notes before either, is told they changed and writes nothing.
    const late = await h.api(owner, "PUT", `/api/app/projects/${id}/notes`, {
      notes: "A tick.",
      seen,
    });
    expect(late.status).toBe(409);
    expect((await json<{ error: { code: string } }>(late)).error.code).toBe("notes_changed");
    expect((await listed(owner))?.notes).toBe("Second agent.");
    // With what it sees now, it writes.
    const now = (await listed(owner))?.notesRev;
    expect(
      (
        await h.api(owner, "PUT", `/api/app/projects/${id}/notes`, {
          notes: "Second agent.\n- A tick.",
          seen: now,
        })
      ).status,
    ).toBe(200);
    // Agents again; then what is brought back is what the person last left, not the first agent's.
    await keepProjectNotes(h.db, at, "Third.", "Assistant");
    await keepProjectNotes(h.db, at, "Fourth.", "Assistant");
    expect((await h.api(owner, "POST", `/api/app/projects/${id}/notes/restore`)).status).toBe(200);
    expect((await listed(owner))?.notes).toBe("Second agent.\n- A tick.");
    // Said without what was seen, as an older page does, it is written.
    expect(
      (await h.api(owner, "PUT", `/api/app/projects/${id}/notes`, { notes: "Plain." })).status,
    ).toBe(200);
    expect(
      (
        await h.api(owner, "PUT", `/api/app/projects/${id}/notes`, {
          notes: "x",
          seen: "yesterday",
        })
      ).status,
    ).toBe(400);
    expect(mine.length).toBeGreaterThan(0);
  });
});
