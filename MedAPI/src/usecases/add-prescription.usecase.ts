import { randomUUID } from 'node:crypto';
import type { PrescriptionRepository } from '../ports/prescription-repository.port';
import type { FetchPriceClient } from '../ports/fetch-price.port';
import type {
  DosageUnit,
  FetchPriceQuote,
  Medicine,
  MedicineForm,
  Member,
  PrescriptionHousehold,
  PriceComparisonStatus,
  StrengthUnit,
} from '../domain/types';
import { computePrescriptionTotal } from '../domain/prescription';
import { comparePrices } from './compare-prices';
import { logger } from '../common/logger';

export interface AddPrescriptionMedicineInput {
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
  fetchPriceClient: FetchPriceClient,
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
        form: med.form,
        strength: med.strength,
        strengthUnit: med.strengthUnit,
        dosageUnit: med.dosageUnit,
        quantity: med.quantity,
        frequency: med.frequency,
        prescriberName: med.prescriberName,
        refills: med.refills,
        medId: med.medId,
        unitPrice: 0,
        total: 0,
        deleted: false,
      })),
    }));

    // Throws PricingUnavailableError on failure — nothing is saved with a guessed price.
    const { priceComparisons, priceComparisonStatus } = await priceMembers(
      members,
      fetchPriceClient,
    );

    const now = new Date();
    const prescription: Omit<PrescriptionHousehold, 'id'> = {
      householdId: input.householdId,
      submittedAt: now,
      lastUpdatedAt: now,
      totalPrice: computePrescriptionTotal(members),
      deleted: false,
      members,
      priceComparisonStatus,
      priceComparisons,
    };

    return prescriptionRepository.create(prescription);
  };
}

export interface PriceResult {
  priceComparisons: FetchPriceQuote[];
  priceComparisonStatus: PriceComparisonStatus;
}

/**
 * Fetches fresh pharmacy offers for every non-deleted medicine (fetchPrice),
 * ranks them (comparePrices), sets each medicine's unitPrice/total from the
 * cheapest offer, and returns the full offer list for the response. A
 * fetchPrice failure propagates (rule 4 — never a guessed price, nothing
 * saved); a comparePrices failure instead degrades to 'unavailable' with the
 * medicine prices from fetchPrice still applied.
 */
export async function priceMembers(
  members: Member[],
  fetchPriceClient: FetchPriceClient,
): Promise<PriceResult> {
  const activeMedicines: Medicine[] = members
    .flatMap((m) => m.medicines)
    .filter((med) => !med.deleted);

  if (activeMedicines.length === 0) {
    return { priceComparisons: [], priceComparisonStatus: 'ready' as const };
  }

  const quotes = await fetchPriceClient.fetchPrice(
    activeMedicines.map((med) => ({
      medicineId: med.id,
      name: med.name,
      form: med.form,
      dosageUnit: med.dosageUnit,
      quantity: med.quantity,
      strength: med.strength,
      strengthUnit: med.strengthUnit,
    })),
  );

  return buildPriceResult(activeMedicines, quotes);
}

function buildPriceResult(
  activeMedicines: Medicine[],
  quotes: FetchPriceQuote[],
): PriceResult {
  try {
    const ranked = comparePrices(quotes);

    const cheapestByMedicineId = new Map<string, number>();
    for (const quote of ranked) {
      if (!cheapestByMedicineId.has(quote.medicineId)) {
        cheapestByMedicineId.set(quote.medicineId, quote.price);
      }
    }
    for (const med of activeMedicines) {
      const unitPrice = cheapestByMedicineId.get(med.id);
      if (unitPrice === undefined) continue;
      med.unitPrice = unitPrice;
      med.total = Math.round(med.quantity * unitPrice * 100) / 100;
    }

    return { priceComparisons: ranked, priceComparisonStatus: 'ready' as const };
  } catch (err) {
    logger.warn('comparePrices failed — priceComparisons unavailable', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { priceComparisons: [], priceComparisonStatus: 'unavailable' as const };
  }
}
