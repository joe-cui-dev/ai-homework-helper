import { useState } from "react";
import type { AgentResult } from "../types";
import { StepList } from "./StepList";
import { HintsList } from "./HintsList";
import { subjectColour } from "../utils/subjectColour";

const DIFFICULTY_COLOURS: Record<string, string> = {
  easy: "bg-green-50 text-green-600",
  medium: "bg-yellow-50 text-yellow-700",
  hard: "bg-red-50 text-red-600",
};

function difficultyColour(difficulty: string) {
  return (
    DIFFICULTY_COLOURS[difficulty.toLowerCase()] ?? "bg-gray-50 text-gray-500"
  );
}

interface ResultCardProps {
  result: AgentResult;
}

export function ResultCard({ result }: ResultCardProps) {
  const [showExplanation, setShowExplanation] = useState(false);

  return (
    <div className="bg-white rounded-2xl shadow-md border border-gray-100 p-4 sm:p-6 space-y-5">
      {/* Badges */}
      <div className="flex flex-wrap gap-2">
        <span
          className={`px-3 py-1 rounded-full text-sm font-bold capitalize ${subjectColour(result.subject)}`}
        >
          {result.subject}
        </span>
        <span
          className={`px-3 py-1 rounded-full text-sm font-semibold capitalize ${difficultyColour(result.difficulty)}`}
        >
          {result.difficulty}
        </span>
      </div>

      {/* Answer */}
      <div>
        <h2 className="text-lg font-bold text-gray-800 mb-1">Answer</h2>
        <p className="text-gray-700 leading-relaxed text-base">
          {result.answer}
        </p>
      </div>

      {/* Steps */}
      {result.steps.length > 0 && (
        <div>
          <h2 className="text-lg font-bold text-gray-800 mb-3">
            How we got there
          </h2>
          <StepList steps={result.steps} />
        </div>
      )}

      {/* Explanation (collapsible) */}
      {result.explanation && (
        <div>
          <button
            onClick={() => setShowExplanation((v) => !v)}
            className="flex items-center gap-2 text-brand-600 font-semibold hover:text-brand-800 transition-colors text-sm"
          >
            <span>🔍</span>
            {showExplanation ? "Hide explanation" : "Simpler explanation"}
            <svg
              className={`w-4 h-4 transition-transform ${showExplanation ? "rotate-180" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </button>
          {showExplanation && (
            <p className="mt-3 text-gray-600 leading-relaxed text-sm bg-blue-50 rounded-xl p-4">
              {result.explanation}
            </p>
          )}
        </div>
      )}

      {/* Hints */}
      {result.hints && result.hints.length > 0 && (
        <HintsList hints={result.hints} />
      )}
    </div>
  );
}
