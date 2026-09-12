import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { PricingApiAdapter } from '../../src/adapters/pricing/pricing-api.adapter';
import { PricingUnavailableError } from '../../src/errors/domain-errors';

let server: Server | undefined;
afterEach(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  server = undefined;
});

async function serve(
  handler: (url: URL, authorization: string | undefined) => unknown,
): Promise<string> {
  server = createServer((request, response) => {
    const value = handler(
      new URL(request.url ?? '/', `http://${request.headers.host}`),
      request.headers.authorization,
    );
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  });
  await new Promise<void>((resolve, reject) =>
    server!.listen(0, '127.0.0.1', () => resolve()).once('error', reject),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('TEST_SERVER_ADDRESS');
  return `http://127.0.0.1:${address.port}`;
}

describe('PricingApiAdapter canonical contract', () => {
  it('returns only verified canonical medication search results', async () => {
    const origin = await serve((url, authorization) => {
      expect(authorization).toBe('Bearer test-pricing-token');
      expect(url.pathname).toBe('/v1/medications');
      expect(url.searchParams.get('q')).toBe('lisinopril');
      return {
        items: [
          {
            id: '314077',
            name: 'lisinopril',
            canonical_name: 'lisinopril 20 MG Oral Tablet',
            strength: '20 mg',
            form: 'tablet',
            route: 'oral',
            release_type: 'immediate',
            rxnorm_rxcui: '314077',
            normalization_status: 'verified',
          },
          {
            id: '2',
            name: 'lisinopril',
            canonical_name: null,
            strength: '10 mg',
            form: 'tablet',
            route: 'oral',
            release_type: 'immediate',
            rxnorm_rxcui: null,
            normalization_status: 'legacy',
          },
        ],
      };
    });
    const values = await new PricingApiAdapter({
      baseUrl: origin,
      apiKey: 'test-pricing-token',
    }).searchMedications('lisinopril');
    expect(values).toEqual([
      {
        medicationId: '314077',
        name: 'lisinopril 20 MG Oral Tablet',
        genericName: 'lisinopril',
        strength: '20 mg',
        form: 'tablet',
        route: 'oral',
        releaseType: 'immediate',
        rxnormRxcui: '314077',
      },
    ]);
  });

  it('requests the canonical medication and exact physical quantity, then keeps the cheapest total', async () => {
    const origin = await serve((url, authorization) => {
      expect(authorization).toBe('Bearer test-pricing-token');
      expect(url.pathname).toBe('/v1/medications/314077/offers');
      expect(url.searchParams.get('quantity')).toBe('90');
      expect(url.searchParams.get('unit')).toBe('tablet');
      return {
        medication: {
          id: '314077',
          name: 'lisinopril',
          canonical_name: 'lisinopril 20 MG Oral Tablet',
          strength: '20 mg',
          form: 'tablet',
          normalization_status: 'verified',
        },
        quote_status: 'available',
        items: [
          { price_cents: '1260', physical_quantity: '90', content_unit: 'tablet' },
          { price_cents: '666', physical_quantity: '90', content_unit: 'tablet' },
        ],
      };
    });
    const quotes = await new PricingApiAdapter({
      baseUrl: origin,
      apiKey: 'test-pricing-token',
    }).getLatestPrices([
      {
        medicineLineId: 'line-1',
        medicationId: '314077',
        quantity: 90,
        quantityUnit: 'tablet',
      },
    ]);
    expect(quotes).toEqual([
      {
        medicineLineId: 'line-1',
        medicationId: '314077',
        name: 'lisinopril 20 MG Oral Tablet',
        genericName: 'lisinopril',
        strength: '20 mg',
        form: 'tablet',
        quantityUnit: 'tablet',
        unitPrice: 0.074,
        total: 6.66,
      },
    ]);
  });

  it('fails closed when no eligible exact quote is returned', async () => {
    const origin = await serve(() => ({
      medication: {
        id: '314077',
        name: 'lisinopril',
        canonical_name: 'lisinopril 20 MG Oral Tablet',
        strength: '20 mg',
        form: 'tablet',
        normalization_status: 'verified',
      },
      quote_status: 'no_eligible_exact_quote',
      items: [],
    }));
    await expect(
      new PricingApiAdapter({
        baseUrl: origin,
        apiKey: 'test-pricing-token',
      }).getLatestPrices([
        {
          medicineLineId: 'line-1',
          medicationId: '314077',
          quantity: 90,
          quantityUnit: 'tablet',
        },
      ]),
    ).rejects.toBeInstanceOf(PricingUnavailableError);
  });
});
