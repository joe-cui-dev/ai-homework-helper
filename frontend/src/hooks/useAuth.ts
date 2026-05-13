import { useState, useEffect, useCallback } from "react";
import {
  signIn,
  signUp,
  confirmSignUp,
  signOut,
  getAccessToken,
  getCurrentUserEmail,
} from "../services/auth";

interface AuthUser {
  email: string;
  token: string;
}

interface UseAuthReturn {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  confirm: (email: string, code: string) => Promise<void>;
  logout: () => void;
}

export function useAuth(): UseAuthReturn {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getAccessToken().then(async (token) => {
      if (token) {
        const email = (await getCurrentUserEmail()) ?? "";
        setUser({ email, token });
      }
      setLoading(false);
    });
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const token = await signIn(email, password);
    setUser({ email, token });
  }, []);

  const register = useCallback(async (email: string, password: string) => {
    await signUp(email, password);
  }, []);

  const confirm = useCallback(async (email: string, code: string) => {
    await confirmSignUp(email, code);
  }, []);

  const logout = useCallback(() => {
    signOut();
    setUser(null);
  }, []);

  return { user, loading, login, register, confirm, logout };
}
