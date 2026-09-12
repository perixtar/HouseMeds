import type {
  PriceQuote,
  PriceQuoteRequest,
  PricingClient,
} from '../../ports/pricing-client.port';
import { PricingUnavailableError } from '../../errors/domain-errors';
import { FreshPriceMonitor } from '../../common/fresh-price-monitor';
import { getPricingApiBaseUrl, getPricingApiKey } from '../../config/env';
import { logger } from '../../common/logger';

const breaker = new FreshPriceMonitor({
  label: 'pricing-api',
  timeoutMs: 3000,
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
});

interface PricingApiResponseItem {
  medicineId: string;
  unitPrice: number;
}

// A slow/failing call degrades to PricingUnavailableError, never a guessed price.
export class PricingApiAdapter implements PricingClient {
  async getLatestPrices(requests: PriceQuoteRequest[]): Promise<PriceQuote[]> {
    if (requests.length === 0) return [];

    try {
      return await breaker.execute(() => this.fetchPrices(requests));
    } catch (err) {
      logger.warn('Pricing API call failed — rendering as unavailable', {
        error: err instanceof Error ? err.message : String(err),
        medicineCount: requests.length,
      });
      throw new PricingUnavailableError('Pricing is temporarily unavailable');
    }
  }

  private async fetchPrices(requests: PriceQuoteRequest[]): Promise<PriceQuote[]> {
    const apiKey = await getPricingApiKey();
    const baseUrl = getPricingApiBaseUrl();

    const response = await fetch(`${baseUrl}/v1/prices/lookup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        items: requests.map((r) => ({
          medicineId: r.medicineId,
          name: r.name,
          genericName: r.genericName,
          quantity: r.quantity,
        })),
      }),
    });

    if (!response.ok) {
      throw new Error(`Pricing API responded with status ${response.status}`);
    }

    const body = (await response.json()) as { prices: PricingApiResponseItem[] };
    return body.prices.map((item) => ({
      medicineId: item.medicineId,
      unitPrice: item.unitPrice,
    }));
  }
}
