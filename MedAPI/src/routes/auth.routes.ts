import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { usecases } from '../composition';
import { errorResponseSchema } from '../common/http-schemas';

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const householdResponseSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  createdAt: z.string(),
});

const loginResponseSchema = z.object({
  accessToken: z.string(),
  idToken: z.string(),
  refreshToken: z.string(),
});

const requestResetSchema = z.object({
  email: z.string().email(),
});

const confirmResetSchema = z.object({
  email: z.string().email(),
  code: z.string().min(1),
  newPassword: z.string().min(8),
});

const okResponseSchema = z.object({ success: z.literal(true) });

// Thin proxies to Cognito via the usecases in composition.ts.
export function registerAuthRoutes(app: FastifyInstance): void {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.post(
    '/register',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Register a new household',
        description:
          'Thin proxy to Cognito SignUp. Creates the household record with the ' +
          'returned Cognito `sub` — MedHouse never stores or hashes a password itself.',
        body: credentialsSchema,
        response: {
          201: householdResponseSchema,
          400: errorResponseSchema,
          409: errorResponseSchema,
          502: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const household = await usecases.registerHousehold(request.body);
      reply.code(201);
      return {
        id: household.id,
        email: household.email,
        createdAt: household.createdAt.toISOString(),
      };
    },
  );

  server.post(
    '/login',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Log in and receive Cognito tokens',
        description:
          'Thin proxy to Cognito InitiateAuth (USER_PASSWORD_AUTH). Returns the ' +
          'access/id/refresh tokens issued by Cognito verbatim — use `accessToken` ' +
          'as the bearer token on every `/prescriptions` route.',
        body: credentialsSchema,
        response: {
          200: loginResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          502: errorResponseSchema,
        },
      },
    },
    async (request) => usecases.loginHousehold(request.body),
  );

  server.post(
    '/reset-password',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Request a password reset code',
        description:
          'Thin proxy to Cognito ForgotPassword. Always responds the same way ' +
          'whether or not the email is registered, to avoid leaking account existence.',
        body: requestResetSchema,
        response: {
          200: okResponseSchema,
          400: errorResponseSchema,
          502: errorResponseSchema,
        },
      },
    },
    async (request) => {
      await usecases.requestPasswordReset(request.body.email);
      return { success: true as const };
    },
  );

  server.post(
    '/reset-password/confirm',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Confirm a password reset with the emailed code',
        description: 'Thin proxy to Cognito ConfirmForgotPassword.',
        body: confirmResetSchema,
        response: {
          200: okResponseSchema,
          400: errorResponseSchema,
          502: errorResponseSchema,
        },
      },
    },
    async (request) => {
      await usecases.confirmPasswordReset(request.body);
      return { success: true as const };
    },
  );
}
