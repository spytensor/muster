import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  base64Url,
  challengeFromBase64,
  codeFrom,
  serverUrlFrom,
  startUrl,
  verifierFrom,
} from "../src/lib/pkce.ts";

test("base64Url matches the platform's encoding for every length", () => {
  for (let length = 0; length < 70; length++) {
    const bytes = randomBytes(length);
    assert.equal(base64Url(bytes), bytes.toString("base64url"));
  }
});

test("the verifier is long enough for the server and uses only allowed characters", () => {
  const verifier = verifierFrom(randomBytes(32));
  assert.equal(verifier.length, 43);
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
  assert.throws(() => verifierFrom(randomBytes(16)));
});

test("the challenge is what the server computes from the verifier", () => {
  for (let i = 0; i < 50; i++) {
    const verifier = verifierFrom(randomBytes(32));
    // The device returns SHA-256 as ordinary base64; the server compares base64url.
    const deviceDigest = createHash("sha256").update(verifier).digest("base64");
    const serverSide = createHash("sha256").update(verifier).digest("base64url");
    const challenge = challengeFromBase64(deviceDigest);
    assert.equal(challenge, serverSide);
    assert.match(challenge, /^[A-Za-z0-9_-]{43,128}$/);
  }
});

test("the start address carries the challenge and the app's redirect", () => {
  const url = new URL(startUrl("http://localhost:7420", "abc-_"));
  assert.equal(url.pathname, "/auth/app/start");
  assert.equal(url.searchParams.get("challenge"), "abc-_");
  assert.equal(url.searchParams.get("redirect"), "muster://auth");
});

test("the code is read only from the app's own redirect", () => {
  assert.equal(codeFrom("muster://auth?code=abc_-123"), "abc_-123");
  assert.equal(codeFrom("muster://auth?x=1&code=a%2Fb#frag"), "a/b");
  assert.equal(codeFrom("muster://auth"), null);
  assert.equal(codeFrom("muster://auth?code="), null);
  assert.equal(codeFrom("muster://other?code=abc"), null);
  assert.equal(codeFrom("https://example.com/?code=abc"), null);
});

test("a server address is tidied, and anything else is refused", () => {
  assert.equal(serverUrlFrom(" https://muster.example.com/ "), "https://muster.example.com");
  assert.equal(serverUrlFrom("http://localhost:7420"), "http://localhost:7420");
  assert.equal(serverUrlFrom("http://192.168.1.5:7420//"), "http://192.168.1.5:7420");
  assert.equal(serverUrlFrom("muster.example.com"), null);
  assert.equal(serverUrlFrom("https://user:pw@example.com"), null);
  assert.equal(serverUrlFrom("https://example.com/path"), null);
  assert.equal(serverUrlFrom("javascript:alert(1)"), null);
});
