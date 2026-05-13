// ── Writing forced-tool schemas ──────────────────────────────────────────────
// Three tools, each used on exactly one turn kind. The Lambda forces tool
// choice per turn so Claude returns structured packets, not free-form prose.
// Per-field maxLength prevents token bloat and field cross-contamination, the
// same shape that protects CoachingPacket.
// ─────────────────────────────────────────────────────────────────────────────
import type { Tool } from "../shared/bedrock";

const GENRE_ENUM = [
  "narrative",
  "persuasive",
  "recount",
  "descriptive",
  "information_report",
  "explanation",
  "procedure",
  "other",
];

const YEAR_ENUM = [
  "year-1",
  "year-2",
  "year-3",
  "year-4",
  "year-5",
  "year-6",
];

export const SUBMIT_WRITING_PLAN_TOOL: Tool = {
  toolSpec: {
    name: "submit_writing_plan",
    description:
      "Submit the parent's coaching plan for this writing assignment. Always call this exactly once on a /writing/start turn.",
    inputSchema: {
      json: {
        type: "object",
        properties: {
          assignmentSummary: {
            type: "string",
            maxLength: 300,
            description:
              "One sentence restating what the assignment is asking for. Lets the parent verify Claude understood the prompt.",
          },
          genre: { type: "string", enum: GENRE_ENUM },
          yearLevel: { type: "string", enum: YEAR_ENUM },
          successCriteria: {
            type: "array",
            description:
              "3–5 bullets describing what a strong response looks like for THIS prompt at this year level. Specific to the prompt, not generic.",
            items: { type: "string", maxLength: 180 },
            minItems: 3,
            maxItems: 5,
          },
          planningQuestions: {
            type: "array",
            description:
              "3–4 Socratic questions the parent reads aloud to the child BEFORE writing. The child does the planning.",
            items: { type: "string", maxLength: 180 },
            minItems: 3,
            maxItems: 4,
          },
          modelAnswers: {
            type: "object",
            description:
              "TWO student-voice exemplars plus per-criterion justifications. Both samples meet the success criteria; the second one demonstrates higher proficiency. The prose samples are gated behind a UI disclosure; the justifications are surfaced openly.",
            properties: {
              atYearLevel: {
                type: "string",
                maxLength: 1200,
                description:
                  "Complete student-voice response calibrated EXACTLY to the locked yearLevel. Year-1/2: 3–6 short sentences with everyday words. Year-3/4: paragraph-length with simple subject vocabulary. Year-5/6: multi-paragraph with accurate genre conventions.",
              },
              aboveYearLevel: {
                type: "string",
                maxLength: 1200,
                description:
                  "Same prompt, written ONE YEAR ABOVE yearLevel — calibrated to the next row of the year-level table. CAPPED AT year-6: at year-6, write at the strong end of Year 6 (do NOT cross into Year 7 / secondary curriculum). Demonstrates higher proficiency: richer vocabulary, more sophisticated sentence variety, sharper genre conventions. Still student voice, not adult voice.",
              },
              aboveYearLevelLabel: {
                type: "string",
                maxLength: 24,
                description:
                  "Human label for the above-year-level sample. For year-1..5: 'Year 2', 'Year 3', ..., 'Year 6'. For year-6: 'upper Year 6'.",
              },
              whyAboveIsBetter: {
                type: "string",
                maxLength: 400,
                description:
                  "Adult-to-adult, 1–3 sentences explaining what the aboveYearLevel sample does better than the atYearLevel sample — name concrete moves (a phrase, sentence structure, vocabulary choice, organisational decision). Not a generic 'it's more advanced' platitude; cite specifics from the two samples.",
              },
            },
            required: [
              "atYearLevel",
              "aboveYearLevel",
              "aboveYearLevelLabel",
              "whyAboveIsBetter",
            ],
          },
          vocabularyToOffer: {
            type: "array",
            description:
              "Year-level-appropriate words/phrases the child COULD use if reaching. Not a word bank to copy — the parent only offers them if the child is stuck.",
            items: { type: "string", maxLength: 60 },
            minItems: 0,
            maxItems: 8,
          },
          watchFor: {
            type: "array",
            description:
              "2–3 common pitfalls a Year-X kid hits with this kind of prompt. Adult-to-adult prose.",
            items: { type: "string", maxLength: 200 },
            minItems: 2,
            maxItems: 3,
          },
          coachingScript: {
            type: "string",
            maxLength: 600,
            description:
              "What the parent should DO during the writing — when to sit beside, when to prompt, when to step back. Action-oriented, not narration.",
          },
        },
        required: [
          "assignmentSummary",
          "genre",
          "yearLevel",
          "successCriteria",
          "planningQuestions",
          "modelAnswers",
          "vocabularyToOffer",
          "watchFor",
          "coachingScript",
        ],
      },
    },
  },
};

