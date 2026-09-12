import type { FetchPriceClient } from '../../ports/fetch-price.port';
import type { FetchPriceQuote, FetchPriceRequestItem } from '../../domain/types';
import { lookupPrice, type PriceLookupFixture } from './mock-utils';
import mockData from '../../../mock-json/mock-data.json';

interface FetchPriceFixture extends PriceLookupFixture {
  pharmacies: { name: string; multiplier: number }[];
}

const fixture = mockData.calls.fetchPrice.response as FetchPriceFixture;

// No real network call — one deterministic quote per fixture pharmacy.
export class MockFetchPriceAdapter implements FetchPriceClient {
  async fetchPrice(items: FetchPriceRequestItem[]): Promise<FetchPriceQuote[]> {
    return items.flatMap((item) => {
      const basePrice = lookupPrice(fixture, item.name);
      return fixture.pharmacies.map((pharmacy): FetchPriceQuote => ({
        ...item,
        rxNormId: `mock-rxnorm-${item.name.toLowerCase()}`,
        medId: `mock-med-${item.name.toLowerCase()}`,
        price: Math.round(basePrice * pharmacy.multiplier * 100) / 100,
        pharmacy: pharmacy.name,
      }));
    });
  }
}
