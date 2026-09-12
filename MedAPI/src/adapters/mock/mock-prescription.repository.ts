import { randomUUID } from 'node:crypto';
import type { PrescriptionRepository } from '../../ports/prescription-repository.port';
import type { PrescriptionHousehold, PrescriptionSummary } from '../../domain/types';
import mockData from '../../../mock-json/mock-data.json';

const seed = mockData.repositories.prescription;

type SeedRow = Omit<PrescriptionHousehold, 'id' | 'submittedAt' | 'lastUpdatedAt'> & {
  id?: string;
  submittedAt?: string;
  lastUpdatedAt?: string;
};

// In-memory store, seeded once from the fixture, instead of Supabase.
export class MockPrescriptionRepository implements PrescriptionRepository {
  private readonly byId = new Map<string, PrescriptionHousehold>();

  constructor() {
    for (const row of seed as SeedRow[]) {
      const prescription: PrescriptionHousehold = {
        ...row,
        id: row.id ?? randomUUID(),
        submittedAt: row.submittedAt ? new Date(row.submittedAt) : new Date(),
        lastUpdatedAt: row.lastUpdatedAt ? new Date(row.lastUpdatedAt) : new Date(),
      };
      this.byId.set(prescription.id, prescription);
    }
  }

  async create(
    prescription: Omit<PrescriptionHousehold, 'id'>,
  ): Promise<PrescriptionHousehold> {
    const created: PrescriptionHousehold = { id: randomUUID(), ...prescription };
    this.byId.set(created.id, created);
    return created;
  }

  async findById(id: string, householdId: string): Promise<PrescriptionHousehold | null> {
    const found = this.byId.get(id);
    return found && found.householdId === householdId ? found : null;
  }

  async listByHousehold(
    householdId: string,
    options: { includeDeleted: boolean },
  ): Promise<PrescriptionSummary[]> {
    return [...this.byId.values()]
      .filter(
        (p) => p.householdId === householdId && (options.includeDeleted || !p.deleted),
      )
      .sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime())
      .map((p) => ({
        id: p.id,
        submittedAt: p.submittedAt,
        lastUpdatedAt: p.lastUpdatedAt,
        totalPrice: p.totalPrice,
      }));
  }

  async replace(prescription: PrescriptionHousehold): Promise<PrescriptionHousehold> {
    this.byId.set(prescription.id, prescription);
    return prescription;
  }

  async softDelete(id: string, householdId: string): Promise<boolean> {
    const found = this.byId.get(id);
    if (!found || found.householdId !== householdId) return false;
    this.byId.set(id, { ...found, deleted: true, lastUpdatedAt: new Date() });
    return true;
  }
}
