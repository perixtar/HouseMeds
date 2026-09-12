import type { Household } from '../domain/types';

export interface HouseholdRepository {
  findByEmail(email: string): Promise<Household | null>;
  findById(id: string): Promise<Household | null>;
  /** Resolves the authenticated household from the Cognito JWT's `sub`. */
  findByCognitoSub(cognitoSub: string): Promise<Household | null>;
  /** Creates the local record after Cognito SignUp succeeds. */
  create(household: Omit<Household, 'id' | 'createdAt'>): Promise<Household>;
}
