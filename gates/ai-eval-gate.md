# AI Eval Gate

Use this profile gate when the product includes LLM, agent, retrieval, ranking, or
prompt-mediated behavior. "I tried it and it looked good" is not a release gate.

## Required record

```text
# AI Eval: <change>

Model(s):
Prompt / policy version:
Tool permissions:
Eval set:
Regression baseline:
Safety / refusal cases:
Latency:
Cost:
Human review sample:
Rollout and rollback:
Verdict: pass | fail
```

## Rules

- Prompts, model choices, retrieval settings, and tool permissions are versioned
  artifacts.
- New or changed behavior needs a golden set or representative eval set with
  expected outcomes.
- Cost and latency are product requirements, not afterthoughts.
- Safety cases include hallucination, prompt injection, unsafe tool use, and
  sensitive data handling where relevant.
