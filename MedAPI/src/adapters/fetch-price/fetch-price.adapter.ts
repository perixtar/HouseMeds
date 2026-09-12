import { randomUUID } from 'node:crypto';
import type { FetchPriceClient } from '../../ports/fetch-price.port';
import type { FetchPriceQuote, FetchPriceRequestItem } from '../../domain/types';

// TODO: replace with a real vendor/pricing-API integration. Hardcoded for now,
// per product decision — a deterministic base price per known drug name, quoted
// across a few fixed pharmacies at a fixed markup/discount each.
const BASE_PRICE_BY_NAME: Record<string, number> = {
  amoxicillin: 12.5,
  lisinopril: 8.75,
  metformin: 5.2,
  atorvastatin: 15.0,
  omeprazole: 6.4,
};
const DEFAULT_BASE_PRICE = 9.99;

const PHARMACIES: { name: string; multiplier: number }[] = [
  { name: 'CVS Pharmacy', multiplier: 1.0 },
  { name: 'Walgreens', multiplier: 1.1 },
  { name: 'Costco Pharmacy', multiplier: 0.85 },
];

function basePriceFor(name: string): number {
  return BASE_PRICE_BY_NAME[name.toLowerCase()] ?? DEFAULT_BASE_PRICE;
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export class FetchPriceAdapter implements FetchPriceClient {
  async fetchPrice(items: FetchPriceRequestItem[]): Promise<FetchPriceQuote[]> {
    return items.flatMap((item) => {
      const basePrice = basePriceFor(item.name);
      return PHARMACIES.map((pharmacy): FetchPriceQuote => ({
        ...item,
        rxNormId: `RX-${slug(item.name)}`,
        medId: `MED-${slug(item.name)}-${randomUUID().slice(0, 8)}`,
        price: Math.round(basePrice * pharmacy.multiplier * 100) / 100,
        pharmacy: pharmacy.name,
      }));
    });
  }
}
