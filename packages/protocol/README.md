# @muster/protocol

Identity and audit-event definitions shared by every Muster component. It has no
I/O: it defines shapes, creates IDs, and computes and checks hashes. It runs in
Node.js and in browsers (it uses the Web Crypto API).

## What it defines

- **IDs** (`ids.ts`). Every tenant, user, agent, run, step, tool call and event is
  identified by a UUIDv7, which sorts by creation time.
- **Agent fingerprint** (`agent.ts`). A SHA-256 over an agent's model,
  instructions, skills and tools. An audit event carries it, so the record says
  which version of the agent acted.
- **Audit event** (`events.ts`). Who acted, what was attempted, why it was or was
  not allowed, and the outcome. Arguments are stored as a digest, not as content.
- **Hash chain** (`chain.ts`). Each event's hash covers its content and the previous
  event's hash. `verifyChain` checks that a list of events is an unbroken
  continuation of the log and returns the checkpoint (position and hash) of the
  last one.

## What the hash chain does and does not prove

The hash is not keyed, so whoever can write the log can also recompute it. On its
own, `verifyChain` catches corruption and edits made without recomputing hashes. It
does **not** catch a writer who edits an event and re-seals everything after it,
appends forged events, or drops events from the end; all three produce a list that
verifies.

The guarantee comes from comparing the checkpoint `verifyChain` returns with one
kept where the log's writer cannot change it. If they match, every event up to
that checkpoint is exactly what was recorded. That trusted store (or a signature
over checkpoints) is not part of this package and does not exist yet.

## Digest format

`canonicalJson` follows RFC 8785 (JCS) for the values it accepts: keys sorted by
UTF-16 code unit, numbers in shortest round-trip form. A verifier in another
language must do the same. Event times are UTC with millisecond precision.

## Status

The event fields are a first proposal (`docs/architecture.md`, Q-1) and are not
locked. Nothing writes or stores events yet.
