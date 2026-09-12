import type { MedicationForm, QuantityUnit } from '../domain/types';

export interface PriceQuoteRequest {
  /** Household-local line correlation id. */
  medicineLineId: string;
  /** Canonical pricing.medications.id. */
  medicationId: string;
  quantity: number;
  quantityUnit: QuantityUnit;
}

export interface PriceQuote {
  medicineLineId: string;
  /** ID sent by the household record; retained to authenticate a redirect. */
  requestedMedicationId: string;
  /** Active canonical ID, which may replace a superseded requested ID. */
  medicationId: string;
  name: string;
  genericName: string;
  strength: string;
  form: MedicationForm;
  quantityUnit: QuantityUnit;
  /** Derived from the exact source total for display only. */
  unitPrice: number;
  /** Exact source total for the requested physical quantity. */
  total: number;
}

export interface CanonicalMedicationSummary {
  medicationId: string;
  name: string;
  genericName: string;
  strength: string;
  form: MedicationForm;
  route: string;
  releaseType: string;
  rxnormRxcui: string | null;
}

// Primary pricing source used on add/update. Distinct from PriceComparison.
export interface PricingClient {
  /** Returns only canonical identities eligible for new household records. */
  searchMedications(query: string): Promise<CanonicalMedicationSummary[]>;
  /** Throws PricingUnavailableError on timeout, failure, or a missing exact quote. */
  getLatestPrices(requests: PriceQuoteRequest[]): Promise<PriceQuote[]>;
}
