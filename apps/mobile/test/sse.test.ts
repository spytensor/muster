import assert from "node:assert/strict";
import { test } from "node:test";
import { createEventParser } from "../src/lib/sse.ts";

test("reads named events with their data", () => {
  const parse = createEventParser();
  assert.deepEqual(parse('event: text\ndata: {"delta":"hi"}\n\n'), [
    { event: "text", data: '{"delta":"hi"}' },
  ]);
});

test("an event split across pieces arrives once, when complete", () => {
  const parse = createEventParser();
  assert.deepEqual(parse("event: te"), []);
  assert.deepEqual(parse('xt\ndata: {"del'), []);
  assert.deepEqual(parse('ta":"a"}\n'), []);
  assert.deepEqual(parse("\nevent: ping\ndata: {}\n\n"), [
    { event: "text", data: '{"delta":"a"}' },
    { event: "ping", data: "{}" },
  ]);
});

test("handles CRLF line ends, even when split between the two characters", () => {
  const parse = createEventParser();
  assert.deepEqual(parse("event: done\r"), []);
  assert.deepEqual(parse("\ndata: 1\r\n\r"), []);
  assert.deepEqual(parse("\n"), [{ event: "done", data: "1" }]);
});

test("joins several data lines, skips comments and unknown fields", () => {
  const parse = createEventParser();
  assert.deepEqual(parse(": keep-alive\nid: 7\nretry: 100\ndata: a\ndata:b\n\n"), [
    { event: "message", data: "a\nb" },
  ]);
});

test("an event without data is not delivered, and does not leak its name", () => {
  const parse = createEventParser();
  assert.deepEqual(parse("event: step\n\ndata: x\n\n"), [{ event: "message", data: "x" }]);
});

test("every way of cutting a stream gives the same events", () => {
  const stream =
    'event: state\ndata: {"running":true}\n\nevent: text\ndata: {"delta":"你好"}\n\nevent: done\ndata: {}\n\n';
  const whole = createEventParser()(stream);
  assert.equal(whole.length, 3);
  for (let cut = 1; cut < stream.length; cut++) {
    const parse = createEventParser();
    assert.deepEqual([...parse(stream.slice(0, cut)), ...parse(stream.slice(cut))], whole);
  }
});
