# AI Homework Helper — Execution Plan

## Overview

A serverless, multimodal AI homework assistant. Students submit a question as text or a photo; the app returns a step-by-step explanation. Built as a portfolio project prioritising simplicity and low cost.

---

## Key Design Decisions

| Decision        | Choice                  | Reason                                     |
| --------------- | ----------------------- | ------------------------------------------ |
| AI pipeline     | Sequential 3-step chain | Simpler and cheaper than a full agent loop |
| Image input     | Base64 in request body  | Removes presigned URL round-trip           |
| OCR             | Claude native vision    | No Textract needed                         |
| History storage | S3 JSON objects         | No DynamoDB table to manage                |
| Auth            | None (public demo)      | Add Cognito in production                  |
| Monorepo        | npm workspaces          | Single `npm install` at root               |

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

- **Frontend:** React 18, Vite, TypeScript, Material UI
- **Backend:** AWS Lambda, Node.js 20, TypeScript
- **Infrastructure:** AWS CDK v2
- **AI:** Amazon Bedrock — Claude Haiku 4.5
- **Storage:** S3 (image input + session history as JSON)
- **API:** API Gateway HTTP API

---

## Environment Variables

### Backend Lambda

```
BEDROCK_MODEL_ID=anthropic.claude-haiku-3-5-20241022-v1:0
S3_BUCKET_NAME=<deployed bucket name>
```

### Frontend (`.env.local`)

```
VITE_API_URL=<API Gateway endpoint after deploy>
```

---

## AI Pipeline

All logic runs inside a single Lambda function. No agent runtime. Three sequential Bedrock calls per request.

```
Request (text + optional base64 image)
  │
  ▼
Step 1 — Classify
  Prompt: Identify the subject (math, science, english, other)
  and difficulty level (primary, secondary, other).
  Return JSON: { subject, difficulty }
  │
  ▼
Step 2 — Solve
  Prompt: Given subject and difficulty, solve the problem.
  Include the image in this call if provided.
  Return JSON: { answer, steps[] }
  │
  ▼
Step 3 — Explain
  Prompt: Rewrite the solution in simple, encouraging language
  for a student at the identified level.
  Return JSON: { explanation }
  │
  ▼
Persist to S3 (async, fire-and-forget)
  Key: sessions/{uuid}.json
  Content: { input, subject, difficulty, answer, steps, explanation, timestamp }
  │
  ▼
Response to frontend
  { subject, difficulty, answer, steps, explanation, sessionId }
```

### Prompt guidelines

- Each prompt requests JSON-only output (no markdown fences).
- Include `max_tokens: 1024` per call.
- Pass `temperature: 0` for deterministic classification, `0.3` for explanation.
- System prompt on every call: `"You are a helpful homework tutor for school students. Always respond in JSON."`

---

## Backend — Lambda

### File: `backend/src/handler.ts`

Responsibilities:

1. Parse request body — extract `question` (string) and `image` (base64 string, optional).
2. Run the 3-step pipeline via `pipeline.ts`.
3. Persist result to S3 asynchronously.
4. Return JSON response.

### File: `backend/src/pipeline.ts`

Export three async functions:

- `classify(question, imageBase64?)` → `{ subject, difficulty }`
- `solve(question, subject, difficulty, imageBase64?)` → `{ answer, steps }`
- `explain(answer, steps, difficulty)` → `{ explanation }`

Each function calls Bedrock using the `@aws-sdk/client-bedrock-runtime` `InvokeModelCommand`.

### File: `backend/src/bedrock.ts`

Single helper:

```typescript
export async function callClaude(
  prompt: string,
  imageBase64?: string,
): Promise<string>;
```

Builds the `messages` array. If `imageBase64` is provided, include it as:

```json
{
  "type": "image",
  "source": {
    "type": "base64",
    "media_type": "image/jpeg",
    "data": "<base64 string>"
  }
}
```

### File: `backend/src/storage.ts`

```typescript
export async function saveSession(
  sessionId: string,
  data: object,
): Promise<void>;
```

Writes `sessions/{sessionId}.json` to S3 using `PutObjectCommand`. Call with `await` inside the handler but do not block the response — use `void saveSession(...)` pattern.

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
POST /solve
Content-Type: application/json

{
  "question": "What is the quadratic formula?",
  "image": "<base64 string | null>"
}
```

Enforce a max image size of 4 MB client-side before encoding.

---

## Infrastructure (CDK)

### `infra/lib/stack.ts` — resources to create

1. **S3 bucket**
   - Block all public access
   - Lifecycle rule: expire objects under `sessions/` prefix after 30 days
   - CORS rule allowing PUT/GET from the frontend origin

2. **Lambda function**
   - Runtime: `nodejs24.x`
   - Memory: 512 MB
   - Timeout: 30 seconds
   - Environment variables: `BEDROCK_MODEL_ID`, `S3_BUCKET_NAME`
   - IAM: grant `bedrock:InvokeModel` on the Haiku model ARN, grant `s3:PutObject` on the sessions prefix

3. **API Gateway HTTP API**
   - Single route: `POST /solve` → Lambda integration
   - CORS enabled for the frontend origin
   - Output the endpoint URL as a CDK stack output

### IAM policy for Bedrock

```typescript
fn.addToRolePolicy(
  new iam.PolicyStatement({
    actions: ["bedrock:InvokeModel"],
    resources: [
      `arn:aws:bedrock:${region}::foundation-model/anthropic.claude-haiku-4-5-xxx`,
    ],
  }),
);
```

---

## Request Size Limits

| Layer                   | Limit                          |
| ----------------------- | ------------------------------ |
| Client-side image guard | 4 MB before base64 encoding    |
| API Gateway payload     | 10 MB (default HTTP API limit) |
| Lambda request body     | 10 MB                          |

Base64 encoding inflates size by ~33%. A 4 MB image becomes ~5.3 MB — safely within limits.

---

## Getting Started

```bash
# Install all dependencies
npm install

# Start frontend locally
npm run dev

# Deploy infrastructure (first time)
cd infra
npx cdk bootstrap
npx cdk deploy

# Copy the API Gateway URL from CDK outputs into frontend/.env.local
```

---

## What to Add in Production

- **Auth:** Amazon Cognito user pool + API Gateway authorizer
- **Rate limiting:** API Gateway usage plan
- **Streaming responses:** Bedrock `InvokeModelWithResponseStream`
- **Personalisation:** Per-user history (DynamoDB keyed by `userId`)
- **Quiz generation:** Post-solve step that generates 3 practice questions

---

## Cost Profile (estimated, low usage)

| Service             | Cost driver                      | Estimate               |
| ------------------- | -------------------------------- | ---------------------- |
| Bedrock (Haiku 4.5) | ~3 calls × 1K tokens per request | ~$0.001 per question   |
| Lambda              | Pay per invocation               | Negligible             |
| API Gateway         | Pay per request                  | Negligible             |
| S3                  | Storage + requests               | < $0.01/month for demo |

**Total: under $1/month for typical portfolio demo usage.**
