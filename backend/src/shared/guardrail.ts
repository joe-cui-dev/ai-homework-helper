// ── Guardrail input tagging ─────────────────────────────────────────────────
// Bedrock assesses every text block in a message when the request carries no
// guardContent block. That default judges quoted source material — the Page
// Context extracted from a photographed worksheet — as if the parent had
// typed it, and a worksheet is not a request: a pirate-dialogue comprehension
// exercise reads as roleplay to the OffTopic topic policy and as an injection
// attempt to the PROMPT_ATTACK filter, blocking the whole submission.
//
// So a guarded call tags what is being asked — the typed question, the list of
// questions to coach — and leaves the source material untagged. The model
// still sees everything; only the guardrail's view narrows. Emit exactly one
// guarded block per message: with none, Bedrock falls back to assessing all of
// it, which is the behaviour this avoids. Output assessment is unaffected.
export const NO_TYPED_REQUEST = "No typed question was provided.";

export const guardedText = (text: string): Record<string, unknown> => ({
  guardContent: {
    text: {
      text: text.trim() || NO_TYPED_REQUEST,
      qualifiers: ["guard_content"],
    },
  },
});
