import { randomUUID } from 'node:crypto';
import type { PrescriptionRepository } from '../ports/prescription-repository.port';
import type { PricingClient } from '../ports/pricing-client.port';
import type { JobQueue } from '../ports/job-queue.port';
import type {
  Medicine,
  Member,
  PrescriptionHousehold,
  QuantityUnit,
} from '../domain/types';
import { computePrescriptionTotal } from '../domain/prescription';
import { PricingUnavailableError } from '../errors/domain-errors';

export interface AddPrescriptionMedicineInput {
  medicationId: string;
  quantity: number;
  quantityUnit: QuantityUnit;
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
        medicationId: med.medicationId,
        name: '',
        genericName: '',
        strength: '',
        form: 'tablet',
        quantity: med.quantity,
        quantityUnit: med.quantityUnit,
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
      medicineLineId: med.id,
      medicationId: med.medicationId,
      quantity: med.quantity,
      quantityUnit: med.quantityUnit,
    })),
  );
  const quoteByLineId = new Map(quotes.map((quote) => [quote.medicineLineId, quote]));

  for (const med of activeMedicines) {
    const quote = quoteByLineId.get(med.id);
    if (
      !quote ||
      quote.medicationId !== med.medicationId ||
      quote.quantityUnit !== med.quantityUnit
    ) {
      throw new PricingUnavailableError(
        'No exact canonical medication quote is available',
      );
    }
    med.name = quote.name;
    med.genericName = quote.genericName;
    med.strength = quote.strength;
    med.form = quote.form;
    med.unitPrice = quote.unitPrice;
    med.total = quote.total;
  }
}
