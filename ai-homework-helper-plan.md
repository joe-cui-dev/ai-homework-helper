# AI Homework Helper — Execution Plan

## Overview

A serverless, multimodal AI homework assistant. Students submit a question as text or a photo; the app returns a step-by-step explanation. Built as a portfolio project prioritising simplicity and low cost.

---

## Key Design Decisions

| Decision        | Choice                          | Reason                                        |
| --------------- | ------------------------------- | --------------------------------------------- |
| AI pipeline     | Tool-dispatching agentic loop   | Claude picks tools; adapts to each question   |
| Image input     | Base64 in request body          | Removes presigned URL round-trip              |
| OCR             | Claude native vision            | No Textract needed                            |
| History storage | S3 JSON objects                 | No DynamoDB table to manage                   |
| Auth            | Amazon Cognito (JWT in Lambda)  | Verified at cold-start; student ID from token |
| API layer       | Lambda Function URL (streaming) | No API GW; removes 29 s timeout ceiling       |
| Monorepo        | npm workspaces                  | Single `npm install` at root                  |

---

## Repo Structure

```
ai-homework-helper/
├── package.json           # root workspace config
├── infra/                 # AWS CDK (TypeScript)
├── backend/               # Lambda functions (TypeScript)
└── frontend/              # Vite + React + TypeScript
```

### Root `package.json`

```json
{
  "private": true,
  "workspaces": ["infra", "backend", "frontend"],
  "scripts": {
    "install:all": "npm install",
    "dev": "npm run dev --workspace=frontend",
    "deploy": "npm run deploy --workspace=infra"
  }
}
```

---

## Tech Stack

- **Frontend:** React 18, Vite, TypeScript, Tailwind _(not yet built)_
- **Backend:** AWS Lambda, Node.js 24, TypeScript
- **Infrastructure:** AWS CDK v2
- **AI:** Amazon Bedrock — Claude Haiku 4.5
- **Auth:** Amazon Cognito (User Pool + SPA client)
- **Storage:** S3 (session history as JSON, 30-day expiry)
- **API:** Lambda Function URL (streaming NDJSON)

---

## Environment Variables

### Backend Lambda (all set by CDK — no manual configuration needed)

| Variable                    | Description                                     |
| --------------------------- | ----------------------------------------------- |
| `BEDROCK_MODEL_ID`          | Bedrock model identifier                        |
| `S3_BUCKET_NAME`            | Session history bucket name                     |
| `BEDROCK_GUARDRAIL_ID`      | Guardrail for content safety                    |
| `BEDROCK_GUARDRAIL_VERSION` | Guardrail version (created by CDK)              |
| `COGNITO_USER_POOL_ID`      | Cognito User Pool ID                            |
| `COGNITO_APP_CLIENT_ID`     | Cognito App Client ID (no secret, browser-safe) |
| `ALLOWED_ORIGIN`            | CORS allowed origin (CDK context, default `*`)  |
| `SERVICE_NAME`              | Powertools logger service name                  |
| `LOG_LEVEL`                 | Log verbosity (CDK context, default `INFO`)     |

### Frontend (`.env.local`)

```
VITE_API_URL=<Lambda Function URL — printed by CDK after deploy>
VITE_COGNITO_USER_POOL_ID=<from CDK output>
VITE_COGNITO_APP_CLIENT_ID=<from CDK output>
```

---

## AI Agent

The backend runs a tool-dispatching agentic loop. Claude receives a system prompt and a set of tools, then decides which to call based on the question. The loop runs up to 5 iterations and always ends when Claude calls `submit_answer`.

### Agent flow

```
Request (question + optional base64 image)
  │
  ▼
Claude (ConverseCommand) — selects tools
  │
  ├── lookup_curriculum (optional)     → local data, zero Bedrock cost
  ├── fetch_session_history (optional) → S3 read; only if studentId present
  ├── solve_question                   → calls pipeline.solve() via Bedrock
  ├── explain_solution (optional)      → calls pipeline.explain() via Bedrock
  ├── generate_hint (optional)         → calls pipeline.generateHint() via Bedrock
  └── submit_answer (terminal)         → ends loop, returns AgentResult
```

### Tools

