# Sign-off Gate

Map final evidence back to every `SO-N` row from the plan. No row may be left
unmapped. "pass" requires reproducible evidence, not assertion (Standard P2).

Required structure:

```text
# Sign-off: <feature>

| ID | Evidence | Result |
| --- | --- | --- |
| SO-1 | <CI run url / command output / path:line citation / recorded manual check> | pass|fail |
| RG-1 | <existing/affected suite result on the merge commit; CI run url> | pass|fail |
```

Rules:

- Every `SO-N` and `RG-N` from the plan appears here exactly once.
- Evidence prefers a **CI run reference** (authoritative, P10); pasted output is a
  convenience copy. Never "looks correct".
- Regression rows (`RG-N`) must pass on the **merge commit**, not an old base, and a
  green reached only by re-running flakes is disclosed, not hidden.
- Any `fail` blocks completion. Report `implementation complete, tracker incomplete`
  rather than `done` if evidence is missing.
