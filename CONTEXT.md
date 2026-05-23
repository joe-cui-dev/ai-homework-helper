# Domain Context

## Terms

### Session
One persisted unit of AI interaction. Stored at `sessions/{studentId}/{sessionType}/{sessionId}.json` with a 30-day lifecycle. Each session maps to one history card. See [ADR 0004](docs/adr/0004-unified-session-model.md) (data model) and [ADR 0005](docs/adr/0005-session-key-includes-type.md) (key layout).

A Session is a discriminated union on `sessionType` with four peer kinds:
- **Homework Session** (`sessionType: "homework"`) — questions are *extracted* from a worksheet image. Holds a `questions` array of `{ input, packet }` (CoachingPacket). Written once.
- **Reading Session** (`sessionType: "reading"`) — questions are *generated* by the AI from a book the parent uploads. Holds a `bookContext` and `readingPackets` (ReadingPacket). Written once.
- **Writing Session** (`sessionType: "writing"`) — multi-turn coaching for one writing assignment. The same S3 object is **mutated across HTTP requests** (plan turn, then 1..N draft turns and 0..N question turns). Holds `prompt`, `plan` (WritingPlan), `turns`, and per-variant `status`/`endedReason`.
- **Practice Session** (`sessionType: "practice"`) — multi-turn tutoring loop spawned from a Homework question. Holds an `origin: { sessionId, questionId }` reference, the source CoachingPacket snapshot, `problems`, `toolLog`, and per-variant `status`/`endedReason`. Practice is a top-level Session kind, not a child of Homework.

For Writing and Practice, raw Bedrock conversation state (`messages[]`, per-turn raw usage) lives in a **sidecar** S3 object at `sessions/{studentId}/{sessionType}/{sessionId}.agent.json`. The user-facing Session JSON contains no Bedrock implementation detail.

### Reading Session
A session where the parent uploads a book (cover + a few pages of content) and the AI generates 5 grounded comprehension questions instead of solving an existing homework problem. The reader of the output is still the Parent-as-Coach. Reading-question generation is *always* grounded in the uploaded pages — generating from cover-only training-data knowledge is forbidden (see ADR 0002). If the AI judges the uploaded pages too thin to write 5 quality questions, it streams a `needs_more_pages` event with a specific request to the parent and saves no session.

### Book Context
Optional metadata attached to a Reading Session: `{ title?, author? }`, populated by Claude only when clearly readable from the cover image. Both fields are omitted when unreadable rather than guessed. Shown in the history card and the result page header.

### Reading Packet
The per-question output for a Reading Session. Sibling of CoachingPacket, with reading-flavoured field semantics:
- `questionType` — `literal` | `inference` | `vocabulary` (the Comprehension Skill targeted)
- `questionText` — phrased so the parent can read aloud verbatim, calibrated to year level
- `modelAnswer` — what a strong answer looks like, grounded in the uploaded pages
- `comprehensionSkill` — adult-to-adult: which sub-skill this question tests and why
- `coachingTip` — adult-to-adult action-oriented guidance for the parent
- `commonMisreadings` — wrong/partial answers a child of this year level often gives
- `discussionPrompt` — Socratic prompt the parent reads if the child is stuck
- `pageReference` — optional pointer to where the answer is in the uploaded pages

Year level is inferred per session (from the cover artwork + page complexity) rather than per question, because the whole book targets one audience.

### Comprehension Skill
The reading sub-skill a Reading Packet targets, set in `questionType`:
- **literal** — find-the-fact in the text
- **inference** — read between the lines (motivation, cause/effect, prediction)
- **vocabulary** — what a word means *here*, in context

A Reading Session aims for ~2 literal, ~2 inference, ~1 vocabulary, but the AI has leeway when the pages don't support a balanced mix.

### Question
A single extracted question within a session, with its own `input`, `subject`, `difficulty`, `answer`, `steps`, `explanation`, and optional `hints`. A session always has at least one question.

### Session History
A browsable list of a student's past sessions, ordered newest-first. Distinct from the agent's internal `fetch_session_history` tool, which retrieves the 3 most recent sessions for personalisation context. The history browser surfaces sessions to the student via the UI.

### History Browser
The parent-facing UI feature for reviewing past sessions, scoped to a single module. Each of the Homework, Reading, and Writing pages renders its own History button that opens a sliding sidebar (collapsible drawer on mobile) showing only that module's sessions. Practice sessions are not browsed directly — they appear as siblings nested under their origin Homework card. Cards show subject badges (Homework only), truncated question preview, and uploaded image thumbnails. Paginated at 10 sessions per page, filtered server-side via `?type=homework|reading|writing`.

### Session Card
A single entry in the history browser representing one session (batch). Displays: all distinct subject badges, timestamp, first question's text truncated to 2 lines, a "+N more" badge when there are additional questions, and uploaded image thumbnails.

### Image Key
The S3 object key for an uploaded image associated with a session. Format: `sessions/{studentId}/{sessionType}/{sessionId}/image-{i}.{ext}` (Homework, Reading) or `sessions/{studentId}/writing/{sessionId}/{role}-{turnIndex?}-image-{i}.{ext}` (Writing — `prompt-image-0.jpeg`, `draft-2-image-0.jpeg`). Stored once per session — all questions within the session share the same image keys. Distinct from the base64 data URL used during request processing — the key is a stable S3 reference; the data URL is transient.

