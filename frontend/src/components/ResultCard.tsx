import { useState } from "react";
import type { CoachingPacket, Subject, YearLevel } from "../types";
import { subjectColour } from "../utils/subjectColour";

const YEAR_LEVEL_LABEL: Record<string, string> = {
  "year-1": "Year 1",
  "year-2": "Year 2",
  "year-3": "Year 3",
  "year-4": "Year 4",
  "year-5": "Year 5",
  "year-6": "Year 6",
};

interface ResultCardProps {
  packet: CoachingPacket;
  subject: Subject;
  yearLevel: YearLevel;
  onPractise?: () => void;
  practiceStatus?: "active" | "ended";
}

export function ResultCard({
  packet,
  subject,
  yearLevel,
  onPractise,
  practiceStatus,
}: ResultCardProps) {
  const [hintOpen, setHintOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyHint = async () => {
    try {
      await navigator.clipboard.writeText(packet.childHint);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard not available — silent.
    }
  };

  return (
    <div className="bg-white rounded-2xl shadow-md border border-gray-100 p-4 sm:p-6 space-y-5">
      {/* Badges */}
      <div className="flex flex-wrap gap-2">
        <span
          className={`px-3 py-1 rounded-full text-sm font-bold capitalize ${subjectColour(subject)}`}
        >
          {subject}
        </span>
        <span className="px-3 py-1 rounded-full text-sm font-semibold bg-gray-100 text-gray-600">
          {YEAR_LEVEL_LABEL[yearLevel] ?? yearLevel}
        </span>
      </div>

      {/* TL;DR Answer */}
      <div>
        <h2 className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-1">
          Answer
        </h2>
        <p className="text-gray-800 leading-relaxed text-base font-semibold">
          {packet.tldrAnswer}
        </p>
      </div>

      {/* Why it works */}
      <div>
        <h2 className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-1">
          Why it works
        </h2>
        <p className="text-gray-700 leading-relaxed text-sm whitespace-pre-line">
          {packet.whyItWorks}
        </p>
      </div>

      {/* Child hint (collapsible, copy-to-clipboard) */}
      {packet.childHint && (
        <div className="border-t border-gray-100 pt-4">
          <button
            onClick={() => setHintOpen((v) => !v)}
            className="flex items-center gap-2 text-brand-600 font-semibold hover:text-brand-800 transition-colors text-sm"
          >
            {hintOpen ? "Hide hint for child" : "Show hint to read aloud"}
            <svg
              className={`w-4 h-4 transition-transform ${hintOpen ? "rotate-180" : ""}`}
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
          {hintOpen && (
            <div className="mt-3 bg-blue-50 rounded-xl p-4 space-y-3">
              <p className="text-gray-700 leading-relaxed text-sm italic">
                "{packet.childHint}"
              </p>
              <button
                onClick={copyHint}
                className="text-xs font-semibold text-brand-600 hover:text-brand-800 transition-colors"
              >
                {copied ? "Copied" : "Copy hint"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Practise this — entry point to the Phase 2 Practice Tutor Loop */}
      {onPractise && (
        <button
          onClick={onPractise}
          className="w-full py-2 rounded-xl bg-brand-600 text-white text-sm font-bold hover:bg-brand-700 transition-colors"
        >
          {practiceStatus === "active"
            ? "Resume practice"
            : practiceStatus === "ended"
              ? "Start a new practice"
              : "Practise this with my child"}
        </button>
      )}
    </div>
  );
}
