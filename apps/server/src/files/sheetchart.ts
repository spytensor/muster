import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

/**
 * Charts in a workbook, as Excel's own: they open in Excel, WPS and Numbers as charts a
 * person can restyle and that follow the cells. The library that writes the workbook has
 * no charts, so they are added to the finished file as the parts the format defines.
 */
export type SheetChartKind = "bar" | "line" | "pie";
/** A chart of one sheet's table: the first column names the points, the others are the numbers. */
export interface SheetChartPlan {
  /** Which sheet, counted from 0, in the order the workbook holds them. */
  sheet: number;
  sheetName: string;
  kind: SheetChartKind;
  title: string;
  /** The header of each series and the column it is in, counted from 0. */
  series: { name: string; column: number; values: (number | null)[] }[];
  categories: string[];
  /** The first and last row of the points, counted from 1 as Excel does. */
  firstRow: number;
  lastRow: number;
  /** The column the chart starts at, to the right of the table, counted from 0. */
  at: number;
  /** Series colours, as RRGGBB. */
  colors: string[];
  /** The numbers are shares: the axis reads in percentages. */
  percent?: boolean;
}

/** Text as XML takes it: its marks written out, and the control characters XML forbids left out. */
const esc = (text: string) =>
  [...text]
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      // Not half of a pair, and not the two code points XML has no place for.
      const lone = ch.length === 1 && code >= 0xd800 && code <= 0xdfff;
      return (code >= 32 || code === 9 || code === 10 || code === 13) && !lone && code < 0xfffe;
    })
    .join("")
    .replace(/[<>&"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
const letters = (column: number): string => {
  let name = "";
  for (let n = column + 1; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};

function chartXml(plan: SheetChartPlan): string {
  const sheet = `'${plan.sheetName.replace(/'/g, "''")}'`;
  const range = (column: number) =>
    `${sheet}!$${letters(column)}$${plan.firstRow}:$${letters(column)}$${plan.lastRow}`;
  const cats = `<c:cat><c:strRef><c:f>${esc(range(0))}</c:f><c:strCache><c:ptCount val="${plan.categories.length}"/>${plan.categories
    .map((name, n) => `<c:pt idx="${n}"><c:v>${esc(name)}</c:v></c:pt>`)
    .join("")}</c:strCache></c:strRef></c:cat>`;
  const fill = (color: string) => `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>`;
  const text = (size: number, color: string, bold = false) =>
    `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${size}" b="${bold ? 1 : 0}">${fill(color)}</a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>`;
  const series = plan.series
    .map((one, n) => {
      const color = plan.colors[n % plan.colors.length] as string;
      const look =
        plan.kind === "line"
          ? `<c:spPr><a:ln w="28575" cap="rnd">${fill(color)}<a:round/></a:ln></c:spPr><c:marker><c:symbol val="circle"/><c:size val="5"/><c:spPr>${fill(color)}<a:ln w="9525">${fill("FFFFFF")}</a:ln></c:spPr></c:marker>`
          : plan.kind === "pie"
            ? plan.categories
                .map(
                  (_, point) =>
                    `<c:dPt><c:idx val="${point}"/><c:bubble3D val="0"/><c:spPr>${fill(plan.colors[point % plan.colors.length] as string)}<a:ln w="19050">${fill("FFFFFF")}</a:ln></c:spPr></c:dPt>`,
                )
                .join("")
            : `<c:spPr>${fill(color)}</c:spPr><c:invertIfNegative val="0"/>`;
      const header = `${sheet}!$${letters(one.column)}$${plan.firstRow - 1}`;
      const values = `<c:val><c:numRef><c:f>${esc(range(one.column))}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${one.values.length}"/>${one.values
        .map((value, point) =>
          value === null ? "" : `<c:pt idx="${point}"><c:v>${value}</c:v></c:pt>`,
        )
        .join("")}</c:numCache></c:numRef></c:val>`;
      return `<c:ser><c:idx val="${n}"/><c:order val="${n}"/><c:tx><c:strRef><c:f>${esc(header)}</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${esc(one.name)}</c:v></c:pt></c:strCache></c:strRef></c:tx>${look}${cats}${values}${plan.kind === "line" ? '<c:smooth val="0"/>' : ""}</c:ser>`;
    })
    .join("");
  const axes =
    plan.kind === "pie"
      ? ""
      : `<c:catAx><c:axId val="111"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr><a:ln w="9525">${fill("C9CED6")}</a:ln></c:spPr>${text(900, "5B6472")}<c:crossAx val="222"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx><c:valAx><c:axId val="222"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines><c:spPr><a:ln w="9525">${fill("E6E9EE")}</a:ln></c:spPr></c:majorGridlines><c:numFmt formatCode="${plan.percent ? "0%" : "#,##0"}" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr><a:ln><a:noFill/></a:ln></c:spPr>${text(900, "5B6472")}<c:crossAx val="111"/><c:crosses val="autoZero"/><c:crossBetween val="${plan.kind === "line" ? "midCat" : "between"}"/></c:valAx>`;
  const plot =
    plan.kind === "bar"
      ? `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${series}<c:gapWidth val="80"/><c:overlap val="-10"/><c:axId val="111"/><c:axId val="222"/></c:barChart>`
      : plan.kind === "line"
        ? `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}<c:marker val="1"/><c:axId val="111"/><c:axId val="222"/></c:lineChart>`
        : `<c:pieChart><c:varyColors val="1"/>${series}<c:dLbls><c:numFmt formatCode="0%" sourceLinked="0"/><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>${text(900, "FFFFFF", true)}<c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="1"/><c:showBubbleSize val="0"/><c:showLeaderLines val="0"/></c:dLbls><c:firstSliceAng val="0"/></c:pieChart>`;
  const legend =
    plan.kind === "pie" || plan.series.length > 1
      ? `<c:legend><c:legendPos val="b"/><c:overlay val="0"/>${text(900, "5B6472")}</c:legend>`
      : "";
  const title = plan.title
    ? `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1200" b="1">${fill("14181F")}</a:defRPr></a:pPr><a:r><a:rPr lang="en-US" sz="1200" b="1">${fill("14181F")}</a:rPr><a:t>${esc(plan.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>`
    : '<c:autoTitleDeleted val="1"/>';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:roundedCorners val="0"/><c:chart>${title}<c:plotArea><c:layout/>${plot}${axes}<c:spPr><a:noFill/></c:spPr></c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart><c:spPr>${fill("FFFFFF")}<a:ln w="9525">${fill("DDE1E7")}</a:ln></c:spPr></c:chartSpace>`;
}

const drawingXml = (plan: SheetChartPlan, id: number) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:twoCellAnchor><xdr:from><xdr:col>${plan.at}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${plan.at + 8}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>19</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${id + 1}" name="Chart ${id}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`;

/** Adds the charts to a finished workbook. One chart a sheet. */
export function addCharts(workbook: Uint8Array, plans: SheetChartPlan[]): Uint8Array {
  if (plans.length === 0) return workbook;
  const parts = unzipSync(workbook);
  const read = (path: string) => (parts[path] ? strFromU8(parts[path]) : "");
  let types = read("[Content_Types].xml");
  // The workbook says which part each sheet is, in order.
  const rels = read("xl/_rels/workbook.xml.rels");
  const targets = new Map(
    [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((tag) => [
      tag[0].match(/\bId="([^"]+)"/)?.[1] ?? "",
      tag[0].match(/\bTarget="([^"]+)"/)?.[1] ?? "",
    ]),
  );
  const order = [...read("xl/workbook.xml").matchAll(/<sheet\b[^>]*r:id="([^"]+)"/g)].map((tag) =>
    (targets.get(tag[1] as string) ?? "").replace(/^\/?(xl\/)?/, ""),
  );
  plans.forEach((plan, index) => {
    const id = index + 1;
    const target = order[plan.sheet];
    const path = target ? `xl/${target}` : "";
    const xml = read(path);
    if (!xml) return;
    const name = path.split("/").pop() as string;
    const relsPath = `xl/worksheets/_rels/${name}.rels`;
    const before = read(relsPath);
    const relId = `rIdChart${id}`;
    const relation = `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${id}.xml"/>`;
    parts[relsPath] = strToU8(
      before
        ? before.replace("</Relationships>", `${relation}</Relationships>`)
        : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relation}</Relationships>`,
    );
    // The format fixes where a sheet names its drawing: after the page's set-up, before
    // anything that follows it.
    const drawing = `<drawing r:id="${relId}"/>`;
    const later = xml.search(
      /<(legacyDrawing|legacyDrawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b/,
    );
    const withDrawing =
      later >= 0
        ? `${xml.slice(0, later)}${drawing}${xml.slice(later)}`
        : xml.replace("</worksheet>", `${drawing}</worksheet>`);
    parts[path] = strToU8(
      withDrawing.includes("xmlns:r=")
        ? withDrawing
        : withDrawing.replace(
            "<worksheet ",
            '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ',
          ),
    );
    parts[`xl/drawings/drawing${id}.xml`] = strToU8(drawingXml(plan, id));
    parts[`xl/drawings/_rels/drawing${id}.xml.rels`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${id}.xml"/></Relationships>`,
    );
    parts[`xl/charts/chart${id}.xml`] = strToU8(chartXml(plan));
    types = types.replace(
      "</Types>",
      `<Override PartName="/xl/drawings/drawing${id}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/><Override PartName="/xl/charts/chart${id}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`,
    );
  });
  parts["[Content_Types].xml"] = strToU8(types);
  return zipSync(parts);
}

/** A chart as a workbook keeps it, for showing beside its sheet. */
export interface SheetChartShown {
  kind: SheetChartKind;
  title: string;
  categories: string[];
  series: { name: string; color: string; values: (number | null)[] }[];
}

/** The most of one part that is read: a chart is a few kilobytes, and a part made huge is made to stall. */
const PART_BYTES = 2 * 1024 * 1024;
/**
 * What lies between the first `open` at or after `from` and the `close` that follows it,
 * found by walking forward once. Nothing, when either is missing: a part that opens
 * something and never closes it is not searched again from every opening.
 */
function between(text: string, open: string, close: string, from = 0) {
  const start = text.indexOf(open, from);
  if (start < 0) return null;
  const end = text.indexOf(close, start + open.length);
  if (end < 0) return null;
  return { body: text.slice(start + open.length, end), next: end + close.length };
}
const unesc = (text: string) =>
  text
    .replace(/&#(\d{1,7});/g, (whole, code) => {
      const point = Number(code);
      return point > 0 && point <= 0x10ffff && (point < 0xd800 || point > 0xdfff)
        ? String.fromCodePoint(point)
        : whole;
    })
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
const cached = (block: string): string[] => {
  const out: string[] = [];
  for (const point of block.matchAll(/<c:pt idx="(\d+)"[^>]*>\s*<c:v>([^<]*)<\/c:v>/g)) {
    const index = Number(point[1]);
    if (index < 400) out[index] = unesc(point[2] ?? "");
  }
  return Array.from(out, (value) => value ?? "");
};

