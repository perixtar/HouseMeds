export interface PriceQuoteRequest {
  medicineId: string;
  name: string;
  genericName: string;
  quantity: number;
}

export interface PriceQuote {
  medicineId: string;
  /** Verbatim from the pricing response — never adjusted. */
  unitPrice: number;
}

// Primary pricing source used on add/update. Distinct from PriceComparison.
export interface PricingClient {
  /** Throws PricingUnavailableError on timeout/failure — never a guessed price. */
  getLatestPrices(requests: PriceQuoteRequest[]): Promise<PriceQuote[]>;
}
