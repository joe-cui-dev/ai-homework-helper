import {
  CognitoUser,
  CognitoUserPool,
  CognitoUserAttribute,
  AuthenticationDetails,
  CognitoUserSession,
} from "amazon-cognito-identity-js";

const userPool = new CognitoUserPool({
  UserPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID,
  ClientId: import.meta.env.VITE_COGNITO_APP_CLIENT_ID,
});

export const signUp = (
  email: string,
  password: string,
): Promise<CognitoUser> => {
  const attributes = [
    new CognitoUserAttribute({ Name: "email", Value: email }),
  ];
  return new Promise((resolve, reject) => {
    userPool.signUp(email, password, attributes, [], (err, result) => {
      if (err || !result) return reject(err ?? new Error("Sign-up failed"));
      resolve(result.user);
    });
  });
};

export const confirmSignUp = (email: string, code: string): Promise<void> => {
  const user = new CognitoUser({ Username: email, Pool: userPool });
  return new Promise((resolve, reject) => {
    user.confirmRegistration(code, true, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
};

export const signIn = (email: string, password: string): Promise<string> => {
  const user = new CognitoUser({ Username: email, Pool: userPool });
  const authDetails = new AuthenticationDetails({
    Username: email,
    Password: password,
  });
  return new Promise((resolve, reject) => {
    user.authenticateUser(authDetails, {
      onSuccess: (session: CognitoUserSession) => {
        resolve(session.getAccessToken().getJwtToken());
      },
      onFailure: reject,
    });
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

export const getCurrentUserEmail = (): string | null => {
  return userPool.getCurrentUser()?.getUsername() ?? null;
};
