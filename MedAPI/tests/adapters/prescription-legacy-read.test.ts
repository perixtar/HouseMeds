import { describe, expect, it } from 'vitest';
import { toDomain } from '../../src/adapters/mongo/prescription.repository';

describe('legacy prescription read compatibility', () => {
  it('keeps free-text legacy medicines readable but explicitly price-unavailable', () => {
    const prescription = toDomain({
      _id: 'legacy-prescription',
      householdId: 'household-1',
      submittedAt: new Date('2026-01-01T00:00:00Z'),
      lastUpdatedAt: new Date('2026-01-01T00:00:00Z'),
      totalPrice: 99,
      deleted: false,
      members: [
        {
          id: 'member-1',
          nickname: 'Family member',
          medicines: [
            {
              id: 'legacy-line',
              name: 'Lisinopril',
              genericName: 'lisinopril',
              quantity: 90,
              unitPrice: 1.1,
              total: 99,
              deleted: false,
            },
          ],
        },
      ],
      priceComparisonStatus: 'ready',
      priceComparisons: [{ medicineId: 'legacy-line', source: 'stale', price: 80 }],
    } as never);

    expect(prescription.totalPrice).toBe(0);
    expect(prescription.priceComparisonStatus).toBe('unavailable');
    expect(prescription.priceComparisons).toEqual([]);
    expect(prescription.members[0]?.medicines[0]).toMatchObject({
      id: 'legacy-line',
      name: 'Lisinopril',
      normalizationStatus: 'needs_review',
      medicationId: null,
      strength: null,
      form: null,
      quantityUnit: null,
      unitPrice: 0,
      total: 0,
    });
  });
});
