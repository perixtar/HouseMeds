// Composition root: constructs adapters, wires them into use-cases. The
// only place that branches on TARGET_SOURCE (mock vs aws).
import { isMockTarget } from './config/env';
import { logger } from './common/logger';

import type { AuthProvider } from './ports/auth-provider.port';
import type { HouseholdRepository } from './ports/household-repository.port';
import type { PrescriptionRepository } from './ports/prescription-repository.port';
import type { FetchPriceClient } from './ports/fetch-price.port';

import { CognitoAuthAdapter } from './adapters/cognito/cognito-auth.adapter';
import { SupabaseHouseholdRepository } from './adapters/db/household.repository';
import { SupabasePrescriptionRepository } from './adapters/db/prescription.repository';
import { FetchPriceAdapter } from './adapters/fetch-price/fetch-price.adapter';

import { MockCognitoAuthAdapter } from './adapters/mock/mock-cognito-auth.adapter';
import { MockHouseholdRepository } from './adapters/mock/mock-household.repository';
import { MockPrescriptionRepository } from './adapters/mock/mock-prescription.repository';
import { MockFetchPriceAdapter } from './adapters/mock/mock-fetch-price.adapter';

import { makeRegisterHousehold } from './usecases/register-household.usecase';
import { makeLoginHousehold } from './usecases/login-household.usecase';
import {
  makeConfirmPasswordReset,
  makeRequestPasswordReset,
} from './usecases/reset-password.usecase';
import { makeAddPrescription } from './usecases/add-prescription.usecase';
import { makeUpdatePrescription } from './usecases/update-prescription.usecase';
import { makeDeletePrescription } from './usecases/delete-prescription.usecase';
import { makeListPrescriptions } from './usecases/list-prescriptions.usecase';
import { makeGetPrescription } from './usecases/get-prescription.usecase';

const useMock = isMockTarget();
logger.info(`Med service starting with TARGET_SOURCE=${useMock ? 'mock' : 'aws'}`);

const householdRepository: HouseholdRepository = useMock
  ? new MockHouseholdRepository()
  : new SupabaseHouseholdRepository();

// Mock adapter needs householdRepository to reject unregistered logins.
const authProvider: AuthProvider = useMock
  ? new MockCognitoAuthAdapter(householdRepository)
  : new CognitoAuthAdapter();

const prescriptionRepository: PrescriptionRepository = useMock
  ? new MockPrescriptionRepository()
  : new SupabasePrescriptionRepository();

const fetchPriceClient: FetchPriceClient = useMock
  ? new MockFetchPriceAdapter()
  : new FetchPriceAdapter();

export const usecases = {
  registerHousehold: makeRegisterHousehold(authProvider, householdRepository),
  loginHousehold: makeLoginHousehold(authProvider),
  requestPasswordReset: makeRequestPasswordReset(authProvider),
  confirmPasswordReset: makeConfirmPasswordReset(authProvider),
  addPrescription: makeAddPrescription(prescriptionRepository, fetchPriceClient),
  updatePrescription: makeUpdatePrescription(prescriptionRepository, fetchPriceClient),
  deletePrescription: makeDeletePrescription(prescriptionRepository),
  listPrescriptions: makeListPrescriptions(prescriptionRepository),
  getPrescription: makeGetPrescription(prescriptionRepository),
};

export { householdRepository };
