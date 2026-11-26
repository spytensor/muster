# Architecture Boundary Gate

Use this profile gate when a change crosses module, service, package, or public API
boundaries. It keeps AI-generated work from eroding long-term maintainability.

## Required record

```text
# Architecture Boundary: <change>

Code-map entries touched:
Existing canonical utilities reused:
Public contracts changed:
Dependency direction:
Data ownership touched:
New abstraction added:
Boundary exceptions:
Reviewer / owner:
Verdict: pass | fail
```

## Review dimensions

- The implementation follows `docs/code-map.md` and any installed
  `docs/ownership-map.md`.
- New dependencies point in the allowed direction; no lower layer imports a higher
  layer to "just get it working".
- Public API or schema changes have compatibility notes and consumers identified.
- New abstractions remove real complexity or match an established local pattern.
- Boundary exceptions are explicit and approved by the owner of the boundary.
