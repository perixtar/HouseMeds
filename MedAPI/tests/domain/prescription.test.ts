import { describe, expect, it } from 'vitest';
import {
  computeMedicineTotal,
  computePrescriptionTotal,
  listActiveMedicines,
  reconcileMembersOnUpdate,
  softDeletePrescription,
} from '../../src/domain/prescription';
import type { Medicine, Member, PrescriptionHousehold } from '../../src/domain/types';

function medicine(overrides: Partial<Medicine> = {}): Medicine {
  return {
    id: 'med-1',
    medicationId: '1',
    name: 'Amoxicillin',
    genericName: 'amoxicillin',
    strength: '500 mg',
    form: 'capsule',
    quantity: 2,
    quantityUnit: 'capsule',
    unitPrice: 10,
    total: 20,
    deleted: false,
    ...overrides,
  };
}

function member(overrides: Partial<Member> = {}): Member {
  return { id: 'member-1', nickname: 'Rex', medicines: [medicine()], ...overrides };
}

describe('computeMedicineTotal', () => {
  it('multiplies quantity by unit price', () => {
    expect(computeMedicineTotal(3, 12.5)).toBe(37.5);
  });

  it('rounds to two decimal places', () => {
    expect(computeMedicineTotal(3, 0.1)).toBe(0.3);
  });
});

describe('computePrescriptionTotal', () => {
  it('sums totals across non-deleted medicines only — hard rule 2', () => {
    const members = [
      member({
        medicines: [
          medicine({ id: 'a', total: 20, deleted: false }),
          medicine({ id: 'b', total: 999, deleted: true }),
        ],
      }),
    ];
    expect(computePrescriptionTotal(members)).toBe(20);
  });

  it('never trusts a pre-existing totalPrice field — recomputes from lines', () => {
    const members = [member({ medicines: [medicine({ total: 20 })] })];
    expect(computePrescriptionTotal(members)).toBe(20);
  });
});

describe('softDeletePrescription', () => {
  it('sets deleted: true without removing any data — hard rule 1', () => {
    const prescription = {
      id: 'p1',
      householdId: 'h1',
      submittedAt: new Date(),
      lastUpdatedAt: new Date(),
      totalPrice: 20,
      deleted: false,
      members: [member()],
      priceComparisonStatus: 'pending',
      priceComparisons: [],
    } as PrescriptionHousehold;

    const result = softDeletePrescription(prescription);

    expect(result.deleted).toBe(true);
    expect(result.members).toEqual(prescription.members);
  });
});

describe('reconcileMembersOnUpdate', () => {
  it('soft-deletes a medicine dropped from the submission, never removes it', () => {
    const existing = [
      member({
        id: 'm1',
        medicines: [medicine({ id: 'a' }), medicine({ id: 'b' })],
      }),
    ];
    const incoming = [
      member({ id: 'm1', medicines: [medicine({ id: 'a' })] }), // 'b' dropped
    ];

    const result = reconcileMembersOnUpdate(existing, incoming);
    const medicines = result.find((m) => m.id === 'm1')?.medicines ?? [];

    expect(medicines).toHaveLength(2);
    expect(medicines.find((m) => m.id === 'a')?.deleted).toBe(false);
    expect(medicines.find((m) => m.id === 'b')?.deleted).toBe(true);
  });

  it('soft-deletes every medicine of a member dropped entirely', () => {
    const existing = [member({ id: 'm1' }), member({ id: 'm2' })];
    const incoming = [member({ id: 'm1' })]; // 'm2' dropped

    const result = reconcileMembersOnUpdate(existing, incoming);
    const droppedMember = result.find((m) => m.id === 'm2');

    expect(droppedMember).toBeDefined();
    expect(droppedMember?.medicines.every((m) => m.deleted)).toBe(true);
  });

  it('adds a brand-new member/medicine with no matching existing id', () => {
    const existing = [member({ id: 'm1' })];
    const incoming = [
      member({ id: 'm1' }),
      member({ id: 'm2', nickname: 'Fido', medicines: [medicine({ id: 'new-med' })] }),
    ];

    const result = reconcileMembersOnUpdate(existing, incoming);

    expect(result.find((m) => m.id === 'm2')?.nickname).toBe('Fido');
  });
});

describe('listActiveMedicines', () => {
  it('excludes soft-deleted medicines', () => {
    const members = [
      member({
        medicines: [
          medicine({ id: 'a', deleted: false }),
          medicine({ id: 'b', deleted: true }),
        ],
      }),
    ];
    expect(listActiveMedicines(members).map((m) => m.id)).toEqual(['a']);
  });
});
