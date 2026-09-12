import { randomUUID } from 'node:crypto';
import type { Collection } from 'mongodb';
import { getDb } from './mongo-client';
import type { PrescriptionRepository } from '../../ports/prescription-repository.port';
import type {
  PriceComparisonRecommendation,
  PrescriptionHousehold,
  PrescriptionSummary,
} from '../../domain/types';

// Server-side deadline, backstop for mongo-client.ts's client-side timeouts.
const OPERATION_TIMEOUT_MS = 5000;

type PrescriptionDoc = Omit<PrescriptionHousehold, 'id'> & { _id: string };

function toDomain(doc: PrescriptionDoc): PrescriptionHousehold {
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
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
      .find(filter, {
        projection: { _id: 1, submittedAt: 1, lastUpdatedAt: 1, totalPrice: 1 },
        maxTimeMS: OPERATION_TIMEOUT_MS,
      })
      .sort({ submittedAt: -1 })
      .toArray();

    return docs.map((doc) => ({
      id: doc._id,
      submittedAt: doc.submittedAt,
      lastUpdatedAt: doc.lastUpdatedAt,
      totalPrice: doc.totalPrice,
    }));
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
