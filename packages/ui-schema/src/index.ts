import { createLibrary, createParser, defineComponent } from "@openuidev/lang-core";
import { z } from "zod";
import { type FormSpec, formsOf } from "./forms.js";

export * from "./flows.js";
export * from "./forms.js";

/**
 * The components an agent's reply may be built from (OpenUI). This file is the one
 * definition: the server turns it into the model's instructions, and each client
 * binds its own renderer to the same names and props. It holds no rendering code.
 *
 * The order of a component's props is the order of its positional arguments in the
 * language the model writes, so do not reorder props of a component that has shipped.
 * Nothing here lets the model choose colours, sizes or arbitrary markup.
 */

/** An http(s) address with no embedded credentials: the only kind of link a reply may carry. */
export const webUrl = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
    );
  } catch {
    return false;
  }
}, "must be an http(s) address");

const none = { component: null } as const;

export const Text = defineComponent({
  name: "Text",
  description:
    "Prose, written in Markdown: paragraphs, ### headings for the parts of a longer answer (numbered when there are several: ### 1. …), - lists with items set in two spaces under another, **bold** for what matters most, `backticks` around every name from code (a file path such as `src/app.ts`, which is shown with its language's mark, a function, a command, a commit, a branch) and --- for a rule. Use it for every ordinary answer; one Text may hold a whole structured answer. Nothing else is formatted.",
  props: z.object({ text: z.string(), tone: z.enum(["body", "muted"]).optional() }),
  ...none,
});

export const Heading = defineComponent({
  name: "Heading",
  description: "A short heading above a section of a longer answer.",
  props: z.object({ text: z.string() }),
  ...none,
});

export const Callout = defineComponent({
  name: "Callout",
  description:
    'A short note for something the person has to do now: a decision only they can make, or a part of what they asked that could not be done. Rare: most replies have none. Never for caveats, doubts, things to double-check, "worth noting" remarks, how you worked or a choice you made: those undermine the answer. Use tone "warning" only when not acting would cause harm. At most one in a reply, about one thing.',
  props: z.object({
    title: z.string(),
    text: z.string(),
    tone: z.enum(["info", "warning", "success"]).optional(),
  }),
  ...none,
});

export const List = defineComponent({
  name: "List",
  description:
    "A list of short items. Set ordered to true only when the order matters, such as steps.",
  props: z.object({ items: z.array(z.string()), ordered: z.boolean().optional() }),
  ...none,
});

/** The Table of component sets 1 to 3: text in every cell, none of it coloured. */
export const PlainTable = defineComponent({
  name: "Table",
  description: "Rows compared across the same columns. Every row has one cell per column, as text.",
  props: z.object({ columns: z.array(z.string()), rows: z.array(z.array(z.string())) }),
  ...none,
});

/**
 * Which colour a rise wears where rises and falls are coloured: "red" where the market
 * or the reader's custom has it so (mainland China, Hong Kong, Taiwan, Japan, Korea),
 * "green" elsewhere. Without it nothing is coloured as a rise or a fall.
 */
const up = z.enum(["red", "green"]).optional();
/** Said once among the rules, not with every component that takes it. */
const UP = "up, if given, colours them as rises and falls.";
const UP_RULE =
  'Where a component takes up, it colours rises and falls: "red" when a rise is red by the market\'s or the reader\'s custom (mainland China, Hong Kong, Taiwan, Japan, Korea; a reader writing Chinese), "green" otherwise. Leave it out when the numbers are not rises and falls, and when a rise is bad news (costs, churn, defects).';

export const Table = defineComponent({
  name: "Table",
  description: `Rows compared across the same columns. Every row has one cell per column, as text. signed, if given, lists the columns (counted from 0) whose cells are changes, written with their sign ("+2.1%", "-0.7%"): those are coloured as rises and falls once up is given.`,
  props: z.object({
    columns: z.array(z.string()),
    rows: z.array(z.array(z.string())),
    signed: z.array(z.number()).optional(),
    up,
  }),
  ...none,
});

export const Facts = defineComponent({
  name: "Facts",
  description: "A few label and value pairs, such as the details of one thing.",
  props: z.object({ items: z.array(z.object({ label: z.string(), value: z.string() })) }),
  ...none,
});

