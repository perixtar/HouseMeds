import { describe, expect, it, vi } from 'vitest';
import { makeAddPrescription } from '../../src/usecases/add-prescription.usecase';
import { PricingUnavailableError } from '../../src/errors/domain-errors';
import type { PrescriptionRepository } from '../../src/ports/prescription-repository.port';
import type { FetchPriceClient } from '../../src/ports/fetch-price.port';
import type {
  FetchPriceQuote,
  FetchPriceRequestItem,
  PrescriptionHousehold,
} from '../../src/domain/types';

function fakeRepository(): PrescriptionRepository {
  return {
    create: vi.fn(async (p) => ({ id: 'p1', ...p }) as PrescriptionHousehold),
    findById: vi.fn(),
    listByHousehold: vi.fn(),
    replace: vi.fn(),
    softDelete: vi.fn(),
  };
}

const medicineInput = {
  name: 'Amoxicillin',
  genericName: 'amoxicillin',
  form: 'capsule' as const,
  strength: 500,
  strengthUnit: 'mg' as const,
  dosageUnit: 'capsule' as const,
  quantity: 3,
  frequency: 'twice daily',
  prescriberName: 'Dr. Smith',
  refills: 2,
  medId: 'med-1',
};

describe('addPrescription', () => {
  it("computes the total server-side from fetchPrice's response — hard rules 2 & 3", async () => {
    const repository = fakeRepository();
    const fetchPriceClient: FetchPriceClient = {
      fetchPrice: vi.fn(async (items: FetchPriceRequestItem[]) =>
        items.map((item): FetchPriceQuote => ({
          ...item,
          rxNormId: 'rx-1',
          medId: 'med-1',
          price: 5,
          pharmacy: 'CVS Pharmacy',
        })),
      ),
    };

    const addPrescription = makeAddPrescription(repository, fetchPriceClient);

    const result = await addPrescription({
      householdId: 'h1',
      members: [{ nickname: 'Rex', medicines: [medicineInput] }],
    });

    expect(result.totalPrice).toBe(15); // 3 * 5, from fetchPrice — not guessed
    expect(result.members[0]?.medicines[0]?.unitPrice).toBe(5);
    expect(result.priceComparisonStatus).toBe('ready');
    expect(result.priceComparisons).toHaveLength(1);
    expect(repository.create).toHaveBeenCalledOnce();
  });

  it('propagates PricingUnavailableError and saves nothing — hard rule 4', async () => {
    const repository = fakeRepository();
    const fetchPriceClient: FetchPriceClient = {
      fetchPrice: vi.fn(async () => {
        throw new PricingUnavailableError('down');
      }),
    };

    const addPrescription = makeAddPrescription(repository, fetchPriceClient);

    await expect(
      addPrescription({
        householdId: 'h1',
        members: [{ nickname: 'Rex', medicines: [medicineInput] }],
      }),
    ).rejects.toBeInstanceOf(PricingUnavailableError);

    expect(repository.create).not.toHaveBeenCalled();
  });
});
