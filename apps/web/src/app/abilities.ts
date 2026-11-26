/** What an agent can do, as the few things a person thinks in, and the tools each stands for. */
export type Ability = "documents" | "files" | "makes" | "knowledge" | "web" | "microsoft" | "sends";
export const ABILITY_TOOLS: Record<Ability, string[]> = {
  documents: ["docs.list", "docs.read", "docs.write"],
  files: ["files.list", "files.read"],
  makes: ["files.create"],
  knowledge: ["knowledge.search"],
  web: ["web.search", "web.fetch"],
  microsoft: ["m365.mail", "m365.calendar", "m365.files", "m365.chats"],
  sends: ["web.send"],
};
export const ABILITY_NAMES = Object.keys(ABILITY_TOOLS) as Ability[];
