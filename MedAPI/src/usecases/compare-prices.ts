import type { FetchPriceQuote } from '../domain/types';

// Placeholder comparison — real ranking logic (insurance, distance, generic
// substitution, etc.) lands here later. For now: cheapest offer first, grouped
// by medicine so a caller can still see every pharmacy's quote.
export function comparePrices(quotes: FetchPriceQuote[]): FetchPriceQuote[] {
  return [...quotes].sort((a, b) => {
    if (a.medicineId !== b.medicineId) return a.medicineId.localeCompare(b.medicineId);
    return a.price - b.price;
  });
}
