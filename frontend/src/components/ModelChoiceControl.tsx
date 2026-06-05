import type { ModelChoice } from "../types";

interface ModelChoiceControlProps {
  value: ModelChoice;
  onChange: (value: ModelChoice) => void;
  disabled?: boolean;
}

const OPTIONS: Array<{ value: ModelChoice; label: string }> = [
  { value: "fast", label: "Fast" },
  { value: "advanced", label: "Advanced" },
];

export function ModelChoiceControl({
  value,
  onChange,
  disabled = false,
}: ModelChoiceControlProps) {
  return (
    <div className="flex items-center justify-between gap-3 flex-wrap">
      <span className="text-sm font-semibold text-gray-700">Model</span>
      <div className="grid grid-cols-2 rounded-xl border border-gray-200 bg-gray-50 p-1 min-w-48">
        {OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50 ${
              value === option.value
                ? "bg-white text-gray-900 shadow-sm"
                : "text-gray-500 hover:text-gray-800"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
