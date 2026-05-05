import { useState } from "react";
import type { CoachingPacket } from "../types";
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
  onPractise?: () => void;
  practiceStatus?: "active" | "ended";
}

export function ResultCard({
  packet,
  onPractise,
  practiceStatus,
}: ResultCardProps) {
  const [hintOpen, setHintOpen] = useState(false);
  const [coachOpen, setCoachOpen] = useState(false);
  const [watchOpen, setWatchOpen] = useState(false);
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
          className={`px-3 py-1 rounded-full text-sm font-bold capitalize ${subjectColour(packet.subject)}`}
        >
          {packet.subject}
        </span>
        <span className="px-3 py-1 rounded-full text-sm font-semibold bg-gray-100 text-gray-600">
          {YEAR_LEVEL_LABEL[packet.yearLevel] ?? packet.yearLevel}
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

      {/* How to coach */}
      <div className="border-t border-gray-100 pt-4">
        <button
          onClick={() => setCoachOpen((v) => !v)}
          className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-gray-400 hover:text-gray-600 transition-colors"
        >
          How to coach
          <svg
            className={`w-3 h-3 transition-transform ${coachOpen ? "rotate-180" : ""}`}
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
        {coachOpen && (
          <p className="mt-2 text-gray-700 leading-relaxed text-sm whitespace-pre-line">
            {packet.howToCoach}
          </p>
        )}
      </div>

      {/* Watch for */}
      {packet.watchFor.length > 0 && (
        <div className="border-t border-gray-100 pt-4">
          <button
            onClick={() => setWatchOpen((v) => !v)}
            className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-gray-400 hover:text-gray-600 transition-colors"
          >
            Watch for
            <svg
              className={`w-3 h-3 transition-transform ${watchOpen ? "rotate-180" : ""}`}
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
          {watchOpen && (
            <ul className="mt-2 space-y-1.5">
              {packet.watchFor.map((item, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2 text-sm text-gray-700 leading-relaxed"
                >
                  <span className="text-amber-500 mt-1 flex-shrink-0">•</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

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
