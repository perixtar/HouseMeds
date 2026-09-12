import type { PrescriptionRepository } from '../ports/prescription-repository.port';
import type { PrescriptionSummary } from '../domain/types';

export interface ListPrescriptionsInput {
  householdId: string;
  includeDeleted: boolean;
}

export function makeListPrescriptions(prescriptionRepository: PrescriptionRepository) {
  return async function listPrescriptions(
    input: ListPrescriptionsInput,
  ): Promise<PrescriptionSummary[]> {
    return prescriptionRepository.listByHousehold(input.householdId, {
      includeDeleted: input.includeDeleted,
    });
  };
}
