# Domain Context

## Terms

### Session
One persisted unit of AI interaction. Stored at `sessions/{studentId}/{sessionType}/{sessionId}.json` with a 30-day lifecycle. Each session maps to one history card. See [ADR 0004](docs/adr/0004-unified-session-model.md) (data model) and [ADR 0005](docs/adr/0005-session-key-includes-type.md) (key layout).

A Session is a discriminated union on `sessionType` with four peer kinds:
- **Homework Session** (`sessionType: "homework"`) — one homework task whose questions are *extracted* from worksheet images. It may receive multiple page submissions over time; later pages, their questions, and their Coaching Packets remain part of the same Session. It may temporarily contain Page Context without a complete Question while waiting for the parent to add the problem pages. One submission contains at most 5 images, one Session contains at most 10 images, and one Session contains at most 30 complete Questions.
- **Reading Session** (`sessionType: "reading"`) — questions are *generated* by the AI from a book the parent uploads. Holds a `bookContext` and `readingPackets` (ReadingPacket). Written once.
- **Writing Session** (`sessionType: "writing"`) — multi-turn coaching for one writing assignment. The same S3 object is **mutated across HTTP requests** (plan turn, then 1..N draft turns and 0..N question turns). Holds `prompt`, `plan` (WritingPlan), `turns`, and per-variant `status`/`endedReason`.
- **Practice Session** (`sessionType: "practice"`) — multi-turn tutoring loop spawned from a Homework Question. Holds an `origin: { sessionId, questionId }` reference, the source CoachingPacket snapshot, `problems`, `toolLog`, and per-variant `status`/`endedReason`. A Homework Question may have multiple Practice Sessions over time, but at most one may be active at a time; a new Practice Session starts only after the previous one has ended or been abandoned. Practice remains a top-level Session kind rather than stored as a child of Homework.

For Writing and Practice, raw Bedrock conversation state (`messages[]`, per-turn raw usage) lives in a **sidecar** S3 object at `sessions/{studentId}/{sessionType}/{sessionId}.agent.json`. The user-facing Session JSON contains no Bedrock implementation detail.

### Model Choice
The parent-selected AI quality/cost profile used for all AI calls in one Session: **Fast** for quicker, cheaper coaching, or **Advanced** for deeper coaching. A Model Choice is locked when the Session starts; Writing keeps the same choice across all later turns, and Practice inherits the choice from its origin Homework Session. The profile is a stable product choice rather than a particular model implementation.

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
A single homework prompt within a Session, which may be contained on one page, continue across pages, or appear in overlapping photos. A later page is merged into an existing Question only when the match is confident; that Question may be revised while its `questionId` remains stable. An uncertain match is preserved as a new Question and identified as possibly repeated rather than risking an incorrect overwrite. `subject` and `yearLevel` live on the Question rather than its Coaching Packet — see [ADR 0006](docs/adr/0006-slim-coaching-packet.md).

### Page Context
The durable semantic representation of one page in a Homework Session. It preserves the page's text, mathematical notation, tables, and descriptions of diagrams or other visual structure needed to understand questions on later pages. Later submissions use Page Context by default; when it is insufficient to resolve a specific visual reference, the referenced earlier image may be interpreted again as a targeted fallback.

_Avoid_: OCR text, article context

### Page Submission
One parent action that adds between 1 and 5 images to the Homework Session currently shown on the result page. It is accepted as a whole only after its Page Contexts, Question changes, Coaching Packets, and durable Session state are ready; a submission that adds useful Page Context but no new or revised Question still succeeds. A limit violation or processing failure leaves the existing Session unchanged so the parent can retry. Retrying the same Page Submission returns its established outcome without duplicating pages, Questions, or AI work. Once processing begins, the parent waits for that outcome rather than cancelling the submission midway.

_Avoid_: Batch, follow-up upload

### Session History
A browsable list of a student's Sessions ordered by recent activity. A Homework Session with Page Context but no complete Question is omitted because it has no reviewable coaching result and cannot be continued from history. Active Writing Sessions appear first, ordered by `updatedAt`; all other Sessions follow in descending `updatedAt` order. One History Browser visit presents a stable snapshot: later Session activity appears after the parent refreshes the browser rather than being inserted between pages during that visit. If a selected Session is no longer accessible, its stale card is removed from the current snapshot without revealing whether the Session expired, never existed, or belongs to another Parent Account. Session History is distinct from the agent's internal `fetch_session_history` tool, which retrieves the 3 most recent sessions for personalisation context. The History Browser surfaces Session History to the parent.

### History Browser
The parent-facing UI feature for reviewing past sessions, scoped to a single module. Each of the Homework, Reading, and Writing pages renders its own History button that opens a sliding sidebar (collapsible drawer on mobile) showing only that module's sessions. Practice sessions are not browsed directly and do not appear on Session Cards; they appear as related activity inside the Session Detail of their origin Homework Session. The browser initially presents Session Cards, and their review content opens as Session Detail on demand. An active Writing Session Card additionally offers an explicit Resume action as its primary workflow action, separate from reviewing its Session Detail.

