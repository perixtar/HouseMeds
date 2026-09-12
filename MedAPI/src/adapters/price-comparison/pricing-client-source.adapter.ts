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
    medicines: { medicineId: string; name: string; genericName: string }[],
  ): Promise<PriceComparisonQuote[]> {
    const quotes = await this.pricingClient.getLatestPrices(
      medicines.map((m) => ({ ...m, quantity: 1 })),
    );
    return quotes.map((q) => ({
      medicineId: q.medicineId,
      source: this.name,
      price: q.unitPrice,
    }));
  }
}
