import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { axis, formatNumber } from "./chart";
import { type Item, NotSlides, readDeck } from "./parse";
import { parseXml } from "./xml";

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const rels = (...items: [id: string, type: string, target: string][]) =>
  `<Relationships>${items
    .map(
      ([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`,
    )
    .join("")}</Relationships>`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A small presentation written by hand: a master, a layout and the slides given. */
function deck(slides: string[], extra: Record<string, Uint8Array> = {}) {
  const files: Record<string, Uint8Array> = {
    "ppt/presentation.xml": strToU8(
      `<p:presentation ${NS}><p:sldIdLst>${slides
        .map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`)
        .join("")}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
    ),
    "ppt/_rels/presentation.xml.rels": strToU8(
      rels(
        ...slides.map((_, i): [string, string, string] => [
          `rId${i + 1}`,
          "slide",
          `slides/slide${i + 1}.xml`,
        ]),
      ),
    ),
    "ppt/theme/theme1.xml": strToU8(
      `<a:theme ${NS}><a:themeElements><a:clrScheme name="x"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:accent1><a:srgbClr val="FF7F41"/></a:accent1></a:clrScheme><a:fontScheme name="x"><a:majorFont><a:latin typeface="Aptos Display"/><a:ea typeface="等线"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`,
    ),
    "ppt/slideMasters/slideMaster1.xml": strToU8(
      `<p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill></p:bgPr></p:bg><p:spTree>
        <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="952500" y="476250"/><a:ext cx="9525000" cy="952500"/></a:xfrm></p:spPr><p:txBody><a:bodyPr anchor="ctr"/><a:p/></p:txBody></p:sp>
        <p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="952500" y="1905000"/><a:ext cx="9525000" cy="3810000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:p/></p:txBody></p:sp>
        <p:sp><p:nvSpPr><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="6667500"/><a:ext cx="12192000" cy="190500"/></a:xfrm><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></p:spPr></p:sp>
      </p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2"/>
      <p:txStyles><p:titleStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="4400" b="1"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle>
      <p:bodyStyle><a:lvl1pPr marL="342900" indent="-342900"><a:buChar char="•"/><a:defRPr sz="2800"/></a:lvl1pPr><a:lvl2pPr marL="742950" indent="-285750"><a:buChar char="–"/><a:defRPr sz="2400"/></a:lvl2pPr></p:bodyStyle></p:txStyles></p:sldMaster>`,
    ),
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": strToU8(
      rels(["rId1", "theme", "../theme/theme1.xml"]),
    ),
    "ppt/slideLayouts/slideLayout1.xml": strToU8(
      `<p:sldLayout ${NS}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp></p:spTree></p:cSld></p:sldLayout>`,
    ),
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels": strToU8(
      rels(["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]),
    ),
    ...extra,
  };
  slides.forEach((tree, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = strToU8(
      `<p:sld ${NS}><p:cSld><p:spTree>${tree}</p:spTree></p:cSld></p:sld>`,
    );
    files[`ppt/slides/_rels/slide${i + 1}.xml.rels`] ??= strToU8(
      rels(
        ["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"],
        ["rId2", "image", "../media/image1.png"],
      ),
    );
  });
  return zipSync(files);
}
const shapes = (items: Item[]) => items.filter((item) => item.type === "shape");
const first = (item: Item | undefined) => {
  if (item?.type !== "shape" || !item.text) throw new Error("expected a shape with text");
  return item.text;
};

describe("reading XML", () => {
  it("keeps names, attributes, text and entities, and expands nothing a file declares", () => {
    const xml = parseXml(
      `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY big "aaaa">]><a:r x="1 &amp; 2"><!-- no --><a:t>Tom &lt; Jerry &#x4e2d; &big;</a:t><a:e/></a:r>`,
    );
    expect(xml.name).toBe("a:r");
    expect(xml.attrs.x).toBe("1 & 2");
    expect(xml.children.map((c) => c.name)).toEqual(["a:t", "a:e"]);
    expect(xml.children[0]?.text).toBe("Tom < Jerry 中 &big;");
  });
});

