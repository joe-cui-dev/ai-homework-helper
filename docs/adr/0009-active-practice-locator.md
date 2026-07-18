# ADR 0009 — One active Practice Session per Homework Question

**Status:** Accepted
**Date:** 2026-07-18

A Homework Question may accumulate multiple Practice Sessions, but at most one may be active at a time. Starting practice must resume the active Practice Session when one exists; a new Practice Session may be created only after the previous one has ended or been abandoned. This gives “Resume practice” one stable meaning and prevents concurrent tutor loops from splitting the same attempt.

Strict uniqueness is coordinated by a small S3 locator stored separately from Session history, under an origin-addressable key such as `sessions/{studentId}/practice-active/{originSessionId}/{questionId}.json`. The locator is not a Session and is not used to list Practice history. Creation uses S3 conditional writes and a short `creating` lease: the winner records a preallocated Practice `sessionId`, persists the Practice Session, then conditionally advances the locator to `active`. A concurrent starter must resume the referenced active Session or retry while an unexpired creation lease is in progress; it must not create another Session.

The protocol is self-healing. An expired `creating` locator with no Session may be conditionally taken over; one whose Session exists may be promoted to `active`. Ending or abandoning Practice saves the ended Session before conditionally releasing its locator. If release is interrupted, the next start observes that the referenced Session is no longer active, repairs the locator, and proceeds. This keeps failures closed against duplicate active Sessions while allowing later requests to recover without operator intervention.

We keep the existing Practice Session key from ADR 0005 and continue to obtain complete Practice history from the `practice/` prefix. The locator exists for the domain uniqueness invariant, not as a History Browser performance index. DynamoDB was rejected because its stronger transactional model does not justify another infrastructure primitive at the app's current scale. A best-effort scan before creation was rejected because concurrent requests could still violate the invariant.
