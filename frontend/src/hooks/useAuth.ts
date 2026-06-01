import { useState, useEffect, useCallback } from "react";
import {
  completeNewPassword,
  confirmSmsMfa,
  signIn,
  signOut,
  getAccessToken,
  getCurrentUserEmail,
  type AuthChallengeResult,
  type SignedInResult,
} from "../services/auth";
import type { CognitoUser } from "amazon-cognito-identity-js";

interface AuthUser {
  email: string;
  token: string;
}

interface UseAuthReturn {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<AuthChallengeResult>;
  completePassword: (
    email: string,
    cognitoUser: CognitoUser,
    newPassword: string,
  ) => Promise<AuthChallengeResult>;
  confirmMfa: (
    email: string,
    cognitoUser: CognitoUser,
    code: string,
  ) => Promise<void>;
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

  const applySignedInResult = (result: SignedInResult) => {
    setUser({ email: result.email, token: result.token });
  };

  const login = useCallback(async (email: string, password: string) => {
    const result = await signIn(email, password);
    if (result.type === "signed_in") {
      applySignedInResult(result);
    }
    return result;
  }, []);

  const completePassword = useCallback(
    async (email: string, cognitoUser: CognitoUser, newPassword: string) => {
      const result = await completeNewPassword(email, cognitoUser, newPassword);
      if (result.type === "signed_in") {
        applySignedInResult(result);
      }
      return result;
    },
    [],
  );

  const confirmMfa = useCallback(
    async (email: string, cognitoUser: CognitoUser, code: string) => {
      const result = await confirmSmsMfa(email, cognitoUser, code);
      applySignedInResult(result);
    },
    [],
  );

  const logout = useCallback(() => {
    signOut();
    setUser(null);
  }, []);

  return { user, loading, login, completePassword, confirmMfa, logout };
}
