import type { PrescriptionRepository } from '../ports/prescription-repository.port';
import { NotFoundError } from '../errors/domain-errors';

export interface DeletePrescriptionInput {
  prescriptionId: string;
  householdId: string;
}

export function makeDeletePrescription(prescriptionRepository: PrescriptionRepository) {
  return async function deletePrescription(
    input: DeletePrescriptionInput,
  ): Promise<{ success: true }> {
    // Sets deleted: true — never a physical delete.
    const found = await prescriptionRepository.softDelete(
      input.prescriptionId,
      input.householdId,
    );
    if (!found) {
      throw new NotFoundError('Prescription not found');
    }
    return { success: true };
  };
}
