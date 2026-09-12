import type {
  PriceComparison,
  PriceComparisonQuote,
} from '../../ports/price-comparison.port';
import type { PricingClient } from '../../ports/pricing-client.port';

// Adapts the primary PricingClient into a PriceComparison source.
export class PricingClientSourceAdapter implements PriceComparison {
  readonly name = 'primary-pricing-api';

  constructor(private readonly pricingClient: PricingClient) {}

  async getQuotes(
    medicines: {
      medicineId: string;
      medicationId: string;
      name: string;
      genericName: string;
      quantity: number;
      quantityUnit: import('../../domain/types').QuantityUnit;
    }[],
  ): Promise<PriceComparisonQuote[]> {
    const quotes = await this.pricingClient.getLatestPrices(
      medicines.map((m) => ({
        medicineLineId: m.medicineId,
        medicationId: m.medicationId,
        quantity: m.quantity,
        quantityUnit: m.quantityUnit,
      })),
    );
    return quotes.map((q) => ({
      medicineId: q.medicineLineId,
      source: this.name,
      price: q.total,
    }));
  }
}
