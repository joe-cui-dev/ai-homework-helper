# Historical Handoff: Session-Locked Model Choice Implementation

> **Status: completed.** The described implementation landed in commit `eb6e84e` on 2026-06-05. This file is retained as design and implementation history only; use [CONTEXT.md](../CONTEXT.md), [ADR 0008](./adr/0008-session-locked-model-choice.md), and the current code as the source of truth.

Date: 2026-06-05

Workspace: `/Users/xiaozhoucui/repos/ai-homework-helper`

Original next-session focus: implement parent-selectable Bedrock model choice across Homework, Reading, Writing, and inherited Practice sessions.

## Current State

This section records the state before implementation; it is no longer current.

Changed workspace files:

- `/Users/xiaozhoucui/repos/ai-homework-helper/CONTEXT.md`
  - Added the domain term `Model Choice`.
- `/Users/xiaozhoucui/repos/ai-homework-helper/docs/adr/0008-session-locked-model-choice.md`
  - Added an ADR for session-locked model choice.

Current git status at handoff time:

```text
 M CONTEXT.md
?? docs/adr/0008-session-locked-model-choice.md
```

Do not duplicate the ADR/glossary content in implementation docs; reference those files instead.

## Resolved Decisions

The next agent should treat these as settled:

- Public field name: `modelChoice`.
- Public enum values: `"fast" | "advanced"`.
- Parent-facing labels: `Fast` and `Advanced`.
- `Fast` maps to Claude Haiku 4.5.
- `Advanced` maps to Claude Sonnet 4.6.
- Model Choice is locked for the whole Session.
- All AI calls in a Session use the selected choice, including hidden analysis/classification calls.
- Homework, Reading, and Writing start forms expose the selector.
- Practice does not get a separate selector; it copies `modelChoice` from the origin Homework Session at `/practice/start`.
- Writing draft/question turns load the persisted Writing Session model choice; the frontend should not send a model choice on continuation turns.
- Practice later turns load the persisted Practice Session model choice.
- Missing `modelChoice` on legacy sessions means `fast`.
- Missing `modelChoice` in new start requests defaults to `fast`.
- Explicit invalid `modelChoice` rejects with validation error.
- If `Advanced` is unavailable, fail explicitly; do not silently downgrade to `Fast`.
- Keep raw Bedrock model IDs out of frontend code, browser requests, and user-facing Session JSON.
- No new frontend environment variables and no `/models` discovery endpoint for v1.
- Usage wire shape stays `{ inputTokens, outputTokens, costUsd }`.
- Cost is computed from the selected model registry entry.
- Results/history should show a compact `Fast` / `Advanced` badge, but history should not filter by model choice.
- `Fast` remains the default everywhere.
- No new per-account/session cost caps in v1.
- `Advanced` means Sonnet 4.6 normal mode; do not enable extended reasoning in v1.
- Tests should focus on routing, persistence, validation, inheritance, legacy defaulting, and Bedrock registry use.

## Verified External Facts

AWS docs verified during the grilling session:

- Claude Sonnet 4.6 is available in Amazon Bedrock and supports both `Invoke` and `Converse`.
- The relevant geo inference ID shown by AWS is `au.anthropic.claude-sonnet-4-6`.
- Sonnet 4.6 launched on Bedrock on February 17, 2026.

References:

- https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-4-6.html
- https://aws.amazon.com/about-aws/whats-new/2026/02/claude-sonnet-4.6-available-in-amazon-bedrock/

Anthropic public pricing surfaced Sonnet 4.6 at `$3 / MTok` input and `$15 / MTok` output. AWS pricing should still be checked directly before hardcoding production prices, because AWS regional/geo/global pricing can vary.

## Existing Code To Inspect First

Backend/shared:

- `/Users/xiaozhoucui/repos/ai-homework-helper/backend/src/shared/bedrock.ts`
  - Currently reads one `process.env.BEDROCK_MODEL_ID`.
  - Also reads single input/output price env vars.
  - `callClaude` and `converseWithTools` need to accept/use `modelChoice`.
- `/Users/xiaozhoucui/repos/ai-homework-helper/backend/src/shared/session.ts`
  - Add `modelChoice` to `SessionBase`.
  - Normalize missing legacy values to `fast` where sessions are loaded/projected.
- `/Users/xiaozhoucui/repos/ai-homework-helper/backend/src/shared/types.ts`
  - Add public `ModelChoice` type and stream-event fields as needed.

Infra:

- `/Users/xiaozhoucui/repos/ai-homework-helper/infra/lib/stack.ts`
  - Currently defines Haiku 4.5 constants, one model env var, one pair of prices, and IAM access for one model/inference profile.
  - Replace the single-model env style with a registry-aware approach.
  - Grant Bedrock invoke permissions for both Haiku 4.5 and Sonnet 4.6 inference profiles/base models.

Module handlers likely needing request parsing and persistence:

