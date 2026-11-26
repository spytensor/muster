import assert from "node:assert/strict";
import { test } from "node:test";
import { factsOf, groupsOf, hostOf, itemsOf, opens, standingOf } from "../src/lib/lives.ts";

const sent = [
  { id: "1", n: 1, kind: "environment", title: "Production", state: { version: "v2.14" } },
  { id: "2", n: 2, kind: "repo", title: "acme/web", ref: "acme/web", state: {} },
  { id: "3", n: 3, kind: "repo", title: "acme/jobs", ref: "acme/jobs", state: { branch: "main" } },
  {
    id: "4",
    n: 0,
    kind: "guide",
    title: "deploy.md",
    file: { id: "f", name: "deploy.md", kind: "document", size: 10 },
  },
  // What a newer server may send that this app does not draw, and what is not a thing at all.
  { id: "5", n: 5, kind: "board", title: "Kanban" },
  { id: 6, kind: "link", title: "No id" },
  null,
  "words",
];

test("what lives in a project is read from whatever was sent, by the kinds this app draws", () => {
  const items = itemsOf(sent);
  assert.deepEqual(
    items.map((item) => item.id),
    ["1", "2", "3", "4"],
  );
  assert.equal(items[0]?.state.version, "v2.14");
  assert.equal(items[0]?.detail, "");
  assert.equal(items[0]?.url, null);
  assert.deepEqual(items[3]?.file, { id: "f", name: "deploy.md", kind: "document", size: 10 });
  assert.deepEqual(itemsOf(undefined), []);
  assert.deepEqual(itemsOf({ items: [] }), []);
});

test("a kind is shown only when the project has some of it, in the page's order", () => {
  const groups = groupsOf(itemsOf(sent));
  assert.deepEqual(
    groups.map((group) => [group.kind, group.items.length]),
    [
      ["repo", 2],
      ["guide", 1],
      ["environment", 1],
    ],
  );
  assert.deepEqual(groupsOf([]), []);
});

test("the top of the page counts what the repositories say, and nothing where nothing is known", () => {
  const items = itemsOf(sent);
  const facts = factsOf({
    facts: {
      "acme/web": { branch: "main", pulls: 2, checks: "failing" },
      "acme/jobs": { branch: "main", pulls: null, checks: "passing" },
      "acme/other": { pulls: 9 },
    },
  });
  assert.deepEqual(Object.keys(facts), ["acme/web", "acme/jobs"]);
  assert.deepEqual(standingOf(items, facts), { repos: 2, failing: 1, pulls: 2 });
  assert.deepEqual(standingOf(items, {}), { repos: 2, failing: 0, pulls: 0 });
  assert.deepEqual(factsOf(null), {});
  assert.deepEqual(factsOf({ facts: "none" }), {});
});

test("an address is named by where it leads, and only one of the web is opened", () => {
  assert.equal(hostOf("https://www.grafana.acme.test/d/1"), "grafana.acme.test");
  assert.equal(hostOf("https://someone@pay.acme.test:8443/x"), "pay.acme.test:8443");
  assert.equal(hostOf("not an address"), "");
  assert.equal(hostOf(null), "");
  assert.equal(opens("https://pay.acme.test/"), true);
  assert.equal(opens("http://intranet/wiki"), true);
  assert.equal(opens("tel:+15551234"), false);
  assert.equal(opens("javascript:alert(1)"), false);
  assert.equal(opens("https://a b"), false);
  assert.equal(opens(null), false);
});
