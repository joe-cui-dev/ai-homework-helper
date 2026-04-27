import { useState, useRef, type FormEvent, type ChangeEvent, type DragEvent } from "react";
import { toBase64 } from "../services/api";

interface QuestionInputProps {
  onSubmit: (question: string, images: string[]) => void;
  disabled: boolean;
}

const MAX_CHARS = 2000;
const MAX_IMAGES = 5;

export function QuestionInput({ onSubmit, disabled }: QuestionInputProps) {
  const [question, setQuestion] = useState("");
  const [imagePreviews, setImagePreviews] = useState<string[]>([]);
  const [imageBase64s, setImageBase64s] = useState<string[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const processFiles = async (files: File[]) => {
    setImageError(null);
    const remaining = MAX_IMAGES - imageBase64s.length;
    if (files.length > remaining) {
      setImageError(`You can upload at most ${MAX_IMAGES} images. ${imageBase64s.length > 0 ? `${imageBase64s.length} already added.` : ""}`);
      files = files.slice(0, remaining);
    }
    const results = await Promise.allSettled(files.map(toBase64));
    const successful: string[] = [];
    for (const r of results) {
      if (r.status === "fulfilled") {
        successful.push(r.value);
      } else {
        setImageError(r.reason instanceof Error ? r.reason.message : "Invalid image.");
      }
    }
    if (successful.length > 0) {
      setImageBase64s((prev) => [...prev, ...successful]);
      setImagePreviews((prev) => [...prev, ...successful]);
    }
  };

  const handleImageChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    await processFiles(files);
    e.target.value = "";
  };

  const handleDragOver = (e: DragEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!disabled) setIsDragging(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLFormElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragging(false);
    }
  };

  const handleDrop = async (e: DragEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (disabled) return;
    const files = Array.from(e.dataTransfer.files).filter((f) =>
      f.type.startsWith("image/"),
    );
    if (files.length === 0 && e.dataTransfer.files.length > 0) {
      setImageError("Only image files can be dropped here.");
      return;
    }
    await processFiles(files);
  };

  const removeImage = (index: number) => {
    setImageBase64s((prev) => prev.filter((_, i) => i !== index));
    setImagePreviews((prev) => prev.filter((_, i) => i !== index));
    setImageError(null);
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = question.trim();
    if ((!trimmed && imageBase64s.length === 0) || disabled) return;
    onSubmit(trimmed, imageBase64s);
  };

  const charsLeft = MAX_CHARS - question.length;
  const canAddMore = imageBase64s.length < MAX_IMAGES;

  return (
    <form
      onSubmit={handleSubmit}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`space-y-3 rounded-2xl transition-colors ${isDragging ? "outline outline-2 outline-dashed outline-brand-400 bg-brand-50" : ""}`}
    >
      <div className="relative">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value.slice(0, MAX_CHARS))}
          rows={4}
          placeholder="Type your homework question here… or drop a photo of it below."
          disabled={disabled}
          className="w-full rounded-2xl border-2 border-gray-200 focus:border-brand-400 focus:outline-none px-4 py-3 text-gray-800 placeholder-gray-400 resize-none transition-colors disabled:opacity-50 text-base leading-relaxed"
        />
        <span
          className={`absolute bottom-3 right-4 text-xs ${charsLeft < 100 ? "text-orange-400" : "text-gray-300"}`}
        >
          {charsLeft}
        </span>
      </div>

      {/* Image section */}
      <div className="flex items-start gap-3 flex-wrap">
        {canAddMore && (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={disabled}
            className="flex items-center gap-2 px-4 py-2 rounded-xl border-2 border-dashed border-gray-300 text-gray-500 hover:border-brand-400 hover:text-brand-600 transition-colors text-sm font-semibold disabled:opacity-40 shrink-0"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 16l4.586-4.586A2 2 0 0111.414 11H12m0 0l4.586 4.586M12 11V3m-8 8h16"
              />
            </svg>
            {isDragging ? "Drop it!" : imageBase64s.length === 0 ? "Add a photo" : "Add another"}
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={handleImageChange}
        />

        {imagePreviews.map((src, i) => (
          <div key={i} className="relative inline-block">
            <img
              src={src}
              alt={`Page ${i + 1}`}
              className="w-16 h-16 rounded-xl object-cover border-2 border-brand-200"
            />
            {imagePreviews.length > 1 && (
              <span className="absolute bottom-0 left-0 right-0 text-center text-white text-[10px] font-bold bg-black/40 rounded-b-xl leading-4">
                p{i + 1}
              </span>
            )}
            <button
              type="button"
              onClick={() => removeImage(i)}
              className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-red-400 text-white text-xs flex items-center justify-center hover:bg-red-500"
              aria-label={`Remove image ${i + 1}`}
            >
              ×
            </button>
          </div>
        ))}

        {imageError && <p className="text-red-500 text-sm self-center">{imageError}</p>}
      </div>

      <button
        type="submit"
        disabled={disabled || (!question.trim() && imageBase64s.length === 0)}
        className="w-full py-3 rounded-2xl bg-gradient-to-r from-brand-500 to-indigo-500 text-white font-bold text-lg shadow-md hover:shadow-lg hover:from-brand-600 hover:to-indigo-600 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {disabled ? "Working on it…" : "Ask the tutor! 🚀"}
      </button>
    </form>
  );
}
