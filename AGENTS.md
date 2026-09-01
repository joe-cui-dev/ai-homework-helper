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

- **Homework** (`backend/src/homework/`) — appendable Session workflow. An `initial` request creates the Session; while viewing its result, the parent may send atomic `append_pages` Page Submissions that add images, Page Context, final Questions, and changed `CoachingPacket`s to the same Session. See [ADR 0011](docs/adr/0011-append-homework-pages-with-page-context.md). SPA route `/homework`.
- **Reading** (`backend/src/reading/`) — stateless. Parent uploads book cover + pages; the AI generates 5 grounded comprehension `ReadingPacket`s. SPA route `/reading`.
- **Writing** (`backend/src/writing/`) — multi-turn coaching for an English writing assignment. Four HTTP turn kinds (`/writing/start`, `/writing/draft`, `/writing/question`, `/writing/end`); each productive turn is one forced-tool Converse call (no per-turn loop). The user-facing Session at `sessions/{studentId}/writing/{sessionId}.json` is mutated across requests. Raw Bedrock messages and per-turn usage live in the `.agent.json` sidecar. See [docs/adr/0004-unified-session-model.md](docs/adr/0004-unified-session-model.md) and [docs/adr/0005-session-key-includes-type.md](docs/adr/0005-session-key-includes-type.md). SPA routes `/writing` and `/writing/:sessionId`.
- **Practice** (`backend/src/practice/`) — multi-turn agentic loop launched from a CoachingPacket. Each turn iterates a 7-tool dispatch up to 5 times until terminal `end_turn`. SPA route `/practice/:sessionId`.
- **History** (`backend/src/history/`) — read-only per-module listing for the sidebar; presigns image URLs and (for Homework Sessions) lists Practice siblings. It returns a purpose-built summary rather than raw session or sidecar state.

**Request flow (Homework example):**

1. The authenticated React SPA POSTs an explicit request kind to the Homework Function URL: `{ kind: "initial", question, images, modelChoice }` or `{ kind: "append_pages", sessionId, submissionId, images }`. `studentId` always comes from the verified Cognito access token.
2. `backend/src/homework/handler.ts` validates the wire payload and identifiers, then calls `processHomeworkSubmission()`.
3. Initial processing analyzes new images into durable Page Context, reconciles Questions, generates packets, saves one Homework Session, and emits `analyzing` / packet progress followed by authoritative `complete` (or `error`).
4. Append processing emits `append_phase` progress (`preparing` → `analyzing` → `generating` → `saving`), uses saved Page Context for earlier pages by default, and rereads only specifically requested earlier images when semantic context is insufficient.
5. `backend/src/shared/sessionStore.ts` uses a submission claim, payload hash, deterministic image keys, and conditional S3 Session write so a Page Submission commits atomically and same-ID retries replay the established outcome.
6. Frontend Homework handling treats only `complete` or structured `error` as terminal; malformed or prematurely ended NDJSON becomes a retryable failure without replacing the prior visible result.

**Streaming:** all four POST endpoints use NDJSON (`application/x-ndjson`) via `awslambda.streamifyResponse`. Frontend parses lines via `ReadableStream`; per-module hooks (`useHomeworkStream`, `useReadingStream`, `useWritingSession`, `usePracticeSession`) manage state. The backend/frontend `StreamEvent` mirrors are guarded by `backend/src/__tests__/streamContract.test.ts`.

**Safety:** two-layer enforcement — Bedrock Guardrails (harmful content/profanity/PII/prompt attacks/off-topic) on all model calls, plus Cognito access-token validation ensuring `studentId` always comes from the verified token. Input assessment is scoped to the parent's request via `guardContent` tagging so quoted worksheet text is not judged as a request; see [docs/adr/0013-guardrail-assesses-the-request-not-the-worksheet.md](docs/adr/0013-guardrail-assesses-the-request-not-the-worksheet.md).

**AI Model:** Sessions use a parent-selected `modelChoice`: Fast maps to Claude Haiku 4.5 and Advanced maps to Claude Sonnet 5. The backend owns the Bedrock model registry and raw model IDs.

## Frontend Setup

After deploying the CDK stack, copy CDK outputs into `frontend/.env.local`:

```
VITE_HOMEWORK_API_URL=<Homework Function URL>
VITE_READING_API_URL=<Reading Function URL>
VITE_WRITING_API_URL=<Writing Function URL>
VITE_PRACTICE_API_URL=<Practice Function URL>
VITE_HISTORY_API_URL=<History Function URL>
VITE_COGNITO_USER_POOL_ID=<User Pool ID>
VITE_COGNITO_APP_CLIENT_ID=<App Client ID>
```

See `frontend/.env.local.example` for the template.

## Key Design Decisions

- **Lambda Function URL (no API Gateway):** enables streaming responses without extra cost or complexity
- **`studentId` from JWT only:** client never sends its own ID — prevents spoofing
- **Practice loop exits on `end_turn`:** the tutor must finish every Practice turn with a terminal tool call; a hard cap of 5 iterations prevents runaway costs
- **`callClaude` vs `converseWithTools`:** single-shot tutoring tools use `InvokeModel`; structured Homework, Reading, and Writing outputs and the Practice orchestration loop use Converse — both pass through Bedrock Guardrails
- **CDK context overrides:** `logLevel` and `allowedOrigin` can be changed at deploy time via `--context` flags without code changes
- **Writing is "agentic at session level only":** each turn is one forced-tool Converse call; the multi-turn-ness across HTTP requests is the agent character, not iteration inside a turn. Cheaper and lower-latency than a per-turn loop, and the only branching decision (`nextStep` discriminator) is one conditional, not a loop.
- **Model Choice is locked per Session:** starts default to Fast; Writing keeps its selected choice and Practice inherits it from the source Homework Session.
- **Homework append is atomic and context-first:** earlier worksheet images are normally represented by saved Page Context; a targeted old-image fallback is allowed only when required. The Session JSON conditional write is the commit point. See [ADR 0011](docs/adr/0011-append-homework-pages-with-page-context.md).

## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
