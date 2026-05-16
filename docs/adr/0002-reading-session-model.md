# ADR 0002: Reading Session model & ReadingPacket type

**Status:** Superseded (in part) by [ADR 0004](./0004-unified-session-model.md)
**Date:** 2026-05-05

> ADR 0004 supersedes the storage and discriminator decisions in this ADR (single optional `sessionType` field on a kitchen-sink `SessionRecord`). The `ReadingPacket` shape, the cover-only-generation prohibition, and the two-step backend pipeline are unchanged.

## Context

The app's existing model centres on the Homework Session: parent uploads a worksheet, AI extracts the questions, and produces one CoachingPacket per question. CoachingPacket fields (`tldrAnswer`, `whyItWorks`, `howToCoach`, `watchFor`, `childHint`) are tuned for problems with a single correct answer.

Parents asked for help with reading homework — books their child is reading. There is no worksheet, no pre-existing questions, and no single right answer for "what was the character feeling here?". Reading needs different inputs (cover + book pages), a different generation step (the AI *writes* questions instead of *extracting* them), and different output semantics (a *model answer*, a *comprehension skill*, a *discussion prompt*).

Two design pressures shaped the model:

1. **Hallucination risk is asymmetric.** The AI can confidently claim to know a book — especially well-known titles — and fabricate plot details that don't match what the child actually read. A wrong answer in a model packet is much worse than no answer, because the parent trusts it as the source of truth when checking comprehension.
2. **The history browser is a single timeline.** Parents think of "things I've done with the AI" as one list, not two parallel ones. Forcing them to switch between a Homework tab and a Reading tab in history would fragment their mental model.

## Decision

Add a Reading Session as a polymorphic variant of the existing Session, sharing storage and history but with its own packet shape and generation pipeline.

### 1. `sessionType` discriminator

`SessionRecord` gains an optional `sessionType: "homework" | "reading"` field. Legacy rows have it absent and are normalised to `"homework"` at read time. The history browser shows both types in one timeline with a different badge.

### 2. New `ReadingPacket` type — separate from `CoachingPacket`

Reading needs reading-flavoured field names (`modelAnswer` not `tldrAnswer`, `discussionPrompt` not `childHint`, `commonMisreadings` not `watchFor`) plus two reading-only fields (`questionType: literal|inference|vocabulary` and optional `pageReference`). A `ReadingPacket` lives alongside the session as `readingPackets: ReadingPacket[]`; the homework `questions` array stays empty for reading sessions.

### 3. Pages are always required; no cover-only generation

The AI is forbidden from generating questions purely from cover-only training-data knowledge of the book. Every model answer must be grounded in the uploaded pages. The cover is used for book identification (title/author when readable) and as one signal for year-level inference, but never as the source of question content.

### 4. Two-step backend pipeline

- `analyzeBook` (`bookAnalyzer.ts`) — single forced-tool Converse call. Returns `{ bookContext, yearLevel, pagesAreSufficient, insufficientReason? }`. If `pagesAreSufficient === false`, handler streams `needs_more_pages` and saves no session.
- `generateReadingPackets` (`readingPacket.ts`) — single forced-tool Converse call. Returns ~5 `ReadingPacket`s, balanced across `questionType`, with strict per-field length caps.

Both steps follow the same forced-tool single-call pattern as `analyzer.ts` / `coachingPacket.ts`.

### 5. Routing via `taskType` request field

The existing homework Lambda gains a `taskType: "homework" | "reading"` body field and branches early. Same auth, same image upload pipeline, same NDJSON streaming, same usage accounting, same S3 prefix.

### 6. Image cap lifted for reading

Homework keeps the existing 5-image cap; reading lifts to 8 (cover + up to 7 content pages). Total payload remains capped at 5.5 MB to stay under the Lambda Function URL limit.

## Alternatives considered

**Extend `CoachingPacket` with optional `questionType` and `pageReference` fields.**
Cheapest to ship — no new packet type, no frontend duplication. Rejected because the field semantics genuinely diverge: `tldrAnswer` reads as "the answer" but a reading question's answer is a *model* answer, not the only correct one; `whyItWorks` reads as "why this maths/science principle holds" but for reading we want "what comprehension sub-skill this targets". Coercing reading into homework field names made the parent-facing UI confusing and the LLM prompts longer.

**Separate storage prefix (`reading-sessions/{studentId}/{sessionId}.json`) and history tab.**
Cleaner separation, no JSON polymorphism. Rejected because it doubles the persistence + history surface area (separate Lambda, separate listing endpoint, separate UI tab) and forces parents to context-switch between two timelines. The `sessionType` discriminator is a single field and `listSessions` already does shape normalisation for legacy rows.

**Allow cover-only question generation when the AI claims familiarity, with a confidence gate.**
Lower-friction UX for famous books like *The Very Hungry Caterpillar*. Rejected because the failure mode is silent and asymmetric: a parent can't easily verify the model answer if the AI fabricated it from training data, especially for newer or local Australian children's books the model knows superficially. Always grounding in uploaded pages costs the parent a few extra photos but eliminates hallucinated comprehension questions.

**True multi-turn page collection ("AI asks for pages → parent uploads more in same session").**
Better UX than "re-upload from scratch". Rejected for v1 because it requires a new in-progress session lifecycle (resumable sessions, partial-state persistence, new event types) that doubles the scope. The friendly `needs_more_pages` error + restart works for v1; the multi-turn variant can be revisited if it shows up in real usage.

**Reuse the Phase 2 Practice Tutor Loop for reading.**
Tempting because it's already built. Rejected for v1: the practice agent's tools (`generate_problem`, `evaluate_attempt`, etc.) are tuned for math problems where new problems can be generated to drill the same skill. For reading, the "problem" is the book — there's nothing to regenerate. A reading-specific practice loop is a separate, larger design problem and would have delayed v1.

## Consequences

- **Storage:** `SessionRecord` JSON gains optional `sessionType`, `bookContext`, `readingPackets`. Legacy homework sessions continue to work unchanged. Reading sessions never write the `questions` field.
- **History API:** `history-handler.ts` surfaces `sessionType`, `bookContext`, `readingPackets`. Practice-session lookups are skipped for reading sessions (no practice mode in v1).
- **Lambda routing:** `handler.ts` branches on `taskType` after JWT validation, calling either the existing homework pipeline or the new `runReadingFlow`.
- **Cost:** A reading session is two Bedrock calls (analyzer + packet generator). Comparable to a small homework batch (analyzer + one packet chunk).
- **Frontend:** New `ReadingInput`, `ReadingPacketCard`, `useReadingStream` hook. `HomePage` gets a Homework/Reading tab. `HistorySidebar` and `SessionDetailModal` render reading sessions natively.
- **Migration:** None required. New field; legacy rows default to homework. No backfill, no data rewrite.
- **Future practice:** When practice-for-reading lands, it will need a parallel agent (different tool set: `ask_followup`, `rephrase_question`, `connect_to_prior_pages`) rather than reusing the math-flavoured one.
