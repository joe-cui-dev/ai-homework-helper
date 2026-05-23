# ADR 0006 — Slim Coaching Packet to answer + concept + hint

**Status:** Accepted
**Date:** 2026-05-23

## Context

The Homework module's coaching pass (`generateCoachingPackets`) emits one packet per identified question via a single forced-tool Converse call. The packet originally carried five prose fields per question:

- `tldrAnswer` (≤200 chars)
- `whyItWorks` (≤600 chars)
- `howToCoach` (≤600 chars) — action prose telling the parent what to say
- `watchFor` (2–3 × ≤200 chars) — predicted misconceptions
- `childHint` (≤300 chars)

…plus per-packet `subject` and `yearLevel` enums.

Output cost scaled linearly with question count. A 21-question worksheet was being chunked into 3 calls of ~4200 output tokens each — close to the 8192-token ceiling and dominating user-perceived latency on the homework upload flow. The two heaviest fields (`howToCoach`, `watchFor`) were also the most speculative: `howToCoach` largely duplicated what `childHint` already provided, and `watchFor` was a pre-baked guess at misconceptions that Practice would later have to re-evaluate against the child's actual answers anyway.

`subject` and `yearLevel` were cheap (single enum tokens) but lived on the wrong side of the analyzer/coaching split — the analyzer pass was already iterating every question and could carry them at effectively zero marginal cost.

## Decision

Slim the Coaching Packet to three fields: `tldrAnswer`, `whyItWorks`, `childHint`. Move `subject` and `yearLevel` from the packet onto the sibling `IdentifiedQuestion` (produced by the cheap analyzer pass). Drop `howToCoach` and `watchFor` entirely.

Consequences for downstream consumers:

- **Practice** snapshots `subject` and `yearLevel` from the originating `IdentifiedQuestion` alongside the packet at launch time, preserving year-level calibration in its prompts. Practice no longer receives a pre-baked `watchFor` list; the agent diagnoses misconceptions from observed errors during `evaluate_attempt` instead.
- **History sidebar** continues to render subject badges by reading `subject` from each question (formerly `q.packet.subject`).
- **Homework result card** renders three sections per question instead of five.

Existing persisted homework sessions written under the old shape are treated as disposable and the `sessions/{*}/homework/` S3 prefix is wiped at deploy time; readers are not made tolerant of both shapes.

## Consequences

**Positive.**
- Per-question output drops from ~600 tokens to ~250 tokens (~58% cut on the coaching call). On a 21-question worksheet the cut compounds with the existing chunking, materially reducing both wall-clock latency and Bedrock spend.
- Practice's misconception diagnosis now reacts to what the child actually did, not what we predicted they might do — strictly better signal.
- The packet's three remaining fields each have a distinct, non-overlapping job (answer / concept / read-aloud prompt).

**Negative.**
- Loss of `howToCoach` removes the explicit "what to say" coaching prose. The parent must compose their teaching from `whyItWorks` (concept) and `childHint` (Socratic prompt). If user research later shows parents need more scaffolding, a lazy-loaded "expand coaching guidance" endpoint is an additive follow-up that doesn't require undoing this ADR.
- Practice has less context on the very first problem, before the child has answered anything. Expected to be a minor degradation; the agent still has `whyItWorks` and can probe.

## Alternatives considered

- **Keep `subject`/`yearLevel` on the packet.** Cheap to keep, but living on the wrong side of the analyzer/coaching split was the latent design bug that made Practice depend on the expensive call for two effectively-free enum values. Rejected.
- **Lazy-load `howToCoach`/`watchFor` on demand.** Preserves the feature but adds a new endpoint, route, persistence question, and frontend loading state — and still pays full cost for any engaged user. Held in reserve as an additive future change if needed.
- **Tolerant readers across old + new packet shapes.** Permanent code complexity for sessions that are 30-day TTL'd in an MVP. Rejected in favour of a one-shot S3 wipe.
