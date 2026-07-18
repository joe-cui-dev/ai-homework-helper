# ADR 0010 — History Card snapshots with live Session Detail

**Status:** Accepted
**Date:** 2026-07-19

The History Browser uses two purpose-built, discriminated read models rather than returning near-complete Sessions in every list page. `SessionCard` is a compact selection summary; `SessionDetail` is the complete parent-facing review of one selected Session. This restores the intent of ADR 0004, prevents the list contract from becoming a kitchen-sink set of optional fields, and avoids preloading every packet, Writing turn, Practice relationship, and image URL when the parent opens the sidebar.

A History Browser visit presents a stable, recent-activity-ordered Card snapshot with active Writing Sessions globally first. Its opaque pagination cursor preserves that snapshot until refresh. Detail is deliberately not frozen with the Card snapshot: opening a Card reads the Session's latest state. A stale Card whose Session is no longer accessible is removed without distinguishing expiry, absence, or another Parent Account's data.

Each Card exposes at most one representative Pre-signed URL and an image count. Detail signs all images needed for review. Image signing is owned by the History read module through an internal signer adapter; Image Keys never cross its external interface, and an individual signing failure degrades only that image. Homework Cards do not query Practice. Homework Detail reads all Practice Sessions for the origin once, groups every parent-facing Practice Summary under its Question, and excludes agent sidecar and tool implementation detail.

The existing History Lambda remains the transport adapter for both Card and Detail reads. A deep History read module owns ordering, snapshot pagination, discriminated projection, Practice enrichment, and image signing. Its internal Session-read and image-signing seams have AWS adapters in production and in-memory/deterministic adapters in tests. Backend and frontend share one History contract module; persisted `Session` remains a separate type and is always explicitly projected.

No Session Card index is introduced. The read module walks all S3 key metadata, reads only the selected Homework/Reading Card page, and performs a bounded scan of Writing candidates that may still be active. Complete Practice history remains an on-demand O(P) scan for one Homework Detail. These choices retain the single source of truth from ADR 0005; metrics on key count, object reads, and latency determine whether an index is justified later.

Returning full review content in every Card page was rejected because it couples list cost to packet, turn, Practice, and image volume. Separate Lambdas for Card and Detail were rejected because both reads share authentication, storage, deployment, and scaling characteristics. Offset pagination was rejected because new or updated Sessions can shift pages and cause duplicates or omissions.
