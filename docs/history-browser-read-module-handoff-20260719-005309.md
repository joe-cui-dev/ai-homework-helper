# Handoff: implement the deep History Browser read module

## Objective

Implement the accepted History Browser architecture so a fresh agent can move directly into code. Deliver compact, stable `SessionCard` pages and on-demand, live `SessionDetail` reads; remove the N×M Practice scan from the Card path; add strict one-active-Practice coordination; migrate the frontend to the new shared contract; and verify the full backend/frontend flow.

Do not restart design or re-interview the user. The grilling session is complete and the decisions are accepted.

## Read first — sources of truth

Do not duplicate or reinterpret these artifacts:

- Domain vocabulary and user-visible behaviour: `/Users/xiaozhoucui/repos/ai-homework-helper/CONTEXT.md`, especially `Session History`, `History Browser`, `Session Card`, `Session Detail`, `Practice Summary`, `Practice Session`, and `Pre-signed URL`.
- Existing Session model and typed S3 prefixes: `/Users/xiaozhoucui/repos/ai-homework-helper/docs/adr/0004-unified-session-model.md` and `0005-session-key-includes-type.md`.
- Strict active-Practice coordination: `/Users/xiaozhoucui/repos/ai-homework-helper/docs/adr/0009-active-practice-locator.md`.
- Card snapshot/live Detail architecture: `/Users/xiaozhoucui/repos/ai-homework-helper/docs/adr/0010-history-card-snapshot-and-live-detail.md`.
- Repo commands and architecture: `/Users/xiaozhoucui/repos/ai-homework-helper/AGENTS.md`.

## Current worktree

The design docs are intentionally uncommitted user-owned changes. Preserve them:

- modified: `CONTEXT.md`
- untracked: `docs/adr/0009-active-practice-locator.md`
- untracked: `docs/adr/0010-history-card-snapshot-and-live-detail.md`

No implementation code has been changed. Do not reset, overwrite, or discard unrelated changes.

## Non-negotiable implementation outcomes

Use the referenced docs for the full rationale. The code must end with these observable properties:

1. One History Lambda serves Card-list and Detail reads.
2. A deep backend read module owns ordering, stable snapshot pagination, projection, Practice enrichment, and image signing.
3. The Lambda handler owns only Cognito/HTTP/route/error mapping and does not instantiate S3/presigner logic for projections.
4. Backend and frontend import one authoritative History wire contract. Persisted `Session` remains separate and is explicitly projected.
5. `SessionCard` and `SessionDetail` are discriminated unions, never a kitchen-sink optional-field type.
6. Card pages never scan Practice, never include usage, packets, turns, Image Keys, or sidecar data, and sign at most one representative thumbnail per Card.
7. Detail always reads current state. Homework Detail scans Practice once for that origin, returns every parent-facing Practice Summary grouped by Question, and never exposes sidecar/tool-log details.
8. Card pages are stable snapshots with active Writing globally first and an opaque, versioned keyset cursor. Refresh starts a new snapshot.
9. Missing/unauthorised Detail reads are indistinguishable. A stale Card is removed client-side. Individual image-signing failures degrade only those images.
10. No History/Card projection index is added. Use observable bounded scans as accepted in ADR 0010.
11. One Homework Question can have many Practice Sessions historically but at most one active. Enforce this through the S3 locator protocol in ADR 0009.

## Recommended target module shape

Keep the module deep; avoid splitting every helper into a shallow file. A practical shape is:

```text
contracts/
  package.json
  history.d.ts                 # authoritative wire-only types; no AWS/React imports

backend/src/history/
  historyRead.ts               # deep facade + projection/pagination implementation
  awsHistoryAdapters.ts        # concrete Session-read + image-signer adapters
  handler.ts                   # thin Lambda adapter

backend/src/practice/
  activePracticeLocator.ts     # S3 conditional locator protocol
  practiceStorage.ts           # create-or-resume integration

frontend/src/
  services/historyApi.ts       # Card/Detail transport only
  hooks/useSessionHistory.ts   # Card snapshot state
  components/HistorySidebar.tsx
  components/SessionDetailModal.tsx
```

This is guidance, not a requirement to create one file per bullet. Prefer locality over file-count symmetry. If `historyRead.ts` becomes unwieldy, extract only a cohesive cursor codec or AWS adapter implementation; keep projectors internal unless they gain a second caller.

### Shared contract package

