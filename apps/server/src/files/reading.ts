import { Worker } from "node:worker_threads";
import { type SheetGrid, Unreadable } from "./extract.js";
import type { ExtractAnswer, ExtractJob } from "./extract-worker.js";
import type { Query } from "./table.js";

const TIME_LIMIT_MS = 30_000;
const HEAP_LIMIT_MB = 512;

/** From source the worker is TypeScript and needs the same loader this process runs under. */
const fromSource = import.meta.url.endsWith(".ts");
const workerFile = new URL(
  fromSource ? "./extract-worker.ts" : "./extract-worker.js",
  import.meta.url,
);
const execArgv = fromSource ? ["--import", import.meta.resolve("tsx")] : [];

/**
 * Reads a file in a worker with a memory limit and a time limit. A file built to
 * exhaust either is reported as unreadable; the server carries on.
 */
function read<T>(job: ExtractJob): Promise<T> {
  return new Promise((done, failed) => {
    const worker = new Worker(workerFile, {
      execArgv,
      resourceLimits: { maxOldGenerationSizeMb: HEAP_LIMIT_MB, stackSizeMb: 4 },
    });
    const tooMuch = () =>
      failed(
        new Unreadable(
          "This file is too large or too complex to open here. Download it to open it.",
        ),
      );
    const timer = setTimeout(() => {
      void worker.terminate();
      tooMuch();
    }, TIME_LIMIT_MS);
    const finish = () => {
      clearTimeout(timer);
      void worker.terminate();
    };
    worker.once("message", (answer: ExtractAnswer) => {
      finish();
      if (answer.ok) done(answer.result as T);
      else
        failed(
          new Unreadable(
            answer.problem ??
              "This file could not be read. It may be damaged or protected by a password.",
          ),
        );
    });
    // Running out of memory arrives here.
    worker.once("error", () => {
      finish();
      tooMuch();
    });
    worker.once("exit", (code) => {
      if (code !== 0) {
        finish();
        tooMuch();
      }
    });
    worker.postMessage(job);
  });
}

export const readText = (file: ExtractJob["file"], bytes: Uint8Array, limit?: number) =>
  read<{ text: string; truncated: boolean }>({
    op: "text",
    file,
    bytes,
    ...(limit ? { limit } : {}),
  });
export const readSheets = (file: ExtractJob["file"], bytes: Uint8Array) =>
  read<SheetGrid[]>({ op: "sheets", file, bytes });
/** What a file's tables hold, worked out over every row. */
export const readProfile = (file: ExtractJob["file"], bytes: Uint8Array, sheet?: string) =>
  read<string>({ op: "profile", file, bytes, ...(sheet ? { sheet } : {}) });
/** Sums, averages and counts over every row of a table. */
export const readQuery = (file: ExtractJob["file"], bytes: Uint8Array, query: Query) =>
  read<string>({ op: "query", file, bytes, query });
