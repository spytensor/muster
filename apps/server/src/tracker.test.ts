import { beforeAll, describe, expect, it } from "vitest";
import type { Net } from "./runtime/net.js";
import { type Harness, harness } from "./test-support.js";

const json = async <T = unknown>(response: Response): Promise<T> => (await response.json()) as T;
// Put together here, so that nothing shaped like a key is written in the repository.
const KEY = ["plane", "api_0123456789abcdefWXYZ"].join("_");
const BASE = "https://plane.acme.test/api/v1/workspaces/acme";

/** A Plane that keeps what it is sent, and can be told to fail. */
function fakePlane() {
  const states = [
    { id: "s-backlog", name: "Backlog", group: "backlog", sequence: 1 },
    { id: "s-todo", name: "Todo", group: "unstarted", sequence: 2, default: true },
    { id: "s-doing", name: "In Progress", group: "started", sequence: 3 },
    { id: "s-review", name: "In Review", group: "started", sequence: 4 },
    { id: "s-done", name: "Done", group: "completed", sequence: 5 },
    { id: "s-off", name: "Cancelled", group: "cancelled", sequence: 6 },
  ];
  type Item = {
    id: string;
    sequence_id: number;
    name: string;
    state: string;
    target_date: string | null;
    updated_at: string;
    external_id?: string;
  };
  const items: Item[] = [];
  const comments: { item: string; html: string }[] = [];
  /** How many items were ever made: a number is not given out twice. */
  let made = 0;
  const calls: { method: string; path: string; key: string | undefined }[] = [];
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const tick = () => {
    clock += 1000;
    return new Date(clock).toISOString();
  };
  const plane = {
    items,
    comments,
    calls,
    /** Answer the next calls with this status before doing anything. */
    failing: 0 as number,
    /** Do what the next create asks, and answer as if it had failed. */
    loseAnswer: false,
    /** Send the list oldest first, whatever order was asked for. */
    unsorted: false,
    /** What the project is called there. */
    identifier: "ACM",
    /** Answer nothing until this is settled. */
    hang: null as Promise<void> | null,
    /** Answer with something that is not an answer at all. */
    broken: false,
    /** Say only that an item exists already, not which. */
    bare409: false,
    edit(id: string, change: Partial<Item>) {
      const item = items.find((one) => one.id === id);
      if (item) Object.assign(item, change, { updated_at: tick() });
    },
    remove(id: string) {
      items.splice(
        items.findIndex((one) => one.id === id),
        1,
      );
    },
    writes: () => calls.filter((call) => call.method !== "GET").length,
  };
  const answer = (status: number, body: unknown, url: string) => ({
    status,
    contentType: "application/json",
    text: JSON.stringify(body),
    truncated: false,
    url,
  });
  const net: Net = {
    async request(url, init = {}) {
      const method = init.method ?? "GET";
      if (!url.startsWith(BASE)) return answer(404, {}, url);
      const { pathname, searchParams } = new URL(url);
      const path = pathname.slice(new URL(BASE).pathname.length);
      calls.push({ method, path, key: init.headers?.["x-api-key"] });
      if (init.headers?.["x-api-key"] !== KEY) return answer(401, { detail: "bad key" }, url);
      if (plane.hang) await plane.hang;
      if (plane.broken) return undefined as never;
      if (plane.failing > 0) {
        plane.failing -= 1;
        return answer(500, {}, url);
      }
      const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      if (path === "/projects/")
        return answer(
          200,
          {
            results: [
              { id: "p-1", identifier: plane.identifier, name: "Acme launch" },
              { id: "p-2", identifier: "OPS", name: "Operations" },
            ],
          },
          url,
        );
      if (path === "/projects/p-1/")
        return answer(200, { id: "p-1", identifier: plane.identifier, name: "Acme launch" }, url);
      if (path === "/projects/p-1/states/") return answer(200, { results: states }, url);
      // Asked for the item made for one step: that item, or none.
      if (
        path === "/projects/p-1/work-items/" &&
        method === "GET" &&
        searchParams.get("external_id")
      ) {
        const made = items.find((item) => item.external_id === searchParams.get("external_id"));
        return made
          ? answer(200, { ...made, external_source: "muster" }, url)
          : answer(404, { error: "not found" }, url);
      }
      if (path === "/projects/p-1/work-items/" && method === "GET") {
        const sorted = [...items].sort((a, b) =>
          plane.unsorted
            ? a.updated_at.localeCompare(b.updated_at)
            : b.updated_at.localeCompare(a.updated_at),
        );
        // Two to a page, to be read through.
        const from = Number(searchParams.get("cursor") ?? 0);
        const page = sorted.slice(from, from + 2);
        return answer(
          200,
          {
            results: page,
            next_page_results: from + 2 < sorted.length,
            next_cursor: String(from + 2),
          },
          url,
        );
      }
      if (path === "/projects/p-1/work-items/" && method === "POST") {
        const had = items.find((one) => one.external_id === body.external_id);
        if (had)
          return answer(
            409,
            plane.bare409 ? { error: "exists" } : { error: "exists", id: had.id },
            url,
          );
        const item: Item = {
          id: `i-${made + 1}`,
          sequence_id: made + 1,
          name: String(body.name),
          state: String(body.state ?? "s-backlog"),
          target_date: (body.target_date as string | undefined) ?? null,
          updated_at: tick(),
          external_id: String(body.external_id),
        };
        items.push(item);
        made += 1;
        if (plane.loseAnswer) {
          plane.loseAnswer = false;
          return answer(502, {}, url);
        }
        return answer(201, item, url);
      }
      const one = /^\/projects\/p-1\/work-items\/([^/]+)\/(comments\/)?$/.exec(path);
      const item = one && items.find((candidate) => candidate.id === one[1]);
      if (!one || !item) return answer(404, {}, url);
      if (one[2] && method === "POST") {
        comments.push({ item: item.id, html: String(body.comment_html) });
        return answer(201, {}, url);
      }
      if (method === "PATCH") {
        if (body.name !== undefined) item.name = String(body.name);
        if (body.state !== undefined) item.state = String(body.state);
        if (body.target_date !== undefined) item.target_date = body.target_date as string | null;
        item.updated_at = tick();
      }
      return answer(200, item, url);
    },
  };
  return { plane, net };
}