Prefer a small types-only npm workspace package so backend CommonJS and frontend ESM do not gain a runtime build-order dependency. Add it to the root workspaces and backend/frontend dependencies, then update `package-lock.json` through `npm install`.

The contract should export only parent-facing History wire types:

- `HistoryModule`
- `SessionCard` union and its Homework/Reading/Writing variants
- `SessionDetail` union and its variants
- `PracticeSummary`
- image availability representation for Detail
- Card-page result and opaque cursor type (`string` externally)
- explicit transport error result/code types

Define or re-export the minimum nested parent-facing packet/turn shapes required by Detail. Do not import backend persistence types, AWS types, React types, Bedrock types, or sidecar types. Leave unrelated streaming event types where they are unless moving them is mechanically necessary.

Because the current `backend/tsconfig.json` has `rootDir: "src"`, validate the types-only package resolution before migrating all usages. A `.d.ts`-only package avoids emitting or including external source. If the chosen package structure requires TypeScript source, adjust project references/build order deliberately and prove both backend and frontend builds before continuing.

## Execution plan

Implement in the following vertical slices. Keep every slice green before moving on.

### Slice 0 — baseline and safety

1. Re-read the source-of-truth docs above.
2. Capture `git status --short`; preserve the three doc changes.
3. Run the current backend tests, frontend tests, backend typecheck, and frontend build. Record any pre-existing failures rather than silently fixing unrelated code.
4. Inspect current CDK Lambda bundling before selecting the contract package layout; the final `infra synth` must resolve the workspace contract.

### Slice 1 — authoritative History contract

1. Add the types-only `contracts` workspace package and root workspace/dependency entries.
2. Define the accepted Card and Detail discriminated unions from `CONTEXT.md`/ADR 0010.
3. Model unavailable Detail images explicitly without exposing Image Keys.
4. Model Card list success, Detail success, `not_found`, `invalid_cursor`, and internal failure separately. Do not reveal “belongs to another Parent Account”.
5. Add compile-time exhaustiveness tests or `never` checks for every discriminant.
6. Migrate only History-specific imports first. Do not delete the old `SessionSummary` until backend and frontend consumers compile against the new contract.

Acceptance: backend and frontend typecheck while still using old runtime behaviour.

### Slice 2 — deep read module, in-memory first

Build the read module test-first with dependency injection. Its external test surface should expose only two behaviours conceptually: list Cards and get Detail. Internal dependencies:

- Session-read adapter: list all object metadata across every `ListObjectsV2` continuation page; load one typed Session; list Practice Sessions for one Parent Account when Detail requests them.
- Image-signer adapter: sign one stable Image Key into a temporary URL.
- Clock dependency for deterministic snapshot/staleness tests.

Use in-memory/deterministic adapters in tests. Do not mock AWS modules in the core tests.

Required red/green cases:

- Homework, Reading, Writing Card projections contain only accepted fields.
- Card projection signs zero/one thumbnail and carries image count.
- Card list never calls the Practice-list adapter.
- Card list never includes usage, packets, turns, Parent Account ID, Image Keys, sidecar, or tool log.
- Homework Detail groups every Practice Summary under its origin Question, sorted by recent activity.
- Reading and Writing Detail project the accepted content and all required parent-facing images.
- Detail loads the Session at click time rather than reusing Card data.
- wrong type, missing Session, and wrong Parent Account all map to the same `not_found` outcome.
- one image-signing failure yields an unavailable image while the rest of Card/Detail succeeds.
- exhaustive discriminant coverage fails compilation when a new Session variant is unhandled.

### Slice 3 — stable Card snapshot and bounded S3 scan

1. Add a versioned opaque cursor codec. Recommended internal payload: version, `snapshotAt`, and the last composite sort position. Keep its encoded form opaque to callers.
2. Use a deterministic total order: active-Writing rank first, then recent activity descending, then `sessionId` as a tie-breaker.
3. Exclude objects created/updated after `snapshotAt` from later pages; they appear after refresh.
4. Replace the current offset cursor, which duplicates/omits entries when the list shifts.
5. Walk every S3 listing page; current `listSessions` silently stops at the first 1000 objects.
6. Homework/Reading: sort object metadata and load only Sessions needed for the requested Card page.
7. Writing: inspect only candidates that can still be active under the accepted seven-day policy, classify stale entries consistently with Writing storage rules, globally pin active entries, then fill the remaining page.
8. Emit structured metrics/logs for listed-key count, loaded-object count, signed-image count, Practice-object count, and duration. Do not add a Card index.

