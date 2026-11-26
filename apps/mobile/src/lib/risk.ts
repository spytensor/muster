import type { Level, Risk, Tool } from "./types.ts";

const order: Level[] = ["A0", "A1", "A2", "A3", "A4"];

/** The same rule the server applies: an agent is as risky as the furthest-reaching tool it holds. */
export function riskOf(tools: Pick<Tool, "level">[]): Risk {
  const top = tools.reduce((max, tool) => Math.max(max, order.indexOf(tool.level)), 0);
  return (["R1", "R2", "R3", "R3", "R4"] as const)[top] ?? "R1";
}
