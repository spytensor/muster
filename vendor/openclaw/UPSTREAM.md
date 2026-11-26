# OpenClaw code vendored into Muster

Muster's agent runtime is derived from OpenClaw (`docs/architecture.md`, D-2): the
agent loop is OpenClaw's, taken piece by piece, and everything around it is
Muster's own. This file is the record of what was taken and what was changed.

- Upstream: https://github.com/openclaw/openclaw
- Version: tag `v2026.9.8`, commit `fc23bc864e4553c2d215e479eeec47b67a0bf943`
- License: MIT, Copyright (c) 2026 OpenClaw Foundation (`LICENSE`). Portions of
  OpenClaw are adapted from pi-mono, MIT, Copyright (c) 2025 Mario Zechner
  (`THIRD_PARTY_NOTICES.md`). Both notices must stay with this code.

## What is here

| Directory | Upstream path | Taken |
|---|---|---|
| `agent-core/src` | `packages/agent-core/src` | Everything except the files listed below |
| `llm-core/src` | `packages/llm-core/src` | Everything except test files |
| `normalization-core/src` | `packages/normalization-core/src` | Only the seven modules the other two import |

The three directories are workspace packages with their upstream names
(`@openclaw/agent-core`, `@openclaw/llm-core`, `@openclaw/normalization-core`), so
the upstream import statements are unchanged. The `package.json` and
`tsconfig.json` in each are Muster's: upstream builds with its own bundler, here
they build with `tsc`.

## What was left out

- `packages/ai` (about 34,000 lines, with the Anthropic, OpenAI, Google and Mistral
  SDKs): OpenClaw's model transports. Muster calls models through its own two
  transports in `apps/server/src/runtime/models.ts`, passed to the loop as its
  `streamFn`. Nothing in the loop depends on which transport is used.
- `agent-core/src/llm.ts`: re-exported all of `packages/ai`.
- Every `*.test.ts` and `*.test-support.ts` file. Upstream's tests depend on
  upstream's test helpers and are not run here. Muster tests the loop through its
  own runtime tests.
- From `normalization-core`: 24 modules nothing here imports (phone numbers, agent
  IDs, home directories and others), and with them the `libphonenumber-js`
  dependency.

## What was changed

Five edits, all to imports. No behaviour was changed.

1. `agent-core/src/agent-stream-response.ts`: three helpers imported from
   `@openclaw/ai/diagnostics` and `@openclaw/ai/transports` now come from
   `./muster-transport-shims.js`.
2. `agent-core/src/harness/session/session.ts`: `stripCompactionReplayCheckpoint`
   likewise.
3. `agent-core/src/validation.ts`: re-exports from `@openclaw/llm-core/validation`
   instead of `@openclaw/ai/validation` (which itself re-exported llm-core's).
4. `normalization-core/src/number-coercion.ts`: `./string-coerce.ts` became
   `./string-coerce.js`, so `tsc` can emit it.
5. Added `agent-core/src/muster-transport-shims.ts`: the four helpers from point 1
   and 2, copied unchanged from `packages/ai`, with their origin noted in the file.

## Things to know before relying on it

- The loop runs every tool call the model makes unless `beforeToolCall` blocks it.
  It has no permissions of its own. Muster's gateway is that hook.
- After a run is aborted, the loop adds a hidden message that tells the model, on
  the next turn, that the previous turn was interrupted.
- `agent-core/src/harness/env/kill-tree.ts` can spawn `ps` and `taskkill`. It is
  exported by upstream's index and never called by Muster.
- Formatting and lint are not applied to this directory (`biome.json`), so files
  stay comparable with upstream.

## Updating

Take the same paths from the new upstream tag, re-apply the five edits above, run
`pnpm check`, and update the version and commit in this file. If upstream has added
an import from `packages/ai`, decide for each one whether to copy the helper or to
bring in more of upstream, and record it here.
