import type {
  DraftFeedbackPacket,
  RubricDimension,
} from "../types";
import { normaliseDraftFeedback } from "../utils/normalizeWriting";

const NEXT_STEP_LABEL: Record<string, { text: string; chip: string }> = {
  revise_with_focus: {
    text: "Revise with focus",
    chip: "bg-amber-50 text-amber-700 border-amber-200",
  },
  ready_for_final_read_aloud: {
    text: "Ready for a final read-aloud",
    chip: "bg-emerald-50 text-emerald-700 border-emerald-200",
  },
  needs_replanning: {
    text: "Needs replanning",
    chip: "bg-rose-50 text-rose-700 border-rose-200",
  },
};

const BAND_CHIP: Record<string, string> = {
  "Working towards": "bg-rose-50 text-rose-700 border-rose-200",
  "At standard": "bg-emerald-50 text-emerald-700 border-emerald-200",
  "Above standard": "bg-violet-50 text-violet-700 border-violet-200",
};

const SCORE_COLOUR = (score: number): string => {
  switch (score) {
    case 1:
      return "bg-rose-200";
    case 2:
      return "bg-amber-200";
    case 3:
      return "bg-emerald-200";
    case 4:
      return "bg-violet-300";
    default:
      return "bg-gray-200";
  }
};

interface DraftFeedbackCardProps {
  packet: DraftFeedbackPacket;
  draftIndex: number;
  imageUrls?: string[];
}

export function DraftFeedbackCard({
  packet: rawPacket,
  draftIndex,
  imageUrls,
}: DraftFeedbackCardProps) {
  const packet = normaliseDraftFeedback(rawPacket);
  const nextStep = NEXT_STEP_LABEL[packet.nextStep] ?? {
    text: packet.nextStep,
    chip: "bg-gray-50 text-gray-700 border-gray-200",
  };

  return (
    <section className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 space-y-4">
      <header className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">
          📝 Draft {draftIndex} feedback
        </span>
        <span
          className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${nextStep.chip}`}
        >
          {nextStep.text}
        </span>
        <span
          className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${
            BAND_CHIP[packet.rubric.overallBand] ?? "bg-gray-50 text-gray-700"
          }`}
        >
          {packet.rubric.overallBand}
        </span>
      </header>

      {imageUrls && imageUrls.length > 0 && (
        <div className="space-y-2">
          {imageUrls.map((url, i) => (
            <img
              key={i}
              src={url}
              alt={`Draft ${draftIndex} page ${i + 1}`}
              className="w-full rounded-xl border border-gray-200 object-contain bg-white"
            />
          ))}
        </div>
      )}

      <details className="rounded-xl bg-gray-50 border border-gray-100 px-3 py-2">
        <summary className="cursor-pointer text-xs font-bold uppercase tracking-wide text-gray-500 select-none">
          Transcription (verbatim — check for OCR errors)
        </summary>
        <p className="mt-2 text-sm text-gray-700 leading-relaxed whitespace-pre-line font-mono text-[13px]">
          {packet.transcription}
        </p>
      </details>

      <div>
        <h3 className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-1">
          Against the prompt
        </h3>
        <p className="text-sm text-gray-800 leading-relaxed">
          {packet.againstPrompt}
        </p>
      </div>

      <div>
        <h3 className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-2">
          Two stars ⭐⭐
        </h3>
        <div className="space-y-2">
          {packet.twoStars.map((s, i) => (
            <div
              key={i}
              className="bg-emerald-50 border border-emerald-100 rounded-xl p-3"
            >
              <p className="text-xs italic text-emerald-700 mb-1">
                “{s.evidenceQuote}”
              </p>
              <p className="text-sm text-gray-800 leading-relaxed">{s.comment}</p>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-2">
          One wish ✨
        </h3>
        <div className="bg-amber-50 border border-amber-100 rounded-xl p-3 space-y-2">
          <p className="text-xs italic text-amber-800">
            “{packet.oneWish.evidenceQuote}”
          </p>
          <p className="text-sm text-gray-800 leading-relaxed">
            {packet.oneWish.comment}
          </p>
          <div className="bg-white rounded-lg border border-amber-100 p-2">
            <p className="text-[11px] font-bold uppercase tracking-wide text-amber-600 mb-0.5">
              Try this revision
            </p>
            <p className="text-sm text-gray-800 leading-relaxed">
              {packet.oneWish.revisionSuggestion}
            </p>
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-1">
          Coaching script
        </h3>
        <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-line">
          {packet.coachingScript}
        </p>
      </div>

      {packet.mechanicsNotes.length > 0 && (
        <div>
          <h3 className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-1">
            Mechanics notes
          </h3>
          <ul className="space-y-1">
            {packet.mechanicsNotes.map((m, i) => (
              <li
                key={i}
                className="text-sm text-gray-700 leading-relaxed pl-4 relative"
              >
                <span className="absolute left-0 text-gray-400">·</span>
                {m}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="pt-1 border-t border-gray-100">
        <h3 className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-2">
          Rubric
        </h3>
        <div className="space-y-1.5">
          {packet.rubric.dimensions.map((d) => (
            <RubricRow key={d.name} dimension={d} />
          ))}
        </div>
      </div>
    </section>
  );
}

function RubricRow({ dimension }: { dimension: RubricDimension }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-gray-600 w-44 shrink-0">{dimension.name}</span>
      <div className="flex gap-0.5">
        {[1, 2, 3, 4].map((n) => (
          <span
            key={n}
            className={`w-3 h-3 rounded-sm ${
              n <= dimension.score ? SCORE_COLOUR(dimension.score) : "bg-gray-100"
            }`}
            aria-label={`${dimension.name} ${dimension.score} of 4`}
          />
        ))}
      </div>
      <span
        className="text-[11px] text-gray-500 truncate flex-1"
        title={dimension.rationale}
      >
        {dimension.rationale}
      </span>
    </div>
  );
}
