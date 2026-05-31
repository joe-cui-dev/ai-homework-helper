import type { WritingPlanPacket } from "../types";
import { normalisePlan } from "../utils/normalizeWriting";

const GENRE_LABEL: Record<string, string> = {
  narrative: "Narrative",
  persuasive: "Persuasive",
  recount: "Recount",
  descriptive: "Descriptive",
  information_report: "Information report",
  explanation: "Explanation",
  procedure: "Procedure",
  other: "Mixed / other",
};

interface WritingPlanCardProps {
  plan: WritingPlanPacket;
}

export function WritingPlanCard({ plan: rawPlan }: WritingPlanCardProps) {
  const plan = normalisePlan(rawPlan);
  const { modelAnswers } = plan;
  const hasModelAnswers = modelAnswers.atYearLevel.trim().length > 0;
  return (
    <section className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 space-y-4">
      <header className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-violet-50 text-violet-700">
          ✍️ Writing plan
        </span>
        <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 capitalize">
          {GENRE_LABEL[plan.genre] ?? plan.genre}
        </span>
        <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-gray-100 text-gray-700">
          {plan.yearLevel.replace("year-", "Year ")}
        </span>
        <span className="text-[10px] font-medium text-gray-400 italic">
          {plan.yearLevelSource === "user" ? "set by you" : "AI estimate"}
        </span>
      </header>

      <div>
        <h3 className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-1">
          Assignment summary
        </h3>
        <p className="text-sm text-gray-800 leading-relaxed">
          {plan.assignmentSummary}
        </p>
      </div>

      <div>
        <h3 className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-1">
          Success criteria
        </h3>
        <ul className="space-y-1">
          {plan.successCriteria.map((c, i) => (
            <li key={i} className="text-sm text-gray-700 leading-relaxed pl-4 relative">
              <span className="absolute left-0 text-violet-400">•</span>
              {c}
            </li>
          ))}
        </ul>
      </div>


      <div>
        <h3 className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-1">
          Planning questions to read aloud
        </h3>
        <ul className="space-y-1">
          {plan.planningQuestions.map((q, i) => (
            <li
              key={i}
              className="text-sm text-gray-800 leading-relaxed pl-5 relative"
            >
              <span className="absolute left-0 text-gray-400">{i + 1}.</span>
              <p className="italic">{q.question}</p>
              {q.suggestedAnswers.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {q.suggestedAnswers.map((answer, answerIndex) => (
                    <li
                      key={answerIndex}
                      className="text-xs text-gray-600 leading-relaxed pl-3 relative"
                    >
                      <span className="absolute left-0 text-violet-300">•</span>
                      {answer}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </div>

      {plan.vocabularyToOffer.length > 0 && (
        <div>
          <h3 className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-1">
            Vocabulary to offer (only if the child reaches)
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {plan.vocabularyToOffer.map((v, i) => (
              <span
                key={i}
                className="text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-100"
              >
                {v}
              </span>
            ))}
          </div>
        </div>
      )}

      <div>
        <h3 className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-1">
          Watch for
        </h3>
        <ul className="space-y-1">
          {plan.watchFor.map((w, i) => (
            <li key={i} className="text-sm text-gray-700 leading-relaxed pl-4 relative">
              <span className="absolute left-0 text-orange-400">!</span>
              {w}
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-1">
          Coaching script
        </h3>
        <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-line">
          {plan.coachingScript}
        </p>
      </div>

      {hasModelAnswers ? (
        <details className="rounded-xl bg-gray-50 border border-gray-100 px-3 py-2">
          <summary className="cursor-pointer text-xs font-bold uppercase tracking-wide text-gray-500 select-none">
            Show model answers (only show these to your child if you choose)
          </summary>
          <div className="mt-3 space-y-4">
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">
                At year level
              </h4>
              <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-line italic">
                {modelAnswers.atYearLevel}
              </p>
            </div>
            {modelAnswers.aboveYearLevel.trim().length > 0 && (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">
                  {modelAnswers.aboveYearLevelLabel || "Stretch"}
                </h4>
                <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-line italic">
                  {modelAnswers.aboveYearLevel}
                </p>
                {modelAnswers.whyAboveIsBetter.trim().length > 0 && (
                  <p className="mt-2 text-xs text-gray-600 leading-relaxed border-l-2 border-violet-200 pl-2">
                    <span className="font-semibold text-gray-500">Why this is stronger: </span>
                    {modelAnswers.whyAboveIsBetter}
                  </p>
                )}
              </div>
            )}
          </div>
        </details>
      ) : (
        <div className="rounded-xl bg-amber-50 border border-amber-100 px-3 py-2 text-xs text-amber-800">
          Model answers unavailable for this session (legacy data).
        </div>
      )}
    </section>
  );
}
