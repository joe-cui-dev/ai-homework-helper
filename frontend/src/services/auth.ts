import {
  CognitoUser,
  CognitoUserPool,
  AuthenticationDetails,
  CognitoUserSession,
  type IAuthenticationCallback,
} from "amazon-cognito-identity-js";

const userPool = new CognitoUserPool({
  UserPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID,
  ClientId: import.meta.env.VITE_COGNITO_APP_CLIENT_ID,
});

export interface SignedInResult {
  type: "signed_in";
  email: string;
  token: string;
}

export interface NewPasswordRequiredResult {
  type: "new_password_required";
  email: string;
  user: CognitoUser;
}

export interface SmsMfaRequiredResult {
  type: "sms_mfa_required";
  email: string;
  user: CognitoUser;
  destination: string | null;
}

export type AuthChallengeResult =
  | SignedInResult
  | NewPasswordRequiredResult
  | SmsMfaRequiredResult;

const toSignedInResult = (
  email: string,
  session: CognitoUserSession,
): SignedInResult => {
  return {
    type: "signed_in",
    email,
    token: session.getAccessToken().getJwtToken(),
  };
};

const getMfaDestination = (challengeParameters: unknown): string | null => {
  if (!challengeParameters || typeof challengeParameters !== "object") {
    return null;
  }
  const destination = (challengeParameters as Record<string, unknown>)[
    "CODE_DELIVERY_DESTINATION"
  ];
  return typeof destination === "string" ? destination : null;
};

const createChallengeCallbacks = (
  email: string,
  user: CognitoUser,
  resolve: (result: AuthChallengeResult) => void,
  reject: (err: unknown) => void,
): IAuthenticationCallback => ({
  onSuccess: (session: CognitoUserSession) => {
    resolve(toSignedInResult(email, session));
  },
  onFailure: reject,
  newPasswordRequired: () => {
    resolve({ type: "new_password_required", email, user });
  },
  mfaRequired: (_challengeName, challengeParameters) => {
    resolve({
      type: "sms_mfa_required",
      email,
      user,
      destination: getMfaDestination(challengeParameters),
    });
  },
});

export const signIn = (
  email: string,
  password: string,
): Promise<AuthChallengeResult> => {
  const user = new CognitoUser({ Username: email, Pool: userPool });
  const authDetails = new AuthenticationDetails({
    Username: email,
    Password: password,
  });
  return new Promise((resolve, reject) => {
    user.authenticateUser(
      authDetails,
      createChallengeCallbacks(email, user, resolve, reject),
    );
  });
};

export const completeNewPassword = (
  email: string,
  user: CognitoUser,
  newPassword: string,
): Promise<AuthChallengeResult> => {
  return new Promise((resolve, reject) => {
    user.completeNewPasswordChallenge(
      newPassword,
      {},
      createChallengeCallbacks(email, user, resolve, reject),
    );
  });
};

export const confirmSmsMfa = (
  email: string,
  user: CognitoUser,
  code: string,
): Promise<SignedInResult> => {
  return new Promise((resolve, reject) => {
    user.sendMFACode(
      code,
      {
        onSuccess: (session: CognitoUserSession) => {
          resolve(toSignedInResult(email, session));
        },
        onFailure: reject,
      },
      "SMS_MFA",
    );
  });
};

export const signOut = (): void => {
  const user = userPool.getCurrentUser();
  user?.signOut();
};

export const getAccessToken = (): Promise<string | null> => {
  return new Promise((resolve) => {
    const user = userPool.getCurrentUser();
    if (!user) return resolve(null);
    user.getSession((err: Error | null, session: CognitoUserSession | null) => {
      if (err || !session || !session.isValid()) return resolve(null);
      resolve(session.getAccessToken().getJwtToken());
    });
  });
};

export const getCurrentUserEmail = (): Promise<string | null> => {
  return new Promise((resolve) => {
    const user = userPool.getCurrentUser();
    if (!user) return resolve(null);
    user.getSession((err: Error | null, session: CognitoUserSession | null) => {
      if (err || !session || !session.isValid()) return resolve(null);
      const email = session.getIdToken().payload.email as string | undefined;
      resolve(email ?? null);
    });
  });
};
