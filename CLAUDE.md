# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

**Request flow:**

1. React SPA authenticates via Amazon Cognito and POSTs questions (+ optional base64 image) to a Lambda Function URL with a JWT Bearer token
2. `backend/src/handler.ts` — Lambda entry point: validates JWT (CognitoJwtVerifier), extracts `studentId` from the `sub` claim, validates question length (≤2000 chars), then calls `runAgent()`
3. `backend/src/agent.ts` — agentic loop (max 5 iterations) calling Bedrock Converse API. Claude picks tools from a schema of 6 tools; each iteration dispatches tools and streams `tool_start`/`tool_end` NDJSON events back to the client
4. `backend/src/pipeline.ts` — single-turn AI skills (`solve`, `explain`, `generateHint`) invoked via `InvokeModel`; uses subject-specific `SKILL_PROMPTS` and year-level `TONE_PROMPTS`
5. On `submit_answer` tool call, handler writes `{ type: "complete", result }` and saves session to S3 at `sessions/{studentId}/{sessionId}.json`
6. `backend/src/storage.ts` — S3 session persistence; `getRecentSessions` fetches up to 3 recent sessions for personalization
7. `backend/src/curriculum.ts` — local lookup of Australian Curriculum outcomes (no API call, zero cost)

**Streaming:** responses are NDJSON (`application/x-ndjson`). Frontend parses lines via `ReadableStream` in `frontend/src/services/api.ts`, and `useHomeworkStream` hook manages state transitions (idle → streaming → done/error).

**Safety:** two-layer enforcement — Bedrock Guardrails (hate/profanity/PII/off-topic) on all InvokeModel calls, plus Cognito JWT validation ensuring `studentId` always comes from the verified token.

**AI Model:** `au.anthropic.claude-haiku-4-5-20251001-v1:0` (cross-region inference profile for ap-southeast-2).

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
- **Agentic loop exits on `submit_answer` tool:** Claude decides when it has enough to respond; hard cap at 5 iterations prevents runaway costs
- **`callClaude` vs `converseWithTools`:** pipeline skills use single-turn `InvokeModel`; the orchestration loop uses multi-turn Converse API — both go through Bedrock Guardrails
- **`AlreadyReportedError`:** thrown when a guardrail blocks a response to prevent duplicate error events being streamed
- **CDK context overrides:** `logLevel` and `allowedOrigin` can be changed at deploy time via `--context` flags without code changes
