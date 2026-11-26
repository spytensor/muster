import { beforeAll, describe, expect, it } from "vitest";
import { makeFile } from "./files/make.js";
import { type Harness, harness } from "./test-support.js";

const json = async <T = unknown>(response: Response): Promise<T> => (await response.json()) as T;

interface Page {
  rows: {
    type: string;
    id: string;
    name: string;
    kind: string;
    source: string;
    found: string | null;
    conversationId: string | null;
    projectName: string | null;
    mine: boolean;
  }[];
  total: number;
  counts: Record<string, number>;
  usedBytes: number;
  next: number | null;
}

describe("a library of many files", () => {
  let h: Harness;
  let owner: string;
  let mo: string;
  beforeAll(async () => {
    h = await harness();
    owner = (await h.signIn("owner@acme.test")).cookie as string;
    await h.api(owner, "POST", "/api/invitations", { email: "mo@acme.test", role: "member" });
    mo = (await h.signIn("mo@acme.test")).cookie as string;
  });
  const page = async (as: string, query = "") =>
    json<Page>(await h.api(as, "GET", `/api/app/library${query}`));

  it("hands over a page at a time, counted and in the order asked for", async () => {
    for (let n = 0; n < 130; n++)
      await h.upload(
        owner,
        `report ${String(n).padStart(3, "0")}.txt`,
        new TextEncoder().encode("x".repeat(n + 1)),
      );
    await h.api(owner, "POST", "/api/app/documents", {
      title: "A note",
      content: "words of a note",
    });
    const first = await page(owner);
    expect(first.total).toBe(131);
    expect(first.rows).toHaveLength(60);
    expect(first.next).toBe(60);
    expect(first.counts).toEqual({ all: 131, made: 0, uploaded: 130, notes: 1 });
    expect(first.usedBytes).toBe((130 * 131) / 2);
    // Every one can be reached, none twice: the old list stopped at five hundred, silently.
    const seen = new Set<string>();
    for (let at: number | null = 0; at !== null; ) {
      const got = await page(owner, `?offset=${at}&limit=100`);
      for (const row of got.rows) seen.add(row.id);
      at = got.next;
    }
    expect(seen.size).toBe(131);
    const byName = await page(owner, "?sort=name&limit=3");
    expect(byName.rows.map((row) => row.name)).toEqual([
      "A note",
      "report 000.txt",
      "report 001.txt",
    ]);
    const bySize = await page(owner, "?sort=size&limit=1&show=uploaded");
    expect(bySize.rows[0]?.name).toBe("report 129.txt");
    expect((await page(owner, "?show=notes")).rows.map((row) => row.type)).toEqual(["note"]);
    // Another person sees none of it.
    expect((await page(mo)).total).toBe(0);
    // A limit beyond the most is the most; nonsense is the default.
    expect((await page(owner, "?limit=5000")).rows).toHaveLength(100);
    expect((await page(owner, "?limit=x&offset=-4&sort=;drop")).rows).toHaveLength(60);
    expect((await page(owner, "?offset=Infinity")).rows).toHaveLength(60);
    expect((await page(owner, "?offset=1e21&limit=-3")).rows).toHaveLength(0);
  });

  it("finds a file by a word in its name or in what it says, once it has been read", async () => {
    const doc = await makeFile("Quarterly.docx", "document", {
      text: "# Results\n\nThe pelican budget was approved in Rotterdam.",
    });
    await h.upload(owner, "Quarterly.docx", doc);
    await h.upload(owner, "100% sure_thing.txt", new TextEncoder().encode("nothing here"));
    expect((await page(owner, "?q=quarterly")).rows.map((row) => row.name)).toEqual([
      "Quarterly.docx",
    ]);
    // Not yet read: a word in it is not found, and nothing fails.
    expect((await page(owner, "?q=pelican")).total).toBe(0);
    while ((await h.files.indexPending(50)) > 0);
    const found = await page(owner, "?q=PELICAN");
    expect(found.rows.map((row) => row.name)).toEqual(["Quarterly.docx"]);
    expect(found.rows[0]?.found).toContain("pelican budget was approved");
    // Found by its name, the words around are not given.
    expect((await page(owner, "?q=quarterly")).rows[0]?.found).toBeNull();
    // A note is found by its words too.
    expect((await page(owner, "?q=words+of")).rows.map((row) => row.name)).toEqual(["A note"]);
    // % and _ mean themselves.
    expect(
      (await page(owner, `?q=${encodeURIComponent("100%")}`)).rows.map((row) => row.name),
    ).toEqual(["100% sure_thing.txt"]);
    expect((await page(owner, `?q=${encodeURIComponent("sure_")}`)).total).toBe(1);
    expect((await page(owner, `?q=${encodeURIComponent("_")}`)).total).toBe(1);
    // The counts are of what was found.
    expect((await page(owner, "?q=pelican")).counts).toMatchObject({
      all: 1,
      uploaded: 1,
      notes: 0,
    });
    expect((await page(owner, "?q=report&kind=document")).total).toBe(0);
  }, 120_000);

  it("deletes several at once, each only if it is the person's own", async () => {
    const mine = await page(owner, "?q=report&limit=3");
    const ids = mine.rows.map((row) => row.id);
    const note = (await page(owner, "?show=notes")).rows[0]?.id as string;
    // Another person deletes none of them.
    expect(
      await json(await h.api(mo, "POST", "/api/app/library/delete", { files: ids, notes: [note] })),
    ).toEqual({ deleted: 0 });
    expect((await page(owner)).total).toBe(133);
    expect(
      await json(
        await h.api(owner, "POST", "/api/app/library/delete", {
          files: [...ids, "not-an-id"],
          notes: [note],
        }),
      ),
    ).toEqual({ deleted: 4 });
    expect((await page(owner)).total).toBe(129);
    // Twice is nothing the second time; none, or too many, is refused.
    expect(
      await json(await h.api(owner, "POST", "/api/app/library/delete", { files: ids })),
    ).toEqual({ deleted: 0 });
    expect((await h.api(owner, "POST", "/api/app/library/delete", {})).status).toBe(400);
    expect(
      (
        await h.api(owner, "POST", "/api/app/library/delete", {
          files: Array.from({ length: 201 }, () => ids[0]),
        })
      ).status,
    ).toBe(400);
  });
});
