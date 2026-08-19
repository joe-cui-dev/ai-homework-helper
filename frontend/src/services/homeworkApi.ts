import type { ModelChoice, StreamEvent } from "../types";
import { parseNdjsonStream } from "./ndjson";

interface InitialHomeworkRequest {
  kind: "initial";
  question: string;
  images: string[] | null;
  modelChoice: ModelChoice;
}

interface AppendHomeworkPagesRequest {
  kind: "append_pages";
  sessionId: string;
  submissionId: string;
  images: string[];
}

export const streamHomework = async (
  question: string,
  token: string,
  onEvent: (event: StreamEvent) => void,
  images?: string[],
  signal?: AbortSignal,
  modelChoice: ModelChoice = "fast",
): Promise<void> => {
  const apiUrl = import.meta.env.VITE_HOMEWORK_API_URL;
  if (!apiUrl) throw new Error("VITE_HOMEWORK_API_URL is not configured.");

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      kind: "initial",
      question,
      images: images?.length ? images : null,
      modelChoice,
    } satisfies InitialHomeworkRequest),
    signal,
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `Request failed with status ${response.status}.`);
  }

  await parseNdjsonStream<StreamEvent>(response.body, onEvent);
};

export const appendHomeworkPages = async (
  sessionId: string,
  submissionId: string,
  images: string[],
  token: string,
  onEvent: (event: StreamEvent) => void,
): Promise<void> => {
  const apiUrl = import.meta.env.VITE_HOMEWORK_API_URL;
  if (!apiUrl) throw new Error("VITE_HOMEWORK_API_URL is not configured.");
  const request: AppendHomeworkPagesRequest = { kind: "append_pages", sessionId, submissionId, images };
  const response = await fetch(apiUrl, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(request) });
  if (!response.ok || !response.body) throw new Error(`Request failed with status ${response.status}.`);
  await parseNdjsonStream<StreamEvent>(response.body, onEvent);
};
