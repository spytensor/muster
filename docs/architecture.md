# Muster — Architecture (Constitution)

This document holds **locked decisions** (Standard P5). Code that contradicts a
locked decision must follow an amendment in
[`proposed-amendments.md`](proposed-amendments.md) that lands first, in its own PR.

Keep this searchable: one decision per entry, each with an ID and rationale.

## Status

Constitution version: v1. Last reviewed: 2026-11-14.

Every locked decision below restates what the owner said on 2026-11-14, including
the corrections the owner made the same day after reading the first draft. How each
decision is carried out is designed in [`design/`](design/); those designs are
proposals until a decision here says otherwise.

## System overview

Muster (点兵) is an enterprise agent workspace, in the same space as
Tencent WorkBuddy. Staff use agents for everyday office work from desktop, mobile
and web clients, and the interface is built around generated UI (OpenUI) so that
people who are not technical can use it. Agents run in a runtime derived from
OpenClaw. Every tool call, network request and file access passes one gateway that
checks policy and writes an audit record. A control plane keeps the registry of
agents, extensions, models, permissions, usage and the audit log, and an admin
console operates it.

```text
desktop / mobile / web clients (OpenUI)
            |
        control plane  ---- admin console
 (agents, extensions, models, permissions,
  policy, approvals, usage and billing, audit)
            |
   runtime -> tool gateway -> sandbox, connectors, models
 (cloud workspace, or the user's own device)
```

