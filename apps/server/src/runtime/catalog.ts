import { agentFingerprint } from "@muster/protocol";

export type Level = "A0" | "A1" | "A2" | "A3" | "A4";
export type Risk = "R1" | "R2" | "R3" | "R4";

/**
 * Every tool an agent can be given. A tool's level says how far its effect reaches;
 * the gateway decides what to do with a call from the level, not from the tool's name.
 * `web.send` is a general tool, so its level is the highest it can reach.
 */
export const TOOLS = {
  "docs.list": { level: "A0", summary: "List the person's documents." },
  "docs.read": { level: "A0", summary: "Read one of the person's documents." },
  "docs.write": { level: "A1", summary: "Create or replace one of the person's documents." },
  "files.list": { level: "A0", summary: "List the person's files." },
  "files.read": {
    level: "A0",
    summary:
      "Read the text of one of the person's files: Word, Excel, PowerPoint, PDF, pages, text.",
  },
  "files.create": {
    level: "A1",
    summary: "Make a finished Word, Excel, PowerPoint, page or text file for the person.",
  },
  "web.search": {
    level: "A0",
    summary:
      "Search the web through the service the organization chose. The pages it finds can be read without asking.",
  },
  "web.fetch": {
    level: "A0",
    summary:
      "Read a public web page. An address that neither the person nor a search gave needs their confirmation first.",
  },
  "web.send": {
    level: "A3",
    summary: "Send data to an address outside the organization. Always asks the person first.",
  },
  // Not given by ticking it: every agent has it in a conversation that is in a project.
  "project.note": {
    level: "A1",
    summary: "Bring the notes of the project a conversation is in up to date.",
  },
  // Not given by ticking it: every agent has it in a conversation that is in a project.
  "project.step": {
    level: "A1",
    summary: "Add a step to the project a conversation is in, or say how far one has come.",
  },
  // Not given by ticking it: every agent has it in a conversation that is in a project.
  "project.update": {
    level: "A1",
    summary: "Write an update on how the project a conversation is in is going.",
  },
  // Not given by ticking it: every agent has it in a conversation that is in a project.
  "project.keep": {
    level: "A1",
    summary:
      "Keep something in the project a conversation is in: a repository, a guide, an environment, a link, someone to reach, a fact.",
  },
  // Not given by ticking it: every agent has it in a conversation that is in a project.
  "project.drop": {
    level: "A1",
    summary: "Take something that is no longer true out of the project a conversation is in.",
  },
  // Not given by ticking it: every agent has it for a person who has memory on.
  "memory.save": {
    level: "A1",
    summary: "Keep one sentence the person wants remembered in later conversations.",
  },
  // Not given by ticking it: every agent has it.
  "followup.set": {
    level: "A1",
    summary:
      "Wait for something and come back to the conversation when the time comes or a mail arrives.",
  },
  // Not given by ticking it: an agent has it when the person may use another agent (CHA-264).
  "agent.ask": {
    level: "A0",
    summary:
      "Pass one step of the work to another agent the person may use. What that agent does asks the person as it would on its own.",
  },
  // Not given by ticking it: an agent has it when it carries a knowledge base.
  "knowledge.search": {
    level: "A0",
    summary:
      "Look things up in the knowledge bases the agent carries, for what the person may read.",
  },
  // The person's own Microsoft 365, once they have connected it. Reading only.
  "m365.mail": { level: "A0", summary: "Search and read the person's Outlook mail." },
  "m365.calendar": { level: "A0", summary: "Read the person's Outlook calendar." },
  "m365.files": {
    level: "A0",
    summary: "Search and read the person's files in OneDrive and SharePoint.",
  },
  "m365.chats": { level: "A0", summary: "Read the person's Teams chats." },
  "files.outline": {
    level: "A0",
    summary: "See the parts of a file made here: its slides, sheets or sections.",
  },
  "files.guide": {
    level: "A0",
    summary: "Read how a document, a presentation or a workbook is written here.",
  },
  "files.change": {
    level: "A1",
    summary: "Add to a file made here, or change one slide, sheet or section of it.",
  },
  "data.profile": {
    level: "A0",
    summary: "See what a spreadsheet's or CSV file's columns hold, over every row.",
  },
  "data.query": {
    level: "A0",
    summary: "Work out sums, averages and counts over every row of a table.",
  },
  // Not given by ticking it: it comes with making files, where the server has a sandbox.
  "code.run": {
    level: "A1",
    summary:
      "Run Python or shell in a sandbox that has only the files it is handed and reaches only the hosts the organization allows: to work data out, draw a chart, convert a file or check how one looks.",
  },
} as const satisfies Record<string, { level: Level; summary: string }>;
export type ToolName = keyof typeof TOOLS;
/** Tools an agent has because of what it carries, never because someone ticked them. */
export const IMPLIED_TOOLS: readonly ToolName[] = [
  "agent.ask",
  "knowledge.search",
  "memory.save",
  "project.note",
  "project.step",
  "project.update",
  "project.keep",
  "project.drop",
  "files.outline",
  "files.change",
  "files.guide",
  "data.profile",
  "data.query",
  "code.run",
];
/**
 * Tools that come with another: an agent that may make files may build them in steps and
 * change them; one that may read files may work out what their tables hold. Nobody ticks
 * these, and they reach no further than the tool they come with.
 */