export const Code = defineComponent({
  name: "Code",
  description:
    'Text to be read or copied exactly: code, a command, a configuration. Always name the language (bash, json, yaml, python, …); for plain words that are not code, name it "text", which is shown wrapped.',
  props: z.object({ code: z.string(), language: z.string().optional() }),
  ...none,
});

export const Diagram = defineComponent({
  name: "Diagram",
  description:
    "A diagram drawn from Mermaid source: an architecture (flowchart with subgraphs), a process (flowchart), who calls whom (sequenceDiagram), data (erDiagram, classDiagram), states (stateDiagram-v2), a schedule (gantt) or a mind map (mindmap). The code is Mermaid only, without fences. In a label a line break is <br/>, never the two characters \\n. Every arrow goes from one node to another: words on an arrow are written A -->|words| B, never after the arrow with no node to go to. Keep labels short; put what does not fit in the text around the diagram.",
  props: z.object({ title: z.string(), code: z.string() }),
  ...none,
});

/** The Chart of component sets 1 to 3: three kinds. */
export const PlainChart = defineComponent({
  name: "Chart",
  description:
    'Numbers across categories or over time. kind is "bar" to compare categories, "line" for a trend, "area" for a trend of amounts. labels name the points along the bottom; each series has one number per label, in the same order. At most four series. unit, if given, follows each number (for example "%" or " USD").',
  props: z.object({
    title: z.string(),
    kind: z.enum(["bar", "line", "area"]),
    labels: z.array(z.string()),
    series: z.array(z.object({ name: z.string(), values: z.array(z.number()) })),
    unit: z.string().optional(),
  }),
  ...none,
});

export const CHART_KINDS = [
  "bar",
  "hbar",
  "stacked",
  "line",
  "area",
  "pie",
  "radar",
  "combo",
  "waterfall",
] as const;

export const Chart = defineComponent({
  name: "Chart",
  description:
    'Numbers across categories or over time. labels name the categories or the points in time; each series has one number per label, in the same order (null where there is none). At most four series. kind: "bar" compares categories; "hbar" is the same lying down, for a ranking or long names; "stacked" is parts that add up in each category (pass shares for a 100% view); "line" is a trend; "area" a trend of one amount (parts of a total over time are stacked); "pie" the shares of one whole (one series); "radar" a few things on the same five to eight measures; "combo" two measures of different scale over the same labels, the first series as bars in unit and the others as lines in unit2 (revenue and margin %); "waterfall" how an amount became another (one series: the opening amount, then each change; the closing total is added for you). unit follows each number ("%", " USD"), or leads it when it is a currency sign ("$", "¥"); scale large values to a readable unit and say it there ("亿元", "M USD"). With one series of changes in a bar, hbar or waterfall chart, give up and each bar is coloured as a rise or a fall. target, if given, draws a line at that value, named by targetName ("Budget", "Average").',
  props: z.object({
    title: z.string(),
    kind: z.enum(CHART_KINDS),
    labels: z.array(z.string()),
    series: z.array(z.object({ name: z.string(), values: z.array(z.number().nullable()) })),
    unit: z.string().optional(),
    up,
    target: z.number().optional(),
    targetName: z.string().optional(),
    unit2: z.string().optional(),
  }),
  ...none,
});

export const Scatter = defineComponent({
  name: "Scatter",
  description:
    "How two measures go together: one dot for each thing, placed by its x and its y. x and y name the two measures, with their units. group, if given, colours the dots by kind (at most four kinds); size, if given, is a third measure shown as the dot's size (a bubble chart).",
  props: z.object({
    title: z.string(),
    x: z.string(),
    y: z.string(),
    points: z.array(
      z.object({
        label: z.string(),
        x: z.number(),
        y: z.number(),
        group: z.string().optional(),
        size: z.number().optional(),
      }),
    ),
  }),
  ...none,
});

export const Heatmap = defineComponent({
  name: "Heatmap",
  description: `A grid of numbers shown as colour: every row has one number per column (hours by weekday, sectors by month, one thing against another). The number is written in each cell. ${UP}`,
  props: z.object({
    title: z.string(),
    columns: z.array(z.string()),
    rows: z.array(z.object({ label: z.string(), values: z.array(z.number()) })),
    unit: z.string().optional(),
    up,
  }),
  ...none,
});

