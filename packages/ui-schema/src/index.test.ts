import { createParser } from "@openuidev/lang-core";
import { describe, expect, it } from "vitest";
import {
  components,
  formsIn,
  isPart,
  library,
  plainText,
  replyFormatPrompt,
  toRenderable,
  UI_VERSION,
  walkthroughIn,
  webUrl,
  withoutCallMarkup,
} from "./index.js";

const parse = (text: string) => createParser(library.toJSONSchema()).parse(text);
/** The names of the components in a parsed reply, in order. */
const shape = (text: string) => {
  const root = parse(text).root as {
    typeName: string;
    props: { children: { typeName: string }[] };
  } | null;
  return root ? [root.typeName, ...root.props.children.map((child) => child.typeName)] : null;
};

describe("the reply components", () => {
  it("parse a reply that uses each of them", () => {
    const reply = `root = Stack([h, t, c, l, tb, f, code, d, ch, s, n])
h = Heading("Summary")
t = Text("Two things changed.", "muted")
c = Callout("Heads up", "One page could not be read.", "warning")
l = List(["First", "Second"], true)
tb = Table(["Name", "Size"], [["a.txt", "2 KB"], ["b.txt", "4 KB"]])
f = Facts([{label: "Owner", value: "Na Li"}])
code = Code("pnpm check", "bash")
d = Diagram("Flow", "flowchart LR; A-->B")
ch = Chart("Sales", "bar", ["Q1", "Q2"], [{name: "North", values: [1, 2]}])
s = Sources([{title: "Docs", url: "https://example.com/docs"}])
n = FollowUps([{label: "Save it", text: "Save this as a document"}])`;
    expect(shape(reply)).toEqual([
      "Stack",
      "Heading",
      "Text",
      "Callout",
      "List",
      "Table",
      "Facts",
      "Code",
      "Diagram",
      "Chart",
      "Sources",
      "FollowUps",
    ]);
  });

  it("are all taught to the model", () => {
    // Every component is taught to a client that draws them all; an older one is taught fewer.
    const prompt = replyFormatPrompt(UI_VERSION, true);
    for (const name of Object.keys(components)) expect(prompt, name).toContain(`${name}(`);
    expect(prompt).toContain("root = Stack");
  });

  it("carry only plain web addresses as links", () => {
    expect(webUrl.safeParse("https://example.com/a?b=1").success).toBe(true);
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,x",
      "https://user:pw@example.com",
      "file:///etc/passwd",
      "example.com",
      "",
    ]) {
      expect(webUrl.safeParse(bad).success, bad).toBe(false);
    }
  });
});

const SAMPLE_ROOT = 'root = Stack([a])\na = Text("It\'s fine.")';

