import { useState, type FormEvent } from "react";
import type { CognitoUser } from "amazon-cognito-identity-js";
import type { AuthChallengeResult } from "../services/auth";

type AuthMode = "signin" | "new_password" | "sms_mfa";

interface PendingChallenge {
  email: string;
  user: CognitoUser;
  destination: string | null;
}

interface AuthPageProps {
  onLogin: (email: string, password: string) => Promise<AuthChallengeResult>;
  onCompletePassword: (
    email: string,
    user: CognitoUser,
    newPassword: string,
  ) => Promise<AuthChallengeResult>;
  onConfirmMfa: (
    email: string,
    user: CognitoUser,
    code: string,
  ) => Promise<void>;
}

export function AuthPage({
  onLogin,
  onCompletePassword,
  onConfirmMfa,
}: AuthPageProps) {
  const [mode, setMode] = useState<AuthMode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [code, setCode] = useState("");
  const [pendingChallenge, setPendingChallenge] =
    useState<PendingChallenge | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const clearMessages = () => {
    setError(null);
    setSuccessMsg(null);
  };

  const applyChallengeResult = (result: AuthChallengeResult) => {
    if (result.type === "new_password_required") {
      setPendingChallenge({
        email: result.email,
        user: result.user,
        destination: null,
      });
      setNewPassword("");
      setConfirmPassword("");
      setMode("new_password");
      setSuccessMsg("Set a permanent password to finish your invitation.");
      return;
    }

    if (result.type === "sms_mfa_required") {
      setPendingChallenge({
        email: result.email,
        user: result.user,
        destination: result.destination,
      });
      setCode("");
      setMode("sms_mfa");
      setSuccessMsg(null);
    }
  };

  const handleSignIn = async (e: FormEvent) => {
    e.preventDefault();
    clearMessages();
    setLoading(true);
    try {
      const result = await onLogin(email, password);
      applyChallengeResult(result);
    } catch (err) {
      setError(normaliseError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleNewPassword = async (e: FormEvent) => {
    e.preventDefault();
    clearMessages();
    if (!pendingChallenge) {
      setError("Please sign in again to continue.");
      setMode("signin");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }

    setLoading(true);
    try {
      const result = await onCompletePassword(
        pendingChallenge.email,
        pendingChallenge.user,
        newPassword,
      );
      setPassword("");
      setNewPassword("");
      setConfirmPassword("");
      applyChallengeResult(result);
    } catch (err) {
      setError(normaliseError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSmsMfa = async (e: FormEvent) => {
    e.preventDefault();
    clearMessages();
    if (!pendingChallenge) {
      setError("Please sign in again to continue.");
      setMode("signin");
      return;
    }

    setLoading(true);
    try {
      await onConfirmMfa(pendingChallenge.email, pendingChallenge.user, code);
      setCode("");
      setPendingChallenge(null);
    } catch (err) {
      setError(normaliseError(err));
    } finally {
      setLoading(false);
    }
  };

  const mfaDestination = pendingChallenge?.destination ?? "your phone";

  return (
    <div className="min-h-screen bg-gradient-to-br from-sky-200 via-indigo-100 to-purple-200 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-3xl shadow-xl overflow-hidden">
          <div className="bg-gradient-to-r from-brand-500 to-indigo-500 px-5 py-6 sm:px-8 sm:py-8 text-center">
            <div className="text-5xl mb-2">🎒</div>
            <h1 className="text-2xl font-extrabold text-white tracking-tight">
              AI Homework Helper
            </h1>
            <p className="text-blue-100 text-sm mt-1">
              Parent coaching for schoolwork
            </p>
          </div>

          <div className="px-5 py-5 sm:px-8 sm:py-6 space-y-4">
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
                <SubmitButton loading={loading}>Sign in</SubmitButton>
              </form>
            )}

            {mode === "new_password" && (
              <form onSubmit={handleNewPassword} className="space-y-4">
                <p className="text-gray-500 text-sm text-center">
                  Create a permanent password for {pendingChallenge?.email}.
                </p>
                <Input
                  label="New password"
                  type="password"
                  value={newPassword}
                  onChange={setNewPassword}
                  placeholder="At least 8 characters"
                  autoComplete="new-password"
                />
                <Input
                  label="Confirm password"
                  type="password"
                  value={confirmPassword}
                  onChange={setConfirmPassword}
                  placeholder="Repeat your new password"
                  autoComplete="new-password"
                />
                <SubmitButton loading={loading}>Continue</SubmitButton>
              </form>
            )}

            {mode === "sms_mfa" && (
              <form onSubmit={handleSmsMfa} className="space-y-4">
                <p className="text-gray-500 text-sm text-center">
                  Enter the 6-digit code sent to {mfaDestination}.
                </p>
                <Input
                  label="SMS code"
                  type="text"
                  value={code}
                  onChange={setCode}
                  placeholder="123456"
                  autoComplete="one-time-code"
                />
                <SubmitButton loading={loading}>Verify</SubmitButton>
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
    const msg = err.message;
    if (
      msg.includes("UserNotFoundException") ||
      msg.includes("Incorrect username") ||
      msg.includes("NotAuthorizedException")
    ) {
      return "Email or password is incorrect.";
    }
    if (msg.includes("PasswordResetRequiredException")) {
      return "This account needs a password reset before signing in.";
    }
    if (msg.includes("InvalidPasswordException")) {
      return "Password must be at least 8 characters and include uppercase, lowercase, and a number.";
    }
    if (msg.includes("CodeMismatchException")) {
      return "That code doesn't match. Please check and try again.";
    }
    if (msg.includes("ExpiredCodeException")) {
      return "That code has expired. Please sign in again.";
    }
    if (msg.includes("LimitExceededException")) {
      return "Too many attempts. Please wait a moment and try again.";
    }
    return msg;
  }
  return "Something went wrong. Please try again.";
}