| Tool                    | Description                                                        | Bedrock call? |
| ----------------------- | ------------------------------------------------------------------ | ------------- |
| `solve_question`        | Solves step by step using subject/year-appropriate prompts         | Yes           |
| `explain_solution`      | Rewrites answer in friendly, age-appropriate language              | Yes           |
| `generate_hint`         | Produces 2–3 Socratic hints                                        | Yes           |
| `lookup_curriculum`     | Returns Australian Curriculum outcomes for subject + year          | No (local)    |
| `fetch_session_history` | Fetches 3 most recent sessions for the student from S3             | No (S3)       |
| `submit_answer`         | Terminal tool — provides the final `AgentResult` and ends the loop | No            |

### Streaming events (NDJSON)

Each line of the response body is a JSON-encoded `StreamEvent`:

| Type         | Payload                | When                                            |
| ------------ | ---------------------- | ----------------------------------------------- |
| `tool_start` | `{ toolName }`         | Before each tool dispatch                       |
| `tool_end`   | `{ toolName, result }` | After each tool completes                       |
| `complete`   | `AgentResult`          | When `submit_answer` is called                  |
| `error`      | `{ message }`          | On auth failure, validation error, or exception |

### Cost behaviour

The system prompt tells Claude to be cost-conscious: skip `explain_solution` for simple factual answers, call `fetch_session_history` only when a `studentId` is present, and call `solve_question` once. Typical request: **3–6 Bedrock calls total**.

---

## Backend — Lambda

### File: `backend/src/handler.ts`

Responsibilities:

1. **Authenticate** — validate the Cognito access token from `Authorization: Bearer <token>`. Rejects with an `error` event if missing or invalid. Extracts student ID from the verified JWT `sub` claim (never trusts the request body for identity).
2. **Parse and validate** — extract `question` (string, required, max 2000 chars) and `image` (base64 string, optional) from the request body.
3. **Stream response** — opens an `HttpResponseStream` with CORS headers and writes NDJSON events.
4. **Run agent** — calls `runAgent()`, forwarding each streaming event to the client.
5. **Persist session** — calls `saveSession()` after the agent completes, keyed as `sessions/{studentId}/{sessionId}.json`.

### File: `backend/src/agent.ts`

The agentic loop. Iterates up to 5 times calling `ConverseCommand`, dispatches tools on each turn, and emits `tool_start`/`tool_end` events to the stream. Ends when Claude calls `submit_answer` or max iterations is reached.

Exports:

- `runAgent(question, studentId, image?, onEvent)` → `AgentResult`
- `TOOL_SCHEMA` — array of 6 tool definitions
- `dispatchTool(name, input, studentId?)` — routes tool calls to pipeline / curriculum / storage

### File: `backend/src/pipeline.ts`

Three async functions, each making a direct `InvokeModelCommand` call. Prompts use a two-dimension system: **domain skill** (subject-specific) × **tone skill** (year-level-appropriate):

- `solve(question, subject, difficulty)` → `{ answer, steps[] }` — temperature 0
- `explain(answer, steps, difficulty)` → `{ explanation }` — temperature 0.3
- `generateHint(question, subject, difficulty)` → `{ hints: string[] }` — temperature 0.3

### File: `backend/src/bedrock.ts`

Two exports:

```typescript
// Direct invocation — used by pipeline.ts
export async function callClaude(
  prompt: string,
  temperature: number,
): Promise<string>;

// Tool-use conversation — used by agent.ts
export async function converseWithTools(
  messages: BedrockMessage[],
  tools: Tool[],
  system: string,
): Promise<ConverseResponse>;
```

Both apply the Bedrock Guardrail when `BEDROCK_GUARDRAIL_ID` is set.

### File: `backend/src/storage.ts`

```typescript
// Persist a completed session
export async function saveSession(
  sessionId: string,
  data: object,
  studentId?: string,
): Promise<void>; // Key: sessions/{studentId}/{sessionId}.json

// Fetch the most recent sessions for personalisation
export async function getRecentSessions(
  studentId: string,
  limit?: number, // default 3
): Promise<object[]>;
```

---

## Frontend

### Key components

| Component       | Purpose                                               |
| --------------- | ----------------------------------------------------- |
| `QuestionInput` | Text area + image upload (base64 encode on select)    |
| `ResultCard`    | Displays subject badge, answer, and step-by-step list |
| `StepList`      | Numbered steps with expand/collapse                   |
| `LoadingState`  | Skeleton UI while waiting for response                |

### Image handling

Convert the uploaded file to base64 in the browser before sending:

```typescript
const toBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
```

Send the base64 string in the request body. Do not upload to S3 directly from the frontend.

### API call shape

