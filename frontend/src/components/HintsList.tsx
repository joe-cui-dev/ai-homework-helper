import { useState } from "react";

interface HintsListProps {
  hints: string[];
}

export function HintsList({ hints }: HintsListProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-4">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-brand-600 font-semibold hover:text-brand-800 transition-colors"
      >
        <span className="text-lg">💡</span>
        {open ? "Hide hints" : "Need a hint?"}
        <span className="text-xs font-normal text-gray-400">
          ({hints.length} hint{hints.length !== 1 ? "s" : ""})
        </span>
        <svg
          className={`w-4 h-4 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {open && (
        <ul className="mt-3 space-y-2">
          {hints.map((hint, i) => (
            <li
              key={i}
              className="flex items-start gap-3 bg-accent-300/20 rounded-xl px-4 py-3"
            >
              <span className="text-accent-500 font-bold text-sm flex-shrink-0 mt-0.5">
                {i + 1}.
              </span>
              <p className="text-gray-700 text-sm leading-relaxed">{hint}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
