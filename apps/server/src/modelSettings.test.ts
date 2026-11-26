import { beforeAll, describe, expect, it } from "vitest";
import { ModelSettings } from "./modelSettings.js";
import { type Harness, harness } from "./test-support.js";

const json = async <T = unknown>(response: Response): Promise<T> => (await response.json()) as T;
// Made up for this test. Long enough that its last four characters are shown.
// Put together here, so that nothing shaped like a key is written in the repository.
const KEY = ["sk", "test", "0123456789abcdefghijWXYZ"].join("-");

interface Models {
  canSeal: boolean;
  source: string;
  problem: string | null;
  inEffect: { id: string; host: string; inputMicros: number; second: { id: string } | null } | null;
  env: { id: string } | null;
  services: { id: string; name: string; hasKey: boolean; keyTail: string; models: number }[];
  models: {
    id: string;
    model: string;
    role: string | null;
    testedOk: boolean | null;
    testedNote: string | null;
    cachedInputMicros: number | null;
  }[];
}

describe("the model chosen in the console", () => {
  let h: Harness;
  let owner: string;
  let mo: string;
  let auditor: string;
  /** What the stand-in model service is asked, and what it answers next. */
  const asked: { url: string; headers: Record<string, string>; body: string }[] = [];
  let answer: () => Response | Promise<Response> = () => new Response("{}", { status: 200 });
  const models = async (as = owner) => json<Models>(await h.api(as, "GET", "/api/models"));
  const service = (extra: Record<string, unknown> = {}) => ({
    name: "DeepSeek",
    api: "openai",
    baseUrl: "https://api.model.test/v1/",
    ...extra,
  });
  const choice = (serviceId: string, extra: Record<string, unknown> = {}) => ({
    serviceId,
    model: "console-model",
    inputMicros: 270_000,
    outputMicros: 1_100_000,
    ...extra,
  });
  let serviceId: string;
  let first: string;
  let second: string;

  beforeAll(async () => {
    h = await harness(
      {},
      {
        modelService: async (input, init) => {
          asked.push({
            url: String(input),
            headers: init?.headers as Record<string, string>,
            body: String(init?.body),
          });
          return answer();
        },
      },
    );
    owner = (await h.signIn("owner@acme.test")).cookie as string;
    await h.api(owner, "POST", "/api/invitations", { email: "mo@acme.test", role: "member" });
    mo = (await h.signIn("mo@acme.test")).cookie as string;
    await h.api(owner, "POST", "/api/invitations", { email: "au@acme.test", role: "auditor" });
    auditor = (await h.signIn("au@acme.test")).cookie as string;
  });

  it("starts as the server's settings have it", async () => {
    const m = await models();
    expect(m).toMatchObject({
      canSeal: true,
      source: "env",
      problem: null,
      inEffect: { id: "test-model", host: "model.invalid", inputMicros: 2_000_000 },
      env: { id: "test-model" },
      services: [],
      models: [],
    });
  });

  it("is an administrator's to change, an auditor's to read and nobody else's", async () => {
    expect((await h.api(mo, "GET", "/api/models")).status).toBe(403);
    expect((await h.api(auditor, "GET", "/api/models")).status).toBe(200);
    for (const who of [mo, auditor]) {
      expect((await h.api(who, "POST", "/api/models/services", service({ key: KEY }))).status).toBe(
        403,
      );
      expect(
        (await h.api(who, "PUT", "/api/models/roles", { first: null, second: null })).status,
      ).toBe(403);
    }
  });

  it("keeps a service's key sealed and never gives it back", async () => {
    // A key with a space or a line break in it is a paste gone wrong.
    for (const key of ["sk test with space", "short", `${KEY}\n`.replace("\n", '"')])
      expect(
        await json(await h.api(owner, "POST", "/api/models/services", service({ key }))),
      ).toMatchObject({ error: { code: "invalid_model_key" } });
    for (const baseUrl of ["ftp://x.test", "not a url", "https://user:pw@x.test"])
      expect(
        (await h.api(owner, "POST", "/api/models/services", service({ baseUrl, key: KEY }))).status,
      ).toBe(400);
    const made = await h.api(owner, "POST", "/api/models/services", service({ key: KEY }));
    expect(made.status).toBe(200);
    serviceId = (await json<{ id: string }>(made)).id;
    const page = await h.api(owner, "GET", "/api/models");
    const text = await page.text();
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(KEY.slice(0, 12));
    expect(JSON.parse(text).services).toMatchObject([
      { name: "DeepSeek", baseUrl: "https://api.model.test/v1", hasKey: true, keyTail: "WXYZ" },
    ]);
    // Not in the database as it was typed, and not on the record of who did what.
    const kept = await h.db.query<{ key_sealed: string }>("select key_sealed from model_services");
    expect(kept[0]?.key_sealed).toBeTruthy();
    expect(kept[0]?.key_sealed).not.toContain(KEY);
    const events = JSON.stringify(await h.db.query("select * from admin_events"));
    expect(events).toContain("model_service.created");
    expect(events).not.toContain(KEY);
    expect(events).not.toContain("WXYZ");
  });

  it("does not send a key entered for one address to another", async () => {
    const moved = service({ baseUrl: "https://elsewhere.test/v1" });
    expect(
      await json(await h.api(owner, "PATCH", `/api/models/services/${serviceId}`, moved)),
    ).toMatchObject({ error: { code: "model_key_again" } });
    // The name alone changes with the key left as it is.
    expect(
      (
        await h.api(
          owner,
          "PATCH",
          `/api/models/services/${serviceId}`,
          service({ name: "DeepSeek (company account)" }),
        )
      ).status,
    ).toBe(200);
    expect((await models()).services[0]).toMatchObject({
      name: "DeepSeek (company account)",
      hasKey: true,
      keyTail: "WXYZ",
    });
  });

  it("replaces the server's settings once a model is chosen, and gives way again", async () => {
    first = (
      await json<{ id: string }>(
        await h.api(
          owner,
          "POST",
          "/api/models/choices",
          choice(serviceId, { cachedInputMicros: 70_000, vision: true, contextWindow: 64_000 }),
        ),
      )
    ).id;
    second = (
      await json<{ id: string }>(
        await h.api(owner, "POST", "/api/models/choices", choice(serviceId, { model: "spare" })),
      )
    ).id;
    // Set up, and nothing has changed: the server's settings still hold.
    expect(h.config.model?.id).toBe("test-model");
    // The second needs a first, and is never the same model.
    for (const roles of [
      { first: null, second },
      { first, second: first },
    ])
      expect((await h.api(owner, "PUT", "/api/models/roles", roles)).status).toBe(400);
    expect((await h.api(owner, "PUT", "/api/models/roles", { first, second })).status).toBe(200);
    expect(h.config.model).toMatchObject({
      id: "console-model",
      api: "openai",
      baseUrl: "https://api.model.test/v1",
      apiKey: KEY,
      inputPrice: 0.27,
      outputPrice: 1.1,
      cachedInputPrice: 0.07,
      vision: true,
      contextWindow: 64_000,
      fallback: { id: "spare", apiKey: KEY },
    });
    expect(h.config.model?.cacheWritePrice).toBeUndefined();
    const m = await models();
    expect(m).toMatchObject({
      source: "console",
      problem: null,
      inEffect: { id: "console-model", host: "api.model.test", second: { id: "spare" } },
      env: { id: "test-model" },
    });
    expect(m.models.map((one) => [one.model, one.role])).toEqual([
      ["console-model", "first"],
      ["spare", "second"],
    ]);
    // A price changed in the console is the price the next run is counted at.
    await h.api(
      owner,
      "PATCH",
      `/api/models/choices/${first}`,
      choice(serviceId, { inputMicros: 500_000 }),
    );
    expect(h.config.model?.inputPrice).toBe(0.5);
    // What agents run on does not go missing: another is chosen first.
    expect(await json(await h.api(owner, "DELETE", `/api/models/choices/${first}`))).toMatchObject({
      error: { code: "model_in_use" },
    });
    expect(
      await json(await h.api(owner, "DELETE", `/api/models/services/${serviceId}`)),
    ).toMatchObject({ error: { code: "model_service_in_use" } });
    // A server started anew reads the same choice.
    const again = new ModelSettings(h.db, { ...h.config, model: h.modelSettings.env });
    await again.apply();
    expect(again.current()?.id).toBe("console-model");
    // Back to the server's settings.
    expect(
      (await h.api(owner, "PUT", "/api/models/roles", { first: null, second: null })).status,
    ).toBe(200);
    expect(h.config.model?.id).toBe("test-model");
    expect((await models()).source).toBe("env");
    const events = JSON.stringify(
      await h.db.query("select action, detail from admin_events where action like 'model%'"),
    );
    expect(events).toContain("model.chosen");
    expect(events).not.toContain(KEY);
  });

  it("does not run agents on a model whose key cannot be read, and says so", async () => {
    await h.api(owner, "PUT", "/api/models/roles", { first, second: null });
    // The server's key is another one now: what was sealed cannot be opened.
    const config = { ...h.config, model: h.modelSettings.env, secretKey: "another-key-".repeat(4) };
    const other = new ModelSettings(h.db, config);
    await other.apply();
    expect(config.model).toBeNull();
    expect(other).toMatchObject({ source: "console", problem: "key_unreadable" });
    // A service with no key at all cannot be chosen.
    const bare = (
      await json<{ id: string }>(
        await h.api(owner, "POST", "/api/models/services", service({ name: "No key yet" })),
      )
    ).id;
    const keyless = (
      await json<{ id: string }>(
        await h.api(owner, "POST", "/api/models/choices", choice(bare, { model: "keyless" })),
      )
    ).id;
    expect(
      await json(await h.api(owner, "PUT", "/api/models/roles", { first: keyless, second: null })),
    ).toMatchObject({ error: { code: "model_no_key" } });
    expect(h.config.model?.id).toBe("console-model");
    expect(
      await json(await h.api(owner, "POST", `/api/models/choices/${keyless}/test`)),
    ).toMatchObject({ ok: false, code: "no_key" });
    await h.api(owner, "PUT", "/api/models/roles", { first: null, second: null });
  });

  it("tests a model with its key and says what the service answered", async () => {
    asked.length = 0;
    answer = () => new Response('{"choices":[]}', { status: 200 });
    expect(
      await json(await h.api(owner, "POST", `/api/models/choices/${first}/test`)),
    ).toMatchObject({ ok: true, code: "ok", status: 200 });
    expect(asked[0]?.url).toBe("https://api.model.test/v1/chat/completions");
    expect(asked[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(asked[0]?.body ?? "{}")).toMatchObject({ model: "console-model" });
    expect((await models()).models.find((one) => one.id === first)).toMatchObject({
      testedOk: true,
      testedNote: "ok",
    });
    // A refused key: the reason is said, and a key the service repeats is not passed on.
    answer = () => new Response(`{"error":"Incorrect API key provided: ${KEY}"}`, { status: 401 });
    const refused = await h.api(owner, "POST", `/api/models/choices/${first}/test`);
    const said = await refused.text();
    expect(JSON.parse(said)).toMatchObject({ ok: false, code: "refused_key", status: 401 });
    expect(said).toContain("Incorrect API key");
    expect(said).not.toContain(KEY);
    for (const [status, code] of [
      [404, "not_found"],
      [429, "over_limit"],
      [500, "error"],
    ] as const) {
      answer = () => new Response("no", { status });
      expect(
        await json(await h.api(owner, "POST", `/api/models/choices/${first}/test`)),
      ).toMatchObject({ ok: false, code, status });
    }
    answer = () => Promise.reject(new Error("getaddrinfo ENOTFOUND"));
    expect(
      await json(await h.api(owner, "POST", `/api/models/choices/${first}/test`)),
    ).toMatchObject({ ok: false, code: "unreachable", status: null });
    expect((await models()).models.find((one) => one.id === first)).toMatchObject({
      testedOk: false,
      testedNote: "unreachable",
    });
    // A model renamed is another model: what the test said of the old one is gone.
    await h.api(
      owner,
      "PATCH",
      `/api/models/choices/${first}`,
      choice(serviceId, { model: "console-model-2" }),
    );
    expect((await models()).models.find((one) => one.id === first)?.testedOk).toBeNull();
    expect((await h.api(mo, "POST", `/api/models/choices/${first}/test`)).status).toBe(403);
    const events = JSON.stringify(await h.db.query("select * from admin_events"));
    expect(events).toContain("model.tested");
    expect(events).not.toContain(KEY);
  });

  it("removes what is no longer used, the key with it", async () => {
    for (const id of [first, second])
      expect((await h.api(owner, "DELETE", `/api/models/choices/${id}`)).status).toBe(200);
    expect((await h.api(owner, "DELETE", `/api/models/services/${serviceId}`)).status).toBe(200);
    const kept = await h.db.query<{ key_sealed: string | null }>(
      "select key_sealed from model_services where id = $1",
      [serviceId],
    );
    expect(kept[0]?.key_sealed).toBeNull();
    expect((await models()).services.map((one) => one.name)).toEqual(["No key yet"]);
  });
});
