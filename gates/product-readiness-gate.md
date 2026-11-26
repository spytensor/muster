# Product Readiness Gate

Use this profile gate when the change creates or materially changes a user-facing
workflow. It prevents agents from turning vague intent into a technically complete
but wrong product.

## Required record

```text
# Product Readiness: <change>

Target user:
Primary job-to-be-done:
Core path:
  1. <entry point>
  2. <main action>
  3. <successful outcome>
Anti-goals / out of scope:
Non-functional requirements:
  - reliability:
  - performance:
  - privacy/security:
  - accessibility:
Success metric:
Owner who ratified this product intent:
```

## Rules

- A Tier 1 plan must cite this gate when the implementation changes a core path.
- Acceptance criteria must be observable from the user's point of view, not only
  from internal implementation details.
- If the product intent is ambiguous, stop and ask `@host`; do not let an agent
  invent product policy.