Required tests:

- more than one S3 listing page
- new Session between page 1/page 2 does not shift the snapshot
- updated Writing between pages does not duplicate or omit snapshot entries
- tie timestamps remain deterministic
- old active-looking Writing is treated consistently with abandonment policy
- invalid/version-unknown cursor is rejected without throwing an opaque 500

### Slice 4 — AWS adapters and thin History Lambda

1. Move S3 listing/loading and `getSignedUrl` behind the internal adapters.
2. Refactor `backend/src/history/handler.ts` so it no longer defines the History projection or imports S3/presigner directly.
3. Keep the existing Card-list request compatible where practical (`type`, cursor, optional limit), but return the new Card-page contract.
4. Add an on-demand Detail route that includes both `sessionType` and `sessionId`; every caller already knows type per ADR 0005. Suggested raw path: `/sessions/{sessionType}/{sessionId}`. Keep the same Function URL/Lambda.
5. Map authentication/validation/not-found/internal failures deliberately. Reset logger context in every exit path.
6. Update handler tests to cover only auth, route/parameter parsing, status/error mapping, and delegation. Move projection assertions to read-module tests.

Do not add another Lambda or new History infrastructure.

### Slice 5 — frontend Card list and lazy Detail

1. Create/rename a History transport module with separate Card-page and Detail reads using the shared contract.
2. Refactor `useSessionHistory` to hold only Cards, stable cursor, loading-more state, and per-card removal after `not_found`.
3. Do not store a `SessionSummary` containing detail. Selecting a review action triggers a separate Detail request with its own loading/error/abort state.
4. Refactor `HistorySidebar` to render discriminated Cards:
   - recent activity time, not creation timestamp
   - Model Choice but no usage/cost
   - one representative thumbnail plus remaining image count
   - accepted module-specific preview/count/status fields
   - active Writing: explicit Resume primary action and Review details secondary action
5. Refactor `SessionDetailModal` to accept a `SessionDetail` union, not a Card or persisted Session.
6. Render unavailable images locally without failing the Detail.
7. When Detail returns `not_found`, show the accepted unavailable message and remove that Card from the current snapshot without refetching the whole page.
8. Delete frontend History type mirrors and optional checks that are made impossible by the discriminated contract. Retain unrelated stream/session UI types.

Required tests:

- Card never renders usage
- one thumbnail and image count
- active Writing exposes separate Resume/Review actions
- Detail is fetched only on Review
- stale Card removal on `not_found`
- all three Detail variants render without optional-field branching
- unavailable images do not hide coaching content
- loading, abort, and retry behaviour

### Slice 6 — Practice summaries and strict active locator

Implement ADR 0009 test-first in `activePracticeLocator.ts` or an equivalently cohesive module.

1. Use an origin-addressable S3 key under a prefix distinct from `practice/` Session history.
2. Locator payload includes version, origin, preallocated Practice `sessionId`, `creating | active`, lease expiry, and timestamps needed for repair.
3. Acquire with conditional create (`If-None-Match` semantics), then persist the Practice Session, then conditionally promote using the locator version/ETag.
4. A live `active` locator resumes the referenced Practice Session; it never creates another.
5. An unexpired `creating` locator produces a retryable “start in progress” result.
6. Expired/missing-target locators are conditionally repaired/taken over. Existing-target `creating` locators are promoted.
7. Ending/abandoning saves the ended Practice Session before conditionally releasing the locator. A later start heals a locator that points to an ended/stale/missing Session.
8. Integrate `createPracticeBundle`/Practice start into create-or-resume semantics and update the History Detail action to use the actual active Practice `sessionId`.
9. Do not build a separate Practice-history index. Detail still obtains full history by one O(P) scan.

Concurrency/failure tests must cover:

- two simultaneous starts: one Session wins
- loser resumes/retries and does not persist a second active Session
- crash after locator create, before Session save
- crash after Session save, before locator promotion
- crash after ended Session save, before locator release
- locator pointing at missing/ended/stale Session
- ETag/version mismatch during takeover/release
- 24-hour Practice auto-abandon releases/heals the locator

