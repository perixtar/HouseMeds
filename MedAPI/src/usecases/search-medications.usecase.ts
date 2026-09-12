import type { PricingClient } from '../ports/pricing-client.port';

export function makeSearchMedications(pricingClient: PricingClient) {
  return async function searchMedications(input: { query: string }) {
    return pricingClient.searchMedications(input.query.trim());
  };
}