### Session Card
A compact summary of one Session in the History Browser. Every Session Card carries the Session's recent activity time, Model Choice, image count, and at most one representative thumbnail. A Homework Session Card adds distinct subjects, the first Question preview, and Question count. A Reading Session Card adds readable Book Context and Question count. A Writing Session Card adds the assignment summary, status and ended reason, and draft and question counts. Token usage, Coaching Packets, Reading Packets, Writing turns, Practice status, and other review content belong to Session Detail rather than the Session Card. For Homework the representative image is the first worksheet image; for Reading it is the book cover; for Writing it is the first assignment-prompt image.

### Session Detail
The complete parent-facing review of one Session, read at the time the parent selects its Session Card. Session Detail shows the Session's latest state even when its card came from an earlier stable Session History snapshot. Every Session Detail carries Model Choice, cumulative usage, and parent-facing images. A Homework Session Detail contains every original image from its accepted Page Submissions and the final version of every Question and Coaching Packet, grouping a Practice Summary for every associated Practice Session under its origin Question in recent-activity order; internal Page Context is not shown. A Reading Session Detail contains Book Context and every Reading Packet. A Writing Session Detail contains the assignment prompt, Writing Plan, chronological draft and question turns, status and ended reason, and turn counts. If an associated image is temporarily unavailable, the rest of the Session Detail remains available and the missing image is represented as unavailable. Session Detail excludes Parent Account identifiers, Image Keys, Bedrock messages, sidecars, internal tool logs, and storage metadata; it is distinct from both the compact Session Card and the persisted Session itself.

### Practice Summary
A parent-facing review summary of one Practice Session as it appears inside its origin Homework Session Detail. It includes the Practice Session's recent activity time, status and ended reason, problem count, final summary, Model Choice, usage, and the appropriate resume or start-again action. It excludes raw Bedrock messages, tool payloads, the internal tool log, prompts, and other agent implementation detail.

### Image Attachment
A parent-supplied image staged as part of a new Session or a Writing draft turn. It becomes durable only when the submission succeeds, at which point it is represented internally by an Image Key.

_Avoid_: Uploaded file, file attachment

### Image Key
The S3 object key for an uploaded image associated with a session. Format: `sessions/{studentId}/{sessionType}/{sessionId}/image-{i}.{ext}` (Homework, Reading) or `sessions/{studentId}/writing/{sessionId}/{role}-{turnIndex?}-image-{i}.{ext}` (Writing — `prompt-image-0.jpeg`, `draft-2-image-0.jpeg`). Stored once per session — all questions within the session share the same image keys. Distinct from the base64 data URL used during request processing — the key is a stable S3 reference; the data URL is transient.

### Pre-signed URL
A time-limited URL granting temporary read access to an image associated with a Session. History Browser reads expose Pre-signed URLs for the images needed by a Session Card or Session Detail; stable Image Keys remain internal and are never part of those parent-facing read models. Failure to produce one Pre-signed URL degrades only that image, not the rest of the Session Card or Session Detail.

### studentId
A legacy name for the account-scoped identifier of the authenticated Parent Account. It is extracted exclusively from the `sub` claim in the Cognito JWT and is not a real child identity; the client never supplies it directly.

### Parent Account
The authenticated account used by the parent or guardian who operates the app. One Parent Account owns the sessions in its account scope; children are the subject of coaching, not the login identity.

### Parent Account Invitation
The controlled onboarding path for a Parent Account. A parent or guardian receives an invitation, sets a permanent password on first sign-in, and only then becomes able to access sessions in that account scope.

### Parent Account Recovery
A support-assisted process for restoring access to a Parent Account when the parent can no longer sign in. Recovery is deliberately separate from normal sign-in verification.

### sessionId
The session's stable UUID identifier and the S3 key stem within its `sessionType` prefix (`sessions/{studentId}/{sessionType}/{sessionId}.json`). One identifier name for all four session kinds — there is no longer a separate "batchId".

### Homework Page
The `/homework` route — entry point for submitting homework images, receiving Coaching Packets, and adding more pages to the Homework Session currently shown on the result page. “Add more pages” accepts image-only Page Submissions for the current Session, while “Coach another question” starts a new Homework Session. Once the parent leaves or refreshes the current result, the Session remains reviewable through Session History but is no longer extendable through the UI. Backed by `HomeworkFunction` (Lambda).

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
The per-question output delivered to the Parent-as-Coach. A Page Submission generates one only for a new or revised Question; unchanged Questions retain their existing Coaching Packets. Fields:
- `tldrAnswer` — the answer in one short sentence
- `whyItWorks` — the underlying concept the question is testing (one paragraph, adult-to-adult)
- `childHint` — a Socratic prompt the parent can read aloud verbatim if the child is stuck

`subject` and `yearLevel` are *not* on the packet — they live on the sibling `IdentifiedQuestion` produced by the analyzer pass. Year-level calibration applies only to `childHint`; `whyItWorks` stays in adult voice regardless.

Previously the packet also carried `howToCoach` (parent action prose) and `watchFor` (predicted misconceptions). Both were removed to reduce per-question latency and token cost; Practice now diagnoses misconceptions from observed errors rather than a pre-baked list. See [ADR 0006](docs/adr/0006-slim-coaching-packet.md).
