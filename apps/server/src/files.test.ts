import { beforeAll, describe, expect, it } from "vitest";
import { cleanName, identify } from "./files/kind.js";
import { type Harness, harness } from "./test-support.js";

const json = async <T = Record<string, unknown>>(response: Response) =>
  (await response.json()) as T;
const PDF = new TextEncoder().encode("%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n");
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0, 0, 0]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

let h: Harness;
let owner: string;
let mo: string;

beforeAll(async () => {
  h = await harness({ MUSTER_MAX_FILE_MB: "1" });
  owner = (await h.signIn("owner@acme.test")).cookie as string;
  await h.api(owner, "POST", "/api/invitations", { email: "mo@acme.test", role: "member" });
  mo = (await h.signIn("mo@acme.test")).cookie as string;
});

describe("what a file is", () => {
  it("is decided by its name and its first bytes together", () => {
    expect(identify("report.docx", ZIP)).toMatchObject({ kind: "document" });
    expect(identify("Budget.XLSX", ZIP)).toMatchObject({ kind: "spreadsheet" });
    expect(identify("deck.pptx", ZIP)).toMatchObject({ kind: "slides" });
    expect(identify("scan.pdf", PDF)).toMatchObject({ kind: "pdf", mime: "application/pdf" });
    expect(identify("photo.png", PNG)).toMatchObject({ kind: "image" });
    expect(identify("page.html", new TextEncoder().encode("<h1>你好</h1>"))).toMatchObject({
      kind: "page",
    });
    // A name that promises one thing and bytes that are another.
    expect(identify("report.docx", PDF)).toBeNull();
    expect(identify("scan.pdf", ZIP)).toBeNull();
    expect(identify("notes.txt", new Uint8Array([0x68, 0x00, 0x69]))).toBeNull();
    expect(identify("tool.exe", ZIP)).toBeNull();
    expect(identify("noending", PDF)).toBeNull();
    expect(identify("empty.pdf", new Uint8Array())).toBeNull();
  });

  it("keeps names free of paths and control characters", () => {
    expect(cleanName("  季度报告.docx ")).toBe("季度报告.docx");
    expect(cleanName("../../etc/passwd")).toBe(".._.._etc_passwd");
    expect(cleanName("a\u0000b\nc.pdf")).toBe("abc.pdf");
    expect(cleanName("")).toBeNull();
    expect(cleanName("..")).toBeNull();
    expect(cleanName("x".repeat(201))).toBeNull();
  });
});

