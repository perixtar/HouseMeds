import { randomUUID } from 'node:crypto';
import type { Collection } from 'mongodb';
import { getDb } from './mongo-client';
import type { HouseholdRepository } from '../../ports/household-repository.port';
import type { Household } from '../../domain/types';
import { logger } from '../../common/logger';

// Server-side deadline, backstop for mongo-client.ts's client-side timeouts.
const OPERATION_TIMEOUT_MS = 5000;

interface HouseholdDoc {
  _id: string;
  email: string;
  cognitoSub: string;
  createdAt: Date;
}

function toDomain(doc: HouseholdDoc): Household {
  return {
    id: doc._id,
    email: doc.email,
    cognitoSub: doc.cognitoSub,
    createdAt: doc.createdAt,
  };
}

async function collection(): Promise<Collection<HouseholdDoc>> {
  const db = await getDb();
  return db.collection<HouseholdDoc>('households');
}

export class MongoHouseholdRepository implements HouseholdRepository {
  async findByEmail(email: string): Promise<Household | null> {
    const col = await collection();
    const startedAt = Date.now();
    try {
      const doc = await col.findOne(
        { email: email.toLowerCase() },
        { maxTimeMS: OPERATION_TIMEOUT_MS },
      );
      logger.debug('households.findByEmail', { durationMs: Date.now() - startedAt });
      return doc ? toDomain(doc) : null;
    } catch (err) {
      logger.error('households.findByEmail failed', {
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  async findById(id: string): Promise<Household | null> {
    const col = await collection();
    const doc = await col.findOne({ _id: id }, { maxTimeMS: OPERATION_TIMEOUT_MS });
    return doc ? toDomain(doc) : null;
  }

  async findByCognitoSub(cognitoSub: string): Promise<Household | null> {
    const col = await collection();
    const doc = await col.findOne({ cognitoSub }, { maxTimeMS: OPERATION_TIMEOUT_MS });
    return doc ? toDomain(doc) : null;
  }

  async create(household: Omit<Household, 'id' | 'createdAt'>): Promise<Household> {
    const col = await collection();
    const doc: HouseholdDoc = {
      _id: randomUUID(),
      email: household.email.toLowerCase(),
      cognitoSub: household.cognitoSub,
      createdAt: new Date(),
    };
    const startedAt = Date.now();
    try {
      await col.insertOne(doc, { maxTimeMS: OPERATION_TIMEOUT_MS });
      logger.debug('households.create', { durationMs: Date.now() - startedAt });
      return toDomain(doc);
    } catch (err) {
      logger.error('households.create failed', {
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}
