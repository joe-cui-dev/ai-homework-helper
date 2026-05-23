# ADR 0005 — Session S3 key includes sessionType

**Status:** Accepted
**Date:** 2026-05-23
**Supersedes (in part):** [ADR 0004](./0004-unified-session-model.md) — only the key layout; the discriminated-union data model and the sidecar split are unchanged.

## Context

ADR 0004 flattened the S3 layout to `sessions/{studentId}/{sessionId}.json` (plus `.agent.json` sidecar and an image folder per session). Every kind of Session lived directly under the student's prefix, and `sessionType` lived only inside the JSON body.

The History Browser was a single global sidebar across all modules, so a flat list of every session was exactly what the read path needed. When we split the History Browser into per-module browsers (Homework / Reading / Writing each get their own History button — Practice still nests under Homework), the flat layout became a poor fit: filtering by `sessionType` required reading the body of every candidate object to discover its type. Pagination correctness suffered too — a page of 10 mixed sessions might contain only 1 Writing session, so the Writing sidebar would show 1 item and require "Load more" to fish for matches.

The app is in MVP and existing session data is disposable, so the cost of changing the key layout is bounded.

## Decision

The S3 key for every session kind now includes `sessionType` as a prefix segment:

```
sessions/{studentId}/{sessionType}/{sessionId}.json          ← user-facing Session
sessions/{studentId}/{sessionType}/{sessionId}.agent.json    ← Bedrock sidecar (Writing/Practice)
sessions/{studentId}/{sessionType}/{sessionId}/image-*.{ext} ← uploaded images
```

`listSessions(studentId, sessionType, cursor?, limit?)` takes `sessionType` as a required argument and uses `Prefix: sessions/{studentId}/{sessionType}/` for S3-level filtering. `loadSession`, `loadAgentSidecar`, `saveAgentSidecar`, and `uploadSessionImages` likewise take a `sessionType` argument. Every caller already knows its kind at the call site (writing handlers always load writing, practice handlers always load practice, the history handler is invoked per-module), so the refactor is bounded.

The history Lambda gains a required `?type=homework|reading|writing` query parameter and 400s when it's missing or invalid. Practice is intentionally not a valid value — practice sessions are never surfaced as top-level cards; they appear as siblings nested under their origin Homework card via `listPracticeSessionsForOrigin`, which now lists the `practice/` prefix directly (cheaper than scanning all session bodies).

Existing dev data in S3 is wiped before deploying this change. There is no migration code, no dual-read fallback, no `sessionType`-discovery probe.

## Considered alternatives

- **Keep flat layout; read all bodies and filter in memory.** Smaller change. Rejected: the pathological case (a student with 100 Homework sessions and 1 Writing) reads 100 bodies to satisfy a Writing filter, and pagination cursors lose their per-module meaning. Cost grows linearly with total session count, not matched count.
- **Keep flat layout; maintain a per-type index of zero-byte marker keys.** Avoids changing the canonical key. Rejected: requires an extra PUT per save, introduces an index that can drift out of sync with the data, and the simplification (single source of truth) we want isn't there. The "every loader must know its type" cost we'd be avoiding turns out to be zero in practice because every loader already does.
- **Encode `sessionType` in the filename instead of the path (`{sessionId}.{sessionType}.json`).** Cheap. Rejected: prefix listing is the operation we're optimising for, and a filename suffix gives no prefix to list against — we'd still have to scan all keys.

## Consequences

- **Pagination is now per-module.** Each page of `limit` results contains up to `limit` matches of the requested type. The history sidebar's "Load more" affordance behaves predictably.
- **`listPracticeSessionsForOrigin` is cheaper.** It now lists the `practice/` prefix directly instead of walking every session under the student.
- **The `WRONG_TYPE` defensive branches in `loadPracticeBundle` and `loadWritingBundle` are unreachable in normal operation.** A cross-type collision can no longer happen because the keys are disjoint. The branches stay in code as belt-and-braces, but their tests now assert `NOT_FOUND` instead of `WRONG_TYPE`.
- **Existing dev data is wiped before deploy.** No migration code, no fallback. If we ever need to migrate real data, the path is a one-off copy script driven by `ListObjectsV2` + body-peek for `sessionType` — not worth carrying now.
- **Future module kinds add a new prefix automatically.** A new `Session` variant flows through without storage changes; the history handler simply accepts another `type` value.
