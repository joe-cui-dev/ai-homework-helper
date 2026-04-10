import { useState } from "react";

interface StepListProps {
  steps: string[];
}

export function StepList({ steps }: StepListProps) {
  const [expanded, setExpanded] = useState<Set<number>>(
    () => new Set(steps.map((_, i) => i)),
  );

  const toggle = (i: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });

  return (
    <ol className="space-y-2">
      {steps.map((step, i) => (
        <li key={i} className="flex items-start gap-3">
          <button
            onClick={() => toggle(i)}
            className="flex-shrink-0 w-7 h-7 rounded-full bg-accent-400 text-white font-bold text-sm flex items-center justify-center hover:bg-accent-500 transition-colors"
            aria-label={expanded.has(i) ? "Collapse step" : "Expand step"}
          >
            {i + 1}
          </button>
          {expanded.has(i) && (
            <p className="text-gray-700 leading-relaxed pt-0.5">{step}</p>
          )}
          {!expanded.has(i) && (
            <p className="text-gray-400 text-sm pt-1 italic">
              Step {i + 1} — click to expand
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}