describe("a person's files", () => {
  it("are uploaded, listed, downloaded byte for byte, and deleted", async () => {
    const sent = await h.upload(owner, "季度 报告.pdf", PDF);
    expect(sent.status).toBe(200);
    const file = await json<{
      id: string;
      name: string;
      kind: string;
      size: number;
      source: string;
    }>(sent);
    expect(file).toMatchObject({
      name: "季度 报告.pdf",
      kind: "pdf",
      size: PDF.byteLength,
      source: "upload",
    });
    expect(await json(await h.api(owner, "GET", "/api/app/files"))).toMatchObject([
      { id: file.id },
    ]);

    const got = await h.api(owner, "GET", `/api/app/files/${file.id}/content`);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(PDF);
    expect(got.headers.get("content-type")).toBe("application/pdf");
    expect(got.headers.get("content-disposition")).toBe(
      `inline; filename*=UTF-8''${encodeURIComponent("季度 报告.pdf")}`,
    );
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect(got.headers.get("content-security-policy")).toContain("sandbox");

    expect(
      (await json<{ action: string }[]>(await h.api(owner, "GET", "/api/audit?limit=2"))).map(
        (e) => e.action,
      ),
    ).toContain("file.uploaded");
    expect((await h.api(owner, "DELETE", `/api/app/files/${file.id}`)).status).toBe(200);
    expect((await h.api(owner, "GET", `/api/app/files/${file.id}/content`)).status).toBe(404);
    expect(await json(await h.api(owner, "GET", "/api/app/files"))).toEqual([]);
  });

  it("never opens a page or a document in place: those are always downloads", async () => {
    const page = await json<{ id: string }>(
      await h.upload(owner, "x.html", "<script>alert(1)</script>"),
    );
    const got = await h.api(owner, "GET", `/api/app/files/${page.id}/content`);
    expect(got.headers.get("content-disposition")).toMatch(/^attachment;/);
    const pdf = await json<{ id: string }>(await h.upload(owner, "y.pdf", PDF));
    expect(
      (await h.api(owner, "GET", `/api/app/files/${pdf.id}/content?download`)).headers.get(
        "content-disposition",
      ),
    ).toMatch(/^attachment;/);
  });

  it("refuses what it does not accept, with a reason", async () => {
    expect((await h.upload(owner, "tool.exe", ZIP)).status).toBe(415);
    expect((await h.upload(owner, "fake.docx", PDF)).status).toBe(415);
    expect((await h.upload(owner, "", PDF)).status).toBe(400);
    expect((await h.upload(owner, "big.txt", "x".repeat(1024 * 1024 + 1))).status).toBe(413);
    expect((await h.upload(null, "a.pdf", PDF)).status).toBe(401);
  });

  it("belong to one person: nobody else can list, read or delete them", async () => {
    const file = await json<{ id: string }>(await h.upload(owner, "private.pdf", PDF));
    expect(
      (await json<{ id: string }[]>(await h.api(mo, "GET", "/api/app/files"))).some(
        (f) => f.id === file.id,
      ),
    ).toBe(false);
    expect((await h.api(mo, "GET", `/api/app/files/${file.id}/content`)).status).toBe(404);
    expect((await h.api(mo, "DELETE", `/api/app/files/${file.id}`)).status).toBe(404);
    expect((await h.api(owner, "GET", `/api/app/files/${file.id}/content`)).status).toBe(200);
  });

  it("shows a workbook as grids: what cells show, merged areas and frozen rows", async () => {
    const { makeFile } = await import("./files/make.js");
    const bytes = await makeFile("b.xlsx", "spreadsheet", {
      sheets: [
        {
          name: "Costs",
          rows: [
            ["Item", "Cost"],
            ["Hosting", 1200.5],
            ["Total", 1200.5],
          ],
        },
        { name: "Notes", rows: [["Only one cell"]] },
        {
          name: "Long",
          rows: [["Item", "Cost"], ...Array.from({ length: 20 }, (_, i) => [`Item ${i}`, i])],
        },
      ],
    });
    const file = await json<{ id: string }>(await h.upload(owner, "b.xlsx", bytes));
    const grids = await json<
      { name: string; rows: string[][]; frozenRows: number; totalRows: number }[]
    >(await h.api(owner, "GET", `/api/app/files/${file.id}/sheets`));
    expect(grids.map((grid) => grid.name)).toEqual(["Costs", "Notes", "Long"]);
    // The grid shows what a spreadsheet would: numbers with their separators and decimals.
    expect(grids[0]).toMatchObject({
      rows: [
        ["Item", "Cost"],
        ["Hosting", "1,200.50"],
        ["Total", "1,200.50"],
      ],
      // A table short enough to see whole is not frozen; one that scrolls keeps its header.
      frozenRows: 0,
      totalRows: 3,
    });
    expect(grids[2]).toMatchObject({ frozenRows: 1, totalRows: 21 });
    expect((await h.api(mo, "GET", `/api/app/files/${file.id}/sheets`)).status).toBe(404);
    const pdf = await json<{ id: string }>(await h.upload(owner, "not-a-sheet.pdf", PDF));
    expect((await h.api(owner, "GET", `/api/app/files/${pdf.id}/sheets`)).status).toBe(404);
  });

  it("reads each file once and keeps what it found, including that a file cannot be read", async () => {
    const good = await json<{ id: string }>(
      await h.upload(owner, "notes.md", "# Notes\n\nKeep this."),
    );
    const first = await json<{ text: string }>(
      await h.api(owner, "GET", `/api/app/files/${good.id}/text`),
    );
    expect(first.text).toBe("# Notes\n\nKeep this.");
    expect(await json(await h.api(owner, "GET", `/api/app/files/${good.id}/text`))).toEqual(first);
    // A file that is not what its ending says, past the first bytes.
    const broken = await json<{ id: string }>(await h.upload(owner, "broken.docx", ZIP));
    const problem = await json<{ problem: string }>(
      await h.api(owner, "GET", `/api/app/files/${broken.id}/text`),
    );
    expect(problem.problem).toMatch(/damaged|could not be read/);
    expect(await json(await h.api(owner, "GET", `/api/app/files/${broken.id}/text`))).toEqual(
      problem,
    );
  });

  it("takes text as people really save it, and says when a file is protected", async () => {
    const utf16 = new Uint8Array([
      0xff,
      0xfe,
      ...new Uint8Array(
        new Uint16Array([..."名称,数量\n苹果,3"].map((c) => c.charCodeAt(0))).buffer,
      ),
    ]);
    const sheet = await json<{ id: string }>(await h.upload(owner, "export.csv", utf16));
    expect(
      (await json<{ text: string }>(await h.api(owner, "GET", `/api/app/files/${sheet.id}/text`)))
        .text,
    ).toContain("苹果,3");
    // GBK, as Excel on Chinese Windows writes CSV: 名称 = C3 FB B3 C6
    const gbk = new Uint8Array([0xc3, 0xfb, 0xb3, 0xc6, 0x2c, 0x31, 0x0a]);
    const legacy = await json<{ id: string }>(await h.upload(owner, "gbk.csv", gbk));
    expect(
      (await json<{ text: string }>(await h.api(owner, "GET", `/api/app/files/${legacy.id}/text`)))
        .text,
    ).toBe("名称,1");
    // A Word file under a password or a sensitivity label has the older format's first bytes.
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    const refused = await h.upload(owner, "secret.docx", ole);
    expect(refused.status).toBe(415);
    expect((await json<{ error: { code: string } }>(refused)).error.code).toBe("protected_file");
    expect((await h.upload(owner, "macro.xlsm", ZIP)).status).toBe(200);
  });

  it("deletes a file once, and what was worked out from it goes too", async () => {
    const file = await json<{ id: string }>(await h.upload(owner, "once.md", "only here"));
    await h.api(owner, "GET", `/api/app/files/${file.id}/text`);
    expect((await h.api(owner, "DELETE", `/api/app/files/${file.id}`)).status).toBe(200);
    expect((await h.api(owner, "DELETE", `/api/app/files/${file.id}`)).status).toBe(404);
    const deleted = (
      await json<{ action: string }[]>(await h.api(owner, "GET", "/api/audit?limit=50"))
    ).filter((e) => e.action === "file.deleted");
    // One delete, one record: the earlier test's and this one's.
    expect(deleted.length).toBe(2);
  });

  it("says what it accepts", async () => {
    const limits = await json<{ maxBytes: number; endings: string[] }>(
      await h.api(mo, "GET", "/api/app/files/limits"),
    );
    expect(limits.maxBytes).toBe(1024 * 1024);
    expect(limits.endings).toEqual(
      expect.arrayContaining(["docx", "xlsx", "pptx", "pdf", "html", "png"]),
    );
  });
});