- `/Users/xiaozhoucui/repos/ai-homework-helper/backend/src/homework/handler.ts`
- `/Users/xiaozhoucui/repos/ai-homework-helper/backend/src/reading/handler.ts`
- `/Users/xiaozhoucui/repos/ai-homework-helper/backend/src/writing/handler.ts`
- `/Users/xiaozhoucui/repos/ai-homework-helper/backend/src/practice/handler.ts`
- `/Users/xiaozhoucui/repos/ai-homework-helper/backend/src/practice/practiceStorage.ts`
- `/Users/xiaozhoucui/repos/ai-homework-helper/backend/src/writing/writingStorage.ts`

Frontend request/UI likely needing updates:

- `/Users/xiaozhoucui/repos/ai-homework-helper/frontend/src/types.ts`
- `/Users/xiaozhoucui/repos/ai-homework-helper/frontend/src/services/homeworkApi.ts`
- `/Users/xiaozhoucui/repos/ai-homework-helper/frontend/src/services/readingApi.ts`
- `/Users/xiaozhoucui/repos/ai-homework-helper/frontend/src/services/writingApi.ts`
- `/Users/xiaozhoucui/repos/ai-homework-helper/frontend/src/pages/HomeworkPage.tsx`
- `/Users/xiaozhoucui/repos/ai-homework-helper/frontend/src/pages/ReadingPage.tsx`
- `/Users/xiaozhoucui/repos/ai-homework-helper/frontend/src/pages/WritingPage.tsx`
- `/Users/xiaozhoucui/repos/ai-homework-helper/frontend/src/components/HistorySidebar.tsx`
- `/Users/xiaozhoucui/repos/ai-homework-helper/frontend/src/components/SessionDetailModal.tsx`

## Suggested Implementation Shape

Prefer a typed backend registry instead of raw env-per-request behavior.

Likely structure:

- Add a shared model module, perhaps `backend/src/shared/modelChoice.ts`.
- Export `type ModelChoice = "fast" | "advanced"`.
- Export parser/normalizer:
  - `parseOptionalModelChoice(value): ModelChoice | validation error`
  - `normaliseModelChoice(value): ModelChoice` for legacy persisted records.
- Export resolver for Bedrock calls:
  - `resolveBedrockModel(modelChoice)` returns model ID, label, input/output prices.

Bedrock wrapper shape:

- Update `callClaude(prompt, temperature, image, modelChoice)` or use an options object.
- Update `converseWithTools(..., modelChoice, ...)` or use an options object to avoid positional-argument sprawl.
- Ensure every call site passes the Session's model choice or the start request's resolved choice.
- `computeCostUsd` should use per-call registry prices instead of module-level single price constants.

Session shape:

- Add `modelChoice` to `SessionBase`.
- Persist it on all new sessions.
- For legacy load/project paths, default missing to `fast`.
- Practice creation copies from origin Homework Session.

Frontend shape:

- Add a compact segmented control component if no suitable one exists.
- Default `Fast`.
- Send `modelChoice` only for Homework, Reading, and Writing start requests.
- Show badge in results/history/detail, with legacy default `Fast`.
- Do not expose raw model IDs.

## Test Targets

Recommended backend tests:

- Missing `modelChoice` on start request defaults to `fast`.
- Invalid explicit `modelChoice` rejects.
- Homework/Reading/Writing start sessions persist selected `modelChoice`.
- All Bedrock calls in a selected session use the selected registry entry.
- Writing draft/question turns use persisted `modelChoice`, ignoring any client attempt to switch.
- Practice start copies origin Homework `modelChoice`.
- Practice later turns use Practice Session `modelChoice`.
- Legacy sessions without `modelChoice` normalize to `fast`.
- Cost calculation uses the selected model's price.

Recommended frontend tests if existing patterns make this cheap:

- Start forms default to `Fast`.
- Selecting `Advanced` sends `modelChoice: "advanced"` on start request.
- History/detail render `Fast` for legacy sessions and `Advanced` for advanced sessions.

## Commands From AGENTS.md

Use these repo commands unless code inspection finds newer patterns:

```bash
npm install
npm run build
cd backend && npm run build
cd backend && npm test
cd backend && npx jest src/__tests__/agent.test.ts
cd infra && npm run synth
```

## Suggested Skills

- `tdd`: Use for implementation, because this feature has clear behavioral contracts around validation, persistence, inheritance, and Bedrock routing.
- `diagnose`: Use only if existing tests fail or Bedrock wrapper behavior is unclear.
- `browser:control-in-app-browser`: Use after frontend changes to verify the start-form selector and history/result badges in the local app.
- `to-issues`: Optional if the user wants this split into independently grabbable implementation tickets before coding.

## Cautions

- The workspace already has documentation changes from the grilling session. Do not revert them.
- Do not add raw Bedrock model IDs to frontend code or user-facing Session JSON.
- Do not implement silent fallback from `advanced` to `fast`.
- Do not make Practice independently selectable unless the user reopens that decision.
- Check current AWS Bedrock pricing before final hardcoded production price constants, especially for `au` geo inference.
- There are no secrets in this handoff.
