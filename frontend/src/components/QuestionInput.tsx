import { useState, useRef, type FormEvent, type ChangeEvent, type DragEvent } from "react";
import { toBase64 } from "../services/api";
import { ImageCropModal } from "./ImageCropModal";

interface QuestionInputProps {
  onSubmit: (question: string, image?: string) => void;
  disabled: boolean;
}

const MAX_CHARS = 2000;

export function QuestionInput({ onSubmit, disabled }: QuestionInputProps) {
  const [question, setQuestion] = useState("");
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [imageBase64, setImageBase64] = useState<string | undefined>(undefined);
  const [imageError, setImageError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [cropSource, setCropSource] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const processFile = async (file: File) => {
    setImageError(null);
    try {
      const dataUrl = await toBase64(file);
      setCropSource(dataUrl);
    } catch (err) {
      setImageError(err instanceof Error ? err.message : "Invalid image.");
    }
  };

  const handleCropConfirm = (croppedDataUrl: string) => {
    setImageBase64(croppedDataUrl);
    setImagePreview(croppedDataUrl);
    setCropSource(null);
  };

  const handleCropCancel = () => {
    setCropSource(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const handleImageChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await processFile(file);
    // Reset input so same file can be re-selected after clearing.
    e.target.value = "";
  };

  const handleDragOver = (e: DragEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!disabled) setIsDragging(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLFormElement>) => {
    // Only clear when leaving the form entirely, not when moving between children.
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragging(false);
    }
  };

  const handleDrop = async (e: DragEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (disabled) return;
    const file = e.dataTransfer.files[0];
    if (file?.type.startsWith("image/")) {
      await processFile(file);
    } else if (file) {
      setImageError("Only image files can be dropped here.");
    }
  };

  const clearImage = () => {
    setImageBase64(undefined);
    setImagePreview(null);
    setImageError(null);
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = question.trim();
    if ((!trimmed && !imageBase64) || disabled) return;
    onSubmit(trimmed, imageBase64);
  };

  const charsLeft = MAX_CHARS - question.length;

  return (
    <>
    {cropSource && (
      <ImageCropModal
        imageSrc={cropSource}
        onConfirm={handleCropConfirm}
        onCancel={handleCropCancel}
      />
    )}
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
      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={disabled}
          className="flex items-center gap-2 px-4 py-2 rounded-xl border-2 border-dashed border-gray-300 text-gray-500 hover:border-brand-400 hover:text-brand-600 transition-colors text-sm font-semibold disabled:opacity-40"
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
          {isDragging ? "Drop it!" : "Add a photo"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleImageChange}
        />

        {imagePreview && (
          <div className="relative inline-block">
            <img
              src={imagePreview}
              alt="Question"
              className="w-16 h-16 rounded-xl object-cover border-2 border-brand-200"
            />
            <button
              type="button"
              onClick={clearImage}
              className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-red-400 text-white text-xs flex items-center justify-center hover:bg-red-500"
              aria-label="Remove image"
            >
              ×
            </button>
          </div>
        )}

        {imageError && <p className="text-red-500 text-sm">{imageError}</p>}
      </div>

      <button
        type="submit"
        disabled={disabled || (!question.trim() && !imageBase64)}
        className="w-full py-3 rounded-2xl bg-gradient-to-r from-brand-500 to-indigo-500 text-white font-bold text-lg shadow-md hover:shadow-lg hover:from-brand-600 hover:to-indigo-600 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {disabled ? "Working on it…" : "Ask the tutor! 🚀"}
      </button>
    </form>
    </>
  );
}