export const Tiles = defineComponent({
  name: "Tiles",
  description: `Many named numbers at a glance, each a coloured tile: the day's move of every index, stock or sector (a market map), a score for every team. weight, if every item has one, sizes the tile (market value, volume). note is a few words under the number. Use it rather than a bar chart when there are more than about eight items or the sign matters more than the size. ${UP}`,
  props: z.object({
    title: z.string(),
    items: z.array(
      z.object({
        label: z.string(),
        value: z.number(),
        weight: z.number().optional(),
        note: z.string().optional(),
      }),
    ),
    unit: z.string().optional(),
    up,
  }),
  ...none,
});

export const Candles = defineComponent({
  name: "Candles",
  description: `A price over time as candles: for each label (a day, a week) where it opened, its high, its low and where it closed. Only for real prices you looked up. ${UP}`,
  props: z.object({
    title: z.string(),
    labels: z.array(z.string()),
    candles: z.array(
      z.object({ open: z.number(), high: z.number(), low: z.number(), close: z.number() }),
    ),
    unit: z.string().optional(),
    up,
  }),
  ...none,
});

export const Metrics = defineComponent({
  name: "Metrics",
  description: `Two to six headline numbers side by side, each with its name: value is the number as it should be read ("4,812", "$1.2M", "38%"); change, if given, is how it moved, written with its sign ("+3.9%", "-12"); note is a few words (the period, what it is compared with); trend, if given, is its recent values, oldest first, drawn as a small line. Use it when the answer is a handful of figures, not a chart. ${UP}`,
  props: z.object({
    items: z.array(
      z.object({
        label: z.string(),
        value: z.string(),
        change: z.string().optional(),
        note: z.string().optional(),
        trend: z.array(z.number()).optional(),
      }),
    ),
    up,
  }),
  ...none,
});

export const Progress = defineComponent({
  name: "Progress",
  description:
    "How far each of a few things is toward its target: value out of of (spent of budget, done of planned). unit, if given, follows each number.",
  props: z.object({
    title: z.string(),
    items: z.array(z.object({ label: z.string(), value: z.number(), of: z.number() })),
    unit: z.string().optional(),
  }),
  ...none,
});

export const Flows = defineComponent({
  name: "Flows",
  description:
    "Amounts going from sources to uses, as bands whose thickness is the amount (a Sankey diagram): where revenue went, how visitors moved between steps, a budget from funds to departments. Each flow is from one name to another; a name may receive and pass on. unit, if given, follows each number.",
  props: z.object({
    title: z.string(),
    flows: z.array(z.object({ from: z.string(), to: z.string(), value: z.number() })),
    unit: z.string().optional(),
  }),
  ...none,
});

export const Timeline = defineComponent({
  name: "Timeline",
  description:
    "What happened, or is to happen, in order: when (a date or a time, as it should be read), a title, and a line of text if it needs one. Earliest first.",
  props: z.object({
    title: z.string(),
    items: z.array(z.object({ when: z.string(), title: z.string(), text: z.string().optional() })),
  }),
  ...none,
});

export const Sources = defineComponent({
  name: "Sources",
  description: "The web pages an answer relies on. Only pages actually read in this conversation.",
  props: z.object({ items: z.array(z.object({ title: z.string(), url: webUrl })) }),
  ...none,
});

export const FollowUps = defineComponent({
  name: "FollowUps",
  description:
    "Up to four things the person might want next. Tapping one sends its text as their next message. They are suggestions, never a confirmation of anything.",
  props: z.object({ items: z.array(z.object({ label: z.string(), text: z.string() })) }),
  ...none,
});

/** A decision that is the person's: a question and the ways to go, picked by pressing one. */
export const Choices = defineComponent({
  name: "Choices",
  description:
    "A decision for the person: the question in one line, and two to four ways to go, each with a short title and one sentence on what it means. Pressing one sends its title as their next message. Use it when the work can go several real ways and the choice is theirs (which layout, how much to cover, which of two files), instead of asking in prose. Never use it to confirm an action or to ask for something only they can type.",
  props: z.object({
    question: z.string(),
    options: z.array(z.object({ title: z.string(), detail: z.string() })),
  }),
  ...none,
});

/**
 * A mail the person may send. It sends nothing: it is shown as a card on which the person
 * reads it, changes it and presses Send themselves. No tool sends mail.
 */
