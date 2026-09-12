import type {
  PriceQuote,
  PriceQuoteRequest,
  PricingClient,
} from '../../ports/pricing-client.port';
import { lookupPrice, type PriceLookupFixture } from './mock-utils';
import mockData from '../../../mock-json/mock-data.json';

const fixture = mockData.calls.getLatestPrices.response as PriceLookupFixture;

// No real pricing API call. Always succeeds — nothing to time out against.
export class MockPricingClient implements PricingClient {
  async getLatestPrices(requests: PriceQuoteRequest[]): Promise<PriceQuote[]> {
    return requests.map((r) => ({
      medicineId: r.medicineId,
      unitPrice: lookupPrice(fixture, r.name),
    }));
  }
}