The diagram is what the decisions below call for, not a description of the code.
What exists as code is in [`code-map.md`](code-map.md); where it falls short of
these decisions is listed in
[`features/README.md`](features/README.md#what-the-locked-decisions-promise-and-the-code-does-not-do).

## Decision index

| ID | Title | Status | Superseded by |
|---|---|---|---|
| D-1 | Muster is an independent product: an agent workspace for the enterprise, with OpenUI at the core of interaction | active | — |
| D-2 | The runtime is derived from OpenClaw, slimmed, and extensions are gated | active | — |
| D-3 | Security comes first and must not cost performance | active | — |
| D-4 | A control plane governs agents and everything an operator manages | active | — |
| D-5 | Every agent has a UUID, a risk level and a complete record | active | — |
| D-6 | Desktop, mobile and web share one backend; local content does not all go to the cloud | active | — |
| D-7 | The maintainers plan in Plane; reports from outside arrive as GitHub Issues | active (amended 2026-11-23, 2026-11-26) | — |

## Locked decisions

### D-1: Muster is an independent product: an agent workspace for the enterprise, with OpenUI at the core of interaction

- **Status:** active
- **Decision:** Muster is built in its own repository and shares no code or
  deployment with the owner's earlier projects. Its position is an agent
  workspace for the enterprise; Tencent WorkBuddy is the product it is measured against. It must lower
  the barrier for the great majority of staff and go deep into office work. OpenUI
  is the core of how people interact with it.
- **Rationale:** The owner's positioning.
- **Implications:** The first user is an employee at a company, not a developer and
  not the general public. A capability that needs technical setup by the end user
  does not meet the bar. Interfaces are generated through OpenUI where OpenUI can
  express them.
- **Locked:** 2026-11-14
- **Superseded by:** —

### D-2: The runtime is derived from OpenClaw, slimmed, and extensions are gated

- **Status:** active
- **Decision:** The agent runtime is not written from scratch. It is derived from
  OpenClaw: slimmed, taken apart and reused. OpenClaw is not adopted whole, because
  it is made for one person's own machine and a company needs less of it and tighter
  defaults. Extensions are gated in two ways:
  - A **plugin** is available to users only after an administrator or operator has
    approved it.
  - A **skill a user installs** must first pass a mandatory security scan, and is
    subject to allowlists and blocklists.
- **Rationale:** The owner judged a from-scratch runtime too hard: too much to
  rebuild and too many edge cases. Reviewing third-party components is not enough;
  what reaches users must be approved or scanned.
- **Implications:** What is kept from OpenClaw is chosen piece by piece and its
  permissions are reviewed; nothing arrives by default. The upstream version each
  piece came from is recorded. No extension path bypasses approval or scanning.
- **Locked:** 2026-11-14
- **Superseded by:** —

### D-3: Security comes first and must not cost performance

- **Status:** active
- **Decision:** Security is the core requirement for enterprise use, and security
  mechanisms must not degrade the product's performance.
- **Rationale:** The owner's words: for enterprises the core is security, and it
  must not affect performance.
- **Implications:** A security mechanism that adds user-visible latency to ordinary
  agent actions needs a measured justification. The owner delegated the design of
  the mechanism; the proposal is in `design/security-and-governance.md`.
- **Locked:** 2026-11-14
- **Superseded by:** —

### D-4: A control plane governs agents and everything an operator manages

- **Status:** active
- **Decision:** Muster has its own control plane and admin console. It provides what
  Microsoft Agent 365 provides for agents (review and tracing), and it is also where
  all back-office information is managed, including model management, billing,
  what each user consumes, permission assignment and agent management.
- **Rationale:** The owner requires an independent, strictly designed governance
  layer and listed these areas as examples of its scope ("and many more").
- **Implications:** Governance is designed before the features it governs. An agent
  capability that cannot be audited is not shippable. Usage is metered per user and
  per agent from the start, because billing and budgets depend on it.
- **Locked:** 2026-11-14
- **Superseded by:** —

### D-5: Every agent has a UUID, a risk level and a complete record

- **Status:** active
- **Decision:** Each agent carries a UUID, and records of what it did are complete
  and attributable to that UUID. This covers agents that users build themselves and
  agents the platform provides. The record includes how users use each agent, and
  every agent has a risk level.
- **Rationale:** The owner requires a complete agent UUID record and named these
  as part of it.
- **Implications:** Identity and the audit record format are shared definitions
  every component uses (`packages/protocol`). An agent cannot run without being
  registered and assigned a risk level.
- **Locked:** 2026-11-14
- **Superseded by:** —

### D-6: Desktop, mobile and web share one backend; local content does not all go to the cloud

- **Status:** active
- **Decision:** Muster ships desktop and mobile clients alongside web, and they are
  all connected: the same account, agents and history on every device. On the
  local (desktop) side, content does not all go to the cloud; what stays on the
  device and what is synced is a deliberate, designed distinction.
- **Rationale:** The owner wants every client connected, and noted that the local
  side raises the same question Codex and Claude Code face.
- **Implications:** A feature is not complete if it works on only one client without
  a stated reason. Uploading local content is never a side effect. The two halves
  of this decision pull against each other: content kept on one device is not
  history on every device. Where that line falls is not settled; the proposal and
  the conflict are in `design/security-and-governance.md`, section 4.
- **Locked:** 2026-11-14
- **Superseded by:** —

### D-7: The maintainers plan in Plane; reports from outside arrive as GitHub Issues

- **Status:** active
- **Decision:** The maintainers' planned work is ticketed only in Plane, on an instance the
  owner runs (items `MUS-N`). The repository follows the owner's coding standard, whose
  installed parts are `AGENTS.md`, `gates/` and `automation/`, with GitHub holding code,
  pull requests, CI and evidence.
- **Rationale:** The owner's instruction when the repository was created, restated
  on 2026-11-14: everything goes by one tracker, then Linear.
- **Amended 2026-11-23:** the tracker is Plane. Linear's free workspace refused new
  issues from 2026-11-22, and the owner asked for one of our own.
  Tickets `CHA-N` remain in Linear as history; nothing new is filed there.
- **Amended 2026-11-26:** the repository is being made public. People outside the
  maintainers cannot reach Plane, so bugs, requests and questions from outside arrive
  as GitHub Issues and pull requests (`CONTRIBUTING.md`); a maintainer who takes one up
  files the Plane item. `MUS-N` and `CHA-N` in commits and documents are the
  maintainers' ticket numbers.
- **Implications:** Where the standard says "issue" or "tracker", it means a Plane
  work item. The owner's working rules (one pull request per EPIC, the agent merges)
  are in `AGENTS.md` under "Project rules set by the owner".
- **Locked:** 2026-11-14
- **Superseded by:** —

## Open questions

These are proposals and unknowns. None is locked. Design proposals for Q-1 to Q-5
are in [`design/security-and-governance.md`](design/security-and-governance.md).

- Q-1: Audit record format and how the log is made tamper-evident. A first version
  is in `packages/protocol`; trusted checkpoints are CHA-161 — owner: @spytensor
- Q-2: Policy model and where it is evaluated; engine (Cedar, OPA, or custom)
  undecided. CHA-156 — owner: @spytensor
- Q-3: Which parts of OpenClaw are kept, and how the vendored code follows upstream.
  CHA-157 — owner: @spytensor
- Q-4: Sandbox for cloud workspaces and for the user's device; the Windows story
  is unknown. CHA-158 — owner: @spytensor
- Q-5: What exactly stays on the device and what is synced. CHA-159 —
  owner: @spytensor
- Q-6: Desktop shell (Electron or Tauri) and mobile stack. CHA-159 —
  owner: @spytensor
- Q-7: Admin console design. The owner asked that it borrow the style of an
  operations console the owner already runs; brand colour and mark are undecided. CHA-155 —
  owner: @spytensor
- Q-8: Whether the name "Muster / 点兵" is clear for trademark and domains.
  CHA-160 — owner: @spytensor