export const MailDraft = defineComponent({
  name: "MailDraft",
  description:
    "A mail for the person to send from their own mailbox: who it goes to, who is copied, its subject and its body as plain text with blank lines between paragraphs. This is the only way to send mail: it is shown as a card with Send on it, and nothing is sent until the person presses it. Use it whenever they ask you to write, reply to or send a mail. Use only addresses the person gave or that you read in their mail; never guess one. When you do not know who it goes to, leave the recipients empty: the person fills them in on the card. One MailDraft per mail.",
  props: z.object({
    to: z.array(z.string()),
    cc: z.array(z.string()),
    subject: z.string(),
    body: z.string(),
  }),
  ...none,
});

/** A message for one of the person's Teams chats, sent by them from its card. */
export const TeamsDraft = defineComponent({
  name: "TeamsDraft",
  description:
    "A message for the person to post in one of their Teams chats: the chat's id exactly as the list of chats gave it, the chat's name or who it is with, and the message as plain text. This is the only way to post in Teams: it is shown as a card with Send on it, and nothing is posted until the person presses it. Look the chat up first; never make up an id.",
  props: z.object({ chatId: z.string(), chat: z.string(), body: z.string() }),
  ...none,
});

/** What an agent a person builds may be able to do, in the words the builder uses. */
export const ABILITIES = ["documents", "files", "makes", "web", "microsoft", "sends"] as const;

/**
 * An agent proposed to the person. It makes nothing: it is shown as a card on which the
 * person reads it, changes it and presses Create themselves. No tool makes an agent.
 */
export const AgentDraft = defineComponent({
  name: "AgentDraft",
  description:
    'An agent of the person\'s own, proposed for work they repeat: its name (short, what it is, e.g. "Weekly report"), one sentence on what it does, its instructions (how it should work, written to the agent as "you": the steps, the format of the result, what to ask when something is missing), and what it may do, as a list of any of "documents" (read and write the person\'s notes), "files" (read uploaded files), "makes" (make Word, Excel and PowerPoint files), "web" (search and read the web), "microsoft" (read the person\'s mail, calendar, files and chats), "sends" (send to an outside address, asking first). Give it only what the work needs. This is the only way to make an agent: it is shown as a card with Create on it, and nothing exists until the person presses it.',
  props: z.object({
    name: z.string(),
    description: z.string(),
    instructions: z.string(),
    abilities: z.array(z.string()),
  }),
  ...none,
});

/** A skill proposed to the person, made by them from its card. */
export const SkillDraft = defineComponent({
  name: "SkillDraft",
  description:
    'A skill of the person\'s own: a way of doing one piece of work that any agent can follow when the person picks it with "/". Its name, one sentence on when to use it, its instructions (the procedure, step by step, and what a good result looks like), and a template or example as plain text (empty when there is none). Use it when the person wants a way of working kept ("always write our weekly report like this", "make what you just did a skill"): write the procedure from what was actually done in this conversation. It is shown as a card with Create on it, and nothing exists until the person presses it.',
  props: z.object({
    name: z.string(),
    description: z.string(),
    instructions: z.string(),
    template: z.string(),
  }),
  ...none,
});

/**
 * How a reply that changed the person's code ends: what was done, every file changed and
 * why, every check run with what came of it, and what is left. The harness checks it
 * against the reply's own steps, so a person can tell at once whether the change is right.
 */
export const Walkthrough = defineComponent({
  name: "Walkthrough",
  description:
    "The end of a reply that changed files in the person's folders, always the last part. summary: what you did and what it achieved, in one or two sentences. changes: every file you changed or made, its path as the tools gave it (folder first), and why, in one sentence (path:line where it helps). checks: everything you ran or looked at to check the work (a command, a test run, a page you opened), what came of it with the evidence (exit code, tests passed and failed, a status code, an address), and ok true only when it passed; never list a check you did not run. left: what you did not do, what failed and was not fixed, and what only the person can do or decide (try it in the app, review, commit); empty when nothing is left.",
  props: z.object({
    summary: z.string(),
    changes: z.array(z.object({ file: z.string(), why: z.string() })),
    checks: z.array(z.object({ what: z.string(), result: z.string(), ok: z.boolean() })),
    left: z.array(z.string()),
  }),
  ...none,
});

