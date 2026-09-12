// Composition root: constructs adapters, wires them into use-cases. The
// only place that branches on TARGET_SOURCE (mock vs aws).
import { isMockTarget } from './config/env';
import { logger } from './common/logger';

import type { AuthProvider } from './ports/auth-provider.port';
import type { HouseholdRepository } from './ports/household-repository.port';
import type { PrescriptionRepository } from './ports/prescription-repository.port';
import type { PricingClient } from './ports/pricing-client.port';
import type { JobQueue } from './ports/job-queue.port';
import type { PriceComparison } from './ports/price-comparison.port';

import { CognitoAuthAdapter } from './adapters/cognito/cognito-auth.adapter';
import { MongoHouseholdRepository } from './adapters/mongo/household.repository';
import { MongoPrescriptionRepository } from './adapters/mongo/prescription.repository';
import { PricingApiAdapter } from './adapters/pricing/pricing-api.adapter';
import { SqsJobQueueAdapter } from './adapters/sqs/sqs-job-queue.adapter';
import { PricingClientSourceAdapter } from './adapters/price-comparison/pricing-client-source.adapter';

import { MockCognitoAuthAdapter } from './adapters/mock/mock-cognito-auth.adapter';
import { MockHouseholdRepository } from './adapters/mock/mock-household.repository';
import { MockPrescriptionRepository } from './adapters/mock/mock-prescription.repository';
import { MockPricingClient } from './adapters/mock/mock-pricing-client.adapter';
import { MockJobQueueAdapter } from './adapters/mock/mock-job-queue.adapter';
import { MockPriceComparisonAdapter } from './adapters/mock/mock-price-comparison.adapter';

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
import { makeGetPriceComparison } from './usecases/get-price-comparison.usecase';
import { makeSearchMedications } from './usecases/search-medications.usecase';

const useMock = isMockTarget();
logger.info(`Med service starting with TARGET_SOURCE=${useMock ? 'mock' : 'aws'}`);

const householdRepository: HouseholdRepository = useMock
  ? new MockHouseholdRepository()
  : new MongoHouseholdRepository();

// Mock adapter needs householdRepository to reject unregistered logins.
const authProvider: AuthProvider = useMock
  ? new MockCognitoAuthAdapter(householdRepository)
  : new CognitoAuthAdapter();

const prescriptionRepository: PrescriptionRepository = useMock
  ? new MockPrescriptionRepository()
  : new MongoPrescriptionRepository();

const pricingClient: PricingClient = useMock
  ? new MockPricingClient()
  : new PricingApiAdapter();

const jobQueue: JobQueue = useMock ? new MockJobQueueAdapter() : new SqsJobQueueAdapter();

// Vendor sources for getPriceComparison — add a new PriceComparison impl here.
const priceComparisonSources: PriceComparison[] = useMock
  ? [new MockPriceComparisonAdapter()]
  : [new PricingClientSourceAdapter(pricingClient)];

export const usecases = {
  registerHousehold: makeRegisterHousehold(authProvider, householdRepository),
  loginHousehold: makeLoginHousehold(authProvider),
  requestPasswordReset: makeRequestPasswordReset(authProvider),
  confirmPasswordReset: makeConfirmPasswordReset(authProvider),
  addPrescription: makeAddPrescription(prescriptionRepository, pricingClient, jobQueue),
  updatePrescription: makeUpdatePrescription(
    prescriptionRepository,
    pricingClient,
    jobQueue,
  ),
  deletePrescription: makeDeletePrescription(prescriptionRepository),
  listPrescriptions: makeListPrescriptions(prescriptionRepository),
  getPrescription: makeGetPrescription(prescriptionRepository),
  searchMedications: makeSearchMedications(pricingClient),
  getPriceComparison: makeGetPriceComparison(
    prescriptionRepository,
    priceComparisonSources,
  ),
};

export { householdRepository };
