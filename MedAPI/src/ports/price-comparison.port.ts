export interface PriceComparisonQuote {
  medicineId: string;
  source: string;
  price: number;
}

// A single vendor price source consulted by the getPriceComparison worker.
export interface PriceComparison {
  readonly name: string;
  getQuotes(
    medicines: {
      medicineId: string;
      medicationId: string;
      name: string;
      genericName: string;
      quantity: number;
      quantityUnit: import('../domain/types').QuantityUnit;
    }[],
  ): Promise<PriceComparisonQuote[]>;
}
