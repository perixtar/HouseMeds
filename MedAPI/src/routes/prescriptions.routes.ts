import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { usecases } from '../composition';
import { requireHousehold } from '../common/auth';
import { withIdempotency } from '../common/idempotency';
import { errorResponseSchema, bearerAuthSecurity } from '../common/http-schemas';
import type { PrescriptionHousehold } from '../domain/types';

const medicineFormSchema = z.enum([
  'tablet',
  'capsule',
  'liquid',
  'cream',
  'ointment',
  'gel',
  'solution',
  'suspension',
  'inhaler',
  'spray',
  'drops',
  'patch',
  'injection',
  'suppository',
  'powder',
  'lozenge',
]);

const strengthUnitSchema = z.enum([
  'mcg',
  'mg',
  'g',
  'mL',
  'L',
  'units',
  'IU',
  'mEq',
  '%',
]);

const dosageUnitSchema = z.enum([
  'tablet',
  'capsule',
  'mL',
  'g',
  'patch',
  'inhaler',
  'vial',
  'syringe',
  'pen',
  'ampule',
  'suppository',
  'lozenge',
  'dose',
]);

const medicineInputSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1),
  genericName: z.string().min(1),
  form: medicineFormSchema,
  strength: z.number().positive(),
  strengthUnit: strengthUnitSchema,
  dosageUnit: dosageUnitSchema,
  quantity: z.number().int().positive(),
  frequency: z.string().min(1),
  prescriberName: z.string().min(1),
  refills: z.number().int().nonnegative(),
  medId: z.string().min(1),
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

const medicineResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  genericName: z.string(),
  form: medicineFormSchema,
  strength: z.number(),
  strengthUnit: strengthUnitSchema,
  dosageUnit: dosageUnitSchema,
  quantity: z.number(),
  frequency: z.string(),
  prescriberName: z.string(),
  refills: z.number(),
  medId: z.string(),
  unitPrice: z.number(),
  total: z.number(),
  deleted: z.boolean(),
});

const memberResponseSchema = z.object({
  id: z.string(),
  nickname: z.string(),
  medicines: z.array(medicineResponseSchema),
});

// Mirrors FetchPriceQuote — what fetchPrice + comparePrices returned.
const priceQuoteResponseSchema = z.object({
  medicineId: z.string(),
  name: z.string(),
  form: medicineFormSchema,
  dosageUnit: dosageUnitSchema,
  quantity: z.number(),
  strength: z.number(),
  strengthUnit: strengthUnitSchema,
  rxNormId: z.string(),
  medId: z.string(),
  price: z.number(),
  pharmacy: z.string(),
});

const prescriptionResponseSchema = z.object({
  id: z.string(),
  householdId: z.string(),
  submittedAt: z.string(),
  lastUpdatedAt: z.string(),
  totalPrice: z.number(),
  deleted: z.boolean(),
  members: z.array(memberResponseSchema),
  priceComparisonStatus: z.enum(['ready', 'unavailable']),
  priceComparisons: z.array(priceQuoteResponseSchema),
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

export function registerPrescriptionRoutes(app: FastifyInstance): void {
  // Scoped child context so the auth preHandler doesn't apply app-wide.
  void app.register(async (scoped) => {
    const server = scoped.withTypeProvider<ZodTypeProvider>();

    server.addHook('preHandler', requireHousehold);

    server.post(
      '/prescriptions',
      {
        schema: {
          tags: ['Prescriptions'],
          summary: 'Add a new prescription',
          description:
            'Fetches a fresh price for every medicine (fetchPrice) and ranks the ' +
            'offers (comparePrices) before saving — a fetchPrice failure returns ' +
            "503 with nothing saved. `priceComparisons` mirrors fetchPrice's " +
            'response shape: one entry per pharmacy offer. Requires an ' +
            "`Idempotency-Key` header so a client/API Gateway retry can't create " +
            'a duplicate submission.',
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
            'Same fetchPrice/comparePrices refresh as POST /prescriptions. ' +
            '`totalPrice` is always recomputed server-side from non-deleted ' +
            'medicine lines only — a client-submitted total is never trusted. ' +
            'Requires an `Idempotency-Key` header.',
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
