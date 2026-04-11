import { callClaude } from "./bedrock";
import { logger } from "./logger";

// Strip markdown code fences (```json ... ``` or ``` ... ```) that Claude
// sometimes emits despite instructions to return only JSON.
const extractJson = (raw: string): string => {
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  return match ? match[1].trim() : raw.trim();
};

export interface SolveResult {
  answer: string;
  steps: string[];
}

export interface ExplainResult {
  explanation: string;
}

export interface HintResult {
  hints: string[];
}

// ---------------------------------------------------------------------------
// Agent skills — two independent skill dimensions selected by classify().
//
//   Dimension 1 — DOMAIN skill (what to solve and how to structure it)
//   Dimension 2 — TONE skill   (how to communicate for the student's year)
//
// classify() is the planner: its output (subject + year) drives both
// selectSkill() and selectTone(), routing to the right expertise and the
// right voice without any extra Bedrock calls.
// ---------------------------------------------------------------------------

type Subject = "math" | "science" | "english" | "other";
type Year = "year-1" | "year-2" | "year-3" | "year-4" | "year-5" | "year-6";

const SKILL_PROMPTS: Record<Subject, string> = {
  math: `You are a math tutor skill. Show every algebraic or arithmetic step explicitly.
Label each step (e.g. "Expand brackets", "Divide both sides").
Use plain-text notation (e.g. x^2, sqrt(x)) — no LaTeX.`,

  science: `You are a science tutor skill. First state the underlying principle or law being applied.
Then walk through the calculation or reasoning step by step.
Include units in every step and call out any assumptions made.`,

  english: `You are an English tutor skill. Identify the grammatical rule, literary device, or writing concept involved.
Explain why it applies to this question before giving the corrected or annotated answer.
Keep terminology accessible.`,

  other: `You are a general tutor skill. Break the problem into clear logical steps.
Explain the reasoning behind each step so the student understands the method, not just the answer.`,
};

// Tone profiles matched to the Australian Curriculum year levels.
// Earlier years use concrete, playful language; later years introduce
// subject-appropriate terminology and slightly more complexity.
const TONE_PROMPTS: Record<Year, string> = {
  "year-1": `The student is in Year 1 (age ~6). Use very short sentences. Prefer everyday words.
Use counting, objects, and simple patterns as analogies. Add lots of encouragement.`,

  "year-2": `The student is in Year 2 (age ~7). Keep sentences short and concrete.
Use familiar objects as examples. Celebrate small wins with positive phrases.`,

  "year-3": `The student is in Year 3 (age ~8). You can introduce simple subject terms
but always explain them in plain language straight away. Use relatable real-world examples.`,

  "year-4": `The student is in Year 4 (age ~9). Use clear, friendly language.
Introduce correct terminology paired with a plain-English explanation.
Short analogies help — keep them age-appropriate.`,

  "year-5": `The student is in Year 5 (age ~10). Use correct subject vocabulary confidently,
explaining any new terms once. Steps can be slightly longer and more abstract.
Encourage independent thinking by briefly noting why each step works.`,

  "year-6": `The student is in Year 6 (age ~11). Use accurate subject terminology throughout.
Steps can cover multi-stage reasoning. Briefly highlight connections to broader concepts
they will encounter in high school.`,
};

const selectSkill = (subject: string): string => {
  const key = subject as Subject;
  return SKILL_PROMPTS[key] ?? SKILL_PROMPTS.other;
};

const selectTone = (difficulty: string): string => {
  const key = difficulty as Year;
  return TONE_PROMPTS[key] ?? TONE_PROMPTS["year-6"];
};

// ---------------------------------------------------------------------------
// Pipeline steps — invoked by the agent via tool dispatch
// ---------------------------------------------------------------------------

export const solve = async (
  question: string,
  subject: string,
  difficulty: string,
): Promise<SolveResult> => {
  logger.debug("pipeline_solve", { subject, difficulty });
  const skill = selectSkill(subject);
  const tone = selectTone(difficulty);
  const prompt = `${skill}
${tone}

Solve the following homework question.
Return ONLY valid JSON with no markdown fences: { "answer": "<concise answer>", "steps": ["<step 1>", "<step 2>"] }

Question: ${question}`;

  try {
    const raw = await callClaude(prompt, 0);
    return JSON.parse(extractJson(raw)) as SolveResult;
  } catch (err) {
    logger.error("pipeline_parse_error", { fn: "solve", subject, difficulty });
    throw err instanceof Error
      ? err
      : new Error("Failed to parse solve response.");
  }
};

export const explain = async (
  answer: string,
  steps: string[],
  difficulty: string,
): Promise<ExplainResult> => {
  logger.debug("pipeline_explain", { difficulty });
  const tone = selectTone(difficulty);
  const prompt = `${tone}

Rewrite the following solution in friendly, encouraging language matching the tone above.
Return ONLY valid JSON with no markdown fences: { "explanation": "<friendly explanation>" }

Answer: ${answer}
Steps:
${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;

  try {
    const raw = await callClaude(prompt, 0.3);
    logger.debug("pipeline_explain_raw", { raw });
    return JSON.parse(extractJson(raw)) as ExplainResult;
  } catch (err) {
    logger.error("pipeline_parse_error", { fn: "explain", difficulty });
    throw err instanceof Error
      ? err
      : new Error("Failed to parse explain response.");
  }
};

export const generateHint = async (
  question: string,
  subject: string,
  difficulty: string,
): Promise<HintResult> => {
  logger.debug("pipeline_generate_hint", { subject, difficulty });
  const skill = selectSkill(subject);
  const tone = selectTone(difficulty);
  const prompt = `${skill}
${tone}

The student needs help but should arrive at the answer themselves.
Generate 2-3 short Socratic hints that guide them toward the solution without giving the answer away.
Return ONLY valid JSON with no markdown fences: { "hints": ["<hint 1>", "<hint 2>"] }

Question: ${question}`;

  try {
    const raw = await callClaude(prompt, 0.3);
    return JSON.parse(extractJson(raw)) as HintResult;
  } catch (err) {
    logger.error("pipeline_parse_error", {
      fn: "generateHint",
      subject,
      difficulty,
    });
    throw err instanceof Error
      ? err
      : new Error("Failed to parse hint response.");
  }
};