describe("toRenderable", () => {
  it("drops tool-call notation a model wrote after its reply, so the card is not drawn as false", () => {
    // As a reply was stored on 2026-11-19: a mail draft, a stray "]", then DeepSeek's closing tags.
    const said =
      'root = Stack([Text("The mail is in the card below.", "body"), mail]) \n' +
      'mail = MailDraft(["lei@northwind.test"], [], "Proposal", "Hi Lei,\\n\\nAttached.\\n\\nMia"])' +
      "</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>";
    expect(shape(toRenderable(said, false))).toEqual(["Stack", "Text", "MailDraft"]);
    expect(shape(toRenderable(said.slice(0, -40), true))?.[2]).toBe("MailDraft");
  });

  it("leaves text without the notation exactly as it was", () => {
    const said = 'root = Stack([a])\na = Code("text", "if a < b and c > d: <tag/>")';
    expect(withoutCallMarkup(said)).toBe(said);
    expect(withoutCallMarkup("<｜tool▁calls▁begin｜>Hello")).toBe("Hello");
  });

  it("tells a component apart from a bare value", () => {
    expect(isPart(parse('root = Stack([a])\na = Text("x")').root)).toBe(true);
    for (const value of [false, true, null, undefined, 3, "false"])
      expect(isPart(value)).toBe(false);
  });

  it("leaves a proper reply alone", () => {
    const reply = 'root = Stack([a])\na = Text("Hi")';
    expect(toRenderable(reply, false)).toBe(reply);
  });

  it("shows plain prose as one Text, quotes and newlines intact", () => {
    const said = 'She said "wait".\nThen left.';
    const wrapped = toRenderable(said, false);
    expect(wrapped).toBe(plainText(said));
    const root = parse(wrapped).root as unknown as {
      props: { children: { props: { text: string } }[] };
    };
    expect(root.props.children[0]?.props.text).toBe(said);
  });

  it("adds a root when the model forgot it", () => {
    expect(shape(toRenderable('a = Heading("One")\nb = Text("Two")', false))).toEqual([
      "Stack",
      "Heading",
      "Text",
    ]);
  });

  it("waits while a reply that may still become a statement is arriving, then decides", () => {
    expect(toRenderable("roo", true)).toBe("roo");
    expect(toRenderable("root = Sta", true)).toBe("root = Sta");
    expect(toRenderable("Hello there, this is prose", true)).toBe(
      plainText("Hello there, this is prose"),
    );
    expect(toRenderable("roo", false)).toBe(plainText("roo"));
    expect(toRenderable("   ", false)).toBe("");
  });

  it("renders a half-written reply as far as it has got", () => {
    const partial = parse('root = Stack([a, b])\na = Text("Hel');
    const root = partial.root as unknown as { props: { children: { props: { text: string } }[] } };
    expect(root.props.children[0]?.props.text).toBe("Hel");
  });

  it("shows a sentence said before the reply as its first paragraph, apostrophes and all", () => {
    // Seen on 2026-11-16: read as written, the apostrophe opens a string and nothing is drawn.
    const reply = `I'll need a few details, so please fill these in.

root = Stack([intro, details])
intro = Text("I'll write it up.")
details = Form("claim", "Client dinner", "Send", [TextField("venue", "Restaurant")])`;
    expect(parse(reply).root).toBeNull();
    const shown = toRenderable(reply, false);
    expect(shape(shown)).toEqual(["Stack", "Text", "Text", "Form"]);
    expect(shown).toContain(JSON.stringify("I'll need a few details, so please fill these in."));
    expect(formsIn(reply).has("claim")).toBe(true);
    // The same while it is still arriving, and with an empty root.
    expect(shape(toRenderable(reply.slice(0, reply.indexOf("intro =")), true))).toEqual([
      "Stack",
      "Text",
    ]);
    expect(shape(toRenderable("It's done.\n\nroot = Stack([])", false))).toEqual(["Stack", "Text"]);
    // A reply that already uses the name the sentence would take keeps its own statement.
    const taken = toRenderable(
      'Here you are.\n\nroot = Stack([said_first_])\nsaid_first_ = Text("The answer.")',
      false,
    );
    expect(shape(taken)).toEqual(["Stack", "Text", "Text"]);
    expect(taken).toContain('said_first_ = Text("The answer.")');
    expect(taken).toContain('said_first__ = Text("Here you are.")');
    // A reply that starts with its root is not touched.
    expect(toRenderable(SAMPLE_ROOT, false)).toBe(SAMPLE_ROOT);
  });

  it("renders a finished reply whose closing brackets the model left out", () => {
    // Seen in QA (E-15): the model stopped after the last string, twice in four replies.
    const unclosed = parse(toRenderable('root = Stack([\n  Text("OK")', false));
    const root = unclosed.root as unknown as { props: { children: { props: { text: string } }[] } };
    expect(root.props.children[0]?.props.text).toBe("OK");
  });
});

describe("drafts", () => {
  it("parses a mail and a Teams message as cards with their fields in order", () => {
    const reply = parse(
      'root = Stack([m, t])\nm = MailDraft(["lei@acme.test"], [], "Budget", "Hello Lei")\nt = TeamsDraft("19:abc@thread.v2", "Launch team", "Friday")',
    );
    const [mail, teams] = (
      reply.root as unknown as { props: { children: { props: Record<string, unknown> }[] } }
    ).props.children;
    expect(mail?.props).toMatchObject({
      to: ["lei@acme.test"],
      cc: [],
      subject: "Budget",
      body: "Hello Lei",
    });
    expect(teams?.props).toMatchObject({ chatId: "19:abc@thread.v2", body: "Friday" });
  });
});

describe("a reply as words", () => {
  it("keeps what the reply says and drops the notation and the settings", async () => {
    const { readableText } = await import("./index.js");
    const reply = [
      "root = Stack([a, b, c])",
      'a = Heading("Q3 review")',
      'b = Callout("warn", "Check", "North missed its target.")',
      'c = Table(["Region", "Revenue"], [["East", "1204"]])',
    ].join("\n");
    expect(readableText(reply)).toBe(
      ["Q3 review", "Check", "North missed its target.", "Region", "Revenue", "East", "1204"].join(
        "\n",
      ),
    );
    expect(readableText("Just a sentence.")).toBe("Just a sentence.");
  });
});

describe("an agent and a skill proposed in a reply", () => {
  it("parses each as a card with its fields in order, and the model is told nothing is made by it", () => {
    const reply = parse(
      'root = Stack([a, s])\na = AgentDraft("Weekly report", "Writes the weekly report.", "You write the report in three parts.", ["files", "makes"])\ns = SkillDraft("Board memo", "When a board memo is asked for.", "1. Read the figures.\\n2. One page.", "# Memo\\n## Decision")',
    );
    const [agent, skill] = (
      reply.root as unknown as { props: { children: { props: Record<string, unknown> }[] } }
    ).props.children;
    expect(agent?.props).toMatchObject({
      name: "Weekly report",
      instructions: "You write the report in three parts.",
      abilities: ["files", "makes"],
    });
    expect(skill?.props).toMatchObject({ name: "Board memo", template: "# Memo\n## Decision" });
    const told = replyFormatPrompt();
    expect(told).toContain("AgentDraft");
    expect(told).toContain("SkillDraft");
    expect(told).toContain("You cannot make an agent or a skill yourself");
  });
});

