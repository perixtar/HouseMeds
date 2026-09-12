import type { AuthProvider } from '../ports/auth-provider.port';

export interface LoginInput {
  email: string;
  password: string;
}

export interface LoginResult {
  accessToken: string;
  idToken: string;
  refreshToken: string;
}

export function makeLoginHousehold(authProvider: AuthProvider) {
  return async function loginHousehold(input: LoginInput): Promise<LoginResult> {
    return authProvider.login(input.email, input.password);
  };
}
