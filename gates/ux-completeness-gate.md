# UX Completeness Gate

Use this profile gate when the user experience is part of the deliverable. It keeps
AI-generated UI from stopping at a polished happy-path demo.

## Required record

```text
# UX Completeness: <change>

Screens / flows touched:
States covered:
  loading:
  empty:
  error:
  success:
Responsive viewports checked:
Keyboard path:
Accessibility checks:
Visual evidence:
Copy reviewed by:
Verdict: pass | fail
```

## Rules

- Every interactive flow needs loading, empty, error, and success behavior unless a
  state is impossible and the PR explains why.
- Visual evidence must name the build and viewport. Screenshots without a path to
  reproduce are weak evidence.
- Keyboard navigation and accessible names matter for tools as much as marketing
  pages.
