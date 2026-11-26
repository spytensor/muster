import assert from "node:assert/strict";
import { test } from "node:test";
import { areaPath, bars, layout, linePath, niceScale, plain } from "../src/lib/chart.ts";
import {
  cacheName,
  endingOf,
  fileSize,
  madeFiles,
  opensAs,
  refusedBefore,
  uploadUrl,
} from "../src/lib/files.ts";
import { compact, deviceName, minutesLeft, money, readableReply } from "../src/lib/format.ts";
import type { FileItem, Step } from "../src/lib/types.ts";

const file = (id: string, name: string, kind: FileItem["kind"] = "document"): FileItem => ({
  id,
  name,
  kind,
  size: 10,
  mime: "",
  source: "agent",
  conversationId: null,
  createdAt: "2026-01-01T00:00:00Z",
});
const step = (tool: string, detail: string, status: Step["status"] = "ok"): Step => ({
  id: `${tool}-${detail}-${status}`,
  tool,
  status,
  detail,
  ms: 1,
});

test("file sizes read like the web app's", () => {
  assert.equal(fileSize(512), "512 B");
  assert.equal(fileSize(34_000), "33 KB");
  assert.equal(fileSize(2_200_000), "2.1 MB");
});

test("a file is refused before upload for its kind or its size, as the server would", () => {
  const limits = { maxBytes: 100, endings: ["docx", "png"] };
  assert.equal(endingOf("Report.DOCX"), "docx");
  assert.equal(endingOf("no ending"), "");
  assert.equal(refusedBefore({ name: "a.docx", size: 50 }, limits), null);
  assert.equal(refusedBefore({ name: "a.exe", size: 50 }, limits), "kind");
  assert.equal(refusedBefore({ name: "a", size: 50 }, limits), "kind");
  assert.equal(refusedBefore({ name: "a.png", size: 101 }, limits), "size");
  assert.equal(refusedBefore({ name: "a.png", size: null }, limits), null);
  assert.equal(refusedBefore({ name: "a.exe", size: 1 }, null), null);
});

test("a cached file's name cannot leave the cache folder and keeps its ending", () => {
  assert.equal(cacheName("01a1-b2", "Q3 report.docx"), "01a1-b2-Q3 report.docx");
  assert.equal(cacheName("id", "../../etc/passwd"), "id-__.._etc_passwd");
  assert.equal(cacheName("../x", "a/b\\c:d.PDF"), "x-a_b_c_d.pdf");
  assert.equal(cacheName("id", "..hidden.txt"), "id-_hidden.txt");
  assert.equal(cacheName("id", "季度报告.xlsx"), "id-季度报告.xlsx");
  assert.equal(cacheName("id", "line\nbreak\u0000.txt"), "id-line_break_.txt");
  assert.ok(cacheName("id", `${"n".repeat(300)}.pptx`).length < 100);
  assert.ok(!cacheName("", "").includes("/"));
});

test("a web page is shown as text and never handed to something that would run it", () => {
  assert.equal(opensAs({ kind: "page", name: "page.html" }), "text");
  assert.equal(opensAs({ kind: "text", name: "sneaky.HTM" }), "text");
  assert.equal(opensAs({ kind: "document", name: "a.docx" }), "native");
  assert.equal(opensAs({ kind: "image", name: "a.png" }), "native");
});

test("the upload address carries the name, encoded", () => {
  assert.equal(
    uploadUrl("http://localhost:7420", "季度 report&x=1.docx"),
    "http://localhost:7420/api/app/files?name=%E5%AD%A3%E5%BA%A6%20report%26x%3D1.docx",
  );
});

test("files an agent made are found by its finished steps, each once", () => {
  const files = [file("new", "Plan.docx"), file("old", "Plan.docx"), file("s", "Sheet.xlsx")];
  const steps = [
    step("files.create", "Plan.docx"),
    step("files.create", "Plan.docx"),
    step("files.create", "Sheet.xlsx", "error"),
    step("files.read", "Sheet.xlsx"),
    step("files.create", "Gone.pdf"),
  ];
  assert.deepEqual(
    madeFiles(steps, files).map((item) => item.id),
    ["new"],
  );
});

test("a reply's file is found by the id its step gives, not by a name another file now has", () => {
  // Newest first, as the server lists them: the upload came after the reply.
  const files = [file("uploaded", "weekly.xlsx"), file("made", "weekly.xlsx")];
  const made: Step = { ...step("files.create", "weekly.xlsx"), file: "made" };
  assert.deepEqual(
    madeFiles([made], files).map((item) => item.id),
    ["made"],
  );
  // A step that changed a file has its card too.
  const changed: Step = { ...step("files.change", "weekly.xlsx"), file: "made" };
  assert.deepEqual(
    madeFiles([changed], files).map((item) => item.id),
    ["made"],
  );
  // The file was deleted since: nothing is offered in its place.
  assert.deepEqual(madeFiles([made], [file("uploaded", "weekly.xlsx")]), []);
  // A reply written before steps said which file: by name, as before.
  assert.deepEqual(
    madeFiles([step("files.create", "weekly.xlsx")], files).map((item) => item.id),
    ["uploaded"],
  );
});

test("counts and money are short", () => {
  assert.equal(compact(950), "950");
  assert.equal(compact(1200), "1.2K");
  assert.equal(compact(34_400), "34K");
  assert.equal(compact(5_600_000), "5.6M");
  assert.equal(money(0), "$0.00");
  assert.equal(money(1_234_567), "$1.23");
  assert.equal(money(1200), "$0.0012");
});

test("the minutes an approval has left never go below zero", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(minutesLeft("2026-01-01T00:09:30Z", now), 10);
  assert.equal(minutesLeft("2026-01-01T00:00:20Z", now), 1);
  assert.equal(minutesLeft("2025-12-31T23:00:00Z", now), 0);
  assert.equal(minutesLeft(undefined, now), null);
  assert.equal(minutesLeft("not a time", now), null);
});