describe("a decision put to the person", () => {
  it("parses as a question and its ways to go", () => {
    const reply = parse(
      'root = Stack([c])\nc = Choices("Which layout?", [{title: "One page", detail: "Figures only."}, {title: "Full pack", detail: "With charts."}])',
    );
    const [choices] = (
      reply.root as unknown as { props: { children: { props: Record<string, unknown> }[] } }
    ).props.children;
    expect(choices?.props).toMatchObject({
      question: "Which layout?",
      options: [
        { title: "One page", detail: "Figures only." },
        { title: "Full pack", detail: "With charts." },
      ],
    });
    expect(replyFormatPrompt()).toContain("Choices");
  });
});

describe("the walkthrough that ends a reply that changed code", () => {
  const reply = `root = Stack([t, w])
t = Text("Done.")
w = Walkthrough("Fixed the login redirect.", [{file: "web/src/auth.ts", why: "Kept the address the person came from."}], [{what: "pnpm test", result: "Exit code 0, 42 passed", ok: true}], ["Try it in the app."])`;

  it("is read as written", () => {
    expect(walkthroughIn(reply)).toEqual({
      summary: "Fixed the login redirect.",
      changes: [{ file: "web/src/auth.ts", why: "Kept the address the person came from." }],
      checks: [{ what: "pnpm test", result: "Exit code 0, 42 passed", ok: true }],
      left: ["Try it in the app."],
    });
    expect(walkthroughIn('root = Stack([t])\nt = Text("Hi.")')).toBeNull();
    expect(walkthroughIn("Plain words.")).toBeNull();
  });

  it("is taught only to a run that works on code for a client that draws it", () => {
    expect(replyFormatPrompt(UI_VERSION, true)).toContain("Walkthrough(");
    expect(replyFormatPrompt(UI_VERSION, false)).not.toContain("Walkthrough");
    expect(replyFormatPrompt(2, true)).not.toContain("Walkthrough");
    // A client that draws forms is still taught them without the walkthrough.
    expect(replyFormatPrompt(2, true)).toContain("Form(");
    expect(replyFormatPrompt(1, false)).not.toContain("Form(");
  });

  it("teaches every way of showing numbers only to a client that draws them", () => {
    const rich = replyFormatPrompt(UI_VERSION);
    for (const name of [
      "Scatter",
      "Heatmap",
      "Tiles",
      "Candles",
      "Metrics",
      "Progress",
      "Timeline",
    ])
      expect(rich).toContain(`${name}(`);
    expect(rich).toContain('"hbar"');
    expect(rich).toContain("signed?");
    const plain = replyFormatPrompt(3, true);
    for (const name of [
      "Scatter",
      "Heatmap",
      "Tiles",
      "Candles",
      "Metrics",
      "Progress",
      "Timeline",
    ])
      expect(plain).not.toContain(`${name}(`);
    expect(plain).not.toContain("hbar");
    expect(plain).not.toContain("signed");
    // What an older client is taught is what it was taught before, to the letter of its kinds.
    expect(plain).toContain('kind: "bar" | "line" | "area"');
    // The same from one message to the next: nothing in it depends on when it is asked.
    expect(replyFormatPrompt(UI_VERSION)).toBe(rich);
  });

  it("reads a market map, a heat map and candles as written", () => {
    const parsed = parse(`root = Stack([m, h, c, t])
m = Tiles("Asia", [{label: "KOSPI", value: 6.3, weight: 2}, {label: "HSI", value: -0.7, weight: 3}], "%", "red")
h = Heatmap("Sectors", ["Mon", "Tue"], [{label: "Tech", values: [1.2, -0.4]}], "%", "red")
c = Candles("NVDA", ["11/20", "11/21"], [{open: 1, high: 3, low: 0.5, close: 2}, {open: 2, high: 2.5, low: 1, close: 1.2}], " USD", "green")
t = Table(["Index", "Move"], [["KOSPI", "+6.3%"]], [1], "red")`);
    expect(parsed.meta.errors).toEqual([]);
    expect(parsed.meta.unresolved).toEqual([]);
    const children = (
      parsed.root as unknown as {
        props: { children: { typeName: string; props: Record<string, unknown> }[] };
      }
    ).props.children;
    expect(children.map((child) => child.typeName)).toEqual([
      "Tiles",
      "Heatmap",
      "Candles",
      "Table",
    ]);
    expect(children[0]?.props.up).toBe("red");
    expect(children[3]?.props.signed).toEqual([1]);
  });
});