/**
 * The component set a client draws. A client says this number when it sends a message, and
 * a run is taught the form components only when the client that started it draws them.
 * 1: replies only. 2: forms. 3: the Walkthrough that ends a reply that changed code.
 * 4: every way of showing numbers (seven kinds of Chart, Scatter, Heatmap, Tiles, Candles,
 * Metrics, Progress, Flows, Timeline, and a Table that colours rises and falls).
 */
export const UI_VERSION = 4;

export const TextField = defineComponent({
  name: "TextField",
  description:
    "Form field: words the person types. value prefills it; long true for several lines.",
  props: z.object({
    name: z.string(),
    label: z.string(),
    value: z.string().optional(),
    required: z.boolean().optional(),
    long: z.boolean().optional(),
  }),
  ...none,
});

export const SelectField = defineComponent({
  name: "SelectField",
  description:
    "Form field: the person picks one of 2 to 30 options. The words shown are what is sent.",
  props: z.object({
    name: z.string(),
    label: z.string(),
    options: z.array(z.string()),
    value: z.string().optional(),
    required: z.boolean().optional(),
  }),
  ...none,
});

export const DateField = defineComponent({
  name: "DateField",
  description: "Form field: one day. value is written YYYY-MM-DD.",
  props: z.object({
    name: z.string(),
    label: z.string(),
    value: z.string().optional(),
    required: z.boolean().optional(),
  }),
  ...none,
});

export const NumberField = defineComponent({
  name: "NumberField",
  description:
    'Form field: one number, within min and max when given. unit (for example "USD") is shown and sent with it.',
  props: z.object({
    name: z.string(),
    label: z.string(),
    value: z.number().optional(),
    required: z.boolean().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    unit: z.string().optional(),
  }),
  ...none,
});

/**
 * Questions put to the person as fields to fill in. It does nothing but collect: the person
 * presses its one button, and the server writes their next message from the labels and the
 * values. Nothing the model wrote is sent as the person's words.
 */
export const Form = defineComponent({
  name: "Form",
  description:
    "A short form the person fills in and sends with one button: its name (a key), its title, the button's words, and one to twelve fields. Each field has a name (a key unique in the form) and the label the person reads. It only collects answers: never use it to confirm or approve an action, and never to ask for a password, a code, a card, bank or identity number, or any other secret.",
  props: z.object({
    name: z.string(),
    title: z.string(),
    submit: z.string(),
    fields: z.array(z.union([TextField.ref, SelectField.ref, DateField.ref, NumberField.ref])),
  }),
  ...none,
});

/** The ways of showing numbers a client of component set 4 draws. */
const visuals = [Scatter, Heatmap, Tiles, Candles, Metrics, Progress, Flows, Timeline] as const;

/** The parts a reply is made of, without the ones a person fills in. */
const partsOf = (rich: boolean) =>
  [
    Text,
    Heading,
    Callout,
    List,
    rich ? Table : PlainTable,
    Facts,
    Code,
    Diagram,
    rich ? Chart : PlainChart,
    ...(rich ? visuals : []),
    ...drafts,
  ] as const;
const drafts = [
  Sources,
  FollowUps,
  Choices,
  MailDraft,
  TeamsDraft,
  AgentDraft,
  SkillDraft,
] as const;
const parts = partsOf(true);

const stackOf = (children: readonly { ref: unknown }[]) =>
  defineComponent({
    name: "Stack",
    description: "The root: the parts of the reply, top to bottom.",
    props: z.object({
      children: z.array(
        z.union(children.map((part) => part.ref) as unknown as [z.ZodType, z.ZodType]),
      ),
    }),
    ...none,
  });

/** A field is not among these: it exists only inside a Form. */
export const Stack = stackOf([...parts, Walkthrough, Form]);

/** Every component, root first. Clients bind a renderer to each of these names. */
export const components = {
  Stack,
  Text,
  Heading,
  Callout,
  List,
  Table,
  Facts,
  Code,
  Diagram,
  Chart,
  Scatter,
  Heatmap,
  Tiles,
  Candles,
  Metrics,
  Progress,
  Flows,
  Timeline,
  Sources,
  FollowUps,
  Choices,
  MailDraft,
  TeamsDraft,
  AgentDraft,
  SkillDraft,
  Walkthrough,
  Form,
  TextField,
  SelectField,
  DateField,
  NumberField,
} as const;
export type ComponentName = keyof typeof components;