export const SUBMIT_DRAFT_FEEDBACK_TOOL: Tool = {
  toolSpec: {
    name: "submit_draft_feedback",
    description:
      "Submit feedback on the student's draft. Always call this exactly once on a /writing/draft turn.",
    inputSchema: {
      json: {
        type: "object",
        properties: {
          transcription: {
            type: "string",
            maxLength: 4000,
            description:
              "Verbatim of the draft, preserving the child's misspellings and grammar. When the input was an image, this is the OCR; when it was text, copy it through unchanged.",
          },
          againstPrompt: {
            type: "string",
            maxLength: 600,
            description:
              "Adult-to-adult: did the draft answer the original prompt and match the genre? Anchor to the successCriteria from turn 1.",
          },
          twoStars: {
            type: "array",
            description:
              "EXACTLY two strengths to celebrate. Each must include a specific quoted fragment from the draft as evidence.",
            items: {
              type: "object",
              properties: {
                evidenceQuote: {
                  type: "string",
                  maxLength: 200,
                  description:
                    "Short fragment from the draft (verbatim) that shows this strength.",
                },
                comment: {
                  type: "string",
                  maxLength: 240,
                  description: "Adult-to-adult: why this fragment is a strength.",
                },
              },
              required: ["evidenceQuote", "comment"],
            },
            minItems: 2,
            maxItems: 2,
          },
          oneWish: {
            type: "object",
            description:
              "EXACTLY one highest-leverage improvement. Forces priority discipline.",
            properties: {
              evidenceQuote: {
                type: "string",
                maxLength: 200,
                description:
                  "Short fragment from the draft (verbatim) that shows the issue.",
              },
              comment: {
                type: "string",
                maxLength: 240,
                description:
                  "Adult-to-adult: what's the issue with this fragment?",
              },
              revisionSuggestion: {
                type: "string",
                maxLength: 300,
                description:
                  "Concrete revision the parent can suggest. Not a rewritten paragraph — a teaching move.",
              },
            },
            required: ["evidenceQuote", "comment", "revisionSuggestion"],
          },
          rubric: {
            type: "object",
            properties: {
              dimensions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: {
                      type: "string",
                      enum: [
                        "Ideas & Content",
                        "Structure & Organisation",
                        "Language & Vocabulary",
                        "Mechanics",
                      ],
                    },
                    score: { type: "number", enum: [1, 2, 3, 4] },
                    rationale: { type: "string", maxLength: 150 },
                  },
                  required: ["name", "score", "rationale"],
                },
                minItems: 4,
                maxItems: 4,
                description:
                  "All four dimensions in this exact order: Ideas & Content, Structure & Organisation, Language & Vocabulary, Mechanics.",
              },
              overallBand: {
                type: "string",
                enum: ["Working towards", "At standard", "Above standard"],
                description:
                  "Coarse categorical, not an averaged numeric. Reads as a teacher's professional judgment.",
              },
            },
            required: ["dimensions", "overallBand"],
          },
          mechanicsNotes: {
            type: "array",
            description:
              "Year-level-gated. Year-1/2: only flag missing capitals at sentence start, missing full stops, reversed letters. Year-3/4: tense consistency, dialogue punctuation. Year-5/6: paragraph structure, complex punctuation. Empty array allowed.",
            items: { type: "string", maxLength: 200 },
            minItems: 0,
            maxItems: 4,
          },
          coachingScript: {
            type: "string",
            maxLength: 600,
            description:
              "What the parent should DO/SAY when sitting with the child to revise. Not narration; not a script for the child.",
          },
          nextStep: {
            type: "string",
            enum: [
              "revise_with_focus",
              "ready_for_final_read_aloud",
              "needs_replanning",
            ],
            description:
              "Drives the UI affordance for the next turn. Never ready_to_submit — that judgment belongs to the parent.",
          },
        },
        required: [
          "transcription",
          "againstPrompt",
          "twoStars",
          "oneWish",
          "rubric",
          "mechanicsNotes",
          "coachingScript",
          "nextStep",
        ],
      },
    },
  },
};

export const SUBMIT_COACHING_NOTE_TOOL: Tool = {
  toolSpec: {
    name: "submit_coaching_note",
    description:
      "Answer the parent's clarifying question about this writing assignment. Always call this exactly once on a /writing/question turn. NEVER produce content the child could copy into their draft.",
    inputSchema: {
      json: {
        type: "object",
        properties: {
          questionUnderstood: {
            type: "string",
            maxLength: 240,
            description:
              "One-sentence rephrase of what the parent asked. Lets the parent catch misunderstandings.",
          },
          answer: {
            type: "string",
            maxLength: 600,
            description:
              "Direct answer, anchored in THIS assignment (use the persisted prompt + plan). If the parent asked for copyable content (sentences, paragraphs, openings, conclusions), redirect to Socratic guidance and to the gated modelAnswers on the WritingPlan.",
          },
          coachingTip: {
            type: "string",
            maxLength: 300,
            description:
              "Bridge from the answer to action: what the parent should DO/SAY with this knowledge.",
          },
          relatedGuidanceField: {
            type: "string",
            maxLength: 80,
            description:
              "Optional pointer back into the WritingPlan ('See planningQuestions #2', 'See watchFor #1') when the question is already answered there.",
          },
        },
        required: ["questionUnderstood", "answer", "coachingTip"],
      },
    },
  },
};
