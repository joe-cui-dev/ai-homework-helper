# ADR 0001: Batch-level session model

**Status:** Superseded by [ADR 0004](./0004-unified-session-model.md)
**Date:** 2026-05-01

## Context

When a student uploads one image containing an article with multiple questions, the app extracts and solves each question independently. Originally, each question was saved as a separate session JSON (`sessions/{studentId}/{batchId}-q{questionId}.json`) and the uploaded image was stored separately under each session key — meaning the same image was written to S3 once per question.

This caused two problems:
1. **Redundant storage** — the same image bytes were stored N times for N questions.
2. **Fragmented history** — the history browser showed N separate cards for what the student perceives as one submission.

## Decision

Collapse the per-question session model into a per-batch session model:

- **One session JSON per batch**, stored at `sessions/{studentId}/{batchId}.json`.
- The JSON contains a `questions` array, each element holding a full question-answer pair (`input`, `subject`, `difficulty`, `answer`, `steps`, `explanation`, `hints`).
- **Images uploaded once per batch**, stored at `sessions/{studentId}/{batchId}/image-{i}.{ext}` and shared across all questions in the session.
- The history browser shows **one card per batch**, regardless of question count.

Old sessions (flat top-level fields, per-question key format) are normalised to a one-element `questions` array at read time in `listSessions`.

## Alternatives considered

**Keep per-question sessions, deduplicate images separately**  
Images could be stored at a batch-level prefix while session JSONs remained per-question. Rejected: the history browser would still show N cards for one upload, which contradicts the student's mental model of "I submitted one worksheet."

**Per-question sessions, show batch grouping in UI**  
Group cards in the history browser by `batchId`. Rejected: adds UI complexity (expand/collapse groups) and the grouping metadata would need to be stored in every session JSON anyway.

## Consequences

- `handler.ts` uploads images once (before the question loop) and writes one session JSON (after the loop).
- `storage.ts` `listSessions` must detect old vs new format and normalise.
- `SessionSummary` frontend type changes: flat `subject`/`difficulty`/`answer` fields replaced by `subjects: string[]` and `questions: QuestionResult[]`.
- Session cards show all distinct subject badges, first question text, and a "+N more" badge.
- Detail modal shows all questions stacked and scrollable.