/** The charts of each sheet of a workbook, by the sheet's place in it: what they showed when saved. */
export function readCharts(parts: Record<string, Uint8Array>): Map<number, SheetChartShown[]> {
  // Only a part the archive really holds, and only one of ordinary size.
  const read = (path: string) => {
    const part = Object.hasOwn(parts, path) ? parts[path] : undefined;
    return part && part.byteLength <= PART_BYTES ? strFromU8(part) : "";
  };
  const relations = (path: string) =>
    new Map(
      [...read(path).matchAll(/<Relationship\b[^>]*>/g)].map((tag) => [
        tag[0].match(/\bId="([^"]+)"/)?.[1] ?? "",
        tag[0].match(/\bTarget="([^"]+)"/)?.[1] ?? "",
      ]),
    );
  const resolve = (from: string, target: string) => {
    if (target.startsWith("/")) return target.slice(1);
    const stack = from.split("/").slice(0, -1);
    for (const part of target.split("/")) {
      if (part === "..") stack.pop();
      else if (part !== ".") stack.push(part);
    }
    return stack.join("/");
  };
  const book = relations("xl/_rels/workbook.xml.rels");
  const sheets = [...read("xl/workbook.xml").matchAll(/<sheet\b[^>]*r:id="([^"]+)"/g)].map((tag) =>
    resolve("xl/workbook.xml", book.get(tag[1] as string) ?? ""),
  );
  const found = new Map<number, SheetChartShown[]>();
  sheets.forEach((sheetPath, index) => {
    const name = sheetPath.split("/").pop() ?? "";
    const sheetRels = `${sheetPath.split("/").slice(0, -1).join("/")}/_rels/${name}.rels`;
    // A sheet names its drawing near its end; a sheet can be large, so only its end is read.
    const sheet = Object.hasOwn(parts, sheetPath) ? parts[sheetPath] : undefined;
    const drawingId = (
      sheet ? strFromU8(sheet.subarray(Math.max(0, sheet.byteLength - 8192))) : ""
    ).match(/<drawing\b[^>]{0,200}r:id="([^"]{1,100})"/)?.[1];
    const drawingTarget = drawingId && relations(sheetRels).get(drawingId);
    if (!drawingTarget) return;
    const drawingPath = resolve(sheetPath, drawingTarget);
    const drawingRels = relations(
      `${drawingPath.split("/").slice(0, -1).join("/")}/_rels/${drawingPath.split("/").pop()}.rels`,
    );
    const charts: SheetChartShown[] = [];
    for (const use of read(drawingPath).matchAll(/<c:chart\b[^>]*r:id="([^"]+)"/g)) {
      const xml = read(resolve(drawingPath, drawingRels.get(use[1] as string) ?? ""));
      const kind: SheetChartKind | null = /<c:(pie|pie3D|doughnut)Chart>/.test(xml)
        ? "pie"
        : /<c:(line|area)Chart>/.test(xml)
          ? "line"
          : /<c:(bar|bar3D)Chart>/.test(xml)
            ? "bar"
            : null;
      if (!kind) continue;
      const series: {
        name: string;
        color: string;
        categories: string[];
        values: (number | null)[];
      }[] = [];
      for (let at = 0; series.length < 12; ) {
        const ser = between(xml, "<c:ser>", "</c:ser>", at);
        if (!ser) break;
        at = ser.next;
        const look = ser.body.indexOf("<c:spPr>");
        series.push({
          name: cached(between(ser.body, "<c:tx>", "</c:tx>")?.body ?? "")[0] ?? "",
          color:
            (look < 0 ? "" : ser.body.slice(look, look + 600)).match(
              /<a:srgbClr val="([0-9A-Fa-f]{6})"/,
            )?.[1] ?? "",
          categories: cached(between(ser.body, "<c:cat>", "</c:cat>")?.body ?? ""),
          values: cached(between(ser.body, "<c:val>", "</c:val>")?.body ?? "").map((value) =>
            value === "" || !Number.isFinite(Number(value)) ? null : Number(value),
          ),
        });
      }
      if (series.length === 0) continue;
      const title = [
        ...(between(xml, "<c:title>", "</c:title>")?.body ?? "")
          .slice(0, 4000)
          .matchAll(/<a:t>([^<]*)<\/a:t>/g),
      ]
        .map((piece) => unesc(piece[1] ?? ""))
        .join("");
      charts.push({
        kind,
        title,
        categories: series[0]?.categories ?? [],
        series: series.map(({ name: label, color, values }) => ({ name: label, color, values })),
      });
      if (charts.length === 4) break;
    }
    if (charts.length) found.set(index, charts);
  });
  return found;
}
