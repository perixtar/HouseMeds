import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { makeIdempotent, IdempotencyConfig } from '@aws-lambda-powertools/idempotency';
import { DynamoDBPersistenceLayer } from '@aws-lambda-powertools/idempotency/dynamodb';
import { usecases } from '../composition';
import { requireHousehold } from '../common/auth';
import { isMockTarget, requireEnv } from '../config/env';
import { errorResponseSchema, bearerAuthSecurity } from '../common/http-schemas';
import {
  medicationForms,
  quantityUnits,
  type PrescriptionHousehold,
} from '../domain/types';

const medicineInputSchema = z.object({
  id: z.string().uuid().optional(),
  medicationId: z.string().regex(/^[1-9][0-9]{0,17}$/),
  quantity: z.number().int().positive(),
  quantityUnit: z.enum(quantityUnits),
});

const memberInputSchema = z.object({
  id: z.string().uuid().optional(),
  nickname: z.string().min(1),
  medicines: z.array(medicineInputSchema).min(1),
});

const savePrescriptionBodySchema = z.object({
  members: z.array(memberInputSchema).min(1),
});

const idParamsSchema = z.object({ id: z.string().uuid() });

const listQuerySchema = z.object({
  includeDeleted: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

const medicationSearchQuerySchema = z.object({ q: z.string().min(2).max(120) });
const medicationSearchResponseSchema = z.object({
  items: z.array(
    z.object({
      medicationId: z.string(),
      name: z.string(),
      genericName: z.string(),
      strength: z.string(),
      form: z.enum(medicationForms),
      route: z.string(),
      releaseType: z.string(),
      rxnormRxcui: z.string().nullable(),
    }),
  ),
});

const medicineResponseSchema = z.object({
  id: z.string(),
  medicationId: z.string().nullable(),
  normalizationStatus: z.enum(['verified', 'needs_review']),
  name: z.string(),
  genericName: z.string(),
  strength: z.string().nullable(),
  form: z.enum(medicationForms).nullable(),
  quantity: z.number(),
  quantityUnit: z.enum(quantityUnits).nullable(),
  unitPrice: z.number(),
  total: z.number(),
  deleted: z.boolean(),
});

const memberResponseSchema = z.object({
  id: z.string(),
  nickname: z.string(),
  medicines: z.array(medicineResponseSchema),
});

const prescriptionResponseSchema = z.object({
  id: z.string(),
  householdId: z.string(),
  submittedAt: z.string(),
  lastUpdatedAt: z.string(),
  totalPrice: z.number(),
  deleted: z.boolean(),
  members: z.array(memberResponseSchema),
  priceComparisonStatus: z.enum(['pending', 'ready', 'unavailable']),
  priceComparisons: z.array(
    z.object({ medicineId: z.string(), source: z.string(), price: z.number() }),
  ),
});

const summaryResponseSchema = z.array(
  z.object({
    id: z.string(),
    submittedAt: z.string(),
    lastUpdatedAt: z.string(),
    totalPrice: z.number(),
  }),
);

const deleteResponseSchema = z.object({ success: z.literal(true) });

function toResponse(p: PrescriptionHousehold) {
  return {
    ...p,
    submittedAt: p.submittedAt.toISOString(),
    lastUpdatedAt: p.lastUpdatedAt.toISOString(),
  };
}

// Keyed off the Idempotency-Key header, not the body, so retries dedupe.
// Skipped under TARGET_SOURCE=mock — DynamoDB is an aws-only concern.
const idempotencyConfig = new IdempotencyConfig({ eventKeyJmesPath: 'idempotencyKey' });

function idempotencyPersistenceStore(): DynamoDBPersistenceLayer {
  return new DynamoDBPersistenceLayer({
    tableName: requireEnv('IDEMPOTENCY_TABLE_NAME'),
  });
}

function withIdempotency<TPayload extends { idempotencyKey: string }, TResult>(
  fn: (payload: TPayload) => Promise<TResult>,
): (payload: TPayload) => Promise<TResult> {
  if (isMockTarget()) return fn;
  return makeIdempotent(fn, {
    persistenceStore: idempotencyPersistenceStore(),
    config: idempotencyConfig,
  });
}

export function registerPrescriptionRoutes(app: FastifyInstance): void {
  // Scoped child context so the auth preHandler doesn't apply app-wide.
  void app.register(async (scoped) => {
    const server = scoped.withTypeProvider<ZodTypeProvider>();

    server.addHook('preHandler', requireHousehold);

    server.get(
      '/medications',
      {
        schema: {
          tags: ['Prescriptions'],
          summary: 'Search verified canonical medications',
          description:
            'Returns canonical pricing medication IDs that can be used in new prescription lines. Free text is search input only; the client must submit the selected medicationId.',
          security: bearerAuthSecurity,
          querystring: medicationSearchQuerySchema,
          response: {
            200: medicationSearchResponseSchema,
            401: errorResponseSchema,
            503: errorResponseSchema,
          },
        },
      },
      async (request) => ({
        items: await usecases.searchMedications({ query: request.query.q }),
      }),
    );

    server.post(
      '/prescriptions',
      {
        schema: {
          tags: ['Prescriptions'],
          summary: 'Add a new prescription',
          description:
            'Fetches a fresh price for every medicine before saving — a pricing ' +
            'failure returns 503 with nothing saved. Enqueues an async ' +
            "getPriceComparison job on success; `priceComparisonStatus` starts `'pending'`. " +
            'Requires an `Idempotency-Key` header so a client/API Gateway retry ' +
            "can't create a duplicate submission.",
          security: bearerAuthSecurity,
          body: savePrescriptionBodySchema,
          response: {
            201: prescriptionResponseSchema,
            400: errorResponseSchema,
            401: errorResponseSchema,
            503: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const idempotentAdd = withIdempotency(
          async (payload: {
            idempotencyKey: string;
            householdId: string;
            members: unknown;
          }) =>
            usecases.addPrescription({
              householdId: payload.householdId,
              members: payload.members as never,
            }),
        );

        const saved = await idempotentAdd({
          idempotencyKey: request.headers['idempotency-key'] as string,
          householdId: request.householdId,
          members: request.body.members,
        });
        reply.code(201);
        return toResponse(saved);
      },
    );

    server.get(
      '/prescriptions',
      {
        schema: {
          tags: ['Prescriptions'],
          summary: 'List prescription summaries for the authenticated household',
          description:
            'CQRS-lite read path — summary shape only, no member/medicine detail.',
          security: bearerAuthSecurity,
          querystring: listQuerySchema,
          response: { 200: summaryResponseSchema, 401: errorResponseSchema },
        },
      },
      async (request) => {
        const summaries = await usecases.listPrescriptions({
          householdId: request.householdId,
          includeDeleted: request.query.includeDeleted,
        });
        return summaries.map((s) => ({
          ...s,
          submittedAt: s.submittedAt.toISOString(),
          lastUpdatedAt: s.lastUpdatedAt.toISOString(),
        }));
      },
    );

    server.get(
      '/prescriptions/:id',
      {
        schema: {
          tags: ['Prescriptions'],
          summary: 'Get one prescription in full detail',
          security: bearerAuthSecurity,
          params: idParamsSchema,
          response: {
            200: prescriptionResponseSchema,
            401: errorResponseSchema,
            404: errorResponseSchema,
          },
        },
      },
      async (request) => {
        const prescription = await usecases.getPrescription({
          prescriptionId: request.params.id,
          householdId: request.householdId,
        });
        return toResponse(prescription);
      },
    );

    server.put(
      '/prescriptions/:id',
      {
        schema: {
          tags: ['Prescriptions'],
          summary: 'Replace a prescription',
          description:
            'Same pricing-refresh behavior as POST /prescriptions. `totalPrice` is ' +
            'always recomputed server-side from non-deleted medicine lines only — a ' +
            'client-submitted total is never trusted. Requires an `Idempotency-Key` ' +
            'header.',
          security: bearerAuthSecurity,
          params: idParamsSchema,
          body: savePrescriptionBodySchema,
          response: {
            200: prescriptionResponseSchema,
            400: errorResponseSchema,
            401: errorResponseSchema,
            404: errorResponseSchema,
            503: errorResponseSchema,
          },
        },
      },
      async (request) => {
        const idempotentUpdate = withIdempotency(
          async (payload: {
            idempotencyKey: string;
            prescriptionId: string;
            householdId: string;
            members: unknown;
          }) =>
            usecases.updatePrescription({
              prescriptionId: payload.prescriptionId,
              householdId: payload.householdId,
              members: payload.members as never,
            }),
        );

        const saved = await idempotentUpdate({
          idempotencyKey: request.headers['idempotency-key'] as string,
          prescriptionId: request.params.id,
          householdId: request.householdId,
          members: request.body.members,
        });
        return toResponse(saved);
      },
    );

    server.delete(
      '/prescriptions/:id',
      {
        schema: {
          tags: ['Prescriptions'],
          summary: 'Soft-delete a prescription',
          description:
            'Sets `deleted: true` — never a physical removal from the database.',
          security: bearerAuthSecurity,
          params: idParamsSchema,
          response: {
            200: deleteResponseSchema,
            401: errorResponseSchema,
            404: errorResponseSchema,
          },
        },
      },
      async (request) =>
        usecases.deletePrescription({
          prescriptionId: request.params.id,
          householdId: request.householdId,
        }),
    );
  });
}
