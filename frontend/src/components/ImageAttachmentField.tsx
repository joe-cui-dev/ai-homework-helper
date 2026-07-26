import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import { compressImage } from "../services/api";

export interface ImageAttachmentValue {
  id: string;
  name: string;
  fingerprint: string;
  dataUrl: string;
}

type Accent = "brand" | "violet";

interface ImageAttachmentFieldProps {
  attachments: ImageAttachmentValue[];
  onChange: (attachments: ImageAttachmentValue[]) => void;
  maxAttachments: number;
  disabled: boolean;
  accent: Accent;
  prompt: string;
  hint?: string;
  compact?: boolean;
  getPreviewLabel?: (index: number, total: number) => string | undefined;
  onProcessingChange?: (isProcessing: boolean) => void;
}

// Only act on drags that actually carry files, so text/link drags don't
// trigger drag-active styling or the form-level navigation guard.
export function hasFilesInDataTransfer(dataTransfer: DataTransfer | null): boolean {
  return !!dataTransfer && Array.from(dataTransfer.types).includes("Files");
}

// Attach to a containing form's onDragOver and onDrop so a file dropped
// outside this field doesn't navigate the browser away from the page.
export function guardFormDrop(e: DragEvent<HTMLFormElement>): void {
  if (hasFilesInDataTransfer(e.dataTransfer)) e.preventDefault();
}

function fingerprintFile(file: File): string {
  return `${file.name}::${file.size}::${file.lastModified}`;
}

let idCounter = 0;
function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  idCounter += 1;
  return `img-${Date.now()}-${idCounter}`;
}

function plural(count: number): string {
  return count === 1 ? "" : "s";
}

