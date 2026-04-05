# AI Homework Helper

A serverless AI tutor for Australian primary school students (Years 1–6). Students submit a homework question and receive a step-by-step explanation tailored to their year level.

> **MVP status:** Backend and infrastructure are complete. Frontend is not yet built.

## How it works

The backend runs an agentic loop powered by **Amazon Bedrock (Claude Haiku 4.5)**. For each question the agent:

1. Classifies the subject and year level
2. Optionally looks up relevant Australian Curriculum outcomes
3. Optionally fetches the student's recent session history for personalisation
4. Solves the question step by step
5. Rewrites the solution in age-appropriate language
6. Optionally generates Socratic hints

Responses stream back to the client as NDJSON events over a Lambda Function URL.

## Architecture

```
Client → Lambda Function URL (streaming)
              │
              ├── Amazon Bedrock (Claude Haiku 4.5)
              ├── Amazon Cognito  (JWT auth)
              ├── S3              (session history)
              └── Bedrock Guardrails (content safety)
```

| Layer          | Technology                                        |
| -------------- | ------------------------------------------------- |
| Backend        | AWS Lambda, Node.js 24, TypeScript                |
| AI             | Amazon Bedrock — Claude Haiku 4.5                 |
| Auth           | Amazon Cognito (access token, verified in Lambda) |
| Storage        | S3 — session history as JSON, 30-day expiry       |
| Infrastructure | AWS CDK v2 (TypeScript)                           |
| Logging        | `@aws-lambda-powertools/logger` → CloudWatch Logs |

## Prerequisites

- Node.js 22+
- AWS CLI configured with credentials for your target account
- Bedrock model access enabled for `anthropic.claude-haiku-4-5-20251001-v1:0` in your region

## Getting started

```bash
# Install all workspace dependencies
npm install

# Deploy to AWS
npm run deploy
```

CDK outputs the Lambda Function URL and Cognito IDs after a successful deploy.

## Configuration

All environment variables are set by CDK — you don't need a `.env` file.

| Variable                | Set by                      | Description                       |
| ----------------------- | --------------------------- | --------------------------------- |
| `BEDROCK_MODEL_ID`      | CDK                         | Bedrock model identifier          |
| `S3_BUCKET_NAME`        | CDK                         | Session history bucket            |
| `BEDROCK_GUARDRAIL_ID`  | CDK                         | Guardrail for content safety      |
| `COGNITO_USER_POOL_ID`  | CDK                         | Cognito User Pool                 |
| `COGNITO_APP_CLIENT_ID` | CDK                         | Cognito App Client                |
| `ALLOWED_ORIGIN`        | CDK context `allowedOrigin` | CORS allowed origin (default `*`) |
| `SERVICE_NAME`          | CDK                         | Powertools service name           |
| `LOG_LEVEL`             | CDK context `logLevel`      | Log verbosity (default `INFO`)    |

To override context values at deploy time:

```bash
cdk deploy --context logLevel=DEBUG --context allowedOrigin=https://example.com
```

## Repo structure

```
ai-homework-helper/
├── package.json          # npm workspaces root
├── backend/
│   └── src/
│       ├── handler.ts    # Lambda entry point (streaming)
│       ├── agent.ts      # Bedrock agentic loop
│       ├── pipeline.ts   # Solve / explain / hint skills
│       ├── bedrock.ts    # Bedrock SDK wrappers
│       ├── storage.ts    # S3 session read/write
│       ├── curriculum.ts # Australian Curriculum data (local)
│       ├── logger.ts     # Powertools logger singleton
│       └── types.ts      # Shared types
├── frontend/             # Not yet built
└── infra/
    ├── bin/app.ts        # CDK app entry point
    └── lib/stack.ts      # Full stack definition
```

## Running tests

```bash
cd backend && npm test
```

## Safety

Content safety is enforced at two layers:

- **Bedrock Guardrails** — blocks harmful content, profanity, PII, and off-topic requests before they reach the model
- **Cognito JWT validation** — every request requires a valid access token; the student ID is always taken from the verified token, never from the request body
