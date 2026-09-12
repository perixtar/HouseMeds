import { randomUUID } from 'node:crypto';
import type { PrescriptionRepository } from '../ports/prescription-repository.port';
import type { PricingClient } from '../ports/pricing-client.port';
import type { JobQueue } from '../ports/job-queue.port';
import type { Member, PrescriptionHousehold } from '../domain/types';
import {
  computePrescriptionTotal,
  reconcileMembersOnUpdate,
} from '../domain/prescription';
import { NotFoundError } from '../errors/domain-errors';
import { refreshPrices } from './add-prescription.usecase';

export interface UpdatePrescriptionMedicineInput {
  /** Omit to add a new medicine line; include an existing id to update it. */
  id?: string;
  name: string;
  genericName: string;
  quantity: number;
}

export interface UpdatePrescriptionMemberInput {
  /** Omit to add a new member; include an existing id to update them. */
  id?: string;
  nickname: string;
  medicines: UpdatePrescriptionMedicineInput[];
}

export interface UpdatePrescriptionInput {
  prescriptionId: string;
  householdId: string;
  members: UpdatePrescriptionMemberInput[];
}

export function makeUpdatePrescription(
  prescriptionRepository: PrescriptionRepository,
  pricingClient: PricingClient,
  jobQueue: JobQueue,
) {
  return async function updatePrescription(
    input: UpdatePrescriptionInput,
  ): Promise<PrescriptionHousehold> {
    const existing = await prescriptionRepository.findById(
      input.prescriptionId,
      input.householdId,
    );
    if (!existing || existing.deleted) {
      throw new NotFoundError('Prescription not found');
    }

    const incomingMembers: Member[] = input.members.map((member) => ({
      id: member.id ?? randomUUID(),
      nickname: member.nickname,
      medicines: member.medicines.map((med) => ({
        id: med.id ?? randomUUID(),
        name: med.name,
        genericName: med.genericName,
        quantity: med.quantity,
        // Placeholder until refreshPrices runs below.
        unitPrice: 0,
        total: 0,
        deleted: false,
      })),
    }));

    // Soft-deletes any member/medicine dropped from the submission.
    const mergedMembers = reconcileMembersOnUpdate(existing.members, incomingMembers);

    await refreshPrices(mergedMembers, pricingClient);

    const updated: PrescriptionHousehold = {
      ...existing,
      members: mergedMembers,
      totalPrice: computePrescriptionTotal(mergedMembers),
      lastUpdatedAt: new Date(),
      priceComparisonStatus: 'pending',
      priceComparisons: [],
    };

    const saved = await prescriptionRepository.replace(updated);

    await jobQueue.enqueuePriceComparisonJob({
      prescriptionId: saved.id,
      householdId: saved.householdId,
    });

    return saved;
  };
}
