import { useState } from "react";
import { BrowserRouter, Routes, Route, Navigate, NavLink } from "react-router-dom";
import { AuthPage } from "./components/AuthPage";
import { HistorySidebar } from "./components/HistorySidebar";
import { HomeworkPage } from "./pages/HomeworkPage";
import { ReadingPage } from "./pages/ReadingPage";
import { PracticePage } from "./pages/PracticePage";
import { WritingPage } from "./pages/WritingPage";
import { WritingSessionPage } from "./pages/WritingSessionPage";
import { useAuth } from "./hooks/useAuth";

function AppShell({
  email,
  token,
  onLogout,
}: {
  email: string;
  token: string;
  onLogout: () => void;
}) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    `px-4 py-2 rounded-xl text-sm font-bold transition-colors ${
      isActive
        ? "bg-white text-brand-700 shadow-sm"
        : "text-gray-500 hover:text-brand-600"
    }`;

  return (
    <div className="min-h-screen bg-gradient-to-br from-sky-100 via-indigo-50 to-purple-100">
      <HistorySidebar token={token} open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <header className="bg-white/80 backdrop-blur-sm border-b border-gray-100 sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          {/* Left: history + logo */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setSidebarOpen(true)}
              className="p-1.5 rounded-lg text-gray-400 hover:text-brand-600 hover:bg-brand-50 transition-colors"
              aria-label="Open history"
            >
              <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path
                  fillRule="evenodd"
                  d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h6a1 1 0 110 2H4a1 1 0 01-1-1z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
            <span className="text-2xl">🎒</span>
          </div>

          {/* Centre: nav */}
          <nav className="flex gap-1 p-1 bg-gray-100/70 rounded-2xl flex-1 max-w-md">
            <NavLink to="/homework" className={navLinkClass}>
              Homework
            </NavLink>
            <NavLink to="/reading" className={navLinkClass}>
              Reading
            </NavLink>
            <NavLink to="/writing" className={navLinkClass}>
              Writing
            </NavLink>
            <NavLink to="/practice" className={navLinkClass}>
              Practice
            </NavLink>
          </nav>

          {/* Right: email + sign out */}
          <div className="flex items-center gap-3 shrink-0">
            <span className="text-sm text-gray-500 hidden sm:block truncate max-w-[120px]">
              {email}
            </span>
            <button
              onClick={onLogout}
              className="px-3 py-1.5 rounded-xl text-sm font-semibold text-gray-500 hover:text-red-500 hover:bg-red-50 transition-colors"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <Routes>
        <Route path="/" element={<Navigate to="/homework" replace />} />
        <Route path="/homework" element={<HomeworkPage token={token} />} />
        <Route path="/reading" element={<ReadingPage token={token} />} />
        <Route path="/writing" element={<WritingPage token={token} />} />
        <Route path="/writing/:batchId" element={<WritingSessionPage token={token} />} />
        <Route path="/practice" element={<Navigate to="/homework" replace />} />
        <Route path="/practice/:sessionId" element={<PracticePage token={token} />} />
        <Route path="*" element={<Navigate to="/homework" replace />} />
      </Routes>
    </div>
  );
}

export default function App() {
  const { user, loading, login, register, confirm, logout } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-sky-100 via-indigo-50 to-purple-100 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <span className="text-5xl animate-bounce">🎒</span>
          <p className="text-brand-600 font-bold text-lg">Loading…</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <AuthPage onLogin={login} onRegister={register} onConfirm={confirm} />
    );
  }

  return (
    <BrowserRouter basename="/ai-homework-helper">
      <AppShell email={user.email} token={user.token} onLogout={logout} />
    </BrowserRouter>
  );
}
