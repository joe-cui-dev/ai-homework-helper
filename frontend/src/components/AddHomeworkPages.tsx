import { useEffect, useState } from "react";
import { ImageAttachmentField, type ImageAttachmentValue } from "./ImageAttachmentField";
import type { HomeworkAppendError } from "../hooks/useHomeworkStream";

interface AddHomeworkPagesProps {
  disabled: boolean;
  remainingPages: number;
  remainingQuestions: number;
  error: HomeworkAppendError | null;
  completedPageCount: number;
  onSubmit: (images: string[], submissionId: string) => void;
  onAttachmentsChanged: () => void;
}

export function AddHomeworkPages({ disabled, remainingPages, remainingQuestions, error, completedPageCount, onSubmit, onAttachmentsChanged }: AddHomeworkPagesProps) {
  const [attachments, setAttachments] = useState<ImageAttachmentValue[]>([]);
  const [submissionId, setSubmissionId] = useState<string>(() => crypto.randomUUID());
  const [requiresCorrection, setRequiresCorrection] = useState(false);
  useEffect(() => { if (!error) setAttachments([]); }, [completedPageCount]);
  useEffect(() => { setRequiresCorrection(error?.retryable === false); }, [error]);
  useEffect(() => { if (!disabled && attachments.length === 0) setSubmissionId(crypto.randomUUID()); }, [attachments.length, disabled]);
  const change = (next: ImageAttachmentValue[]) => {
    if (next.map((a) => a.id).join(",") !== attachments.map((a) => a.id).join(",")) {
      setSubmissionId(crypto.randomUUID());
      setRequiresCorrection(false);
      onAttachmentsChanged();
    }
    setAttachments(next);
  };
  if (remainingPages <= 0) return <p className="text-sm text-gray-500">This session has reached its 10-page limit.</p>;
  if (remainingQuestions <= 0) return <p className="text-sm text-gray-500">This session has reached its 30-question limit.</p>;
  return <section className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4 sm:p-6 space-y-3">
    <h2 className="font-bold text-gray-800">Add more pages</h2>
    <p className="text-sm text-gray-500">Add up to {Math.min(5, remainingPages)} more worksheet photos to this session.</p>
    <ImageAttachmentField attachments={attachments} onChange={change} maxAttachments={Math.min(5, remainingPages)} disabled={disabled} accent="brand" prompt="Add worksheet photos" compact />
    {error && <p className="text-sm text-red-600">{error.message}{!error.retryable && " Check the selected pages and make a correction before trying again."}</p>}
    <button disabled={disabled || requiresCorrection || attachments.length === 0} onClick={() => onSubmit(attachments.map((a) => a.dataUrl), submissionId)} className="px-5 py-2 rounded-xl bg-brand-600 text-white font-semibold disabled:opacity-50">{error?.retryable ? "Retry adding pages" : "Add pages"}</button>
  </section>;
}
