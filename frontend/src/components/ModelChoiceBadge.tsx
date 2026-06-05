import type { ModelChoice } from "../types";

export const modelChoiceLabel = (choice?: ModelChoice): string =>
  choice === "advanced" ? "Advanced" : "Fast";

export function ModelChoiceBadge({ choice }: { choice?: ModelChoice }) {
  const isAdvanced = choice === "advanced";
  return (
    <span
      className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${
        isAdvanced
          ? "bg-indigo-50 text-indigo-700 border-indigo-100"
          : "bg-emerald-50 text-emerald-700 border-emerald-100"
      }`}
    >
      {modelChoiceLabel(choice)}
    </span>
  );
}
