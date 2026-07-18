# AI Homework Helper

A serverless, parent-led AI coaching app for Australian primary-school students (Years 1–6). Parents sign in with an invite-only Cognito account, submit learning material, and receive guidance they can use to coach their child.

## What it provides

- **Homework** — upload a worksheet or enter questions; the app extracts questions and creates one `CoachingPacket` for each.
- **Reading** — upload a book cover and pages; the app creates five comprehension `ReadingPacket`s grounded only in those pages.
- **Writing** — start from an assignment prompt, receive a parent coaching plan, then return with drafts or clarifying questions in the same Writing Session.
- **Practice** — launch an adaptive, multi-turn tutor from a Homework question.

Parents choose **Fast** (Claude Haiku 4.5) or **Advanced** (Claude Sonnet 4.6) when starting Homework, Reading, or Writing. The choice is retained for that Session; Practice inherits it from its source Homework Session.

## Architecture

```text
React SPA (CloudFront + S3)
        |
        +-- Cognito: invite-only Parent Accounts with required SMS MFA
        |
        +-- Lambda Function URLs: Homework, Reading, Writing, Practice, History
                |
                +-- Amazon Bedrock: Fast / Advanced models and Guardrails
                +-- S3: session records, agent sidecars, uploaded images
```

All POST coaching endpoints stream NDJSON responses. Homework and Reading are one-shot pipelines; Writing keeps session-level state across requests; Practice may call its tutoring tools repeatedly within a turn. Session data expires after 30 days.

## Prerequisites

- Node.js 22+
- AWS CLI credentials for the target account
- Bedrock access to the configured Claude Haiku 4.5 and Claude Sonnet 4.6 inference profiles
- An ACM certificate for the configured site domain in `us-east-1`; see `infra/bin/app.ts` for the required infrastructure configuration

## Getting started

```bash
npm install

# Copy the frontend template and add the deployed CDK output values.
cp frontend/.env.local.example frontend/.env.local

# Start the SPA locally at http://localhost:5173.
npm run dev
```

After deployment, copy these CDK outputs into `frontend/.env.local`: `HomeworkApiUrl`, `ReadingApiUrl`, `WritingApiUrl`, `PracticeApiUrl`, `HistoryApiUrl`, `UserPoolId`, and `UserPoolClientId`. See [frontend/.env.local.example](frontend/.env.local.example) for the exact variable names.

To build and deploy the SPA and infrastructure together:

```bash
npm run deploy
```

## Repository layout

```text
ai-homework-helper/
├── backend/src/
│   ├── homework/        # Worksheet analysis and coaching packets
│   ├── reading/         # Grounded book comprehension packets
│   ├── writing/         # Multi-turn writing coaching
│   ├── practice/        # Adaptive tutor loop
│   ├── history/         # Per-module session history
│   └── shared/          # Bedrock, sessions, storage, curriculum, logging
├── frontend/            # React + Vite SPA
├── infra/               # AWS CDK stack and frontend deployment
├── CONTEXT.md           # Domain glossary
└── docs/adr/            # Architecture decision records
```

## Commands

```bash
npm run dev              # Run the frontend development server
npm run build            # Build the frontend
npm test                 # Run workspace tests
npm run deploy           # Build the frontend and deploy the CDK stack

cd backend && npm run build
cd backend && npm test
cd infra && npm run synth
```

## Safety and privacy

Every backend endpoint verifies a Cognito access token and derives the account-scoped `studentId` from the token's `sub` claim; clients cannot choose it. Bedrock Guardrails apply content, PII, prompt-attack, and off-topic protections to model calls. The authenticated identity is a Parent Account, while the child is the subject of the coaching.

See [CONTEXT.md](CONTEXT.md) for canonical domain language and [docs/adr](docs/adr) for the durable design decisions.