test("a device is named from its user agent", () => {
  assert.equal(
    deviceName(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    ),
    "Chrome · Mac",
  );
  assert.equal(
    deviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Safari/604.1"),
    "Safari · iPhone",
  );
  assert.equal(deviceName("Muster/1 CFNetwork/3826.500 Darwin/27.0.0"), "iOS");
  assert.equal(deviceName("curl/8"), null);
  assert.equal(deviceName(null), null);
});

test("a copied reply is its words, not the notation around them", () => {
  assert.equal(readableReply("Plain answer."), "Plain answer.");
  assert.equal(
    readableReply(
      'root = Stack([a, b, c])\na = Heading("Result")\nb = Callout("Careful", "It is \\"hot\\".", "warning")\nc = List(["One", "Two"], true)',
    ),
    'Result\nCareful\nIt is "hot".\nOne\nTwo',
  );
  assert.equal(readableReply("root = Stack([])"), "root = Stack([])");
  assert.equal(
    readableReply(
      'root = Stack([c, s])\nc = Chart("Revenue", "bar", ["Jan", "Feb"], [{"name": "Sales", "values": [3, 5]}], "M")\ns = Sources([{"title": "Notes", "url": "https://example.com/n"}])',
    ),
    "Revenue\nJan\nFeb\nSales\nM\nNotes\nhttps://example.com/n",
  );
});

test("a scale has round numbers, covers the values and includes zero", () => {
  assert.deepEqual(niceScale([3, 7, 12]).ticks, [0, 5, 10, 15]);
  assert.deepEqual(niceScale([-4, 6]).ticks, [-5, -2.5, 0, 2.5, 5, 7.5]);
  assert.deepEqual(niceScale([0.1, 0.25, 0.3]).ticks, [0, 0.1, 0.2, 0.3]);
  assert.deepEqual(niceScale([]).ticks, [0, 0.25, 0.5, 0.75, 1]);
  const big = niceScale([120_000, 480_000]);
  assert.equal(big.min, 0);
  assert.ok(big.max >= 480_000);
  for (const values of [[1], [-3], [0, 0], [999, 1001], [Number.NaN, 5]]) {
    const scale = niceScale(values);
    assert.ok(scale.min <= 0 && scale.max >= 0 && scale.max > scale.min);
    assert.ok(scale.ticks.length >= 2 && scale.ticks.length <= 8);
  }
});

test("points, bars and lines land inside the plot area", () => {
  const box = { left: 40, top: 10, width: 240, height: 100 };
  const series = [{ values: [0, 5, 10] }, { values: [10, 5] }];
  const at = layout(box, 3, series);
  assert.deepEqual(at.centers, [80, 160, 240]);
  assert.equal(at.y(0), 110);
  assert.equal(at.y(10), 10);
  assert.equal(at.zero, 110);
  const first = bars(at, series[0]?.values ?? [], 0, 2, 80);
  const second = bars(at, series[1]?.values ?? [], 1, 2, 80);
  assert.equal(first[0]?.height, 0);
  assert.equal(first[2]?.y, 10);
  assert.equal(first[2]?.height, 100);
  assert.equal(second[2], null);
  for (const bar of [...first, ...second]) {
    if (!bar) continue;
    assert.ok(bar.x >= box.left && bar.x + bar.width <= box.left + box.width);
    assert.ok(bar.y >= box.top && bar.y + bar.height <= box.top + box.height + 0.001);
  }
  assert.ok((first[1]?.x ?? 0) + (first[1]?.width ?? 0) <= (second[1]?.x ?? 0));
  assert.equal(linePath(at, [0, 5, 10]), "M80.0 110.0 L160.0 60.0 L240.0 10.0");
  assert.equal(linePath(at, [0, Number.NaN, 10]), "M80.0 110.0 M240.0 10.0");
  assert.equal(
    areaPath(at, [0, 5, 10]),
    "M80.0 110.0 L160.0 60.0 L240.0 10.0 L240.0 110.0 L80.0 110.0 Z",
  );
  assert.equal(areaPath(at, [0, 5]), "");
});

test("negative values draw downward from zero", () => {
  const at = layout({ left: 0, top: 0, width: 100, height: 100 }, 2, [{ values: [-5, 5] }]);
  const drawn = bars(at, [-5, 5], 0, 1, 50);
  assert.equal(drawn[0]?.y, at.zero);
  assert.equal(drawn[0]?.height, 50);
  assert.equal(drawn[1]?.y, 0);
});

test("crowded labels are thinned so they do not overlap", () => {
  const at = layout({ left: 0, top: 0, width: 200, height: 100 }, 20, [{ values: [] }]);
  assert.equal(at.shown.filter(Boolean).length, 4);
  assert.equal(at.shown[0], true);
  const roomy = layout({ left: 0, top: 0, width: 300, height: 100 }, 3, [{ values: [] }]);
  assert.deepEqual(roomy.shown, [true, true, true]);
});

test("numbers are written without noise", () => {
  assert.equal(plain(1234567), "1,234,567");
  assert.equal(plain(12.5), "12.5");
  assert.equal(plain(0.1 + 0.2), "0.3");
  // Two decimals at most whatever the size: a price keeps its cents.
  assert.equal(plain(-1500.4), "-1,500.4");
  assert.equal(plain(1234.56), "1,234.56");
  assert.equal(plain(1234.5), "1,234.5");
  assert.equal(plain(1234.005), "1,234.01");
  assert.equal(plain(-0.001), "0");
  assert.equal(plain(Number.NaN), "");
  assert.equal(plain(0), "0");
});
