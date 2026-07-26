import { useState, type FormEvent } from "react";
import {
  ImageAttachmentField,
  guardFormDrop,
  type ImageAttachmentValue,
} from "./ImageAttachmentField";

interface QuestionInputProps {
  onSubmit: (question: string, images: string[]) => void;
  disabled: boolean;
}

const MAX_CHARS = 2000;
const MAX_IMAGES = 5;

export function QuestionInput({ onSubmit, disabled }: QuestionInputProps) {
  const [question, setQuestion] = useState("");
  const [attachments, setAttachments] = useState<ImageAttachmentValue[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = question.trim();
    if ((!trimmed && attachments.length === 0) || disabled || isProcessing) return;
    onSubmit(
      trimmed,
      attachments.map((a) => a.dataUrl),
    );
  };

  const charsLeft = MAX_CHARS - question.length;

  return (
    <form
      onSubmit={handleSubmit}
      onDragOver={guardFormDrop}
      onDrop={guardFormDrop}
      className="space-y-3"
    >
      <div className="relative">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value.slice(0, MAX_CHARS))}
          rows={4}
          placeholder="Type your homework question here… or attach a photo of it below."
          disabled={disabled}
          className="w-full rounded-2xl border-2 border-gray-200 focus:border-brand-400 focus:outline-none px-4 py-3 text-gray-800 placeholder-gray-400 resize-none transition-colors disabled:opacity-50 text-base leading-relaxed"
        />
        <span
          className={`absolute bottom-3 right-4 text-xs ${charsLeft < 100 ? "text-orange-400" : "text-gray-300"}`}
        >
          {charsLeft}
        </span>
      </div>

      <ImageAttachmentField
        attachments={attachments}
        onChange={setAttachments}
        maxAttachments={MAX_IMAGES}
        disabled={disabled}
        accent="brand"
        prompt="Drag and drop a photo of your question"
        hint={`or click to choose files (up to ${MAX_IMAGES})`}
        getPreviewLabel={(index, total) => (total > 1 ? `p${index + 1}` : undefined)}
        onProcessingChange={setIsProcessing}
      />

      <button
        type="submit"
        disabled={disabled || isProcessing || (!question.trim() && attachments.length === 0)}
        className="w-full py-3 rounded-2xl bg-gradient-to-r from-brand-500 to-indigo-500 text-white font-bold text-lg shadow-md hover:shadow-lg hover:from-brand-600 hover:to-indigo-600 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {disabled ? "Working on it…" : isProcessing ? "Preparing photo…" : "Ask the tutor! 🚀"}
      </button>
    </form>
  );
}
