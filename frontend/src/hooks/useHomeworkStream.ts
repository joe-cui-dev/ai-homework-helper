import { useState, useCallback, useRef } from "react";
import { streamHomework } from "../services/api";
import type { AgentResult, StreamEvent } from "../types";

type Status = "idle" | "streaming" | "done" | "error";

interface ToolEvent {
  tool: string;
  done: boolean;
}

interface UseHomeworkStreamReturn {
  status: Status;
  toolEvents: ToolEvent[];
  result: AgentResult | null;
  error: string | null;
  submit: (question: string, token: string, image?: string) => Promise<void>;
  reset: () => void;
}

// Custom hook to manage the state of the homework stream
export const useHomeworkStream = (): UseHomeworkStreamReturn => {
  const [status, setStatus] = useState<Status>("idle"); // Track the current status of the stream
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]); // Track the events of tools being used during the stream
  const [result, setResult] = useState<AgentResult | null>(null); // Track the final result of the stream
  const [error, setError] = useState<string | null>(null); // Track any error that occurs during the stream

  // Ref to signal when to abort an ongoing stream (e.g., on reset)
  // Using a ref instead of state because we don't want to trigger re-renders when this value changes.
  const abortRef = useRef(false);

  // Reset the state to initial values and signal any ongoing stream to abort
  // This is useful when the user wants to clear the current progress and start fresh.
  const reset = useCallback(() => {
    abortRef.current = true;
    setStatus("idle");
    setToolEvents([]);
    setResult(null);
    setError(null);
  }, []);

  // Submit a question to the homework stream and handle incoming events
  // This function initiates the streaming process and updates the state based on the events received.
  // The handleEvent function is defined inside submit to have access to the current state and refs.
  // The submit function is memoized with useCallback to prevent unnecessary re-renders of components that depend on it.
  const submit = useCallback(
    async (question: string, token: string, image?: string) => {
      // Start a new stream: reset state and clear any previous progress
      abortRef.current = false; // Allow new events to be processed
      setStatus("streaming"); // Mark the status as streaming to show progress indicators
      setToolEvents([]); // Clear any previous tool events
      setResult(null); // Clear previous result
      setError(null); // Clear previous error

      // Handle events from the homework stream
      const handleEvent = (event: StreamEvent) => {
        console.log("Received event:", event); // Log the event for debugging purposes
        // If the user has reset or submitted a new question, we should ignore any incoming events from the previous stream.
        if (abortRef.current) return;

        // Update tool events based on the type of event received
        if (event.type === "tool_start") {
          // When a tool starts, we add it to the list of tool events with done: false
          setToolEvents((prev) => [...prev, { tool: event.tool, done: false }]);
        } else if (event.type === "tool_end") {
          // When a tool ends, we mark it as done in the list of tool events
          setToolEvents((prev) =>
            prev.map((e) =>
              e.tool === event.tool && !e.done ? { ...e, done: true } : e,
            ),
          );
        } else if (event.type === "complete") {
          // When the stream is complete, we set the final result and mark the status as done
          setResult(event.result);
          setStatus("done");
        } else if (event.type === "error") {
          // When an error occurs, we set the error message and mark the status as error
          setError(event.message);
          setStatus("error");
        }
      };

      try {
        // Start streaming the homework process. This function will call handleEvent for each event received from the stream.
        await streamHomework(question, token, handleEvent, image);
        // If the stream finishes without errors, we ensure the status is set to done (in case the complete event was missed)
        setStatus((prev) => (prev === "streaming" ? "done" : prev));
      } catch (err) {
        // If an error occurs during the streaming process (e.g., network error), we catch it here. We also check if the stream was aborted to avoid setting state based on stale events.
        if (!abortRef.current) {
          setError(
            err instanceof Error ? err.message : "Something went wrong.",
          );
          setStatus("error");
        }
      }
    },
    [],
  );

  return { status, toolEvents, result, error, submit, reset };
};
