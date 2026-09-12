import type { MedicationForm } from '../../domain/types';
import { medicationForms } from '../../domain/types';
import type {
  CanonicalMedicationSummary,
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

interface PricingMedication {
  id: string;
  name: string;
  canonical_name: string | null;
  strength: string;
  form: string;
  normalization_status: string;
}
interface PricingOffer {
  price_cents: string;
  physical_quantity: string;
  content_unit: string;
}
interface PricingApiResponse {
  medication: PricingMedication;
  requested_medication_id?: string;
  resolved_medication_id?: string;
  items: PricingOffer[];
  quote_status: string;
}

export class PricingApiAdapter implements PricingClient {
  constructor(private readonly configured?: { baseUrl: string; apiKey: string }) {}

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

  async searchMedications(query: string): Promise<CanonicalMedicationSummary[]> {
    try {
      const apiKey = this.configured?.apiKey ?? (await getPricingApiKey()),
        baseUrl = this.configured?.baseUrl ?? getPricingApiBaseUrl();
      const url = new URL('/v1/medications', baseUrl);
      url.searchParams.set('q', query);
      url.searchParams.set('limit', '30');
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(3000),
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!response.ok)
        throw Error(`Pricing API responded with status ${response.status}`);
      const body = (await response.json()) as {
        items: Array<{
          id: string;
          name: string;
          canonical_name: string | null;
          strength: string;
          form: string;
          route: string;
          release_type: string;
          rxnorm_rxcui: string | null;
          normalization_status: string;
        }>;
      };
      return body.items
        .filter(
          (item) =>
            item.normalization_status === 'verified' &&
            medicationForms.includes(item.form as MedicationForm),
        )
        .map((item) => ({
          medicationId: item.id,
          name: item.canonical_name ?? [item.name, item.strength, item.form].join(' '),
          genericName: item.name,
          strength: item.strength,
          form: item.form as MedicationForm,
          route: item.route,
          releaseType: item.release_type,
          rxnormRxcui: item.rxnorm_rxcui,
        }));
    } catch (err) {
      logger.warn('Medication catalog search failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw new PricingUnavailableError('Medication catalog is temporarily unavailable');
    }
  }

  private async fetchPrices(requests: PriceQuoteRequest[]): Promise<PriceQuote[]> {
    const apiKey = this.configured?.apiKey ?? (await getPricingApiKey()),
      baseUrl = this.configured?.baseUrl ?? getPricingApiBaseUrl();
    return Promise.all(
      requests.map((request) => this.fetchOne(baseUrl, apiKey, request)),
    );
  }

  private async fetchOne(
    baseUrl: string,
    apiKey: string,
    request: PriceQuoteRequest,
  ): Promise<PriceQuote> {
    if (!/^[1-9][0-9]{0,17}$/.test(request.medicationId))
      throw Error('INVALID_CANONICAL_MEDICATION_ID');
    const url = new URL(`/v1/medications/${request.medicationId}/offers`, baseUrl);
    url.searchParams.set('quantity', String(request.quantity));
    url.searchParams.set('unit', request.quantityUnit);
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) throw Error(`Pricing API responded with status ${response.status}`);
    const body = (await response.json()) as PricingApiResponse;
    const requestedId = body.requested_medication_id ?? request.medicationId,
      resolvedId = body.resolved_medication_id ?? body.medication?.id;
    if (
      requestedId !== request.medicationId ||
      resolvedId !== body.medication?.id ||
      !Array.isArray(body.items) ||
      body.items.length === 0
    )
      throw Error('NO_ELIGIBLE_EXACT_QUOTE');
    if (body.medication.normalization_status !== 'verified')
      throw Error('MEDICATION_IDENTITY_NOT_VERIFIED');
    const form = body.medication.form as MedicationForm;
    if (!medicationForms.includes(form)) throw Error('UNSUPPORTED_MEDICATION_FORM');
    const eligible = body.items.filter(
      (item) =>
        item.content_unit === request.quantityUnit &&
        /^\d+$/.test(item.price_cents) &&
        Number.isFinite(Number(item.physical_quantity)) &&
        Number(item.physical_quantity) === request.quantity,
    );
    if (!eligible.length) throw Error('NO_ELIGIBLE_EXACT_QUOTE');
    const best = eligible.reduce((a, b) =>
        BigInt(a.price_cents) <= BigInt(b.price_cents) ? a : b,
      ),
      cents = Number(best.price_cents);
    if (!Number.isSafeInteger(cents)) throw Error('PRICE_OUT_OF_RANGE');
    const total = cents / 100,
      unitPrice = Math.round((total / request.quantity) * 10000) / 10000;
    return {
      medicineLineId: request.medicineLineId,
      requestedMedicationId: request.medicationId,
      medicationId: body.medication.id,
      name:
        body.medication.canonical_name ??
        [body.medication.name, body.medication.strength, body.medication.form].join(' '),
      genericName: body.medication.name,
      strength: body.medication.strength,
      form,
      quantityUnit: request.quantityUnit,
      unitPrice,
      total,
    };
  }
}