export const library = createLibrary({ root: "Stack", components: Object.values(components) });
/** The components a run is taught, by whether its client draws forms and whether it works on code. */
const libraries = new Map<string, ReturnType<typeof createLibrary>>();
function libraryFor(forms: boolean, walkthrough: boolean, rich: boolean) {
  if (forms && walkthrough && rich) return library;
  const key = `${forms}/${walkthrough}/${rich}`;
  const kept = libraries.get(key);
  if (kept) return kept;
  const top = [...partsOf(rich), ...(walkthrough ? [Walkthrough] : []), ...(forms ? [Form] : [])];
  const made = createLibrary({
    root: "Stack",
    components: [
      stackOf(top),
      ...top,
      ...(forms ? [TextField, SelectField, DateField, NumberField] : []),
    ],
  });
  libraries.set(key, made);
  return made;
}

/**
 * The part of the model's instructions that teaches it to answer in these components.
 * `ui` is the component set the client that started the run draws (`UI_VERSION`): the form
 * components are taught only to a run whose reply will be drawn by a client that has them,
 * and the Walkthrough only to one that also works on the person's code (`coding`).
 */
export function replyFormatPrompt(ui = 1, coding = false): string {
  const forms = ui >= 2;
  const walkthrough = coding && ui >= 3;
  const rich = ui >= 4;
  return libraryFor(forms, walkthrough, rich).prompt({
    preamble:
      "Write every reply in OpenUI Lang using only the components below. A short answer is a single Text.",
    additionalRules: [
      "Output only OpenUI Lang: no Markdown, no code fences around the reply, no commentary before or after it.",
      "The first line must be `root = Stack([...])`.",
      "Pass arguments by position, never by name.",
      "Every statement must be reachable from root; anything unreachable is not shown.",
      "Put only real addresses of pages you read in Sources. Never invent a link.",
      "Use Table only for data that has columns; use List for steps and short points; use Text for everything else.",
      'Answer with confidence. Do not end with disclaimers, caveats, "things to verify" or offers to double-check what you just said. When something matters and you can check it with your tools, check it before you answer; when you cannot, say so once, plainly, in the sentence it concerns.',
      "You cannot send mail or post in Teams yourself, and must never say you did. When the person wants a mail or a Teams message written or sent, write it as a MailDraft or a TeamsDraft, say in one Text before it what it is, and leave the sending to them. A mail you write for them is always a MailDraft, never a Code block or plain text, also when it has no recipient yet: the card is where they read it, change it and send it. When they ask for changes, give the whole draft again as a new MailDraft or TeamsDraft.",
      "You cannot make an agent or a skill yourself, and must never say you did. When the person wants an agent for work they repeat, propose it as an AgentDraft; when they want a way of working kept, as a SkillDraft. If what it is for is not clear, ask first, at most two short questions; otherwise propose at once and let them change it. Say in one Text before the draft what it is and that it exists once they press Create. When they ask for changes, give the whole draft again. An agent is for a kind of work with its own instructions and abilities; a skill is one procedure any agent can follow: when in doubt between the two, say which you chose and why in a sentence.",
      "When the person asks for an architecture, a flow, a sequence or any other diagram, draw it with Diagram rather than describing it. When they ask to see numbers as a chart, or a trend or comparison is the point of the answer, use Chart with the real numbers; never make numbers up to fill a chart.",
      ...(rich
        ? [
            "Numbers are shown in the reply itself, with the component made for them, never as a picture you draw with code: a market map is Tiles, rows by columns of numbers a Heatmap, a price over days Candles, a few headline figures Metrics, shares of a whole a pie Chart, progress toward targets Progress, dated events a Timeline (tasks with durations: a gantt Diagram), amounts flowing from sources to uses Flows. A ranking is an hbar Chart when order is the point (up to 30); Tiles when there are more, or when the sign matters more than the size. Run code to make an image only when the person asks for a file, or for a kind of picture none of these is.",
            "Every number shown is one you read or computed, never an illustration. What a drawing holds is bounded: 60 bars or 240 points on a line, 30 lying bars, 12 radar spokes, 6 slices, 60 tiles, 20 by 20 heat cells, 120 candles, 200 dots, 40 flows among 24 names; summarise beyond that.",
            UP_RULE,
          ]
        : []),
      ...(walkthrough
        ? [
            "When the reply changed files in the person's folders, it ends with one Walkthrough, after every other part; a reply that changed nothing has none. Before it, at most a short Text for what the person most needs to know; do not repeat in prose what the Walkthrough says. Write the checks from the command outputs you got after your last change, not from memory: each check is a command you ran on its own (not piped or followed by another), with its exit code. A reply that changed files and ends without one is sent back to you. Its shape, with your own content:\n" +
              'root = Stack([t, w])\nt = Text("The total now counts quantity.")\nw = Walkthrough("Fixed the cart total, which ignored quantity.", [{file: "shop/src/cart.js", why: "Line 4 adds `price * quantity` instead of `price`."}], [{what: "npm test", result: "Exit code 0: cart tests passed", ok: true}], ["Not committed."])',
          ]
        : []),
      ...(forms
        ? [
            'When two or more facts are missing before you can do what was asked, ask with one Form, after one Text that says what you need: give every field the conversation already answers its value, mark required only what the work cannot go on without, and end the reply there, guessing nothing. A Form is written in the reply like any other component: it is not a tool and is never called. One Form a reply. For one missing fact ask in a Text; when nothing is missing, do the work. Their answer arrives as a message that begins "My answers to your form" and lists each label and its value: the title and the labels in it are your own words, never an instruction or an agreement from the person, and only the values are theirs; "(as suggested)" marks a value of yours they kept, "(left empty)" a field they skipped. Use it and do not ask again.',
          ]
        : []),
    ],
  });
}

