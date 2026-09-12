import { randomUUID } from 'node:crypto';
import type { Collection } from 'mongodb';
import { getDb } from './mongo-client';
import type { PrescriptionRepository } from '../../ports/prescription-repository.port';
import type {
  Medicine,
  PriceComparisonRecommendation,
  PrescriptionHousehold,
  PrescriptionSummary,
} from '../../domain/types';
import { medicationForms, quantityUnits } from '../../domain/types';

// Server-side deadline, backstop for mongo-client.ts's client-side timeouts.
const OPERATION_TIMEOUT_MS = 5000;

type PrescriptionDoc = Omit<PrescriptionHousehold, 'id'> & { _id: string };

function storedMedicine(raw: Record<string, unknown>): Medicine {
  const valid =
    raw.normalizationStatus !== 'needs_review' &&
    typeof raw.medicationId === 'string' &&
    /^[1-9]\d{0,17}$/.test(raw.medicationId) &&
    typeof raw.strength === 'string' &&
    raw.strength.length > 0 &&
    medicationForms.includes(raw.form as (typeof medicationForms)[number]) &&
    quantityUnits.includes(raw.quantityUnit as (typeof quantityUnits)[number]);
  const base = {
    id: String(raw.id ?? randomUUID()),
    name: String(raw.name ?? ''),
    genericName: String(raw.genericName ?? raw.name ?? ''),
    quantity: Number(raw.quantity ?? 0),
    deleted: raw.deleted === true,
  };
  if (!valid)
    return {
      ...base,
      normalizationStatus: 'needs_review',
      medicationId: null,
      strength: null,
      form: null,
      quantityUnit: null,
      unitPrice: 0,
      total: 0,
    };
  return {
    ...base,
    normalizationStatus: 'verified',
    medicationId: raw.medicationId as string,
    strength: raw.strength as string,
    form: raw.form as (typeof medicationForms)[number],
    quantityUnit: raw.quantityUnit as (typeof quantityUnits)[number],
    unitPrice: Number(raw.unitPrice ?? 0),
    total: Number(raw.total ?? 0),
  };
}

export function toDomain(doc: PrescriptionDoc): PrescriptionHousehold {
  const { _id, ...rest } = doc;
  const members = (Array.isArray(rest.members) ? rest.members : []).map((member) => ({
    ...member,
    medicines: (Array.isArray(member.medicines) ? member.medicines : []).map((medicine) =>
      storedMedicine(medicine as unknown as Record<string, unknown>),
    ),
  }));
  const totalPrice = members
    .flatMap((member) => member.medicines)
    .filter((medicine) => !medicine.deleted)
    .reduce((total, medicine) => total + medicine.total, 0);
  const unresolved = members.some((member) =>
    member.medicines.some(
      (medicine) => !medicine.deleted && medicine.normalizationStatus !== 'verified',
    ),
  );
  return {
    id: _id,
    ...rest,
    members,
    totalPrice: Math.round(totalPrice * 100) / 100,
    priceComparisonStatus: unresolved ? 'unavailable' : rest.priceComparisonStatus,
    priceComparisons: unresolved ? [] : rest.priceComparisons,
  };
}

async function collection(): Promise<Collection<PrescriptionDoc>> {
  const db = await getDb();
  return db.collection<PrescriptionDoc>('prescriptionHouseholds');
}

export class MongoPrescriptionRepository implements PrescriptionRepository {
  async create(
    prescription: Omit<PrescriptionHousehold, 'id'>,
  ): Promise<PrescriptionHousehold> {
    const col = await collection();
    const doc: PrescriptionDoc = { _id: randomUUID(), ...prescription };
    await col.insertOne(doc, { maxTimeMS: OPERATION_TIMEOUT_MS });
    return toDomain(doc);
  }

  async findById(id: string, householdId: string): Promise<PrescriptionHousehold | null> {
    const col = await collection();
    // Scoped server-side to the authenticated household's own id.
    const doc = await col.findOne(
      { _id: id, householdId },
      { maxTimeMS: OPERATION_TIMEOUT_MS },
    );
    return doc ? toDomain(doc) : null;
  }

  async listByHousehold(
    householdId: string,
    options: { includeDeleted: boolean },
  ): Promise<PrescriptionSummary[]> {
    const col = await collection();
    const filter = options.includeDeleted
      ? { householdId }
      : { householdId, deleted: false };
    const docs = await col
      .find(filter, { maxTimeMS: OPERATION_TIMEOUT_MS })
      .sort({ submittedAt: -1 })
      .toArray();

    return docs.map((doc) => {
      const normalized = toDomain(doc);
      return {
        id: normalized.id,
        submittedAt: normalized.submittedAt,
        lastUpdatedAt: normalized.lastUpdatedAt,
        totalPrice: normalized.totalPrice,
      };
    });
  }

  async replace(prescription: PrescriptionHousehold): Promise<PrescriptionHousehold> {
    const col = await collection();
    const { id, ...rest } = prescription;
    const doc: PrescriptionDoc = { _id: id, ...rest };
    await col.replaceOne({ _id: id, householdId: prescription.householdId }, doc, {
      maxTimeMS: OPERATION_TIMEOUT_MS,
    });
    return prescription;
  }

  async softDelete(id: string, householdId: string): Promise<boolean> {
    const col = await collection();
    const result = await col.updateOne(
      { _id: id, householdId },
      { $set: { deleted: true, lastUpdatedAt: new Date() } },
      { maxTimeMS: OPERATION_TIMEOUT_MS },
    );
    return result.matchedCount > 0;
  }

  async savePriceComparisons(
    id: string,
    offers: PriceComparisonRecommendation[],
  ): Promise<void> {
    const col = await collection();
    await col.updateOne(
      { _id: id },
      { $set: { priceComparisonStatus: 'ready', priceComparisons: offers } },
      { maxTimeMS: OPERATION_TIMEOUT_MS },
    );
  }

  async markPriceComparisonUnavailable(id: string): Promise<void> {
    const col = await collection();
    await col.updateOne(
      { _id: id },
      { $set: { priceComparisonStatus: 'unavailable', priceComparisons: [] } },
      { maxTimeMS: OPERATION_TIMEOUT_MS },
    );
  }
}
