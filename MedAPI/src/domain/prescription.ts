import type { Medicine, Member, PrescriptionHousehold } from './types';

// Pure domain functions for PrescriptionHousehold — no DB, no fetchPrice calls.

export function computeMedicineTotal(quantity: number, unitPrice: number): number {
  return roundMoney(quantity * unitPrice);
}

/** Sum of non-deleted medicine totals — never a client-submitted total. */
export function computePrescriptionTotal(members: Member[]): number {
  const sum = members
    .flatMap((m) => m.medicines)
    .filter((med) => !med.deleted)
    .reduce((acc, med) => acc + med.total, 0);
  return roundMoney(sum);
}

/** Soft-delete a whole prescription — never a physical removal. */
export function softDeletePrescription(
  prescription: PrescriptionHousehold,
): PrescriptionHousehold {
  return { ...prescription, deleted: true };
}

/**
 * - In `existing` but not `incoming` (by id): marked `deleted: true`, never removed.
 * - In both: kept, taking `incoming`'s non-price fields; price fields untouched
 *   here (the usecase refetches pricing for every non-deleted medicine).
 * - Only in `incoming`: a new addition.
 */
export function reconcileMembersOnUpdate(
  existing: Member[],
  incoming: Member[],
): Member[] {
  const incomingById = new Map(incoming.map((m) => [m.id, m]));
  const result: Member[] = [];

  for (const existingMember of existing) {
    const incomingMember = incomingById.get(existingMember.id);
    if (!incomingMember) {
      // Dropped from the submission: soft-delete its medicines, keep the row.
      result.push({
        ...existingMember,
        medicines: existingMember.medicines.map((med) =>
          med.deleted ? med : { ...med, deleted: true },
        ),
      });
      continue;
    }
    result.push({
      id: existingMember.id,
      nickname: incomingMember.nickname,
      medicines: reconcileMedicines(existingMember.medicines, incomingMember.medicines),
    });
  }

  for (const incomingMember of incoming) {
    if (!existing.some((m) => m.id === incomingMember.id)) {
      result.push(incomingMember);
    }
  }

  return result;
}

function reconcileMedicines(existing: Medicine[], incoming: Medicine[]): Medicine[] {
  const incomingById = new Map(incoming.map((m) => [m.id, m]));
  const result: Medicine[] = [];

  for (const existingMed of existing) {
    const incomingMed = incomingById.get(existingMed.id);
    if (!incomingMed) {
      result.push(existingMed.deleted ? existingMed : { ...existingMed, deleted: true });
      continue;
    }
    result.push({
      ...existingMed,
      name: incomingMed.name,
      genericName: incomingMed.genericName,
      form: incomingMed.form,
      strength: incomingMed.strength,
      strengthUnit: incomingMed.strengthUnit,
      dosageUnit: incomingMed.dosageUnit,
      quantity: incomingMed.quantity,
      frequency: incomingMed.frequency,
      prescriberName: incomingMed.prescriberName,
      refills: incomingMed.refills,
      medId: incomingMed.medId,
    });
  }

  for (const incomingMed of incoming) {
    if (!existing.some((m) => m.id === incomingMed.id)) {
      result.push(incomingMed);
    }
  }

  return result;
}

/** All non-deleted medicines — the set that must get a fresh price. */
export function listActiveMedicines(members: Member[]): Medicine[] {
  return members.flatMap((m) => m.medicines).filter((med) => !med.deleted);
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}
