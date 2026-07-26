import { useState, type FormEvent } from "react";
import {
  ImageAttachmentField,
  guardFormDrop,
  type ImageAttachmentValue,
} from "./ImageAttachmentField";

interface ReadingInputProps {
  onSubmit: (images: string[]) => void;
  disabled: boolean;
}

const MAX_IMAGES = 8;

// Reading-task uploader. Differs from QuestionInput: no text field, requires
// at least one image (the cover), and prompts for cover + content pages.
export function ReadingInput({ onSubmit, disabled }: ReadingInputProps) {
  const [attachments, setAttachments] = useState<ImageAttachmentValue[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (attachments.length === 0 || disabled || isProcessing) return;
    onSubmit(attachments.map((a) => a.dataUrl));
  };

  return (
    <form
      onSubmit={handleSubmit}
      onDragOver={guardFormDrop}
      onDrop={guardFormDrop}
      className="space-y-3"
    >
      <div className="bg-sky-50 border border-sky-100 rounded-xl px-4 py-3 text-sm text-sky-800 leading-relaxed">
        Upload the <span className="font-semibold">book cover</span> first, then a few{" "}
        <span className="font-semibold">pages of content</span> (4–8 images works well). I'll
        generate 5 comprehension questions you can use to check your child understands the book.
      </div>

      <ImageAttachmentField
        attachments={attachments}
        onChange={setAttachments}
        maxAttachments={MAX_IMAGES}
        disabled={disabled}
        accent="brand"
        prompt={
          attachments.length === 0
            ? "Drag and drop the book cover"
            : "Drag and drop another page"
        }
        hint={`or click to choose files (up to ${MAX_IMAGES})`}
        getPreviewLabel={(index) => (index === 0 ? "cover" : `p${index}`)}
        onProcessingChange={setIsProcessing}
      />

      <button
        type="submit"
        disabled={disabled || isProcessing || attachments.length === 0}
        className="w-full py-3 rounded-2xl bg-gradient-to-r from-brand-500 to-indigo-500 text-white font-bold text-lg shadow-md hover:shadow-lg hover:from-brand-600 hover:to-indigo-600 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {disabled ? "Working on it…" : isProcessing ? "Preparing photo…" : "Generate questions 📚"}
      </button>
    </form>
  );
}