export const COMES_WITH: Partial<Record<ToolName, readonly ToolName[]>> = {
  "files.create": ["files.outline", "files.change", "files.guide", "code.run"],
  "files.read": ["data.profile", "data.query"],
};
/** A list of tools with the ones that come with them. */
export const withCompanions = (names: readonly string[]): string[] => [
  ...new Set([...names, ...names.flatMap((name) => COMES_WITH[name as ToolName] ?? [])]),
];

/**
 * How much a person lets agents do in one conversation without asking them first.
 * - ask: ask before writing a file on their computer and before reading a site they did not name.
 * - auto: write in the folders they attached without asking; still ask about a new site.
 * - full: also read any public page without asking.
 * Sending anything outside the organization asks in every mode.
 */
export const MODES = ["ask", "auto", "full"] as const;
export type Mode = (typeof MODES)[number];
export const isMode = (value: unknown): value is Mode => MODES.includes(value as Mode);

/**
 * What an agent can do in the folders a person attached to a project on their own
 * computer. These are not given to an agent by its builder: they come with the person's
 * computer, for a run started from the desktop app, and only as far as the agent's own
 * tools already reach (`needs`): an agent that may not write the person's documents may
 * not write their folders either. They run on that computer, never on the server.
 */
export const DEVICE_TOOLS = {
  "local.list": { level: "A0", needs: ["files.list", "files.read"] },
  "local.read": { level: "A0", needs: ["files.read"] },
  "local.search": { level: "A0", needs: ["files.read"] },
  "local.write": { level: "A1", needs: ["files.create", "docs.write"] },
  // Working on code there (CHA-273): finding files by name, changing a piece of one,
  // running a command, and looking after a command that goes on. Running a command can
  // reach as far as the person can; what it is decides whether it asks (commands.ts).
  "local.find": { level: "A0", needs: ["files.list", "files.read"] },
  "local.edit": { level: "A1", needs: ["files.create", "docs.write"] },
  "local.exec": { level: "A2", needs: ["files.create", "docs.write"] },
  "local.job": { level: "A0", needs: ["files.create", "docs.write"] },
  // The work's pull request (MUS-18): pushing its branch and opening one always asks the
  // person first, whatever the mode (the gateway sees to that); reading how it stands does not.
  "local.pr": { level: "A0", needs: ["files.create", "docs.write"] },
} as const satisfies Record<string, { level: Level; needs: readonly ToolName[] }>;
/**
 * What an agent can do with a repository of the company's when the person's computer is
 * not there: the work is done in the server's sandbox (codeHost.ts). Like the tools of a
 * computer they are given by nobody: they are there where the company connected its code
 * host and the server can run code, as far as the agent's own tools reach. Nothing leaves
 * through them: `repo.propose` shows the person the work, and it is the person who sends it.
 */
export const CLOUD_TOOLS = {
  "repo.open": { level: "A0", needs: ["files.create", "docs.write"] },
  "repo.read": { level: "A0", needs: ["files.create", "docs.write"] },
  "repo.write": { level: "A1", needs: ["files.create", "docs.write"] },
  "repo.edit": { level: "A1", needs: ["files.create", "docs.write"] },
  "repo.propose": { level: "A1", needs: ["files.create", "docs.write"] },
} as const satisfies Record<string, { level: Level; needs: readonly ToolName[] }>;
export type CloudToolName = keyof typeof CLOUD_TOOLS;
export const isCloudTool = (value: string): value is CloudToolName =>
  Object.hasOwn(CLOUD_TOOLS, value);
/** The cloud tools an agent has, given the tools its builder gave it. */
export const cloudToolsFor = (tools: readonly string[]): CloudToolName[] =>
  (Object.keys(CLOUD_TOOLS) as CloudToolName[]).filter((name) =>
    CLOUD_TOOLS[name].needs.some((need) => tools.includes(need)),
  );
export type DeviceToolName = keyof typeof DEVICE_TOOLS;
export const isDeviceTool = (value: string): value is DeviceToolName =>
  Object.hasOwn(DEVICE_TOOLS, value);
/** The device tools an agent with these tools gets when the person's computer is there. */
export const deviceToolsFor = (tools: readonly string[]): DeviceToolName[] =>
  (Object.keys(DEVICE_TOOLS) as DeviceToolName[]).filter((name) =>
    DEVICE_TOOLS[name].needs.some((need) => tools.includes(need)),
  );

/**
 * Every agent also has this one, whatever tools it was given: it lets the agent show the
 * person its plan and how far along it is. It reads and changes nothing but that list.
 */
