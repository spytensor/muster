import { z } from "zod";
import { digestOf, Sha256 } from "./digest.js";

/**
 * Everything that determines how an agent behaves. Two agents with the same
 * definition behave the same; any change yields a different fingerprint.
 */
export const AgentDefinition = z.strictObject({
  model: z.string().min(1),
  instructions: z.string(),
  /** Skill name to the digest of its content. */
  skills: z
    .custom<Record<string, unknown>>(
      // z.record drops a "__proto__" key without validating it, which would let a
      // skill ride along without changing the fingerprint.
      (value) => typeof value === "object" && value !== null && !Object.hasOwn(value, "__proto__"),
      "skills must be an object without a __proto__ key",
    )
    .pipe(z.record(z.string().min(1), Sha256)),
  /** Names of the tools the agent may call. Order does not matter. */
  tools: z.array(z.string().min(1)),
});
export type AgentDefinition = z.infer<typeof AgentDefinition>;

/** The version an audit record points at to say "this is what was running". */
export async function agentFingerprint(definition: AgentDefinition): Promise<Sha256> {
  const parsed = AgentDefinition.parse(definition);
  return digestOf({ ...parsed, tools: [...new Set(parsed.tools)].sort() });
}
