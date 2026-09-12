import type { PrescriptionRepository } from '../ports/prescription-repository.port';
import type { PriceComparison } from '../ports/price-comparison.port';
import type { PriceComparisonRecommendation } from '../domain/types';
import { listActiveMedicines } from '../domain/prescription';
import { logger } from '../common/logger';

export interface GetPriceComparisonInput {
  prescriptionId: string;
  householdId: string;
}

// Fans out to every registered PriceComparison, keeps the lowest price per medicine.
export function makeGetPriceComparison(
  prescriptionRepository: PrescriptionRepository,
  sources: PriceComparison[],
) {
  return async function getPriceComparison(
    input: GetPriceComparisonInput,
  ): Promise<void> {
    const prescription = await prescriptionRepository.findById(
      input.prescriptionId,
      input.householdId,
    );
    if (!prescription || prescription.deleted) {
      logger.warn('getPriceComparison skipped — prescription not found or deleted', {
        prescriptionId: input.prescriptionId,
      });
      return;
    }

    const activeMedicines = listActiveMedicines(prescription.members).map((med) => ({
      medicineId: med.id,
      medicationId: med.medicationId,
      name: med.name,
      genericName: med.genericName,
      quantity: med.quantity,
      quantityUnit: med.quantityUnit,
    }));

    if (activeMedicines.length === 0) {
      await prescriptionRepository.savePriceComparisons(prescription.id, []);
      return;
    }

    const results = await Promise.allSettled(
      sources.map((source) => source.getQuotes(activeMedicines)),
    );

    const bestByMedicineId = new Map<string, PriceComparisonRecommendation>();
    let anySourceSucceeded = false;

    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      anySourceSucceeded = true;
      for (const quote of result.value) {
        const current = bestByMedicineId.get(quote.medicineId);
        if (!current || quote.price < current.price) {
          bestByMedicineId.set(quote.medicineId, {
            medicineId: quote.medicineId,
            source: quote.source,
            price: quote.price,
          });
        }
      }
    }

    if (!anySourceSucceeded) {
      // Every source failed — never a stale or guessed recommendation.
      await prescriptionRepository.markPriceComparisonUnavailable(prescription.id);
      return;
    }

    await prescriptionRepository.savePriceComparisons(
      prescription.id,
      Array.from(bestByMedicineId.values()),
    );
  };
}
