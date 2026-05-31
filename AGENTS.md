# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Commands

```bash
# Install all workspace dependencies
npm install

# Run frontend dev server (localhost:5173)
npm run dev

# Build frontend
npm run build

# Deploy AWS CDK stack
npm run deploy

# Backend: type check only (no emit; Lambda uses esbuild at deploy time)
cd backend && npm run build

# Backend: run all tests
cd backend && npm test

# Backend: run a single test file
cd backend && npx jest src/__tests__/agent.test.ts

# Infrastructure: show pending CDK changes
cd infra && npm run diff

# Infrastructure: synthesize CloudFormation template
cd infra && npm run synth
```

## Architecture

This is an npm workspaces monorepo with three packages: `backend/`, `frontend/`, `infra/`.

**Modules** (each is its own Lambda Function URL):

- **Homework** (`backend/src/homework/`) — stateless. Parent uploads a worksheet image; Codex extracts questions and emits a `CoachingPacket` per question. SPA route `/homework`.
- **Reading** (`backend/src/reading/`) — stateless. Parent uploads book cover + pages; Codex generates 5 grounded comprehension `ReadingPacket`s. SPA route `/reading`.
- **Writing** (`backend/src/writing/`) — multi-turn coaching for an English writing assignment. Three typed turn kinds (`/writing/start`, `/writing/draft`, `/writing/question`), each one forced-tool Converse call (no per-turn loop). State lives in `sessions/{studentId}/{batchId}.json` with `sessionType: "writing"` and is **mutated across HTTP requests**. `_internal` namespace holds Bedrock `messages[]` and per-turn raw usage; the history reader skips it. See [docs/adr/0003-writing-session-model.md](docs/adr/0003-writing-session-model.md). SPA routes `/writing` and `/writing/:batchId`.
- **Practice** (`backend/src/practice/`) — multi-turn agentic loop launched from a CoachingPacket. Each turn iterates a 7-tool dispatch up to 5 times until terminal `end_turn`. SPA route `/practice/:sessionId`.
- **History** (`backend/src/history/`) — read-only listing for the sidebar; presigns image URLs and (for homework sessions) lists practice siblings. Strips `_internal` from writing sessions on projection.

**Request flow (Homework example):**

1. React SPA authenticates via Amazon Cognito and POSTs questions (+ optional base64 image) to the Homework Function URL with a JWT Bearer token
2. `backend/src/homework/handler.ts` — Lambda entry: validates JWT, extracts `studentId` from `sub`, validates input, then calls `analyzePages()` and `generateCoachingPackets()`
3. NDJSON stream emits `analyzing` → `packet_start` per question → `packet_complete` per packet → `complete`
4. `backend/src/shared/storage.ts` — persists the batch session to S3
5. `backend/src/shared/curriculum.ts` — local lookup of AU Curriculum outcomes (math/science/english) plus English writing outcomes per genre via `lookupWritingOutcomes`

**Streaming:** all four POST endpoints use NDJSON (`application/x-ndjson`) via `awslambda.streamifyResponse`. Frontend parses lines via `ReadableStream`; per-module hooks (`useHomeworkStream`, `useReadingStream`, `useWritingSession`, `usePracticeSession`) manage state.

**Safety:** two-layer enforcement — Bedrock Guardrails (hate/profanity/PII/off-topic) on all InvokeModel calls, plus Cognito JWT validation ensuring `studentId` always comes from the verified token.

**AI Model:** `au.anthropic.Codex-haiku-4-5-20251001-v1:0` (cross-region inference profile for ap-southeast-2).

## Frontend Setup

After deploying the CDK stack, copy CDK outputs into `frontend/.env.local`:

```
VITE_API_URL=<Lambda Function URL>
VITE_COGNITO_USER_POOL_ID=<User Pool ID>
VITE_COGNITO_APP_CLIENT_ID=<App Client ID>
```

See `frontend/.env.local.example` for the template.

## Key Design Decisions

- **Lambda Function URL (no API Gateway):** enables streaming responses without extra cost or complexity
- **`studentId` from JWT only:** client never sends its own ID — prevents spoofing
- **Agentic loop exits on `submit_answer` tool:** Codex decides when it has enough to respond; hard cap at 5 iterations prevents runaway costs
- **`callClaude` vs `converseWithTools`:** pipeline skills use single-turn `InvokeModel`; the orchestration loop uses multi-turn Converse API — both go through Bedrock Guardrails
- **`AlreadyReportedError`:** thrown when a guardrail blocks a response to prevent duplicate error events being streamed
- **CDK context overrides:** `logLevel` and `allowedOrigin` can be changed at deploy time via `--context` flags without code changes
- **Writing is "agentic at session level only":** each turn is one forced-tool Converse call; the multi-turn-ness across HTTP requests is the agent character, not iteration inside a turn. Cheaper and lower-latency than a per-turn loop, and the only branching decision (`nextStep` discriminator) is one conditional, not a loop.

## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