Important existing limitation: the frontend Practice transcript currently lives only in hook state, and the route encodes Homework origin rather than Practice `sessionId`. This implementation must at minimum resume the same persisted Practice Session/sidecar and must not create a duplicate Session. Do not silently add full transcript persistence in this change. It is acceptable for resume to continue with the next tutor turn using the existing sidecar. If the product requires reconstructing and displaying all prior parent/agent messages after reload, stop that slice and run `grill-with-docs`; that behaviour was not decided in this session.

### Slice 7 — delete shallow paths and reconcile docs

After all replacement paths are green:

1. Remove the handler-local kitchen-sink `SessionSummary` and projection code.
2. Remove/replace `listPracticeSessionsForOrigin` usages that cause per-Card scans. A single Detail-scoped scan may remain behind the adapter.
3. Remove frontend History mirrors from `frontend/src/types.ts` and obsolete normalization/optional fallbacks.
4. Remove direct History handler S3/presigner imports and mocks.
5. Update stale comments claiming legacy History normalisation or single-value Practice association.
6. Re-read `CONTEXT.md` and ADRs 0004/0005/0009/0010; code vocabulary and tests must use `Session Card`, `Session Detail`, `Practice Summary`, Parent Account, module/interface/seam/adapter/locality/leverage consistently.
7. Do not edit the accepted ADR decisions to match accidental implementation shortcuts.

## Verification commands

Run at minimum:

```bash
npm install
npm test --workspace=backend
npm test --workspace=frontend
npm run build --workspace=backend
npm run build --workspace=frontend
npm run synth --workspace=infra
git status --short
git diff --check
```

Also run focused tests repeatedly during development, for example:

```bash
cd backend && npx jest src/__tests__/historyRead.test.ts
cd backend && npx jest src/__tests__/history-handler.test.ts
cd backend && npx jest src/__tests__/activePracticeLocator.test.ts
cd backend && npx jest src/__tests__/practice-handler.test.ts
```

Use the actual test filenames chosen by the implementation.

## Definition of done

- All non-negotiable outcomes above are implemented and covered by tests.
- Opening History performs no Practice scan and signs at most one image per Card.
- Opening Homework Detail performs one Practice-history scan and returns every Practice Summary grouped by Question.
- Card pagination remains stable across concurrent Session creation/update.
- Detail reflects updates made after the Card snapshot.
- Active Writing is globally pinned, not merely pinned within the current frontend page.
- No frontend/backend History wire type duplication remains.
- History handler contains transport code, not projection/storage orchestration.
- Strict one-active-Practice concurrency and all documented crash windows are tested.
- No Parent Account ID, Image Key, sidecar, raw Bedrock message, tool payload, or internal tool log appears in Card/Detail JSON.
- Backend tests, frontend tests, both builds, and CDK synth pass.
- The original doc changes remain preserved and the final diff contains no unrelated edits.

## Risks and traps

- Do not use current S3 offset pagination as the new cursor; it is unstable and capped by the first `ListObjectsV2` response.
- Do not make the Card contract a renamed version of current `SessionSummary`; the accepted design requires genuinely small variant types.
- Do not load all Practice Sessions while building Homework Cards.
- Do not call `getSignedUrl` in the Lambda handler after introducing the signer adapter.
- Do not expose Image Keys as a fallback when signing fails.
- Do not use `studentId` in new parent-facing contracts. It is a legacy storage identifier; the authenticated Parent Account remains the owner.
- Do not conflate stable Card snapshots with Detail freshness.
- Do not add DynamoDB, a Card index, or a full Practice-origin history index.
- Do not let S3 locator records be returned by `listSessions` or aged/parsed as Sessions.
- Verify S3 conditional-write and conditional-release support in the installed AWS SDK; preserve strict uniqueness if an SDK detail requires a different conditional operation.
- Be careful with Writing stale-status mutation: reuse or centralise the accepted seven-day abandonment policy instead of inventing a different History-only interpretation.

## Suggested skills

- Invoke `$tdd` first. The accepted design has several concurrency, pagination, and projection invariants that should be driven red-green-refactor.
- Then invoke `$implement` with this handoff plus ADRs 0009/0010 as the spec.
- Use `$diagnosing-bugs` only if an existing test/build failure blocks a slice; do not fold unrelated fixes into this refactor.
- Use `$codebase-design` only if implementation discovers that the two-operation read interface cannot remain deep; do not reopen accepted product decisions casually.
- Use `$grill-with-docs` only for genuinely new product behaviour, especially full Practice transcript restoration after reload.
