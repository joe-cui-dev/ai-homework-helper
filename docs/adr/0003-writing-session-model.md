# ADR 0003 — Writing Session model

**Status:** Accepted
**Date:** 2026-05-09
**Supersedes:** none. Sibling of [ADR 0001](./0001-batch-session-model.md) (batch model) and [ADR 0002](./0002-reading-session-model.md) (reading polymorphism).

## Context

The English Writing Coaching module helps the parent coach the child through a writing assignment in two stages: pre-write (a coaching plan derived from the assignment prompt) and post-write (feedback on each draft, with optional clarifying-question turns in between). Pedagogically, post-write feedback must reference both the original prompt and the AI's earlier guidance — a stateless single-shot like Homework or Reading would lose that context.

Practice already establishes a multi-turn pattern (`PracticeSession`), but it's anchored to a parent Homework Session's question and lives in a separate file (`practice-{questionId}.json`). Writing has no parent — the whole batch *is* the writing session — so the Practice file split doesn't apply.

## Decisions

### 1. Writing is a third polymorphic variant of Session

Adds `sessionType: "writing"` to the existing `Session` polymorphism documented in [CONTEXT.md](../../CONTEXT.md) and [ADR 0002](./0002-reading-session-model.md). The S3 key remains `sessions/{studentId}/{batchId}.json` — the same shape as Homework and Reading. The history Lambda's listing logic gains a writing branch; the public `SessionRecord` type gains optional Writing fields (`status`, `endedReason`, `updatedAt`, `prompt`, `plan`, `turns`, `draftCount`, `questionCount`).

### 2. Mutable polymorphism — same object, mutated across HTTP requests

**Writing is the first session type whose S3 object is mutated after creation.** Each turn reads the record, appends to `turns[]`, increments counters, and writes back. There is no two-phase commit; the write is atomic at the S3 object level and the UI prevents concurrent turns for the same session.

Trade-off considered and rejected: a separate `writing-state.json` file holding turn state (mirroring Practice's split). Rejected because:

- Writing has no parent SessionRecord to anchor on — Practice's split is justified by being "layered on" an existing Homework Session.
- One file means one atomic write per turn. Two files would require either tolerating brief inconsistency or implementing two-phase commit.
- The history reader, `getRecentSessions`, and `SessionDetailModal` are designed around one-file-per-session. Adding a second file means new read paths in three places.

### 3. The `_internal` namespace convention

The Writing SessionRecord JSON has a top-level `_internal` field that holds the Bedrock conversation `messages[]` and per-turn raw token usage. Public projections — `getRecentSessions`, `listSessions`, the History Lambda's `SessionSummary` projection — **must skip `_internal`**. The convention is enforced by:

- The `SessionRecord` TypeScript type does not declare `_internal`. Readers that adhere to the type cannot accidentally surface it.
- `projectSessionRecord` in `backend/src/shared/storage.ts` projects only the SessionRecord fields, never the raw JSON.
- The History Lambda's `SessionSummary` interface mirrors SessionRecord's writing-only fields and does not include `_internal`.

This mirrors Practice's separation in spirit (Bedrock state stays internal, public summaries don't carry it) but co-locates the state with the public record so we keep the one-file model. The cost is a single namespace convention developers need to know about; in return we get atomic writes and simpler readers.

### 4. Image-key naming with turn-role prefix

Existing Homework and Reading sessions use `sessions/{studentId}/{batchId}/image-{i}.{ext}`. Writing extends this with a turn-role prefix:

- `sessions/{studentId}/{batchId}/prompt-image-{i}.{ext}` — assignment images uploaded at turn 1.
- `sessions/{studentId}/{batchId}/draft-{turnIndex}-image-{i}.{ext}` — student-draft images uploaded at draft turn N.

Trade-off considered and rejected: per-turn subdirectories (`turn-2/image-0.jpeg`). Rejected to keep consistency with the existing flat-per-batch convention; the prefix already disambiguates role and turn.

`uploadSessionImages` accepts an optional `prefix` parameter (default `"image"` for back-compat with Homework and Reading). The Writing handler passes `"prompt-image"` at turn 1 and `"draft-{turnIndex}-image"` at each draft turn.

### 5. Caps enforced server-side, not just UI

- Maximum 5 draft turns per session. Reaching the cap auto-flips the session to `status: "ended", endedReason: "max_drafts"`.
- Maximum 3 question turns per session. Reaching the cap rejects further question turns with a `limit_reached` event but does not end the session — drafts are the main workflow.
- 24-hour stale auto-abandon (`WRITING_SESSION_MAX_AGE_HOURS`). Lazy on read: when a session is loaded, if `status === "active"` and `updatedAt > 24 h` ago, the loader flips to `ended`/`abandoned` and persists before returning.

The UI mirrors these caps for affordance disabling but is not the source of truth. The handler always validates against the server-side counters.

