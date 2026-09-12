import { getDbClient } from './db-client';
import type { HouseholdRepository } from '../../ports/household-repository.port';
import type { Household } from '../../domain/types';
import { logger } from '../../common/logger';

interface HouseholdRow {
  id: string;
  email: string;
  cognito_sub: string;
  created_at: Date;
}

function toDomain(row: HouseholdRow): Household {
  return {
    id: row.id,
    email: row.email,
    cognitoSub: row.cognito_sub,
    createdAt: row.created_at,
  };
}

export class SupabaseHouseholdRepository implements HouseholdRepository {
  async findByEmail(email: string): Promise<Household | null> {
    const sql = await getDbClient();
    const startedAt = Date.now();
    try {
      const rows = await sql<HouseholdRow[]>`
        select id, email, cognito_sub, created_at from households
        where email = ${email.toLowerCase()}
        limit 1
      `;
      logger.debug('households.findByEmail', { durationMs: Date.now() - startedAt });
      return rows[0] ? toDomain(rows[0]) : null;
    } catch (err) {
      logger.error('households.findByEmail failed', {
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  async findById(id: string): Promise<Household | null> {
    const sql = await getDbClient();
    const rows = await sql<HouseholdRow[]>`
      select id, email, cognito_sub, created_at from households where id = ${id} limit 1
    `;
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async findByCognitoSub(cognitoSub: string): Promise<Household | null> {
    const sql = await getDbClient();
    const rows = await sql<HouseholdRow[]>`
      select id, email, cognito_sub, created_at from households
      where cognito_sub = ${cognitoSub}
      limit 1
    `;
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async create(household: Omit<Household, 'id' | 'createdAt'>): Promise<Household> {
    const sql = await getDbClient();
    const startedAt = Date.now();
    try {
      const rows = await sql<HouseholdRow[]>`
        insert into households (email, cognito_sub)
        values (${household.email.toLowerCase()}, ${household.cognitoSub})
        returning id, email, cognito_sub, created_at
      `;
      logger.debug('households.create', { durationMs: Date.now() - startedAt });
      return toDomain(rows[0]!);
    } catch (err) {
      logger.error('households.create failed', {
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}
