import type { FetchPriceRequestItem, FetchPriceQuote } from '../domain/types';

// Looks up pharmacy offers for a batch of medicine lines. Real implementation is
// hardcoded for now (see adapters/fetch-price/) — a future vendor integration
// slots in behind this same interface.
export interface FetchPriceClient {
  /** Throws PricingUnavailableError on failure — never a guessed price. */
  fetchPrice(items: FetchPriceRequestItem[]): Promise<FetchPriceQuote[]>;
}
