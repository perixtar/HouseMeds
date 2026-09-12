import { join } from 'node:path';
import Fastify from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
} from 'fastify-type-provider-zod';
import { registerAuthRoutes } from './routes/auth.routes';
import { registerPrescriptionRoutes } from './routes/prescriptions.routes';
import { DomainError } from './errors/domain-errors';
import { logger } from './common/logger';
import { swaggerAuthorizeStatusScript } from './common/swagger-authorize-status';
import { getEnv } from './config/env';

const healthResponseSchema = z.object({ status: z.literal('ok') });

export function buildApp() {
  const app = Fastify({ logger: false });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Generated from the same Zod schemas that validate each route.
  void app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'MedHouse API',
        description:
          'Household medication-cost tracking API. Auth is email/password per ' +
          'household via Cognito.\n\n' +
          '**To call a protected route (`/prescriptions*`) from this page:**\n' +
          '1. Run `POST /login` below ("Try it out") with a registered email/password.\n' +
          '2. Copy the `accessToken` from the response.\n' +
          '3. Click the **Authorize** button (top right, 🔓) and paste *just* the ' +
          'token — no `Bearer ` prefix, Swagger adds that for you.\n' +
          '4. Click **Authorize**, then **Close**. Every "Try it out" call on a ' +
          'protected route now sends it automatically until you close the tab or ' +
          'click **Logout** in that same dialog.',
        version: '0.1.0',
      },
      // API_BASE_URL is set only in deployed environments; falls back to
      // the local dev-server port otherwise.
      servers: [
        {
          url: getEnv().API_BASE_URL ?? 'http://localhost:3000',
          description: getEnv().API_BASE_URL ? 'Deployed' : 'Local dev',
        },
      ],
      tags: [
        {
          name: 'Auth',
          description: 'Cognito-backed registration, login, and password reset',
        },
        {
          name: 'Prescriptions',
          description: "A household's members and their medicines",
        },
        { name: 'Health', description: 'Liveness check' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description:
              'Cognito access token from POST /login. In the deployed environment, API ' +
              "Gateway's HTTP API JWT authorizer verifies this before the request ever " +
              'reaches the Lambda.',
          },
        },
      },
    },
    transform: jsonSchemaTransform,
  });

  // esbuild bundles into one file, so the plugin's static/ dir doesn't ship
  // with it — point baseDir at the copy serverless.yml's package.patterns
  // places under LAMBDA_TASK_ROOT. Omit it locally so the plugin uses its
  // own on-disk path (exactOptionalPropertyTypes rejects `undefined`).
  const swaggerUiStaticBaseDir = process.env.LAMBDA_TASK_ROOT
    ? join(process.env.LAMBDA_TASK_ROOT, 'node_modules/@fastify/swagger-ui/static')
    : undefined;

  void app.register(fastifySwaggerUi, {
    routePrefix: '/docs',
    // Avoids the plugin's default disk read for its own logo.svg, which
    // 500s once esbuild bundles everything into one file.
    logo: {
      type: 'image/svg+xml',
      content: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><rect width="40" height="40" rx="8" fill="#1d4ed8"/><text x="20" y="26" font-family="sans-serif" font-size="16" font-weight="700" fill="#fff" text-anchor="middle">M</text></svg>',
      ),
    },
    ...(swaggerUiStaticBaseDir ? { baseDir: swaggerUiStaticBaseDir } : {}),
    uiConfig: {
      // Keep the entered token applied across a page reload.
      persistAuthorization: true,
      // Expand the route list so protected-route lock icons are visible.
      docExpansion: 'list',
    },
    // Verifies the "Authorize" token actually works via a real API call
    // (the dialog itself only confirms it was saved).
    theme: {
      js: [{ filename: 'authorize-status.js', content: swaggerAuthorizeStatusScript }],
    },
  });

  // Only place typed domain errors turn into HTTP responses.
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) {
      reply.code(error.statusCode).send({ code: error.code, message: error.message });
      return;
    }

    // Zod validation failures already carry statusCode 400.
    if (
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode < 500
    ) {
      reply.code(error.statusCode).send({ code: 'BAD_REQUEST', message: error.message });
      return;
    }

    logger.error('Unhandled error', {
      error: error.message,
      requestId: request.id,
    });
    reply.code(500).send({ code: 'INTERNAL_ERROR', message: 'Something went wrong' });
  });

  // Wrapped in .register() so these routes register after the swagger
  // plugin boots and show up in the generated spec.
  void app.register(async (instance) => {
    registerAuthRoutes(instance);

    instance.withTypeProvider<ZodTypeProvider>().get(
      '/health',
      {
        schema: {
          tags: ['Health'],
          summary: 'Liveness check',
          response: { 200: healthResponseSchema },
        },
      },
      async () => ({ status: 'ok' as const }),
    );
  });

  registerPrescriptionRoutes(app);

  return app;
}

export { jsonSchemaTransform };
