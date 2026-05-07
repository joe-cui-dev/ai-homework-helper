import type { SessionSummary } from "../types";

// Sanity cap on the raw file before compression runs.
// Genuine homework photos are never this large; this mainly guards against
// someone accidentally picking a video file.
const MAX_RAW_FILE_BYTES = 20 * 1024 * 1024; // 20 MB

// Target dimensions and quality after compression.
// 1920 px is enough for Claude to read A4 printed text clearly.
const MAX_DIMENSION = 1920;
const JPEG_QUALITY = 0.85;

// Compress and EXIF-correct an image file before uploading.
// - Scales the image so its longest edge is ≤ MAX_DIMENSION (no-op if already smaller).
// - Re-encodes photos as JPEG; keeps PNG for screenshots / diagrams.
// - Uses createImageBitmap with imageOrientation:"from-image" so the EXIF rotation
//   tag is respected — portrait photos stay portrait, they are not rotated.
export const compressImage = async (file: File): Promise<string> => {
  if (file.size > MAX_RAW_FILE_BYTES) {
    throw new Error("Image file is too large. Please use a photo under 20 MB.");
  }

  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });

  const { width, height } = bitmap;
  const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height));
  const targetWidth = Math.round(width * scale);
  const targetHeight = Math.round(height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable — cannot compress image.");
  ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
  bitmap.close();

  const outputType = file.type === "image/png" ? "image/png" : "image/jpeg";

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) { reject(new Error("Failed to compress image.")); return; }
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error("Failed to read compressed image."));
        reader.readAsDataURL(blob);
      },
      outputType,
      outputType === "image/jpeg" ? JPEG_QUALITY : undefined,
    );
  });
};

export const fetchSessionHistory = async (
  token: string,
  cursor?: string,
  signal?: AbortSignal,
): Promise<{ sessions: SessionSummary[]; nextCursor: string | null }> => {
  const historyUrl = import.meta.env.VITE_HISTORY_API_URL as string | undefined;
  if (!historyUrl) throw new Error("VITE_HISTORY_API_URL is not configured.");

  const url = new URL(historyUrl);
  if (cursor) url.searchParams.set("cursor", cursor);

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });

  if (!response.ok) {
    throw new Error(`History fetch failed with status ${response.status}.`);
  }

  return response.json() as Promise<{ sessions: SessionSummary[]; nextCursor: string | null }>;
};

