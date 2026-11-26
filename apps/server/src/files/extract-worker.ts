import { parentPort } from "node:worker_threads";
import { extractText, sheetGrids, tables, Unreadable } from "./extract.js";
import type { FileKind } from "./kind.js";
import { BadQuery, profile, type Query, query } from "./table.js";

/**
 * Reads a file's content away from the server's own thread and memory. A file that
 * needs more than this worker is allowed takes the worker down, not the server.
 */
export interface ExtractJob {
  op: "text" | "sheets" | "profile" | "query";
  file: { name: string; kind: FileKind; mime: string };
  bytes: Uint8Array;
  /** For text: the most to give back. */
  limit?: number;
  /** For profile and query: which sheet, and what to work out. */
  sheet?: string;
  query?: Query;
}
export type ExtractAnswer = { ok: true; result: unknown } | { ok: false; problem: string | null };

parentPort?.once("message", async (job: ExtractJob) => {
  let answer: ExtractAnswer;
  try {
    const result =
      job.op === "sheets"
        ? await sheetGrids(job.bytes)
        : job.op === "profile"
          ? profile(await tables(job.file, job.bytes), job.sheet)
          : job.op === "query"
            ? query(await tables(job.file, job.bytes), job.query ?? {})
            : await extractText(job.file, job.bytes, job.limit);
    answer = { ok: true, result };
  } catch (error) {
    answer = {
      ok: false,
      problem: error instanceof Unreadable || error instanceof BadQuery ? error.message : null,
    };
  }
  parentPort?.postMessage(answer);
});
