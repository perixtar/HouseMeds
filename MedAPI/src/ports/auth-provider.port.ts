// Proxy contract to Cognito's SignUp/InitiateAuth/ForgotPassword/ConfirmForgotPassword.
export interface AuthProvider {
  /** Returns the new user's Cognito `sub`. */
  signUp(email: string, password: string): Promise<{ cognitoSub: string }>;

  login(
    email: string,
    password: string,
  ): Promise<{ accessToken: string; idToken: string; refreshToken: string }>;

  requestPasswordReset(email: string): Promise<void>;

  confirmPasswordReset(email: string, code: string, newPassword: string): Promise<void>;
}
