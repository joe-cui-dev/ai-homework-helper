import { useState, type FormEvent } from "react";

type AuthMode = "signin" | "signup" | "confirm";

interface AuthPageProps {
  onLogin: (email: string, password: string) => Promise<void>;
  onRegister: (email: string, password: string) => Promise<void>;
  onConfirm: (email: string, code: string) => Promise<void>;
}

export function AuthPage({ onLogin, onRegister, onConfirm }: AuthPageProps) {
  const [mode, setMode] = useState<AuthMode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [pendingEmail, setPendingEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const clearMessages = () => {
    setError(null);
    setSuccessMsg(null);
  };

  const handleSignIn = async (e: FormEvent) => {
    e.preventDefault();
    clearMessages();
    setLoading(true);
    try {
      await onLogin(email, password);
    } catch (err) {
      setError(normaliseError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSignUp = async (e: FormEvent) => {
    e.preventDefault();
    clearMessages();
    setLoading(true);
    try {
      await onRegister(email, password);
      setPendingEmail(email);
      setMode("confirm");
      setSuccessMsg(`We sent a verification code to ${email}.`);
    } catch (err) {
      setError(normaliseError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async (e: FormEvent) => {
    e.preventDefault();
    clearMessages();
    setLoading(true);
    try {
      await onConfirm(pendingEmail, code);
      setSuccessMsg("Account confirmed! Please sign in.");
      setMode("signin");
      setEmail(pendingEmail);
      setPassword("");
      setCode("");
    } catch (err) {
      setError(normaliseError(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-sky-200 via-indigo-100 to-purple-200 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Card */}
        <div className="bg-white rounded-3xl shadow-xl overflow-hidden">
          {/* Hero header */}
          <div className="bg-gradient-to-r from-brand-500 to-indigo-500 px-8 py-8 text-center">
            <div className="text-5xl mb-2">🎒</div>
            <h1 className="text-2xl font-extrabold text-white tracking-tight">
              AI Homework Helper
            </h1>
            <p className="text-blue-100 text-sm mt-1">
              Your personal study buddy for school ✨
            </p>
          </div>

          {/* Tab switcher (only for signin/signup) */}
          {mode !== "confirm" && (
            <div className="flex border-b border-gray-100">
              {(["signin", "signup"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => {
                    setMode(m);
                    clearMessages();
                  }}
                  className={`flex-1 py-3 text-sm font-bold transition-colors ${
                    mode === m
                      ? "text-brand-600 border-b-2 border-brand-500"
                      : "text-gray-400 hover:text-gray-600"
                  }`}
                >
                  {m === "signin" ? "Sign In" : "Sign Up"}
                </button>
              ))}
            </div>
          )}

          <div className="px-8 py-6 space-y-4">
            {/* Feedback messages */}
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-red-600 text-sm">
                {error}
              </div>
            )}
            {successMsg && (
              <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-green-700 text-sm">
                {successMsg}
              </div>
            )}

            {/* Sign In form */}
            {mode === "signin" && (
              <form onSubmit={handleSignIn} className="space-y-4">
                <Input
                  label="Email"
                  type="email"
                  value={email}
                  onChange={setEmail}
                  placeholder="you@example.com"
                  autoComplete="email"
                />
                <Input
                  label="Password"
                  type="password"
                  value={password}
                  onChange={setPassword}
                  placeholder="Your password"
                  autoComplete="current-password"
                />
                <SubmitButton loading={loading}>Let's go! 🚀</SubmitButton>
                <p className="text-center text-sm text-gray-400">
                  No account?{" "}
                  <button
                    type="button"
                    onClick={() => {
                      setMode("signup");
                      clearMessages();
                    }}
                    className="text-brand-500 font-semibold hover:underline"
                  >
                    Sign up free
                  </button>
                </p>
              </form>
            )}

            {/* Sign Up form */}
            {mode === "signup" && (
              <form onSubmit={handleSignUp} className="space-y-4">
                <Input
                  label="Email"
                  type="email"
                  value={email}
                  onChange={setEmail}
                  placeholder="you@example.com"
                  autoComplete="email"
                />
                <Input
                  label="Password"
                  type="password"
                  value={password}
                  onChange={setPassword}
                  placeholder="At least 8 characters"
                  autoComplete="new-password"
                />
                <SubmitButton loading={loading}>
                  Create my account 🎉
                </SubmitButton>
                <p className="text-center text-sm text-gray-400">
                  Already have one?{" "}
                  <button
                    type="button"
                    onClick={() => {
                      setMode("signin");
                      clearMessages();
                    }}
                    className="text-brand-500 font-semibold hover:underline"
                  >
                    Sign in
                  </button>
                </p>
              </form>
            )}

            {/* Confirm form */}
            {mode === "confirm" && (
              <form onSubmit={handleConfirm} className="space-y-4">
                <p className="text-gray-500 text-sm text-center">
                  Check your email for a 6-digit code and enter it below.
                </p>
                <Input
                  label="Verification code"
                  type="text"
                  value={code}
                  onChange={setCode}
                  placeholder="123456"
                  autoComplete="one-time-code"
                />
                <SubmitButton loading={loading}>
                  Verify & continue ✅
                </SubmitButton>
              </form>
            )}
          </div>
        </div>

        <p className="text-center text-xs text-gray-400 mt-4">
          Safe, private, and designed for Australian primary school students.
        </p>
      </div>
    </div>
  );
}

// ─── Small helpers ─────────────────────────────────────────────────────────────

interface InputProps {
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoComplete?: string;
}

function Input({
  label,
  type,
  value,
  onChange,
  placeholder,
  autoComplete,
}: InputProps) {
  return (
    <div className="space-y-1">
      <label className="text-sm font-bold text-gray-600">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        required
        className="w-full rounded-xl border-2 border-gray-200 focus:border-brand-400 focus:outline-none px-4 py-2.5 text-gray-800 placeholder-gray-300 transition-colors"
      />
    </div>
  );
}

interface SubmitButtonProps {
  loading: boolean;
  children: React.ReactNode;
}

function SubmitButton({ loading, children }: SubmitButtonProps) {
  return (
    <button
      type="submit"
      disabled={loading}
      className="w-full py-3 rounded-2xl bg-gradient-to-r from-brand-500 to-indigo-500 text-white font-bold text-base shadow hover:shadow-md hover:from-brand-600 hover:to-indigo-600 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
    >
      {loading ? (
        <span className="flex items-center justify-center gap-2">
          <svg
            className="animate-spin w-4 h-4 text-white"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
          Working…
        </span>
      ) : (
        children
      )}
    </button>
  );
}

function normaliseError(err: unknown): string {
  if (err instanceof Error) {
    // Make Cognito error messages friendlier.
    const msg = err.message;
    if (
      msg.includes("UserNotFoundException") ||
      msg.includes("Incorrect username")
    )
      return "Email or password is incorrect.";
    if (msg.includes("NotAuthorizedException"))
      return "Email or password is incorrect.";
    if (msg.includes("UsernameExistsException"))
      return "That email is already registered. Try signing in.";
    if (msg.includes("InvalidPasswordException"))
      return "Password must be at least 8 characters and include a number and symbol.";
    if (msg.includes("CodeMismatchException"))
      return "That code doesn't match. Please check and try again.";
    if (msg.includes("ExpiredCodeException"))
      return "That code has expired. Please sign up again.";
    return msg;
  }
  return "Something went wrong. Please try again.";
}
