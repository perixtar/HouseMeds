import { describe, expect, it, vi } from 'vitest';
import { makeAddPrescription } from '../../src/usecases/add-prescription.usecase';
import { PricingUnavailableError } from '../../src/errors/domain-errors';
import type { PrescriptionRepository } from '../../src/ports/prescription-repository.port';
import type { PricingClient } from '../../src/ports/pricing-client.port';
import type { JobQueue } from '../../src/ports/job-queue.port';
import type { PrescriptionHousehold } from '../../src/domain/types';
import type { PriceQuoteRequest } from '../../src/ports/pricing-client.port';

function fakeRepository(): PrescriptionRepository {
  return {
    create: vi.fn(async (p) => ({ id: 'p1', ...p }) as PrescriptionHousehold),
    findById: vi.fn(),
    listByHousehold: vi.fn(),
    replace: vi.fn(),
    softDelete: vi.fn(),
    savePriceComparisons: vi.fn(),
    markPriceComparisonUnavailable: vi.fn(),
  };
}

function fakeJobQueue(): JobQueue {
  return { enqueuePriceComparisonJob: vi.fn() };
}

describe('addPrescription', () => {
  it('computes the total server-side from the pricing API response — hard rules 2 & 3', async () => {
    const repository = fakeRepository();
    const jobQueue = fakeJobQueue();
    const pricingClient: PricingClient = {
      searchMedications: vi.fn(async () => []),
      getLatestPrices: vi.fn(async (requests: PriceQuoteRequest[]) =>
        requests.map((r) => ({
          medicineLineId: r.medicineLineId,
          medicationId: r.medicationId,
          name: 'Amoxicillin 500 mg Capsule',
          genericName: 'amoxicillin',
          strength: '500 mg',
          form: 'capsule' as const,
          quantityUnit: r.quantityUnit,
          unitPrice: 5,
          total: r.quantity * 5,
        })),
      ),
    };

    const addPrescription = makeAddPrescription(repository, pricingClient, jobQueue);

    const result = await addPrescription({
      householdId: 'h1',
      members: [
        {
          nickname: 'Rex',
          medicines: [{ medicationId: '1', quantity: 3, quantityUnit: 'capsule' }],
        },
      ],
    });

    expect(result.totalPrice).toBe(15); // 3 * 5, from the pricing API — not guessed
    expect(result.members[0]?.medicines[0]?.unitPrice).toBe(5);
    expect(result.members[0]?.medicines[0]).toEqual(
      expect.objectContaining({
        medicationId: '1',
        name: 'Amoxicillin 500 mg Capsule',
        strength: '500 mg',
        form: 'capsule',
        quantityUnit: 'capsule',
      }),
    );
    expect(repository.create).toHaveBeenCalledOnce();
    expect(jobQueue.enqueuePriceComparisonJob).toHaveBeenCalledWith(
      expect.objectContaining({ prescriptionId: 'p1', householdId: 'h1' }),
    );
  });

  it('propagates PricingUnavailableError and saves nothing — hard rule 4', async () => {
    const repository = fakeRepository();
    const jobQueue = fakeJobQueue();
    const pricingClient: PricingClient = {
      searchMedications: vi.fn(async () => []),
      getLatestPrices: vi.fn(async () => {
        throw new PricingUnavailableError('down');
      }),
    };

    const addPrescription = makeAddPrescription(repository, pricingClient, jobQueue);

    await expect(
      addPrescription({
        householdId: 'h1',
        members: [
          {
            nickname: 'Rex',
            medicines: [{ medicationId: '999', quantity: 1, quantityUnit: 'tablet' }],
          },
        ],
      }),
    ).rejects.toBeInstanceOf(PricingUnavailableError);

    expect(repository.create).not.toHaveBeenCalled();
    expect(jobQueue.enqueuePriceComparisonJob).not.toHaveBeenCalled();
  });
});
