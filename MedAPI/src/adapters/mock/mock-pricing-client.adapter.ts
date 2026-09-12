import type { MedicationForm } from '../../domain/types';
import type {
  CanonicalMedicationSummary,
  PriceQuote,
  PriceQuoteRequest,
  PricingClient,
} from '../../ports/pricing-client.port';
import { PricingUnavailableError } from '../../errors/domain-errors';
import { lookupPrice, type PriceLookupFixture } from './mock-utils';
import mockData from '../../../mock-json/mock-data.json';

const fixture = mockData.calls.getLatestPrices.response as PriceLookupFixture;
const catalog: Record<string, { name: string; strength: string; form: MedicationForm }> =
  {
    '1': { name: 'amoxicillin', strength: '500 mg', form: 'capsule' },
    '2': { name: 'lisinopril', strength: '20 mg', form: 'tablet' },
    '3': { name: 'metformin', strength: '500 mg', form: 'tablet' },
    '4': { name: 'atorvastatin', strength: '40 mg', form: 'tablet' },
    '5': { name: 'omeprazole', strength: '20 mg', form: 'capsule' },
  };

// No real network call. Canonical identity is resolved from a fixed catalog id.
export class MockPricingClient implements PricingClient {
  async searchMedications(query: string): Promise<CanonicalMedicationSummary[]> {
    const wanted = query.toLowerCase().trim();
    return Object.entries(catalog)
      .filter(([, medication]) => medication.name.includes(wanted))
      .map(([medicationId, medication]) => ({
        medicationId,
        name: `${medication.name.charAt(0).toUpperCase() + medication.name.slice(1)} ${medication.strength} ${medication.form}`,
        genericName: medication.name,
        strength: medication.strength,
        form: medication.form,
        route: 'oral',
        releaseType: 'immediate',
        rxnormRxcui: null,
      }));
  }
  async getLatestPrices(requests: PriceQuoteRequest[]): Promise<PriceQuote[]> {
    return requests.map((request) => {
      const medication = catalog[request.medicationId];
      if (!medication)
        throw new PricingUnavailableError('Unknown canonical medication id');
      const unitPrice = lookupPrice(fixture, medication.name),
        total = Math.round(request.quantity * unitPrice * 100) / 100;
      return {
        medicineLineId: request.medicineLineId,
        medicationId: request.medicationId,
        name: `${medication.name.charAt(0).toUpperCase() + medication.name.slice(1)} ${medication.strength} ${medication.form}`,
        genericName: medication.name,
        strength: medication.strength,
        form: medication.form,
        quantityUnit: request.quantityUnit,
        unitPrice,
        total,
      };
    });
  }
}
