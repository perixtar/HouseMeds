import { describe, expect, it, vi } from 'vitest';
import { makeDeletePrescription } from '../../src/usecases/delete-prescription.usecase';
import { NotFoundError } from '../../src/errors/domain-errors';
import type { PrescriptionRepository } from '../../src/ports/prescription-repository.port';

function fakeRepository(softDeleteResult: boolean): PrescriptionRepository {
  return {
    create: vi.fn(),
    findById: vi.fn(),
    listByHousehold: vi.fn(),
    replace: vi.fn(),
    softDelete: vi.fn(async () => softDeleteResult),
  };
}

describe('deletePrescription', () => {
  it('calls the repository soft-delete — never a physical removal (hard rule 1)', async () => {
    const repository = fakeRepository(true);
    const deletePrescription = makeDeletePrescription(repository);

    const result = await deletePrescription({ prescriptionId: 'p1', householdId: 'h1' });

    expect(result).toEqual({ success: true });
    expect(repository.softDelete).toHaveBeenCalledWith('p1', 'h1');
  });

  it('throws NotFoundError when scoped to the wrong household or missing id', async () => {
    const repository = fakeRepository(false);
    const deletePrescription = makeDeletePrescription(repository);

    await expect(
      deletePrescription({ prescriptionId: 'missing', householdId: 'h1' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
