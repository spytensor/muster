# Real-Use Gate

The most important gate, and the one most often skipped. Green CI plus passing
fixtures is **necessary but not sufficient** (Standard P3). An EPIC closes only
after a real-use gate proves the actual product path works for a real user.

This gate exists because of a recurring failure: a milestone is closed with a
beautiful, uniform Evidence Ledger — every row says CI passed — and then it turns
out no one ever exercised the real product. Uniform self-reported evidence lulls
you into trusting it. Break that with a check CI cannot fake.

**Independence is required (Standard P10).** The gate must be executed by CI or by a
party that is **not** the implementer — a self-produced, re-blessable transcript is
not enough. The repeatable command runs in CI (or an independent agent/human re-runs
it) for the EPIC-closing PR, and that run is the verdict source.

## What qualifies

At least one of:

- **Dogfood run** — a scripted exercise of the real built artifact against a fresh,
  realistic environment (not a unit fixture). Prefer a committed, repeatable script
  so the gate can be re-run.
- **Manual smoke** — a recorded walkthrough of the real product path with observed
  output (screenshots/snapshots/transcript), naming the build and the steps.
- **End-to-end test** — exercising the full path through real components, not mocks.

## What does NOT qualify

- A renderer/unit test that only proves internal pieces line up.
- "CI is green."
- A prose claim that it was tried.
- Anything satisfiable entirely by fixtures or mocks.

## Required record

```text
# Real-Use Gate: <EPIC>

Artifact exercised: <real binary/app/build, version/sha>
Environment: <fresh/realistic context the agent could not read the answer from>
Steps run: <ordered, reproducible — ideally a committed script path>
Observed result: <what actually happened; attach snapshot/transcript>
Repeatable command: <how to re-run this gate>
executed_by: <CI run url, or party != implementer>
Verdict: pass|fail
```

A `fail` reopens the EPIC. Do not close on CI evidence alone.
