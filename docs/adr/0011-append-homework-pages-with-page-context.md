# ADR 0011 — Append Homework pages with persisted Page Context

**Status:** Accepted
**Date:** 2026-08-18
**Supersedes in part:** [ADR 0004](./0004-unified-session-model.md), for the claim that Homework Sessions are always complete

A Homework Session represents one homework task and may be extended on its current result page by atomic, idempotent Page Submissions instead of forcing later pages into unrelated Sessions. Each new image is interpreted once into durable Page Context containing text, mathematical notation, tables, and visual-structure descriptions; later submissions normally send prior Page Context with the new images, rereading only a specifically referenced earlier image when that context is insufficient. This preserves cross-page meaning while avoiding the latency and cost of repeatedly sending every old image.

Question reconciliation keeps stable identifiers: confident continuations or overlaps revise the existing Question and regenerate only its Coaching Packet, while uncertain matches remain separate and are marked as possibly repeated. A Page Submission either commits all page contexts, images, Question changes, packets, and cumulative usage or leaves the previous Session unchanged; retries return the established outcome. One submission contains at most 5 images, one Session at most 10 images and 30 complete Questions.

## Considered alternatives

- **Create a linked Homework Session for every later upload.** Rejected because one homework task would be fragmented across history cards and later questions would not naturally share the earlier context.
- **Resend every earlier image on every submission.** Rejected because image input cost and latency grow with every added page.
- **Reuse plain OCR text only and never reread an image.** Rejected because tables, diagrams, layout, and ambiguous visual references can be essential to a correct answer.

## Consequences

- Homework joins Writing as a Session kind that can change across HTTP requests, while retaining its locked Model Choice.
- A Homework Session may temporarily contain only Page Context and no complete Question; such a Session is omitted from history because it cannot be continued there and has no coaching result to review.
- Session History shows every accepted original image and the latest Questions and Coaching Packets, but never exposes internal Page Context.
- The result page keeps existing results visible while a Page Submission runs, offers no mid-submission cancellation, and atomically merges the completed result. The main UI shows cumulative Session usage rather than per-submission usage.
