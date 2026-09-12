import type { AuthProvider } from '../ports/auth-provider.port';

export function makeRequestPasswordReset(authProvider: AuthProvider) {
  return async function requestPasswordReset(email: string): Promise<void> {
    await authProvider.requestPasswordReset(email);
  };
}

export interface ConfirmPasswordResetInput {
  email: string;
  code: string;
  newPassword: string;
}

export function makeConfirmPasswordReset(authProvider: AuthProvider) {
  return async function confirmPasswordReset(
    input: ConfirmPasswordResetInput,
  ): Promise<void> {
    await authProvider.confirmPasswordReset(input.email, input.code, input.newPassword);
  };
}
