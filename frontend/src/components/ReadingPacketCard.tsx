import { useState } from "react";
import type { ReadingPacket } from "../types";

const YEAR_LEVEL_LABEL: Record<string, string> = {
  "year-1": "Year 1",
  "year-2": "Year 2",
  "year-3": "Year 3",
  "year-4": "Year 4",
  "year-5": "Year 5",
  "year-6": "Year 6",
};

const QUESTION_TYPE_LABEL: Record<string, string> = {
  literal: "Literal recall",
  inference: "Inference",
  vocabulary: "Vocabulary",
};

const QUESTION_TYPE_COLOUR: Record<string, string> = {
  literal: "bg-emerald-50 text-emerald-700",
  inference: "bg-violet-50 text-violet-700",
  vocabulary: "bg-amber-50 text-amber-700",
};

interface ReadingPacketCardProps {
  packet: ReadingPacket;
  index: number;
  total: number;
}

export function ReadingPacketCard({ packet, index, total }: ReadingPacketCardProps) {
  const [coachOpen, setCoachOpen] = useState(false);
  const [watchOpen, setWatchOpen] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(packet.discussionPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard not available — silent.
    }
  };

  return (
    <div className="bg-white rounded-2xl shadow-md border border-gray-100 p-4 sm:p-6 space-y-5">
      {/* Header: question count + type + year */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-bold uppercase tracking-widest text-gray-400">
          Question {index + 1} of {total}
        </span>
        <span
          className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${
            QUESTION_TYPE_COLOUR[packet.questionType] ?? "bg-gray-100 text-gray-600"
          }`}
        >
          {QUESTION_TYPE_LABEL[packet.questionType] ?? packet.questionType}
        </span>
        <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-600">
          {YEAR_LEVEL_LABEL[packet.yearLevel] ?? packet.yearLevel}
        </span>
        {packet.pageReference && (
          <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-sky-50 text-sky-700">
            {packet.pageReference}
          </span>
        )}
      </div>

      {/* Question text — the parent reads this aloud */}
      <div>
        <h2 className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-1">
          Ask your child
        </h2>
        <p className="text-gray-800 leading-relaxed text-base font-semibold">
          {packet.questionText}
        </p>
      </div>

      {/* Model answer */}
      <div>
        <h2 className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-1">
          Model answer
        </h2>
        <p className="text-gray-700 leading-relaxed text-sm whitespace-pre-line">
          {packet.modelAnswer}
        </p>
      </div>

      {/* Comprehension skill */}
      <div className="border-t border-gray-100 pt-4">
        <h2 className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-1">
          What this tests
        </h2>
        <p className="text-gray-700 leading-relaxed text-sm">
          {packet.comprehensionSkill}
        </p>
      </div>

      {/* Coaching tip */}
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
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {coachOpen && (
          <p className="mt-2 text-gray-700 leading-relaxed text-sm whitespace-pre-line">
            {packet.coachingTip}
          </p>
        )}
      </div>

      {/* Common misreadings */}
      {packet.commonMisreadings.length > 0 && (
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
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {watchOpen && (
            <ul className="mt-2 space-y-1.5">
              {packet.commonMisreadings.map((item, i) => (
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

      {/* Discussion prompt */}
      {packet.discussionPrompt && (
        <div className="border-t border-gray-100 pt-4">
          <button
            onClick={() => setPromptOpen((v) => !v)}
            className="flex items-center gap-2 text-brand-600 font-semibold hover:text-brand-800 transition-colors text-sm"
          >
            {promptOpen ? "Hide hint to read aloud" : "Show hint to read aloud"}
            <svg
              className={`w-4 h-4 transition-transform ${promptOpen ? "rotate-180" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {promptOpen && (
            <div className="mt-3 bg-blue-50 rounded-xl p-4 space-y-3">
              <p className="text-gray-700 leading-relaxed text-sm italic">
                "{packet.discussionPrompt}"
              </p>
              <button
                onClick={copyPrompt}
                className="text-xs font-semibold text-brand-600 hover:text-brand-800 transition-colors"
              >
                {copied ? "Copied" : "Copy hint"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
