import type {
  PriceComparisonRecommendation,
  PrescriptionHousehold,
  PrescriptionSummary,
} from '../domain/types';

// Use-cases depend on this, never on the Mongo driver directly.
export interface PrescriptionRepository {
  create(prescription: Omit<PrescriptionHousehold, 'id'>): Promise<PrescriptionHousehold>;

  /** Scoped to householdId — never trust a client-supplied id for scoping. */
  findById(id: string, householdId: string): Promise<PrescriptionHousehold | null>;

  /** Summary view, non-deleted by default. */
  listByHousehold(
    householdId: string,
    options: { includeDeleted: boolean },
  ): Promise<PrescriptionSummary[]>;

  replace(prescription: PrescriptionHousehold): Promise<PrescriptionHousehold>;

  softDelete(id: string, householdId: string): Promise<boolean>;

  /** Called by the getPriceComparison worker once recommendations are ready. */
  savePriceComparisons(
    id: string,
    offers: PriceComparisonRecommendation[],
  ): Promise<void>;

  markPriceComparisonUnavailable(id: string): Promise<void>;
}
