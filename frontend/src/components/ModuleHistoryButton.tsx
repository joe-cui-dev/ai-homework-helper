import { useState } from "react";
import { HistorySidebar } from "./HistorySidebar";
import type { HistoryModule } from "../services/api";

interface ModuleHistoryButtonProps {
  token: string;
  module: HistoryModule;
}

export function ModuleHistoryButton({ token, module }: ModuleHistoryButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-semibold text-gray-500 bg-white border border-gray-200 hover:text-brand-600 hover:border-brand-200 transition-colors"
      >
        <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path
            fillRule="evenodd"
            d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-13a.75.75 0 00-1.5 0v5c0 .2.08.39.22.53l3 3a.75.75 0 101.06-1.06L10.75 9.69V5z"
            clipRule="evenodd"
          />
        </svg>
        History
      </button>
      <HistorySidebar
        token={token}
        module={module}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