### 6. Per-turn = single forced-tool Converse call

Each turn calls Bedrock once with `toolChoice: { tool: { name: "submit_..." } }` forcing the appropriate output schema. There is no per-turn iteration loop (unlike Practice's verdict-driven dispatch). The "agentic" character of the Writing module lives at the **session** level (turn 1 → turn 2 → … across HTTP requests), not inside each turn.

This was a deliberate design call (Q2 in the planning interview). Branching dispatch only adds value when one tool's output decides the next tool — Writing's `nextStep` is a single discriminator, not a loop, so it stays in one packet.

## Consequences

### Positive

- **Predictable cost.** Each Bedrock call is bounded; no runaway iteration. A worst-case session (1 plan + 5 drafts + 3 questions, all with images) sits around ~$0.05 at Haiku 4.5 prices.
- **Resumable across visits.** A parent can submit the prompt, the child writes for an hour, and the parent comes back to submit the draft — the SessionRecord IS the resume state. The history Lambda surfaces it as an "In progress" card pinned to the top of the sidebar.
- **No new infra primitives.** Reuses the existing S3 bucket, Cognito JWT validation, Bedrock Guardrails config, NDJSON streaming, and history-listing pipeline.
- **One file per session keeps history reads simple.** No fan-out, no two-file consistency.

### Negative / accepted costs

- **Mutable polymorphism is a precedent.** Future session types might be tempted to follow the Writing pattern when a stateless model would suffice. The CONTEXT.md `Session` entry and this ADR must be the source of truth on when a session is allowed to mutate.
- **`_internal` is a convention, not a type-system guarantee.** A future reader could in principle access raw JSON and accidentally echo `_internal`. The convention is documented here and reinforced by `projectSessionRecord` being the only project-side reader path.
- **The History Lambda's `SessionSummary` carries Writing-specific optional fields**, even when the session is Homework/Reading. The cost is a few extra `undefined`s on the wire.

## Out of scope for v1

- Cross-session personalisation via `getRecentSessions` (could ground a turn 1 plan in patterns from prior writing sessions). Reserved for a later iteration — adds JSON read cost and risks over-fitting feedback to a different assignment.
- A feature flag for the route. Direct release, mirroring Reading and Practice.
- Per-turn subdirectories for image keys. Flat with prefix is sufficient.

## 2026-05 update — paired Model Answers

The single `modelAnswer: string` on the WritingPlan was replaced with a structured `modelAnswers` object: two student-voice exemplars (`atYearLevel`, `aboveYearLevel`) plus a `whyAboveIsBetter` comparative note (1–3 sentences). An earlier iteration of this change used a per-criterion N×2 justification grid, but that proved noisy in the UI — the comparative note carries the same coaching intent more concisely. The turn-1 output roughly doubles versus the original single-answer design, adding ~$0.01 per session at Haiku 4.5 prices. The worst-case session estimate rises modestly but remains well under $0.10. This was a **hard cutover**: sessions persisted before this change have no `modelAnswers` field and render a "Model answers unavailable for this session (legacy data)" notice on the plan card.

## Amendments

### 2026-05-10 — Year level may be sourced from parent input

The "lock both for the rest of this writing session" decision (§Decisions) is preserved, but the *source* of `yearLevel` is no longer inference-only. The writing landing page exposes an optional year-level picker; when set, the value is passed to `/writing/start` and treated as authoritative for the entire session (server defensively overwrites `plan.yearLevel` after the Bedrock call). The plan packet gains `yearLevelSource: "user" | "inferred"` so readers and telemetry can tell the two paths apart. The previous "when in doubt, choose the lower year" instruction in `buildPlanSystemPrompt` is removed — it was a workaround for the fact that wrong inference couldn't be corrected, and the override now provides the correction path. Genre remains inference-only and locked.

## Verification

End-to-end checks live in [/Users/xiaozhoucui/.claude/plans/in-this-agentic-validated-cook.md](../../.claude/plans/in-this-agentic-validated-cook.md) (the implementation plan). The most important to run on first deploy:

1. Submit a typed prompt → receive a plan → submit a typed draft → receive feedback. Confirm the rubric strip renders, two stars + one wish are present, and `nextStep` chip is visible.
2. Submit a handwritten draft as an image — confirm `transcription` field renders verbatim with misspellings preserved.
3. Submit 5 drafts; confirm the 6th is rejected server-side with `limit_reached`.
4. Resume an active session by closing the tab and clicking the pinned active card in the sidebar.
5. Force a stale session by editing `updatedAt` in S3 to >24 h ago; confirm the next read flips it to `abandoned` without a Bedrock call.
6. Ask the coach for a "stronger opening sentence" via a question turn — confirm the answer redirects to Socratic guidance and points at the gated `modelAnswer`, with no copyable content emitted.