```typescript
POST <VITE_API_URL>
Content-Type: application/json
Authorization: Bearer <Cognito access token>

{
  "question": "What is the quadratic formula?",
  "image": "<base64 string | null>"
}
```

The response is a streaming NDJSON body. Parse each newline-delimited JSON object as a `tool_start`, `tool_end`, `complete`, or `error` event.

Enforce a max image size of 4 MB client-side before encoding.

---

## Infrastructure (CDK)

### `infra/lib/stack.ts` — resources deployed

1. **S3 bucket**
   - Block all public access
   - 30-day lifecycle expiry on `sessions/` prefix
   - Auto-delete on stack destroy (demo only)

2. **Bedrock Guardrail**
   - Filters: HATE, INSULTS, SEXUAL, VIOLENCE (HIGH both directions)
   - Word policy: PROFANITY managed list
   - PII blocking: NAME, EMAIL, PHONE, ADDRESS, AGE
   - Topic deny: off-topic requests, roleplay, code generation, jailbreaks

3. **Cognito User Pool**
   - Email sign-in with auto-verification; self-signup enabled
   - SPA App Client (no secret, ALLOW_USER_SRP_AUTH)
   - User Pool ID + Client ID output as CDK stack outputs

4. **Lambda function**
   - Runtime: `nodejs24.x`, memory: 512 MB, timeout: **5 minutes**
   - Reserved concurrency: **10** (primary cost and abuse throttle)
   - Response streaming enabled
   - All 9 environment variables set by CDK
   - IAM: `bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream`, `bedrock:ApplyGuardrail`, `s3:PutObject`, `s3:GetObject` on `sessions/*`

5. **Lambda Function URL**
   - Invocation mode: `RESPONSE_STREAM`; auth type: `NONE` (Cognito validated inside Lambda)
   - CORS: POST allowed from `*`, headers `Content-Type` + `Authorization`
   - Function URL output as CDK stack output

6. **Bedrock invocation logging**
   - CloudWatch log group (30-day retention) + service role via CDK custom resource
   - Enables model-level request/response auditing

### IAM policy for Bedrock

```typescript
fn.addToRolePolicy(
  new iam.PolicyStatement({
    actions: [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
      "bedrock:ApplyGuardrail",
    ],
    resources: [
      `arn:aws:bedrock:${region}::foundation-model/${HAIKU_45_MODEL_ID}`,
      guardrail.attrGuardrailArn,
    ],
  }),
);
```

---

## Request Size Limits

| Layer                   | Limit                             |
| ----------------------- | --------------------------------- |
| Client-side image guard | 4 MB before base64 encoding       |
| Lambda Function URL     | 20 MB (streaming invocation mode) |
| Lambda request body     | 20 MB                             |

Base64 encoding inflates size by ~33%. A 4 MB image becomes ~5.3 MB — safely within the 20 MB limit.

---

## Getting Started

```bash
# Install all dependencies
npm install

# Deploy infrastructure (first time)
cd infra
npx cdk bootstrap
npx cdk deploy

# CDK outputs:
#   AiHomeworkHelperStack.FunctionUrl    → VITE_API_URL
#   AiHomeworkHelperStack.UserPoolId     → VITE_COGNITO_USER_POOL_ID
#   AiHomeworkHelperStack.AppClientId    → VITE_COGNITO_APP_CLIENT_ID

# Copy the above values into frontend/.env.local, then start the frontend:
npm run dev
```

---

## What to Add in Production

- **Rate limiting:** AWS WAF or tighten reserved-concurrency (currently capped at 10)
- **Richer personalisation:** DynamoDB keyed by `userId` instead of flat S3 objects
- **Quiz generation:** Post-solve step that generates 3 practice questions
- **Frontend auth flow:** Sign-up/sign-in UI using `amazon-cognito-identity-js`

---

## Cost Profile (estimated, low usage)

| Service             | Cost driver                                | Estimate                  |
| ------------------- | ------------------------------------------ | ------------------------- |
| Bedrock (Haiku 4.5) | 3–6 Bedrock calls × ~1K tokens per request | ~$0.001–$0.003 / question |
| Lambda              | Pay per invocation + duration              | Negligible                |
| Cognito             | Free tier: 50,000 MAU                      | $0                        |
| S3                  | Storage + requests                         | < $0.01/month for demo    |

**Total: under $1/month for typical portfolio demo usage.**

## Todo

- select AI models
- MFA
- Update curriculum logic
- Expand to year 12