describe("a workbook written by another program", () => {
  it("is read cell by cell when the library cannot load it", async () => {
    // As openpyxl writes one with a cell comment: the comment is kept at a path the
    // library does not expect, and it gives up on the whole workbook (seen 2026-11-15 on
    // a customer-like file). The cells are plain to read all the same.
    const { strToU8, zipSync } = await import("fflate");
    const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>Step</t></is></c><c r="B1" t="inlineStr"><is><t>Owner &amp; team</t></is></c><c r="D1" t="s"><v>0</v></c></row>
<row r="2" ht="30" customHeight="1"/>
<row r="3"><c r="A3" t="inlineStr"><is><t>Check the invoice</t></is></c><c r="B3" t="inlineStr"><is><t>Finance</t></is></c><c r="C3"><v>42.5</v></c><c r="D3" t="s"/><c r="E3" t="b"><v>1</v></c><c r="F3" t="inlineStr"><is><r><t>Kana</t></r><rPh sb="0" eb="1"><t>READING</t></rPh></is></c><c r="G3" t="inlineStr"><is><t>&#20013;&#x41;</t></is></c></row>
</sheetData><legacyDrawing r:id="rId2" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></worksheet>`;
    const bytes = zipSync({
      "[Content_Types].xml": strToU8(
        `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/comments/comment1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/></Types>`,
      ),
      "_rels/.rels": strToU8(
        `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      ),
      "xl/workbook.xml": strToU8(
        `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Current process" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
      "xl/_rels/workbook.xml.rels": strToU8(
        `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet1.xml"/></Relationships>`,
      ),
      "xl/sharedStrings.xml": strToU8(
        `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Minutes</t></si></sst>`,
      ),
      "xl/worksheets/sheet1.xml": strToU8(sheet),
      "xl/worksheets/_rels/sheet1.xml.rels": strToU8(
        `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="comments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="/xl/comments/comment1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing" Target="/xl/drawings/commentsDrawing1.vml"/></Relationships>`,
      ),
      "xl/comments/comment1.xml": strToU8(
        `<?xml version="1.0"?><comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>Ops</author></authors><commentList><comment ref="A2" authorId="0"><text><t>Takes two days</t></text></comment></commentList></comments>`,
      ),
      "xl/drawings/commentsDrawing1.vml": strToU8("<xml></xml>"),
    });
    const h = await harness();
    const owner = (await h.signIn("owner@acme.test")).cookie as string;
    const file = (await (await h.upload(owner, "Current_Payment_Process.xlsx", bytes)).json()) as {
      id: string;
    };
    const read = (await (await h.api(owner, "GET", `/api/app/files/${file.id}/text`)).json()) as {
      text: string;
    };
    // Said first: what the agent is reading is not as a person would see it in Excel.
    expect(read.text).toMatch(/^\[This workbook was read without its formatting/);
    expect(read.text).toContain('--- Sheet "Current process" (2 rows) ---');
    expect(read.text).toContain("1: Step,Owner & team,,Minutes");
    // A row that only has a height takes nothing from the row after it; an empty shared
    // string is empty; a reading aid is not the cell's text; character references are read.
    expect(read.text).toContain("3: Check the invoice,Finance,42.5,,TRUE,Kana,中A");
    expect(read.text).not.toContain("more rows not shown");
  });

  it("is refused, quickly, when its markup is not what it should be", async () => {
    const { strToU8, zipSync } = await import("fflate");
    const book = (sheetXml: string) =>
      zipSync({
        "[Content_Types].xml": strToU8("<Types/>"),
        "xl/workbook.xml": strToU8(
          '<workbook xmlns:r="x"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
        ),
        "xl/_rels/workbook.xml.rels": strToU8(
          '<Relationships><Relationship Id="rId1" Type="t/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        ),
        "xl/worksheets/sheet1.xml": strToU8(sheetXml),
      });
    const h = await harness();
    const owner = (await h.signIn("owner@acme.test")).cookie as string;
    // Tags that open and never close: read in one walk, not by the square of their number.
    for (const [name, xml] of [
      ["rows.xlsx", `<worksheet><sheetData>${"<row ".repeat(150_000)}`],
      [
        "cells.xlsx",
        `<worksheet><sheetData><row r="1">${"<c ".repeat(150_000)}</row></sheetData></worksheet>`,
      ],
      [
        "texts.xlsx",
        `<worksheet><sheetData><row r="1"><c t="inlineStr"><is>${"<t>".repeat(150_000)}</is></c></row></sheetData></worksheet>`,
      ],
      // Cut off in the middle of a row: not read as far as it goes.
      [
        "cut.xlsx",
        '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2"><v>2',
      ],
    ] as const) {
      const file = (await (await h.upload(owner, name, book(xml))).json()) as { id: string };
      const started = performance.now();
      const read = (await (await h.api(owner, "GET", `/api/app/files/${file.id}/text`)).json()) as {
        text: string;
        problem?: string;
      };
      // What this guards against is reading that takes the square of the tags' number,
      // which for these is minutes. Three seconds was the bound until 2026-11-22, and was
      // missed twice by a little (3.3 s) while other tests held the machine.
      expect(performance.now() - started, name).toBeLessThan(10_000);
      expect(read.text, name).toBe("");
      expect(read.problem, name).toBeTruthy();
    }
  });
});
