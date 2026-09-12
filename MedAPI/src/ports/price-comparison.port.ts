export interface PriceComparisonQuote {
  medicineId: string;
  source: string;
  price: number;
}

// A single vendor price source consulted by the getPriceComparison worker.
export interface PriceComparison {
  readonly name: string;
  getQuotes(
    medicines: { medicineId: string; name: string; genericName: string }[],
  ): Promise<PriceComparisonQuote[]>;
}