export const PLAN_TOOL = "plan.set";
export interface PlanItem {
  title: string;
  status: "pending" | "in_progress" | "done";
}
export const TOOL_NAMES = Object.keys(TOOLS) as ToolName[];
export const isToolName = (value: string): value is ToolName => Object.hasOwn(TOOLS, value);

/** The level that reaches further. Levels are names, not numbers, so this is not Math.max. */
export const further = (a: Level, b: Level): Level => (b.localeCompare(a) > 0 ? b : a);

/** An agent's risk level follows from the furthest-reaching thing it is able to do. */
export function riskOf(tools: readonly string[]): Risk {
  const top = tools
    .filter(isToolName)
    .reduce<Level>((max, name) => further(max, TOOLS[name].level), "A0");
  // R1 only reads. R2 changes things inside the organization. R3 can act outside it. R4 is what nothing may do yet.
  return top === "A4" ? "R4" : top === "A3" || top === "A2" ? "R3" : top === "A1" ? "R2" : "R1";
}

export interface AgentDefinition {
  model: string;
  instructions: string;
  tools: string[];
}

/** The version recorded on every run: it changes whenever the model, instructions or tools do. */
export const versionOf = (definition: AgentDefinition) =>
  agentFingerprint({ ...definition, skills: {} });

/**
 * The name the general agent is kept under, and the one it is known by. It is stored and
 * looked up as "Assistant"; to people, and to a model that may name it to them, it is
 * Muster (the owner, 2026-11-24).
 *
 * Which agent is the general one is said by its row, not by its name alone: it is the
 * company's (`source = 'platform'`) and kept under that name. A person's own agent named
 * "Assistant" from before the name was refused (2026-11-15) is theirs and keeps its name.
 * The server says the shown name wherever it names an agent to a person or to a model, so
 * a client draws what it is given and nothing downstream has to know the rule.
 */
export const GENERAL_AGENT = "Assistant";
export const GENERAL_SHOWN = "Muster";
export const isGeneral = (agent: { name: string; source?: string | null }): boolean =>
  agent.source === "platform" && agent.name === GENERAL_AGENT;
/** The name an agent is shown by, from its row. */
export const shownOf = (agent: { name: string; source?: string | null }): string =>
  isGeneral(agent) ? GENERAL_SHOWN : agent.name;
/** The same in a query: the column to select where an agent is named to a person. */
export const shownSql = (alias: string): string =>
  `(case when ${alias}.source = 'platform' and ${alias}.name = '${GENERAL_AGENT}' then '${GENERAL_SHOWN}' else ${alias}.name end)`;
/**
 * A name kept as words where the agent's row is not known any more: who a step was passed
 * to, who wrote a note, in rows written before the shown name was the one kept. There the
 * bare name is all there is, and "Assistant" is taken for the general agent.
 */
export const legacySql = (column: string): string =>
  `(case when ${column} = '${GENERAL_AGENT}' then '${GENERAL_SHOWN}' else ${column} end)`;
export const legacyByline = (name: string): string =>
  name === GENERAL_AGENT ? GENERAL_SHOWN : name;

/** Agents every organization starts with. */
export const PLATFORM_AGENTS: {
  name: string;
  description: string;
  instructions: string;
  tools: ToolName[];
}[] = [
  {
    name: GENERAL_AGENT,
    description:
      "A general helper for everyday work: answers questions, reads pages and keeps notes in your documents.",
    instructions:
      "You are a helpful assistant for someone at work. Be direct and brief. Use the person's documents and files when they are relevant, and save work the person asks you to keep. When they ask for a Word, Excel or PowerPoint file, make that file rather than pasting its content.",
    tools: [
      "docs.list",
      "docs.read",
      "docs.write",
      "files.list",
      "files.read",
      "files.create",
      "web.search",
      "web.fetch",
      "m365.mail",
      "m365.calendar",
      "m365.files",
      "m365.chats",
    ],
  },
  {
    name: "Writer",
    description: "Drafts and revises documents, and saves them where you can find them.",
    instructions:
      "You draft and revise documents for someone at work. Ask what is missing only when you cannot proceed. Save each finished draft and say what you saved it as: as a Word, PowerPoint or Excel file when the person asks for one or the work is meant to be sent to others, otherwise as a document.",
    tools: ["docs.list", "docs.read", "docs.write", "files.list", "files.read", "files.create"],
  },
  {
    name: "Researcher",
    description: "Searches the web, reads the pages and writes up what it finds, with its sources.",
    instructions:
      "You research questions using public web pages. Search first, then read the most relevant pages yourself rather than relying on a search's summary or on what you remember. Do not guess addresses. Give the address of every page you rely on, and say plainly when you could not find something.",
    tools: ["web.search", "web.fetch", "docs.write", "files.read", "files.create"],
  },
  {
    name: "Messenger",
    description:
      "Sends a message to an outside address you name, such as a team chat webhook. Always asks you before anything leaves.",
    instructions:
      "You send messages to outside addresses on the person's behalf. Write the message, state exactly what will be sent and where, then send it. Never send anything the person did not ask for.",
    tools: ["docs.read", "files.list", "files.read", "web.send"],
  },
];