type StepRow = {
  id: string;
  n: number;
  title: string;
  state: string;
  due: string | null;
  result: string;
  ticket: { key: string; url: string } | null;
};
type Standing = {
  parked: number;
  available: boolean;
  link: { identifier: string; name: string; url: string } | null;
  waiting: number;
  failed: string | null;
  mine: boolean;
};

describe("a project's steps and the company's tracker", () => {
  const { plane, net } = fakePlane();
  let h: Harness;
  let owner: string;
  let mo: string;
  let id: string;
  /** Later each time: what is due is due. */
  let later = Date.now();
  const pass = async (minutes = 3) => {
    later += minutes * 60_000;
    await h.tracker.tick(new Date(later));
  };
  const at = (rest = "") => `/api/app/projects/${id}${rest}`;
  const steps = async (as = owner) => json<StepRow[]>(await h.api(as, "GET", at("/steps")));
  const standing = async (as = owner) => json<Standing>(await h.api(as, "GET", at("/tracker")));
  const add = async (title: string, more: Record<string, unknown> = {}) =>
    json<StepRow>(await h.api(owner, "POST", at("/steps"), { title, ...more }));
  const change = (step: string, body: Record<string, unknown>) =>
    h.api(owner, "PATCH", at(`/steps/${step}`), body);
  const itemOf = (key: string | undefined) =>
    plane.items.find((item) => `ACM-${item.sequence_id}` === key);
  const waits = (step: string) =>
    h.db.query<{ tries: number; parked_at: Date | null; last_error: string | null }>(
      "select tries, parked_at, last_error from tracker_outbox where step_id = $1",
      [step],
    );

  beforeAll(async () => {
    h = await harness({ MUSTER_SECRET_KEY: "k".repeat(40) }, { net });
    owner = (await h.signIn("owner@acme.test")).cookie as string;
    await h.api(owner, "POST", "/api/invitations", { email: "mo@acme.test", role: "member" });
    mo = (await h.signIn("mo@acme.test")).cookie as string;
    id = (
      await json<{ id: string }>(
        await h.api(owner, "POST", "/api/app/projects", { name: "Launch" }),
      )
    ).id;
  });

  it("is connected once by an administrator, tried before it is kept, and never gives its key back", async () => {
    expect((await standing()).available).toBe(false);
    const put = (body: unknown, as = owner) => h.api(as, "PUT", "/api/tracker", body);
    const good = { baseUrl: "https://plane.acme.test", workspace: "acme", key: KEY };
    expect((await put(good, mo)).status).toBe(403);
    expect((await put({ ...good, baseUrl: "http://plane.acme.test" })).status).toBe(400);
    expect((await put({ ...good, baseUrl: "https://10.0.0.8" })).status).toBe(400);
    expect((await put({ ...good, workspace: "a/b" })).status).toBe(400);
    // A key the tracker refuses: said, and nothing kept.
    expect(await json(await put({ ...good, key: "not-the-right-key" }))).toMatchObject({
      ok: false,
      problem: { kind: "key" },
    });
    expect(
      (await json<{ tracker: unknown }>(await h.api(owner, "GET", "/api/tracker"))).tracker,
    ).toBeNull();
    expect(await json(await put(good))).toEqual({ ok: true, projects: 2 });
    const shown = await h.api(owner, "GET", "/api/tracker");
    const text = await shown.clone().text();
    expect(await json(shown)).toMatchObject({
      canSeal: true,
      tracker: {
        kind: "plane",
        baseUrl: "https://plane.acme.test",
        workspace: "acme",
        keyTail: "WXYZ",
      },
    });
    expect(text).not.toContain(KEY);
    // Another address needs the key typed again; the same one keeps it.
    expect((await put({ baseUrl: "https://other.acme.test", workspace: "acme" })).status).toBe(400);
    expect(
      await json(await put({ baseUrl: "https://plane.acme.test", workspace: "acme" })),
    ).toEqual({
      ok: true,
      projects: 2,
    });
    expect(await json(await h.api(owner, "POST", "/api/tracker/test"))).toEqual({
      ok: true,
      projects: 2,
    });
    // Nowhere in the record or in what is kept.
    expect(JSON.stringify(await json(await h.api(owner, "GET", "/api/audit")))).not.toContain(KEY);
    expect(JSON.stringify(await h.db.query("select * from trackers"))).not.toContain(KEY);
  });

  it("is linked by the project's owner, and the steps already there are sent", async () => {
    const first = await add("Draft the announcement", { due: "2026-12-01" });
    const second = await add("Book the room");
    await change(second.id, { state: "done", result: "Room 4 is booked." });
    // Nothing leaves before the project is linked.
    await pass();
    expect(plane.writes()).toBe(0);

    const people = await json<{ id: string; email: string }[]>(
      await h.api(owner, "GET", "/api/members"),
    );
    const moId = people.find((one) => one.email === "mo@acme.test")?.id;
    expect((await h.api(owner, "PUT", at(`/members/${moId}`), { role: "work" })).status).toBe(200);
    // Which projects there may be linked is an administrator's to say. Until one is, no
    // project owner is offered anything, and none can be linked by asking for it.
    expect((await standing()).available).toBe(false);
    expect(await json(await h.api(owner, "GET", at("/tracker/projects")))).toEqual({
      ok: true,
      projects: [],
    });
    expect((await h.api(owner, "PUT", at("/tracker"), { project: "p-1" })).status).toBe(403);
    expect(await json(await h.api(owner, "GET", "/api/tracker/projects"))).toMatchObject({
      ok: true,
      projects: [
        { id: "p-1", allowed: false },
        { id: "p-2", allowed: false },
      ],
    });
    expect((await h.api(mo, "PUT", "/api/tracker/projects", { allowed: ["p-1"] })).status).toBe(
      403,
    );
    expect((await h.api(owner, "PUT", "/api/tracker/projects", { allowed: ["p-9"] })).status).toBe(
      400,
    );
    expect(
      await json(await h.api(owner, "PUT", "/api/tracker/projects", { allowed: ["p-1"] })),
    ).toEqual({ ok: true });
    expect((await standing()).available).toBe(true);
    // Someone working in the project sees where it stands, and does not link it.
    expect((await h.api(mo, "GET", at("/tracker/projects"))).status).toBe(403);
    expect((await h.api(mo, "PUT", at("/tracker"), { project: "p-1" })).status).toBe(403);
    expect(await json(await h.api(owner, "GET", at("/tracker/projects")))).toEqual({
      ok: true,
      projects: [{ id: "p-1", identifier: "ACM", name: "Acme launch" }],
    });
    // Not one the administrator ticked, though the tracker has it.
    expect((await h.api(owner, "PUT", at("/tracker"), { project: "p-2" })).status).toBe(403);
    expect((await h.api(owner, "PUT", at("/tracker"), { project: "p-9" })).status).toBe(403);
    expect(await json(await h.api(owner, "PUT", at("/tracker"), { project: "p-1" }))).toEqual({
      ok: true,
    });
    expect((await h.api(owner, "PUT", at("/tracker"), { project: "p-1" })).status).toBe(409);
    expect(await standing(mo)).toMatchObject({
      link: { identifier: "ACM", name: "Acme launch" },
      waiting: 2,
      failed: null,
      mine: false,
    });

    await pass();
    expect(plane.items).toMatchObject([
      {
        name: "Draft the announcement",
        state: "s-todo",
        target_date: "2026-12-01",
        external_id: first.id,
      },
      { name: "Book the room", state: "s-done", target_date: null },
    ]);
    // What came of a step is a comment on its item.
    expect(plane.comments).toEqual([{ item: "i-2", html: "<p>Room 4 is booked.</p>" }]);
    expect((await steps()).map((step) => step.ticket)).toEqual([
      { key: "ACM-1", url: "https://plane.acme.test/acme/browse/ACM-1/" },
      { key: "ACM-2", url: "https://plane.acme.test/acme/browse/ACM-2/" },
    ]);
    expect(await standing()).toMatchObject({ waiting: 0, failed: null, mine: true });
  });

  it("sends a step that is added or changed, once, and nothing when nothing changed", async () => {
    const from = plane.calls.length;
    const step = await add("Write the page");
    await pass();
    const item = itemOf((await steps()).find((one) => one.id === step.id)?.ticket?.key);
    expect(item).toMatchObject({ name: "Write the page", state: "s-todo" });

    // Taken up, renamed, dated; then waiting, which the tracker has no word for: still under way.
    await change(step.id, { state: "doing", title: "Write the pricing page", due: "2026-12-05" });
    await pass();
    expect(item).toMatchObject({
      name: "Write the pricing page",
      state: "s-doing",
      target_date: "2026-12-05",
    });
    const before = plane.writes();
    await change(step.id, { state: "waiting" });
    await pass();
    await pass();
    expect(item?.state).toBe("s-doing");
    expect(plane.writes()).toBe(before);

    await change(step.id, { state: "done", result: "Published at /pricing." });
    await pass();
    expect(item?.state).toBe("s-done");
    expect(plane.comments.at(-1)).toEqual({
      item: item?.id,
      html: "<p>Published at /pricing.</p>",
    });
    // The same result is not said twice.
    const comments = plane.comments.length;
    await change(step.id, { due: null });
    await pass();
    expect(item?.target_date).toBeNull();
    expect(plane.comments.length).toBe(comments);
    expect(plane.calls.slice(from).every((call) => call.key === KEY)).toBe(true);
  });

  it("brings back what was changed in the tracker", async () => {
    const step = await add("Brief the sales team");
    await pass();
    const key = (await steps()).find((one) => one.id === step.id)?.ticket?.key;
    const item = itemOf(key);
    plane.edit(item?.id ?? "", {
      name: "Brief  the sales team in Dubai",
      state: "s-review",
      target_date: "2026-12-09",
    });
    await pass();
    expect((await steps()).find((one) => one.id === step.id)).toMatchObject({
      title: "Brief the sales team in Dubai",
      state: "doing",
      due: "2026-12-09",
    });
    // Brought in, not sent back out: nothing was written for it.
    const writes = plane.writes();
    await pass();
    expect(plane.writes()).toBe(writes);
    expect((await standing()).waiting).toBe(0);

    // Moved within what a step calls the same thing: the step is left as it is.
    await change(step.id, { state: "waiting" });
    await pass();
    plane.edit(item?.id ?? "", { state: "s-doing" });
    await pass();
    expect((await steps()).find((one) => one.id === step.id)?.state).toBe("waiting");

    // Called off there: done here, and saying why it has nothing to show.
    plane.edit(item?.id ?? "", { state: "s-off" });
    await pass();
    expect((await steps()).find((one) => one.id === step.id)).toMatchObject({
      state: "done",
      result: `Cancelled in ${key}.`,
    });
    // The tracker said so: it is not told back to it as a comment.
    const comments = plane.comments.length;
    await pass();
    await pass();
    expect(plane.comments.length).toBe(comments);
    // Back to the backlog there: to do again here.
    plane.edit(item?.id ?? "", { state: "s-backlog" });
    await pass();
    expect((await steps()).find((one) => one.id === step.id)?.state).toBe("todo");
  });

  it("lets the tracker's word stand where both changed the same thing, and keeps the rest", async () => {
    const step = await add("Check the legal copy");
    await pass();
    const item = itemOf((await steps()).find((one) => one.id === step.id)?.ticket?.key);
    // Both rename it between two passes; only this side dates it.
    await change(step.id, { title: "Check the legal copy (ours)", due: "2026-12-12" });
    plane.edit(item?.id ?? "", { name: "Check the legal copy (theirs)" });
    await pass();
    expect((await steps()).find((one) => one.id === step.id)).toMatchObject({
      title: "Check the legal copy (theirs)",
      due: "2026-12-12",
    });
    expect(item).toMatchObject({
      name: "Check the legal copy (theirs)",
      target_date: "2026-12-12",
    });
    // A tracker that does not sort as it was asked is read to the end, and nothing is missed.
    plane.unsorted = true;
    plane.edit(item?.id ?? "", { name: "Check the legal copy (again)" });
    await pass();
    plane.unsorted = false;
    expect((await steps()).find((one) => one.id === step.id)?.title).toBe(
      "Check the legal copy (again)",
    );
  });

  it("unties a step whose item was deleted, and never deletes across", async () => {
    const one = await add("Deleted there, changed here");
    const two = await add("Deleted there, found by reading");
    const three = await add("Deleted here");
    await pass();
    const keys = new Map((await steps()).map((step) => [step.id, step.ticket?.key]));
    const count = plane.items.length;

    // Deleted in the tracker; then changed here: the step stays, untied, and is not made again.
    plane.remove(itemOf(keys.get(one.id))?.id ?? "");
    await change(one.id, { title: "Deleted there, changed here (still mine)" });
    await pass();
    expect((await steps()).find((step) => step.id === one.id)).toMatchObject({
      title: "Deleted there, changed here (still mine)",
      ticket: null,
    });
    await pass();
    expect(plane.items.length).toBe(count - 1);
    // Changed again, and again: still not made a second time, and nothing is left waiting.
    await change(one.id, { title: "Deleted there, changed here (twice)" });
    await pass();
    await change(one.id, { state: "done", result: "Done without a ticket." });
    await pass();
    expect(plane.items.length).toBe(count - 1);
    expect(await waits(one.id)).toEqual([]);
    expect(
      await h.db.query("select 1 from step_tickets where step_id = $1 and gone_at is not null", [
        one.id,
      ]),
    ).toHaveLength(1);

    // Deleted in the tracker and not touched here: found when everything is read, once a day.
    plane.remove(itemOf(keys.get(two.id))?.id ?? "");
    await pass();
    expect((await steps()).find((step) => step.id === two.id)?.ticket).not.toBeNull();
    await pass(25 * 60);
    expect((await steps()).find((step) => step.id === two.id)).toMatchObject({
      title: "Deleted there, found by reading",
      ticket: null,
    });

    // Deleted here: the item stays there.
    const item = itemOf(keys.get(three.id));
    expect((await h.api(owner, "DELETE", at(`/steps/${three.id}`))).status).toBe(200);
    await pass();
    expect(plane.items).toContain(item);
    expect((await standing()).waiting).toBe(0);
  });

  it("tries again after a failure, says so, and makes an item only once", async () => {
    // The tracker makes the item and its answer is lost: asked again, it is the same item.
    // Found by asking for it before making one; what the tracker says to a second making
    // is not relied on (here it says only that there is one, not which).
    const count = plane.items.length;
    plane.loseAnswer = true;
    plane.bare409 = true;
    const step = await add("Made once");
    await pass();
    expect(plane.items.length).toBe(count + 1);
    expect(await standing()).toMatchObject({ waiting: 1 });
    await pass();
    expect(plane.items.length).toBe(count + 1);
    expect((await steps()).find((one) => one.id === step.id)?.ticket?.key).toBe(
      `ACM-${plane.items.at(-1)?.sequence_id}`,
    );

    // Down for a while: each try is later than the last, the page says so, the record once.
    plane.failing = 1000;
    await change(step.id, { title: "Made once, renamed while it was down" });
    await pass(1);
    // Not asked again before its time.
    await pass(0.5);
    expect((await waits(step.id))[0]?.tries).toBe(1);
    await pass(10);
    await pass(40);
    expect(await standing()).toMatchObject({ waiting: 1, failed: "The tracker answered 500." });
    const record = JSON.stringify(await json(await h.api(owner, "GET", "/api/audit")));
    expect(record.match(/tracker\.failing/g)?.length).toBeGreaterThanOrEqual(1);
    // Back: what was owed is sent.
    plane.failing = 0;
    await pass(200);
    expect(plane.items.at(-1)?.name).toBe("Made once, renamed while it was down");
    expect(await standing()).toMatchObject({ waiting: 0, failed: null });
  });

  it("never makes a step wait for the tracker", async () => {
    const step = await add("Written while the tracker hangs");
    let release = () => {};
    plane.hang = new Promise<void>((resolve) => {
      release = resolve;
    });
    // A pass is under way and the tracker does not answer.
    const passing = pass();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const stuck = new Promise<string>((resolve) => setTimeout(() => resolve("stuck"), 3000));
    expect(
      await Promise.race([
        change(step.id, { title: "Changed while the tracker hangs" }).then((r) => r.status),
        stuck,
      ]),
    ).toBe(200);
    expect(
      await Promise.race([add("Added while the tracker hangs").then((made) => made.title), stuck]),
    ).toBe("Added while the tracker hangs");
    expect((await steps()).some((one) => one.title === "Changed while the tracker hangs")).toBe(
      true,
    );
    plane.hang = null;
    release();
    await passing;
    // What was written meanwhile is sent once it answers again.
    await pass(6);
    await pass(6);
    expect(plane.items.map((item) => item.name)).toEqual(
      expect.arrayContaining(["Changed while the tracker hangs", "Added while the tracker hangs"]),
    );
    expect((await standing()).waiting).toBe(0);
  });

  it("waits longer after anything that goes wrong, and sets aside what keeps failing", async () => {
    // Not a refusal the tracker's client knows of: an answer that is no answer.
    const poisoned = await add("Cannot be sent");
    plane.broken = true;
    await pass();
    expect(await waits(poisoned.id)).toMatchObject([
      { tries: 1, parked_at: null, last_error: "Something went wrong keeping this in step." },
    ]);
    // Not tried again before its time; then later and later; and after enough, set aside.
    await pass(0.5);
    expect((await waits(poisoned.id))[0]?.tries).toBe(1);
    for (let attempt = 0; attempt < 9; attempt++) await pass(200);
    expect(await waits(poisoned.id)).toMatchObject([{ tries: 8 }]);
    expect((await waits(poisoned.id))[0]?.parked_at).not.toBeNull();
    expect(await standing()).toMatchObject({ waiting: 0, parked: 1 });
    expect((await standing()).failed).not.toBeNull();
    // It stands in nobody's way: another step goes out as soon as the tracker answers.
    plane.broken = false;
    const other = await add("Sent while one is set aside");
    await pass(200);
    expect(plane.items.at(-1)?.name).toBe("Sent while one is set aside");
    expect((await steps()).find((one) => one.id === other.id)?.ticket).not.toBeNull();
    expect(await standing()).toMatchObject({ waiting: 0, parked: 1 });
    // Changed, it is tried again.
    await change(poisoned.id, { title: "Can be sent now" });
    await pass();
    expect(plane.items.at(-1)?.name).toBe("Can be sent now");
    expect(await standing()).toMatchObject({ waiting: 0, parked: 0, failed: null });
  });

  it("goes on with a reading that was cut short, and counts nothing as seen until it has been", async () => {
    // More changed at once than one reading takes (the stand-in gives two a page; ten pages a pass).
    const made: StepRow[] = [];
    for (let n = 1; n <= 22; n++) made.push(await add(`Many ${n}`));
    await pass();
    await pass();
    const keys = new Map((await steps()).map((step) => [step.id, step.ticket?.key]));
    expect(made.every((step) => keys.get(step.id))).toBe(true);
    await pass();
    const mark = async () =>
      (
        await h.db.query<{ seen_through: Date | null; resume_cursor: string | null }>(
          "select seen_through, resume_cursor from project_trackers where project_id = $1",
          [id],
        )
      )[0];
    const before = await mark();
    for (const step of made)
      plane.edit(itemOf(keys.get(step.id))?.id ?? "", { name: `${step.title} (changed there)` });
    const changedHere = async () =>
      (await steps()).filter((step) => step.title.endsWith("(changed there)")).length;
    await pass();
    // Twenty read; the mark has not moved, and where it stopped is kept.
    expect(await changedHere()).toBe(20);
    expect((await mark())?.seen_through).toEqual(before?.seen_through);
    expect((await mark())?.resume_cursor).not.toBeNull();
    // The next pass, at once, goes on from there: none is lost.
    await pass(0.1);
    expect(await changedHere()).toBe(22);
    expect((await mark())?.resume_cursor).toBeNull();
    expect((await mark())?.seen_through?.getTime()).toBeGreaterThan(
      before?.seen_through?.getTime() ?? 0,
    );
    // Nothing of it is sent back.
    const writes = plane.writes();
    await pass();
    expect(plane.writes()).toBe(writes);
  });

  it("shows a ticket's key as the tracker's project is called now", async () => {
    plane.identifier = "NEW";
    await pass();
    const now = (await steps()).filter((step) => step.ticket);
    expect(now.length).toBeGreaterThan(20);
    expect(now.every((step) => step.ticket?.key.startsWith("NEW-"))).toBe(true);
    expect(now[0]?.ticket?.url).toMatch(/\/browse\/NEW-\d+\/$/);
    expect((await standing()).link?.identifier).toBe("NEW");
  });

  it("is unlinked leaving both sides as they are", async () => {
    const before = { items: plane.items.length, steps: (await steps()).length };
    expect((await h.api(mo, "DELETE", at("/tracker"))).status).toBe(403);
    expect((await h.api(owner, "DELETE", at("/tracker"))).status).toBe(200);
    expect(await standing()).toMatchObject({ available: true, link: null, waiting: 0 });
    const now = await steps();
    expect(now.length).toBe(before.steps);
    expect(now.every((step) => step.ticket === null)).toBe(true);
    const writes = plane.writes();
    await add("After it was unlinked");
    await pass();
    expect(plane.writes()).toBe(writes);
    expect(plane.items.length).toBe(before.items);
    const record = JSON.stringify(await json(await h.api(owner, "GET", "/api/audit")));
    for (const action of ["tracker.set", "project.tracker_linked", "project.tracker_unlinked"])
      expect(record).toContain(action);
    // Taking the connection away is an administrator's, and leaves projects as they are.
    expect((await h.api(mo, "DELETE", "/api/tracker")).status).toBe(403);
    expect((await h.api(owner, "DELETE", "/api/tracker")).status).toBe(200);
    expect((await standing()).available).toBe(false);
  });
});