function joinWithAnd(parts: string[]): string {
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

interface BatchCounts {
  added: number;
  nonImageCount: number;
  duplicateCount: number;
  overflowCount: number;
  failureCount: number;
}

function buildFeedback({
  added,
  nonImageCount,
  duplicateCount,
  overflowCount,
  failureCount,
}: BatchCounts): string | null {
  const ignoredParts: string[] = [];
  if (nonImageCount > 0) ignoredParts.push(`${nonImageCount} non-image file${plural(nonImageCount)}`);
  if (duplicateCount > 0) ignoredParts.push(`${duplicateCount} duplicate${plural(duplicateCount)}`);
  if (overflowCount > 0) ignoredParts.push(`${overflowCount} over the limit`);
  if (failureCount > 0) ignoredParts.push(`${failureCount} that failed to process`);

  if (added === 0 && ignoredParts.length === 0) return null;
  if (added > 0 && ignoredParts.length > 0) {
    return `Added ${added} image${plural(added)}; ignored ${joinWithAnd(ignoredParts)}.`;
  }
  if (added > 0) {
    return `Added ${added} image${plural(added)}.`;
  }
  return `Ignored ${joinWithAnd(ignoredParts)}.`;
}

const accentClasses: Record<
  Accent,
  {
    hoverBorder: string;
    dragBorder: string;
    dragBg: string;
    dragText: string;
    previewBorder: string;
    focusRing: string;
  }
> = {
  brand: {
    hoverBorder: "hover:border-brand-400",
    dragBorder: "border-brand-400",
    dragBg: "bg-brand-50",
    dragText: "text-brand-600",
    previewBorder: "border-brand-200",
    focusRing: "focus-visible:ring-brand-400",
  },
  violet: {
    hoverBorder: "hover:border-violet-400",
    dragBorder: "border-violet-400",
    dragBg: "bg-violet-50",
    dragText: "text-violet-600",
    previewBorder: "border-violet-200",
    focusRing: "focus-visible:ring-violet-400",
  },
};

export function ImageAttachmentField({
  attachments,
  onChange,
  maxAttachments,
  disabled,
  accent,
  prompt,
  hint,
  compact = false,
  getPreviewLabel,
  onProcessingChange,
}: ImageAttachmentFieldProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const attachmentsRef = useRef(attachments);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  const isFull = attachments.length >= maxAttachments;
  const canInteract = !disabled && !isProcessing && !isFull;

  useEffect(() => {
    if (!canInteract) {
      setIsDragging(false);
      dragDepthRef.current = 0;
    }
  }, [canInteract]);

  useEffect(() => {
    onProcessingChange?.(isProcessing);
  }, [isProcessing, onProcessingChange]);

  const cls = accentClasses[accent];

  const processIncoming = async (files: File[]) => {
    if (files.length === 0) return;
    setFeedback(null);

    let nonImageCount = 0;
    const imageFiles: File[] = [];
    for (const file of files) {
      if (file.type.startsWith("image/")) imageFiles.push(file);
      else nonImageCount += 1;
    }

    const existingFingerprints = new Set(attachments.map((a) => a.fingerprint));
    const seenInBatch = new Set<string>();
    let duplicateCount = 0;
    const deduped: File[] = [];
    for (const file of imageFiles) {
      const fp = fingerprintFile(file);
      if (existingFingerprints.has(fp) || seenInBatch.has(fp)) {
        duplicateCount += 1;
        continue;
      }
      seenInBatch.add(fp);
      deduped.push(file);
    }

    const remaining = Math.max(0, maxAttachments - attachments.length);
    let overflowCount = 0;
    let candidates = deduped;
    if (deduped.length > remaining) {
      candidates = deduped.slice(0, remaining);
      overflowCount = deduped.length - candidates.length;
    }

    if (candidates.length === 0) {
      setFeedback(buildFeedback({ added: 0, nonImageCount, duplicateCount, overflowCount, failureCount: 0 }));
      return;
    }

    setIsProcessing(true);
    setStatusMessage(`Preparing ${candidates.length} image${plural(candidates.length)}…`);

    const results = await Promise.allSettled(candidates.map((file) => compressImage(file)));

    let failureCount = 0;
    const successes: ImageAttachmentValue[] = [];
    results.forEach((result, i) => {
      if (result.status === "fulfilled") {
        const file = candidates[i];
        successes.push({
          id: generateId(),
          name: file.name,
          fingerprint: fingerprintFile(file),
          dataUrl: result.value,
        });
      } else {
        failureCount += 1;
      }
    });

    if (successes.length > 0) {
      onChange([...attachmentsRef.current, ...successes]);
    }

    setIsProcessing(false);
    setStatusMessage(null);
    setFeedback(
      buildFeedback({
        added: successes.length,
        nonImageCount,
        duplicateCount,
        overflowCount,
        failureCount,
      }),
    );
  };

  const handleActivate = () => {
    if (!canInteract) return;
    fileRef.current?.click();
  };

  const handleFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    void processIncoming(files);
  };

  const handleDragEnter = (e: DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    if (!canInteract || !hasFilesInDataTransfer(e.dataTransfer)) return;
    dragDepthRef.current += 1;
    setIsDragging(true);
  };

  const handleDragOver = (e: DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
  };

  const handleDragLeave = (_e: DragEvent<HTMLButtonElement>) => {
    if (!canInteract) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragging(false);
  };

  const handleDrop = (e: DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = 0;
    setIsDragging(false);
    if (!canInteract) return;
    void processIncoming(Array.from(e.dataTransfer.files));
  };

  const removeAttachment = (id: string) => {
    setFeedback(null);
    onChange(attachments.filter((a) => a.id !== id));
  };

  let primaryText: string;
  let secondaryText: string | undefined;
  if (isProcessing) {
    primaryText = statusMessage ?? "Preparing images…";
  } else if (isDragging && canInteract) {
    primaryText = "Drop images here";
    secondaryText = hint;
  } else if (disabled) {
    primaryText = "Locked while working…";
  } else if (isFull) {
    primaryText = `Maximum of ${maxAttachments} images added.`;
    secondaryText = "Remove one to add another.";
  } else {
    primaryText = prompt;
    secondaryText = hint;
  }

  const locked = disabled || isProcessing;
  const statusText = isProcessing ? statusMessage : feedback;

  return (
    <div className={compact ? "space-y-1.5" : "space-y-2"}>
      <button
        type="button"
        data-testid="image-attachment-dropzone"
        aria-disabled={!canInteract}
        onClick={handleActivate}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`w-full flex items-center gap-3 rounded-2xl border-2 border-dashed transition-colors text-left ${
          compact ? "px-3 py-2.5" : "px-4 py-3.5"
        } ${
          isDragging && canInteract
            ? `${cls.dragBorder} ${cls.dragBg}`
            : `border-gray-300 ${canInteract ? cls.hoverBorder : ""}`
        } ${!canInteract ? "opacity-60 cursor-not-allowed" : "cursor-pointer"} focus:outline-none focus-visible:ring-2 ${cls.focusRing}`}
      >
        <svg
          className={`${compact ? "w-4 h-4" : "w-5 h-5"} shrink-0 text-gray-400`}
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
        <span className="min-w-0">
          <span
            className={`block font-semibold ${compact ? "text-xs" : "text-sm"} ${
              isDragging && canInteract ? cls.dragText : "text-gray-600"
            }`}
          >
            {primaryText}
          </span>
          {secondaryText && (
            <span className={`block ${compact ? "text-[11px]" : "text-xs"} text-gray-400`}>
              {secondaryText}
            </span>
          )}
        </span>
      </button>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={handleFileInputChange}
      />

      {attachments.length > 0 && (
        <ul className={`flex flex-wrap ${compact ? "gap-1.5" : "gap-2"}`}>
          {attachments.map((a, i) => {
            const label = getPreviewLabel?.(i, attachments.length);
            return (
              <li key={a.id} className="relative inline-block list-none">
                <img
                  src={a.dataUrl}
                  alt={label ? `${label} preview` : `Attached image ${i + 1}`}
                  className={`${compact ? "w-12 h-12" : "w-16 h-16"} rounded-xl object-cover border-2 ${cls.previewBorder}`}
                />
                {label && (
                  <span className="absolute bottom-0 left-0 right-0 text-center text-white text-[10px] font-bold bg-black/40 rounded-b-xl leading-4">
                    {label}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => removeAttachment(a.id)}
                  disabled={locked}
                  aria-label={`Remove image ${i + 1}`}
                  className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-red-400 text-white text-xs flex items-center justify-center hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <p role="status" aria-live="polite" aria-atomic="true" className="text-xs text-gray-500 min-h-[1em]">
        {statusText}
      </p>
    </div>
  );
}
