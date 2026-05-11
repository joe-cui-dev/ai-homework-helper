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
              className="text-sm text-gray-800 leading-relaxed pl-5 relative italic"
            >
              <span className="absolute left-0 text-gray-400">{i + 1}.</span>
              {q}
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

      <details className="rounded-xl bg-gray-50 border border-gray-100 px-3 py-2">
        <summary className="cursor-pointer text-xs font-bold uppercase tracking-wide text-gray-500 select-none">
          Show model answer (only show this to your child if you choose)
        </summary>
        <p className="mt-2 text-sm text-gray-800 leading-relaxed whitespace-pre-line italic">
          {plan.modelAnswer}
        </p>
      </details>
    </section>
  );
}
