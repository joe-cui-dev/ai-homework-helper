import { AuthPage } from "./components/AuthPage";
import { HomePage } from "./components/HomePage";
import { useAuth } from "./hooks/useAuth";

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

  return <HomePage email={user.email} token={user.token} onLogout={logout} />;
}
