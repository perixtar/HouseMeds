import {
  CognitoIdentityProviderClient,
  SignUpCommand,
  InitiateAuthCommand,
  ForgotPasswordCommand,
  ConfirmForgotPasswordCommand,
  UsernameExistsException,
  NotAuthorizedException,
  UserNotFoundException,
  CodeMismatchException,
  ExpiredCodeException,
} from '@aws-sdk/client-cognito-identity-provider';
import type { AuthProvider } from '../../ports/auth-provider.port';
import {
  AuthProviderError,
  ConflictError,
  UnauthorizedError,
  ValidationError,
} from '../../errors/domain-errors';
import { requireEnv } from '../../config/env';

const client = new CognitoIdentityProviderClient({});

// Thin proxy to Cognito SignUp/InitiateAuth/ForgotPassword/ConfirmForgotPassword.
export class CognitoAuthAdapter implements AuthProvider {
  async signUp(email: string, password: string): Promise<{ cognitoSub: string }> {
    try {
      const result = await client.send(
        new SignUpCommand({
          ClientId: requireEnv('COGNITO_APP_CLIENT_ID'),
          Username: email,
          Password: password,
          UserAttributes: [{ Name: 'email', Value: email }],
        }),
      );
      if (!result.UserSub) {
        throw new AuthProviderError('Cognito SignUp returned no UserSub');
      }
      return { cognitoSub: result.UserSub };
    } catch (err) {
      if (err instanceof UsernameExistsException) {
        throw new ConflictError('An account with this email already exists');
      }
      throw wrapUnknown(err);
    }
  }

  async login(
    email: string,
    password: string,
  ): Promise<{ accessToken: string; idToken: string; refreshToken: string }> {
    try {
      const result = await client.send(
        new InitiateAuthCommand({
          AuthFlow: 'USER_PASSWORD_AUTH',
          ClientId: requireEnv('COGNITO_APP_CLIENT_ID'),
          AuthParameters: { USERNAME: email, PASSWORD: password },
        }),
      );
      const authResult = result.AuthenticationResult;
      if (!authResult?.AccessToken || !authResult.IdToken || !authResult.RefreshToken) {
        throw new AuthProviderError('Cognito InitiateAuth returned no tokens');
      }
      return {
        accessToken: authResult.AccessToken,
        idToken: authResult.IdToken,
        refreshToken: authResult.RefreshToken,
      };
    } catch (err) {
      if (err instanceof NotAuthorizedException || err instanceof UserNotFoundException) {
        throw new UnauthorizedError('Invalid email or password');
      }
      throw wrapUnknown(err);
    }
  }

  async requestPasswordReset(email: string): Promise<void> {
    try {
      await client.send(
        new ForgotPasswordCommand({
          ClientId: requireEnv('COGNITO_APP_CLIENT_ID'),
          Username: email,
        }),
      );
    } catch (err) {
      // Don't leak whether the email exists.
      if (err instanceof UserNotFoundException) return;
      throw wrapUnknown(err);
    }
  }

  async confirmPasswordReset(
    email: string,
    code: string,
    newPassword: string,
  ): Promise<void> {
    try {
      await client.send(
        new ConfirmForgotPasswordCommand({
          ClientId: requireEnv('COGNITO_APP_CLIENT_ID'),
          Username: email,
          ConfirmationCode: code,
          Password: newPassword,
        }),
      );
    } catch (err) {
      if (err instanceof CodeMismatchException || err instanceof ExpiredCodeException) {
        throw new ValidationError('Invalid or expired reset code');
      }
      throw wrapUnknown(err);
    }
  }
}

function wrapUnknown(err: unknown): Error {
  if (err instanceof Error) {
    return new AuthProviderError(`Cognito request failed: ${err.message}`);
  }
  return new AuthProviderError('Cognito request failed');
}