describe("reading a presentation", () => {
  it("gives a title and a list the place, size, colour and bullets their master sets", () => {
    const read = readDeck(
      deck([
        `<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>季度路线图</a:t></a:r></a:p></p:txBody></p:sp>
         <p:sp><p:nvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr><a:normAutofit fontScale="50000"/></a:bodyPr>
           <a:p><a:r><a:t>Beta in </a:t></a:r><a:r><a:rPr b="1"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:rPr><a:t>March</a:t></a:r></a:p>
           <a:p><a:pPr lvl="1"/><a:r><a:t>Pilot</a:t></a:r></a:p></p:txBody></p:sp>`,
      ]),
    );
    expect([read.width, read.height]).toEqual([1280, 720]);
    const slide = read.slides[0];
    expect(slide?.background).toEqual({ css: "rgb(255, 255, 255)" });
    // The master's bar is behind the slide's own shapes; its empty placeholders are not drawn.
    const [bar, title, body] = shapes(slide?.items ?? []);
    expect(bar).toMatchObject({ box: { y: 700, w: 1280 }, fill: { css: "rgb(255, 127, 65)" } });
    expect(title).toMatchObject({ box: { x: 100, y: 50, w: 1000, h: 100 } });
    const heading = first(title);
    expect(heading.anchor).toBe("middle");
    expect(heading.paragraphs[0]).toMatchObject({ align: "center", bullet: null });
    expect(heading.paragraphs[0]?.runs[0]).toMatchObject({
      text: "季度路线图",
      bold: true,
      color: "rgb(0, 0, 0)",
      font: 'Aptos Display", "等线',
    });
    expect(heading.paragraphs[0]?.runs[0]).toMatchObject({ size: expect.closeTo(58.67, 1) });

    const list = first(body);
    expect(body).toMatchObject({ box: { x: 100, y: 200, w: 1000, h: 400 } });
    expect(list.paragraphs[0]).toMatchObject({ bullet: "•", marginLeft: 36, indent: -36 });
    // Shrunk to fit, as the file says: half of 28 points.
    expect(list.paragraphs[0]?.runs[0]).toMatchObject({ size: expect.closeTo(18.67, 1) });
    expect(list.paragraphs[0]?.runs[1]).toMatchObject({
      text: "March",
      bold: true,
      color: "rgb(255, 0, 0)",
    });
    expect(list.paragraphs[1]).toMatchObject({ bullet: "–", marginLeft: 78 });
  });

  it("reads pictures, groups, tables and what it cannot draw", () => {
    const read = readDeck(
      deck(
        [
          `<p:pic><p:blipFill><a:blip r:embed="rId2"/><a:srcRect l="25000"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm></p:spPr></p:pic>
           <p:grpSp><p:grpSpPr><a:xfrm><a:off x="952500" y="952500"/><a:ext cx="1905000" cy="1905000"/><a:chOff x="0" y="0"/><a:chExt cx="952500" cy="952500"/></a:xfrm></p:grpSpPr>
             <p:sp><p:spPr><a:xfrm rot="5400000"><a:off x="476250" y="0"/><a:ext cx="476250" cy="476250"/></a:xfrm><a:prstGeom prst="ellipse"/><a:solidFill><a:srgbClr val="336699"><a:alpha val="50000"/></a:srgbClr></a:solidFill><a:ln w="19050"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></p:spPr></p:sp></p:grpSp>
           <p:graphicFrame><p:xfrm><a:off x="0" y="3810000"/><a:ext cx="1905000" cy="952500"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1"/><a:tblGrid><a:gridCol w="952500"/><a:gridCol w="952500"/></a:tblGrid>
             <a:tr h="381000"><a:tc gridSpan="2"><a:txBody><a:bodyPr/><a:p><a:r><a:t>Region</a:t></a:r></a:p></a:txBody></a:tc><a:tc hMerge="1"><a:txBody><a:bodyPr/><a:p/></a:txBody></a:tc></a:tr>
             <a:tr h="381000"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>North</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>42</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>
           <p:graphicFrame><p:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"/></a:graphic></p:graphicFrame>`,
        ],
        { "ppt/media/image1.png": PNG },
      ),
    );
    const [picture, circle, table, chart] = read.slides[0]?.items.slice(1) ?? [];
    expect(picture).toMatchObject({
      type: "image",
      image: "ppt/media/image1.png",
      crop: [0.25, 0, 0, 0],
    });
    expect(read.media["ppt/media/image1.png"]).toEqual(PNG);
    // Inside a group drawn at twice its size, moved to where the group is.
    expect(circle).toMatchObject({
      geometry: "ellipse",
      box: { x: 200, y: 100, w: 100, h: 100, rotate: 90 },
      fill: { css: "rgba(51, 102, 153, 0.5)" },
      line: { color: "rgb(0, 0, 0)", width: 2 },
    });
    if (table?.type !== "table") throw new Error("expected a table");
    expect(table.columns).toEqual([100, 100]);
    expect(table.rows[0]?.cells).toHaveLength(1);
    expect(table.rows[0]?.cells[0]).toMatchObject({ colSpan: 2, fill: "rgb(255, 127, 65)" });
    expect(table.rows[1]?.cells[1]?.text?.paragraphs[0]?.runs[0]).toMatchObject({ text: "42" });
    expect(chart).toMatchObject({ type: "other", what: "chart" });
  });

  it("refuses what is not a presentation", () => {
    expect(() => readDeck(new Uint8Array([1, 2, 3]))).toThrow(NotSlides);
    expect(() => readDeck(zipSync({ "word/document.xml": strToU8("<w:document/>") }))).toThrow(
      NotSlides,
    );
    expect(() => readDeck(deck([]))).toThrow(/no slides/);
  });

  it("does not follow a picture that points outside the file", () => {
    const read = readDeck(
      deck(
        [
          `<p:pic><p:blipFill><a:blip r:embed="rId2"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm></p:spPr></p:pic>`,
        ],
        {
          "ppt/slides/_rels/slide1.xml.rels": strToU8(
            `<Relationships><Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${REL}/image" Target="https://example.com/track.png" TargetMode="External"/></Relationships>`,
          ),
        },
      ),
    );
    expect(read.slides[0]?.items.at(-1)).toMatchObject({ type: "other", what: "picture" });
    expect(read.media).toEqual({});
  });
  it("reads a chart's kind, numbers, colours and labels", () => {
    const chart = `<c:chartSpace xmlns:c="c" xmlns:a="a"><c:chart><c:plotArea><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>
      <c:ser><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>订阅</c:v></c:pt></c:strCache></c:strRef></c:tx><c:spPr><a:solidFill><a:srgbClr val="2F6BFF"/></a:solidFill></c:spPr>
        <c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:strCache></c:strRef></c:cat>
        <c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>210</c:v></c:pt><c:pt idx="1"><c:v>238.5</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser>
      <c:dLbls><c:numFmt formatCode="#,##0.0"/><c:showVal val="1"/></c:dLbls></c:barChart></c:plotArea><c:legend><c:legendPos val="b"/></c:legend></c:chart></c:chartSpace>`;
    const read = readDeck(
      deck(
        [
          `<p:graphicFrame><p:xfrm><a:off x="0" y="0"/><a:ext cx="4762500" cy="2857500"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rId9"/></a:graphicData></a:graphic></p:graphicFrame>`,
        ],
        {
          "ppt/charts/chart1.xml": strToU8(chart),
          "ppt/slides/_rels/slide1.xml.rels": strToU8(
            rels(
              ["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"],
              ["rId9", "chart", "/ppt/charts/chart1.xml"],
            ),
          ),
        },
      ),
    );
    const item = read.slides[0]?.items.at(-1);
    expect(item).toMatchObject({
      type: "chart",
      box: { w: 500, h: 300 },
      chart: {
        kind: "bar",
        sideways: false,
        categories: ["Q1", "Q2"],
        series: [{ name: "订阅", color: "rgb(47, 107, 255)", values: [210, 238.5] }],
        legend: "b",
        labels: "value",
        format: "#,##0.0",
      },
    });
    expect(formatNumber(1238.5, "#,##0.0")).toBe("1,238.5");
    expect(formatNumber(0.416, "0%")).toBe("42%");
    expect(formatNumber(12, '"¥"0.0"万"')).toBe("¥12.0万");
    expect(axis(0, 308).ticks).toEqual([0, 100, 200, 300, 400]);
  });

  it("stays quick on a file made to be slow, and takes no meaning from odd names", () => {
    // A tag with a very long run of characters and no attribute in it.
    const started = performance.now();
    parseXml(`<a ${"x".repeat(400_000)}><b/></a>`);
    // A slide with thousands of placeholders that have no place of their own.
    const many =
      `<p:sp><p:nvSpPr><p:nvPr><p:ph idx="7"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>`.repeat(20_000);
    const read = readDeck(deck([many]));
    expect(performance.now() - started).toBeLessThan(3000);
    expect(shapes(read.slides[0]?.items ?? [])).toHaveLength(1);
    const odd = parseXml(`<a __proto__="x" constructor="y" b = 'c > d'/>`);
    expect(Object.getPrototypeOf(odd.attrs)).toBe(Object.prototype);
    expect(odd.attrs.b).toBe("c > d");
  });

  it("reads true and false written as words, and a picture dropped into a placeholder", () => {
    const read = readDeck(
      deck(
        [
          `<p:pic><p:nvPicPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/></p:blipFill><p:spPr/></p:pic>
           <p:sp><p:nvSpPr><p:cNvPr id="9" name="x" hidden="true"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9525" cy="9525"/></a:xfrm><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></p:spPr></p:sp>
           <p:graphicFrame><p:xfrm><a:off x="0" y="0"/><a:ext cx="1905000" cy="381000"/></p:xfrm><a:graphic><a:graphicData uri="t"><a:tbl><a:tblGrid><a:gridCol w="952500"/><a:gridCol w="952500"/></a:tblGrid><a:tr h="381000"><a:tc gridSpan="2"><a:txBody><a:bodyPr/><a:p><a:r><a:t>A</a:t></a:r></a:p></a:txBody></a:tc><a:tc hMerge="true"><a:txBody><a:bodyPr/><a:p/></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`,
        ],
        { "ppt/media/image1.png": PNG },
      ),
    );
    const [picture, table] = read.slides[0]?.items.slice(1) ?? [];
    // The picture takes the body placeholder's place from the master; the hidden shape is left out.
    expect(picture).toMatchObject({ type: "image", box: { x: 100, y: 200, w: 1000, h: 400 } });
    if (table?.type !== "table") throw new Error("expected a table");
    expect(table.rows[0]?.cells).toHaveLength(1);
  });
});
