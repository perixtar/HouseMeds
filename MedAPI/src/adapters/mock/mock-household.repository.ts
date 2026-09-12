import { randomUUID } from 'node:crypto';
import type { HouseholdRepository } from '../../ports/household-repository.port';
import type { Household } from '../../domain/types';
import mockData from '../../../mock-json/mock-data.json';

const seed = mockData.repositories.household;

interface SeedRow {
  id?: string;
  email: string;
  cognitoSub: string;
  createdAt?: string;
}

// In-memory store, seeded once from the fixture, instead of Supabase.
export class MockHouseholdRepository implements HouseholdRepository {
  private readonly byId = new Map<string, Household>();

  constructor() {
    for (const row of seed as SeedRow[]) {
      const household: Household = {
        id: row.id ?? randomUUID(),
        email: row.email.toLowerCase(),
        cognitoSub: row.cognitoSub,
        createdAt: row.createdAt ? new Date(row.createdAt) : new Date(),
      };
      this.byId.set(household.id, household);
    }
  }

  async findByEmail(email: string): Promise<Household | null> {
    const target = email.toLowerCase();
    return [...this.byId.values()].find((h) => h.email === target) ?? null;
  }

  async findById(id: string): Promise<Household | null> {
    return this.byId.get(id) ?? null;
  }

  async findByCognitoSub(cognitoSub: string): Promise<Household | null> {
    return [...this.byId.values()].find((h) => h.cognitoSub === cognitoSub) ?? null;
  }

  async create(household: Omit<Household, 'id' | 'createdAt'>): Promise<Household> {
    const created: Household = {
      id: randomUUID(),
      email: household.email.toLowerCase(),
      cognitoSub: household.cognitoSub,
      createdAt: new Date(),
    };
    this.byId.set(created.id, created);
    return created;
  }
}
