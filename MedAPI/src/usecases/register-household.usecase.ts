import type { AuthProvider } from '../ports/auth-provider.port';
import type { HouseholdRepository } from '../ports/household-repository.port';
import type { Household } from '../domain/types';
import { ConflictError } from '../errors/domain-errors';

export interface RegisterHouseholdInput {
  email: string;
  password: string;
}

export function makeRegisterHousehold(
  authProvider: AuthProvider,
  householdRepository: HouseholdRepository,
) {
  return async function registerHousehold(
    input: RegisterHouseholdInput,
  ): Promise<Household> {
    const existing = await householdRepository.findByEmail(input.email);
    if (existing) {
      throw new ConflictError('An account with this email already exists');
    }

    const { cognitoSub } = await authProvider.signUp(input.email, input.password);

    return householdRepository.create({ email: input.email, cognitoSub });
  };
}
