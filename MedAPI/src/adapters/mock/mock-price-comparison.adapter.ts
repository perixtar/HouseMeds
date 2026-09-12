import type {
  PriceComparison,
  PriceComparisonQuote,
} from '../../ports/price-comparison.port';
import { lookupPrice, type PriceLookupFixture } from './mock-utils';
import mockData from '../../../mock-json/mock-data.json';

const fixture = mockData.calls.getPriceComparisonQuotes.response as PriceLookupFixture & {
  source: string;
};

// No real network call — a separate vendor source from MockPricingClient.
export class MockPriceComparisonAdapter implements PriceComparison {
  readonly name = fixture.source;

  async getQuotes(
    medicines: { medicineId: string; name: string; genericName: string }[],
  ): Promise<PriceComparisonQuote[]> {
    return medicines.map((m) => ({
      medicineId: m.medicineId,
      source: this.name,
      price: lookupPrice(fixture, m.name),
    }));
  }
}
