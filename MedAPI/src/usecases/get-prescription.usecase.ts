import type { PrescriptionRepository } from '../ports/prescription-repository.port';
import type { PrescriptionHousehold } from '../domain/types';
import { NotFoundError } from '../errors/domain-errors';

export interface GetPrescriptionInput {
  prescriptionId: string;
  householdId: string;
}

export function makeGetPrescription(prescriptionRepository: PrescriptionRepository) {
  return async function getPrescription(
    input: GetPrescriptionInput,
  ): Promise<PrescriptionHousehold> {
    const prescription = await prescriptionRepository.findById(
      input.prescriptionId,
      input.householdId,
    );
    if (!prescription) {
      throw new NotFoundError('Prescription not found');
    }
    return prescription;
  };
}
