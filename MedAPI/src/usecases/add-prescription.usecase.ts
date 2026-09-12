import { randomUUID } from 'node:crypto';
import type { PrescriptionRepository } from '../ports/prescription-repository.port';
import type { PricingClient } from '../ports/pricing-client.port';
import type { JobQueue } from '../ports/job-queue.port';
import type { Medicine, Member, PrescriptionHousehold } from '../domain/types';
import { computeMedicineTotal, computePrescriptionTotal } from '../domain/prescription';

export interface AddPrescriptionMedicineInput {
  name: string;
  genericName: string;
  quantity: number;
}

export interface AddPrescriptionMemberInput {
  nickname: string;
  medicines: AddPrescriptionMedicineInput[];
}

export interface AddPrescriptionInput {
  householdId: string;
  members: AddPrescriptionMemberInput[];
}

export function makeAddPrescription(
  prescriptionRepository: PrescriptionRepository,
  pricingClient: PricingClient,
  jobQueue: JobQueue,
) {
  return async function addPrescription(
    input: AddPrescriptionInput,
  ): Promise<PrescriptionHousehold> {
    const members: Member[] = input.members.map((member) => ({
      id: randomUUID(),
      nickname: member.nickname,
      medicines: member.medicines.map((med) => ({
        id: randomUUID(),
        name: med.name,
        genericName: med.genericName,
        quantity: med.quantity,
        unitPrice: 0,
        total: 0,
        deleted: false,
      })),
    }));

    // Throws PricingUnavailableError on failure — nothing is saved with a guessed price.
    await refreshPrices(members, pricingClient);

    const now = new Date();
    const prescription: Omit<PrescriptionHousehold, 'id'> = {
      householdId: input.householdId,
      submittedAt: now,
      lastUpdatedAt: now,
      totalPrice: computePrescriptionTotal(members),
      deleted: false,
      members,
      priceComparisonStatus: 'pending',
      priceComparisons: [],
    };

    const saved = await prescriptionRepository.create(prescription);

    await jobQueue.enqueuePriceComparisonJob({
      prescriptionId: saved.id,
      householdId: saved.householdId,
    });

    return saved;
  };
}

/** Fetches a fresh price for every non-deleted medicine, in place. */
export async function refreshPrices(
  members: Member[],
  pricingClient: PricingClient,
): Promise<void> {
  const activeMedicines: Medicine[] = members
    .flatMap((m) => m.medicines)
    .filter((med) => !med.deleted);

  if (activeMedicines.length === 0) return;

  const quotes = await pricingClient.getLatestPrices(
    activeMedicines.map((med) => ({
      medicineId: med.id,
      name: med.name,
      genericName: med.genericName,
      quantity: med.quantity,
    })),
  );
  const quoteByMedicineId = new Map(quotes.map((q) => [q.medicineId, q.unitPrice]));

  for (const med of activeMedicines) {
    const unitPrice = quoteByMedicineId.get(med.id);
    if (unitPrice === undefined) continue;
    med.unitPrice = unitPrice;
    med.total = computeMedicineTotal(med.quantity, unitPrice);
  }
}
