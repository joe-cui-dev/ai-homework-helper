# ADR 0004 — Unified Session model with Bedrock sidecar

**Status:** Accepted
**Date:** 2026-05-16
**Supersedes:** [ADR 0001](./0001-batch-session-model.md), [ADR 0002](./0002-reading-session-model.md), [ADR 0003](./0003-writing-session-model.md)

## Context

Three earlier ADRs each layered a new shape on top of the original homework-only `SessionRecord`: 0001 collapsed per-question files into a per-batch file; 0002 added a `sessionType` discriminator and reading-specific optional fields; 0003 introduced mutable polymorphism, an `_internal` namespace for Bedrock state, and per-turn image-key prefixes. Practice was bolted on alongside under a *different* key prefix (`sessions/{studentId}/{batchId}/practice-{questionId}.json`) with its own type, inlining Bedrock messages without stripping.

The result was a single `SessionRecord` with ~15 optional fields, a non-narrowing discriminator, a parallel `WritingSessionRecord`/`PracticeSession` pair living outside it, two storage layouts, and the overloaded word "Batch" coexisting with "Session" in the glossary. Reading the session model required holding all four module histories in your head.

## Decision

A single discriminated `Session` union for four peer kinds — **Homework, Reading, Writing, Practice** — with a tiny shared core (`sessionId, studentId, timestamp, updatedAt, usage`). Each kind has its own data variant; `sessionType` is a real TypeScript discriminator that narrows reads. Status / `endedReason` are per-variant (only Writing and Practice carry them); Homework and Reading are conceptually always complete.

Raw Bedrock state (`messages[]`, per-turn raw usage) moves out of the session JSON into a sidecar S3 object at `sessions/{studentId}/{sessionId}.agent.json`, written only for Writing and Practice. The user-facing session JSON has no `_internal` namespace and no per-kind stripping logic at read time.

S3 key layout is flattened: every session kind uses `sessions/{studentId}/{sessionId}.json` (sidecar at `.agent.json`, images at `sessions/{studentId}/{sessionId}/image-*.{ext}`). Practice is no longer nested under a Homework key — it has its own UUID `sessionId` and records its source via an `origin: { sessionId, questionId }` field. The word "batchId" is dropped from the codebase; `sessionId` is the only identifier name.

The history endpoint returns a separate `SessionSummary` discriminated union purpose-built for the sidebar card, not the full session.

## Considered alternatives

- **Keep `SessionRecord` as one flat optional-field interface, sharpen names only.** Cheaper change. Rejected: every reader keeps writing `if (s.questions)`/`if (s.readingPackets)` branches and TS gives no narrowing. The pain reported by the user is exactly this shape.
- **Four fully independent types, no shared core.** Maximally simple per module. Rejected: the history sidebar genuinely needs a uniform projection, and a tiny core (5 fields all four kinds genuinely have) costs nothing while making the read paths obvious.
- **`_internal` namespace, applied uniformly to all kinds.** One file per session, one stripping rule. Rejected: the session JSON stays fat (full tool-call transcripts on every history fetch unless we also project) and the convention is enforced only by discipline. A sidecar makes the boundary structural.
- **Two-level union (one-shot vs multi-turn) with a shared `LiveSession` base for Writing+Practice.** Groups the mutable kinds. Rejected: `endedReason` enums are kind-specific and forcing a shared status base tempts a single union of reasons that loses the locality.

## Consequences

- **Migration is a hard cutover.** Old Practice files (nested under Homework keys) and pre-batch homework rows (flat top-level fields) stop appearing in history. The 30-day S3 lifecycle ages them out. The app is early/MVP; we accept the loss rather than carry dual-read logic forever.
- **Two-object write for Writing and Practice turns is not atomic.** We write the session JSON first, then the agent sidecar. If the sidecar write fails for an `"active"` session, the next turn must either re-derive Bedrock state from the user-facing transcript or surface an error — never silently corrupt.
- **The history payload is a different type from the stored session.** This is intentional. Future card features pressure `SessionSummary`, not `Session`.
- **`SessionRecord`, `WritingSessionRecord`, `PracticeSession`, and the `_internal` namespace all go away.** Any future module adds itself as a new variant of `Session`, not as a parallel type.