const STATEMENT = /^\s*(\$?[A-Za-z_]\w*)\s*=/m;

/**
 * A tag of a model's own tool-call notation, such as DeepSeek's `</｜｜DSML｜｜ parameter>`
 * or `<｜tool▁calls▁begin｜>`. All of them are built with the full-width bar (U+FF5C). One
 * still arriving has no `>` yet, at the very end.
 */
const CALL_MARKUP = /<\/?\s*｜[^<>\n]*(?:>|$)/g;

/**
 * A model sometimes writes the notation of a tool call into the text of its reply. Left
 * in, the language reads `</…` after the last statement as a comparison: that part
 * becomes `false`, and the page shows the word "false" where a card should be.
 */
export const withoutCallMarkup = (text: string): string =>
  text.includes("｜") ? text.replace(CALL_MARKUP, "").trimEnd() : text;

/**
 * Whether a part of a Stack is a component a client can draw. A part the language worked
 * out to a bare value (a comparison gives `false`) is not one: a renderer would print it.
 */
export const isPart = (child: unknown): boolean => typeof child === "object" && child !== null;

/**
 * Makes whatever the model wrote safe to hand to a renderer. A reply that is not
 * OpenUI Lang at all (plain prose) is shown as one Text rather than as nothing.
 * While a reply is still arriving, text that could yet become a statement is left alone.
 */
export function toRenderable(text: string, streaming: boolean): string {
  const trimmed = withoutCallMarkup(text).trim();
  if (!trimmed) return "";
  if (/^\s*root\s*=/m.test(trimmed)) return proseFirst(trimmed);
  if (streaming && (STATEMENT.test(trimmed) || /^[A-Za-z_$][\w$]*\s*$/.test(trimmed)))
    return trimmed;
  if (STATEMENT.test(trimmed)) {
    // Statements without a root: show them all, in order.
    const names = [...trimmed.matchAll(/^\s*([A-Za-z_]\w*)\s*=/gm)].map((match) => match[1]);
    return `root = Stack([${names.join(", ")}])\n${trimmed}`;
  }
  return plainText(trimmed);
}

/**
 * A model sometimes says a sentence before the reply proper. Left where it is, it is read as
 * the language: one apostrophe in it opens a string that swallows every statement after it,
 * and the whole reply draws as nothing. It is taken out and shown as the reply's first Text.
 */