### Pre-signed URL
A time-limited S3 URL granting temporary read access to a specific image object. Generated by the history Lambda with a 1-hour expiry. Used by the frontend to render images in session cards without exposing AWS credentials.

### studentId
The unique identifier for a student, extracted exclusively from the `sub` claim in the Cognito JWT. Never supplied by the client directly — prevents spoofing.

### sessionId
The session's stable UUID identifier and the S3 key stem within its `sessionType` prefix (`sessions/{studentId}/{sessionType}/{sessionId}.json`). One identifier name for all four session kinds — there is no longer a separate "batchId".

### Homework Page
The `/homework` route — entry point for submitting homework images and receiving Coaching Packets. Backed by `HomeworkFunction` (Lambda).

### Reading Page
The `/reading` route — entry point for submitting book cover + pages and receiving Reading Packets. Backed by `ReadingFunction` (Lambda).

### Practice Page
The `/practice/:sessionId` route — full-page tutor loop linked from a Coaching Packet result. `sessionId` is the Practice Session's own UUID; the originating Homework question is recorded inside the session as `origin: { sessionId, questionId }`. Backed by `PracticeFunction` (Lambda).

### Writing Page
The `/writing` route — entry point for starting a new Writing Session (paste or photograph the assignment) and resuming any active Writing Sessions. Backed by `WritingFunction` (Lambda).

### Writing Session Page
The `/writing/:sessionId` route — the in-session view used both immediately after starting a session (the parent is redirected here from `/writing`) and to resume an active session from the history sidebar. Renders the Writing Plan, the chronological transcript of all draft and question turns, and the next-turn affordances.

### Writing Session
A session where the parent uploads a writing assignment prompt, receives a Writing Plan to coach the child through the writing, then submits the child's draft(s) for Draft Feedback over multiple turns. Distinguished from Homework and Reading Sessions by being **mutable across HTTP requests** rather than written once. The same S3 object is read-modified-written per turn. Capped at 5 draft turns and 3 question turns; auto-abandons after 24 h of inactivity. `sessionType: "writing"`.

### Writing Plan
The turn-1 output of a Writing Session — the **parent's coaching plan** for this assignment, not the kid's outline. Tells the parent what success looks like, what to ask the child before writing, what pitfalls to anticipate, and what to do during writing. Holds a pair of `modelAnswers` (see Model Answers) gated behind a UI disclosure. Genre is inferred at turn 1 and locked. Year level is either provided by the parent on the landing page or, if absent, inferred at turn 1; either way it is locked for the rest of the session, and `yearLevelSource: "user" | "inferred"` records which path produced it.

### Model Answers
A pair of student-voice exemplars produced at turn 1 of a Writing Session: `atYearLevel` (calibrated exactly to the locked year level) and `aboveYearLevel` (one year above, capped at Year 6 — at Year 6 the stretch sample stays at Year 6 but is labelled "upper Year 6"). Both meet the success criteria; the stretch sample shows the upper proficiency band through richer vocabulary, sharper genre conventions, and more sentence variety. Both prose samples are gated behind a UI disclosure. Accompanied by `whyAboveIsBetter` — a short adult-to-adult comparison (1–3 sentences) citing concrete moves that make the stretch sample stronger; rendered alongside the stretch sample inside the same disclosure.

### Draft Feedback
The draft-turn output of a Writing Session. Strength-first ("two stars"), priority-disciplined ("one wish") writing-conference feedback for the Parent-as-Coach. Carries a verbatim `transcription` of the draft (preserving misspellings — separates handwriting OCR errors from writing-skill judgments), a 4-trait rubric (1–4 per trait, plus a categorical `overallBand`), year-level-calibrated mechanics notes, and a discriminated `nextStep` (`revise_with_focus` | `ready_for_final_read_aloud` | `needs_replanning`). Never `ready_to_submit` — that judgment belongs to the parent.

### Coaching Note
The question-turn output of a Writing Session. The parent's escape hatch for clarifying questions during a writing assignment. By policy the system prompt refuses to produce any content the child could copy verbatim into their draft; instead the answer redirects to Socratic guidance and points to the gated `modelAnswers` on the WritingPlan.

### Genre
The kind of writing an assignment calls for — `narrative` | `persuasive` | `recount` | `descriptive` | `information_report` | `explanation` | `procedure` | `other`. Inferred by Claude from the prompt at turn 1 of a Writing Session and locked for the session. Drives the success criteria, the rubric descriptors, and the planning questions.

### Parent-as-Coach
The primary reader of the app's output. The parent reads the answer privately and then teaches the child in their own words. The student is the *subject* of the homework but not the direct reader of the AI output. This shapes tone (adult-to-adult, concise), structure (must include teaching guidance, not just answers), and what success looks like (the child learns from the parent, not from the screen).

### Coaching Packet
The per-question output delivered to the Parent-as-Coach. Replaces the old `{ answer, steps, explanation, hints }` shape. Fields:
- `tldrAnswer` — the answer in one short sentence
- `whyItWorks` — the underlying concept the question is testing (one paragraph, adult-to-adult)
- `howToCoach` — what the parent should *do/say* with the child (instructional, not narration)
- `watchFor` — common wrong answers and misconceptions a child of this year level might fall into (array)
- `childHint` — a Socratic prompt the parent can read aloud verbatim if the child is stuck

Year level still drives complexity calibration (a Year-1 `childHint` is concrete and short; a Year-6 one can use subject vocabulary), but the parent-facing fields stay in adult voice regardless.
