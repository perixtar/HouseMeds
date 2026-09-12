import { randomUUID } from 'node:crypto';
import type { PrescriptionRepository } from '../ports/prescription-repository.port';
import type { FetchPriceClient } from '../ports/fetch-price.port';
import type {
  DosageUnit,
  MedicineForm,
  Member,
  PrescriptionHousehold,
  StrengthUnit,
} from '../domain/types';
import {
  computePrescriptionTotal,
  reconcileMembersOnUpdate,
} from '../domain/prescription';
import { NotFoundError } from '../errors/domain-errors';
import { priceMembers } from './add-prescription.usecase';

export interface UpdatePrescriptionMedicineInput {
  /** Omit to add a new medicine line; include an existing id to update it. */
  id?: string;
  name: string;
  genericName: string;
  form: MedicineForm;
  strength: number;
  strengthUnit: StrengthUnit;
  dosageUnit: DosageUnit;
  quantity: number;
  frequency: string;
  prescriberName: string;
  refills: number;
  medId: string;
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
  fetchPriceClient: FetchPriceClient,
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
        form: med.form,
        strength: med.strength,
        strengthUnit: med.strengthUnit,
        dosageUnit: med.dosageUnit,
        quantity: med.quantity,
        frequency: med.frequency,
        prescriberName: med.prescriberName,
        refills: med.refills,
        medId: med.medId,
        // Placeholder until priceMembers runs below.
        unitPrice: 0,
        total: 0,
        deleted: false,
      })),
    }));

    // Soft-deletes any member/medicine dropped from the submission.
    const mergedMembers = reconcileMembersOnUpdate(existing.members, incomingMembers);

    const { priceComparisons, priceComparisonStatus } = await priceMembers(
      mergedMembers,
      fetchPriceClient,
    );

    const updated: PrescriptionHousehold = {
      ...existing,
      members: mergedMembers,
      totalPrice: computePrescriptionTotal(mergedMembers),
      lastUpdatedAt: new Date(),
      priceComparisonStatus,
      priceComparisons,
    };

    return prescriptionRepository.replace(updated);
  };
}