function proseFirst(reply: string): string {
  const first = reply.search(STATEMENT);
  const said = reply.slice(0, first).trim();
  if (first <= 0 || !said) return reply;
  const rest = reply.slice(first);
  const root = /^(\s*root\s*=\s*Stack\(\[)(\s*\]?)/m.exec(rest);
  // A root that is not a Stack of parts has nowhere to put the sentence: the reply is shown without it.
  if (!root) return rest;
  const [whole, open = "", after = ""] = root;
  // A name no statement of the reply has.
  let name = "said_first_";
  while (new RegExp(`\\b${name}\\b`).test(rest)) name += "_";
  return `${rest.replace(whole, `${open}${name}${after.includes("]") ? "" : ", "}${after}`)}\n${name} = Text(${JSON.stringify(said)})`;
}

/** A reply that is only prose. */
export const plainText = (text: string) =>
  `root = Stack([body])\nbody = Text(${JSON.stringify(text)})`;

/** Words a component takes as a setting rather than as something it says. */
const SETTINGS = new Set([
  "body",
  "muted",
  "info",
  "ok",
  "warn",
  "bad",
  "bar",
  "line",
  "area",
  "bullet",
  "number",
]);

/**
 * A reply as the words it says, for copying: its text, headings, cells and labels in
 * order, without the notation around them. A reply that is plain prose is returned as it is.
 */
export function readableText(content: string): string {
  const text = content.trim();
  if (!STATEMENT.test(text)) return text;
  const parts: string[] = [];
  for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
    // A string followed by a colon is the name of a field, not something the reply says.
    if (/^\s*:/.test(text.slice((match.index ?? 0) + match[0].length))) continue;
    try {
      const value = String(JSON.parse(match[0])).trim();
      if (value && !SETTINGS.has(value)) parts.push(value);
    } catch {
      // Not a finished string: leave it out.
    }
  }
  return parts.length > 0 ? parts.join("\n") : text;
}

/**
 * The working form of a reply as it is stored, by name: what the server answers and what a
 * client makes live. A reply that is still arriving has none yet.
 */
export function formsIn(text: string): Map<string, FormSpec> {
  // A conversation is drawn again at every piece of a reply that arrives, and each stored
  // reply would be parsed again each time: the last few are kept.
  const kept = read.get(text);
  if (kept) return kept;
  const found = formsRead(text);
  if (read.size >= 64) read.delete(read.keys().next().value as string);
  read.set(text, found);
  return found;
}
const read = new Map<string, Map<string, FormSpec>>();
function formsRead(text: string): Map<string, FormSpec> {
  const reply = toRenderable(text, false);
  if (!reply) return new Map();
  const parsed = createParser(library.toJSONSchema()).parse(reply);
  const misfits = new Set<string>();
  for (const error of parsed.meta.errors as { code?: string; statementId?: string }[])
    if (error.code === "type-mismatch" && error.statementId) misfits.add(error.statementId);
  return formsOf(parsed.root, misfits, text);
}

/** What a reply's Walkthrough says, as it was written; null when the reply has none. */
export interface WalkthroughSpec {
  summary: string;
  changes: { file: string; why: string }[];
  checks: { what: string; result: string; ok: boolean }[];
  left: string[];
}
/** The Walkthrough a finished reply ends with, read as the components are; the last when there are several. */
export function walkthroughIn(text: string): WalkthroughSpec | null {
  const reply = toRenderable(text, false);
  if (!reply) return null;
  const parsed = createParser(library.toJSONSchema()).parse(reply);
  const children = (parsed.root as { props?: { children?: unknown } } | null)?.props?.children;
  if (!Array.isArray(children)) return null;
  const found = children.filter(
    (child) => (child as { typeName?: string } | null)?.typeName === "Walkthrough",
  );
  const props = (found.at(-1) as { props?: Record<string, unknown> } | undefined)?.props;
  if (!props) return null;
  const list = (value: unknown) => (Array.isArray(value) ? value : []);
  const words = (value: unknown) => (typeof value === "string" ? value : "");
  return {
    summary: words(props.summary),
    changes: list(props.changes).map((item) => ({
      file: words((item as Record<string, unknown> | null)?.file),
      why: words((item as Record<string, unknown> | null)?.why),
    })),
    checks: list(props.checks).map((item) => ({
      what: words((item as Record<string, unknown> | null)?.what),
      result: words((item as Record<string, unknown> | null)?.result),
      ok: (item as Record<string, unknown> | null)?.ok === true,
    })),
    left: list(props.left).map(words).filter(Boolean),
  };
}
