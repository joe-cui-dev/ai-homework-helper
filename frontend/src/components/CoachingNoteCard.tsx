import type { CoachingNotePacket } from "../types";
import { normaliseCoachingNote } from "../utils/normalizeWriting";

interface CoachingNoteCardProps {
  packet: CoachingNotePacket;
  question: string;
  questionIndex: number;
}

export function CoachingNoteCard({
  packet: rawPacket,
  question,
  questionIndex,
}: CoachingNoteCardProps) {
  const packet = normaliseCoachingNote(rawPacket);
  return (
    <section className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 space-y-3">
      <header className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-sky-50 text-sky-700">
          💬 Coaching note {questionIndex}
        </span>
      </header>

      {question && (
        <div className="bg-gray-50 rounded-xl border border-gray-100 px-3 py-2">
          <p className="text-[11px] font-bold uppercase tracking-wide text-gray-500 mb-0.5">
            You asked
          </p>
          <p className="text-sm text-gray-700 leading-relaxed">{question}</p>
        </div>
      )}

      <div>
        <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-0.5">
          As I understand it
        </p>
        <p className="text-sm text-gray-700 leading-relaxed italic">
          {packet.questionUnderstood}
        </p>
      </div>

      <div>
        <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-0.5">
          Answer
        </p>
        <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-line">
          {packet.answer}
        </p>
      </div>

      <div>
        <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-0.5">
          Coaching tip
        </p>
        <p className="text-sm text-gray-800 leading-relaxed">{packet.coachingTip}</p>
      </div>

      {packet.relatedGuidanceField && (
        <p className="text-xs text-gray-500 italic">
          Related: {packet.relatedGuidanceField}
        </p>
      )}
    </section>
  );
}
