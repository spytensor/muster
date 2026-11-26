/**
 * The sandbox runner as a small web service, for the server and nobody else: it listens
 * on a network only the server is on. Four things can be asked of it.
 *
 *   GET    /health                       whether code can be run, and how it is kept apart
 *   PUT    /spaces/<id>/files/<name>     keep a file in a workspace
 *   GET    /spaces/<id>/files/<name>     give one back
 *   POST   /spaces/<id>/run              run code there: {language, code, seconds, hosts, live}
 *   PUT    /spaces/<id>/unpack/<folder>  put a repository's archive into a folder
 *   GET    /spaces/<id>/tree/<folder>    that folder's files, with git's fingerprints
 *   DELETE /spaces/<id>/files/<name>     take a file out
 *   DELETE /spaces/<id>                  forget a workspace
 *
 * And for the page an administrator reads (the server's sandboxAdmin.ts):
 *
 *   GET    /status                       health, places, workspaces in all, the disk, the limits
 *   GET    /running                      every run asked for and not over
 *   GET    /spaces                       every workspace: files, bytes, last used, busy
 *   POST   /spaces/<id>/stop             end what runs there, as an administrator
 *   DELETE /spaces/<id>?idle=1           release a workspace, unless something runs there
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { LIMITS, Refused, Runner } from "./runner.js";

const STATUS: Record<Refused["code"], number> = {
  not_ready: 503,
  bad_space: 404,
  bad_name: 400,
  no_file: 404,
  too_large: 413,
  space_full: 413,
  busy: 429,
  bad_request: 400,
  stopped: 499,
  ended: 499,
  in_use: 409,
  broke: 502,
};

async function body(request: IncomingMessage, most: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > most) throw new Refused("too_large", "That is more than a sandbox takes in.");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export function serve(runner: Runner) {
  return createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    try {
      const url = new URL(request.url ?? "/", "http://sandbox");
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (request.method === "GET" && url.pathname === "/health") return send(200, runner.state());
      if (request.method === "GET" && url.pathname === "/status")
        return send(200, await runner.status());
      if (request.method === "GET" && url.pathname === "/running")
        return send(200, runner.flying());
      if (request.method === "GET" && parts.length === 1 && parts[0] === "spaces")
        return send(200, await runner.spaces());
      if (parts[0] !== "spaces" || !parts[1]) return send(404, { error: "not_found" });
      const space = parts[1];
      if (parts[2] === "stop" && parts.length === 3 && request.method === "POST")
        return send(200, { ended: runner.end(space) });
      if (parts[2] === "files" && parts.length > 3) {
        const name = parts.slice(3).join("/");
        if (request.method === "PUT")
          return send(200, await runner.put(space, name, await body(request, LIMITS.fileBytes)));
        if (request.method === "DELETE") {
          await runner.drop(space, name);
          return send(200, { ok: true });
        }
        if (request.method === "GET") {
          const bytes = await runner.get(space, name);
          response.writeHead(200, { "content-type": "application/octet-stream" });
          return void response.end(Buffer.from(bytes));
        }
      }
      // A repository, as its code host's archive, into one folder; and that folder as it stands.
      if (parts[2] === "unpack" && parts.length === 4 && request.method === "PUT")
        return send(
          200,
          await runner.unpack(space, parts[3] as string, await body(request, LIMITS.fileBytes)),
        );
      if (parts[2] === "tree" && parts.length === 4 && request.method === "GET")
        return send(200, await runner.tree(space, parts[3] as string));
      if (parts[2] === "run" && parts.length === 3 && request.method === "POST") {
        let asked: Record<string, unknown>;
        try {
          asked = JSON.parse(new TextDecoder().decode(await body(request, 1024 * 1024)));
        } catch (error) {
          if (error instanceof Refused) throw error;
          throw new Refused("bad_request", "The request is not JSON.");
        }
        // Whoever asked has gone (the person stopped the reply): the run ends with them.
        const gone = new AbortController();
        response.on("close", () => {
          if (!response.writableFinished) gone.abort();
        });
        if (asked?.live !== true)
          return send(200, await runner.run(space, asked ?? {}, { signal: gone.signal }));
        // Asked to be told as it goes: a line for what was printed, a few times a second
        // at most, and a last line with how it ended.
        response.writeHead(200, {
          "content-type": "application/x-ndjson",
          "cache-control": "no-store",
          "x-accel-buffering": "no",
        });
        const line = (value: unknown) => response.write(`${JSON.stringify(value)}\n`);
        const held = { out: "", err: "" };
        let timer: NodeJS.Timeout | null = null;
        const flush = () => {
          timer = null;
          for (const stream of ["out", "err"] as const)
            if (held[stream]) {
              line({ said: { stream, text: held[stream] } });
              held[stream] = "";
            }
        };
        try {
          const ran = await runner.run(space, asked, {
            signal: gone.signal,
            said: (stream, text) => {
              held[stream] += text;
              if (held.out.length + held.err.length > 16_000) {
                if (timer) clearTimeout(timer);
                flush();
              } else timer ??= setTimeout(flush, 250);
            },
          });
          if (timer) clearTimeout(timer);
          flush();
          line({ ran });
        } catch (error) {
          if (timer) clearTimeout(timer);
          if (!(error instanceof Refused)) console.error(error);
          line(
            error instanceof Refused
              ? {
                  error: error.code,
                  message: error.message,
                  ...(error.wall === undefined ? {} : { wall: error.wall }),
                }
              : { error: "failed", message: "The sandbox failed." },
          );
        }
        return void response.end();
      }
      if (parts.length === 2 && request.method === "DELETE") {
        // Released for being idle: not while something runs there. Forgotten: after it.
        if (url.searchParams.get("idle") === "1") {
          const since = Number(url.searchParams.get("since"));
          await runner.release(space, Number.isFinite(since) && since > 0 ? since : undefined);
        } else await runner.forget(space);
        return send(200, { ok: true });
      }
      return send(404, { error: "not_found" });
    } catch (error) {
      if (error instanceof Refused)
        return send(STATUS[error.code], {
          error: error.code,
          message: error.message,
          ...(error.wall === undefined ? {} : { wall: error.wall }),
        });
      console.error(error);
      return send(500, { error: "failed", message: "The sandbox failed." });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const runner = new Runner(
    process.env.SANDBOX_SPACES ?? "/spaces",
    process.env.SANDBOX_IMAGE_DIR ?? fileURLToPath(new URL("../image", import.meta.url)),
    {
      ...(process.env.SANDBOX_RUNTIME ? { runtime: process.env.SANDBOX_RUNTIME } : {}),
      allowContainer: process.env.SANDBOX_ALLOW_CONTAINER === "1",
    },
  );
  const port = Number(process.env.PORT ?? 7420);
  serve(runner).listen(port, process.env.SANDBOX_BIND ?? "0.0.0.0", () => {
    console.log(JSON.stringify({ at: new Date().toISOString(), event: "listening", port }));
  });
  // The image may take minutes to build the first time; the service answers meanwhile.
  const prepare = async () => {
    const health = await runner.prepare();
    if (!health.ready) setTimeout(prepare, 10 * 60 * 1000).unref();
  };
  void prepare();
  setInterval(() => void runner.sweep().catch(() => {}), 5 * 60 * 1000).unref();
  // What is running ends with the service: nothing is left for nobody to watch.
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.on(signal, () => void runner.stop().finally(() => process.exit(0)));
}
