import type { AuthProvider } from '../../ports/auth-provider.port';
import type { HouseholdRepository } from '../../ports/household-repository.port';
import { UnauthorizedError } from '../../errors/domain-errors';
import { buildMockToken, mockCognitoSub } from './mock-utils';
import mockData from '../../../mock-json/mock-data.json';

const signUpResponse = mockData.calls.signUp.response;
const loginResponse = mockData.calls.login.response;
const requestPasswordResetResponse = mockData.calls.requestPasswordReset.response;
const confirmPasswordResetResponse = mockData.calls.confirmPasswordReset.response;

// No real Cognito call — cognitoSub is derived deterministically from email.
export class MockCognitoAuthAdapter implements AuthProvider {
  constructor(private readonly householdRepository: HouseholdRepository) {}

  async signUp(email: string): Promise<{ cognitoSub: string }> {
    return { cognitoSub: mockCognitoSub(email, signUpResponse.cognitoSubPrefix) };
  }

  async login(
    email: string,
  ): Promise<{ accessToken: string; idToken: string; refreshToken: string }> {
    // Any password is accepted; the account must still exist.
    const household = await this.householdRepository.findByEmail(email);
    if (!household) {
      throw new UnauthorizedError('Invalid email or password');
    }

    const sub = household.cognitoSub;
    return {
      accessToken: buildMockToken(loginResponse.accessTokenPrefix, sub, email),
      idToken: buildMockToken(loginResponse.idTokenPrefix, sub, email),
      refreshToken: buildMockToken(loginResponse.refreshTokenPrefix, sub, email),
    };
  }

  async requestPasswordReset(_email: string): Promise<void> {
    void requestPasswordResetResponse;
  }

  async confirmPasswordReset(): Promise<void> {
    void confirmPasswordResetResponse;
  }
}
