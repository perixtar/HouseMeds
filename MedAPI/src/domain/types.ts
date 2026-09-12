// Core domain types — separate from route DTOs and Mongo document shapes.

export interface Household {
  id: string;
  email: string;
  /** Cognito `sub` — Cognito is the sole credential store. */
  cognitoSub: string;
  createdAt: Date;
}

export interface Medicine {
  /** Household-local prescription line id. It is never a pricing catalog id. */
  id: string;
  name: string;
  genericName: string;
  quantity: number;
  unitPrice: number;
  total: number;
  deleted: boolean;
  normalizationStatus: 'verified' | 'needs_review';
  /** Canonical HouseMeds pricing.medications.id selected from the catalog. */
  medicationId: string | null;
  /** Server-resolved canonical display fields; clients cannot set these directly. */
  strength: string | null;
  form: MedicationForm | null;
  quantityUnit: QuantityUnit | null;
}

export type VerifiedMedicine = Medicine & {
  normalizationStatus: 'verified';
  medicationId: string;
  strength: string;
  form: MedicationForm;
  quantityUnit: QuantityUnit;
};

export const medicationForms = [
  'tablet',
  'capsule',
  'liquid',
  'cream',
  'ointment',
  'gel',
  'solution',
  'suspension',
  'inhaler',
  'spray',
  'drops',
  'patch',
  'injection',
  'suppository',
  'powder',
  'lozenge',
] as const;
export type MedicationForm = (typeof medicationForms)[number];

export const quantityUnits = [
  'tablet',
  'capsule',
  'ml',
  'g',
  'patch',
  'inhaler',
  'vial',
  'syringe',
  'pen',
  'ampule',
  'suppository',
  'lozenge',
  'dose',
] as const;
export type QuantityUnit = (typeof quantityUnits)[number];

export interface Member {
  id: string;
  nickname: string;
  medicines: Medicine[];
}

export type PriceComparisonStatus = 'pending' | 'ready' | 'unavailable';

export interface PriceComparisonRecommendation {
  medicineId: string;
  source: string;
  price: number;
}

export interface PrescriptionHousehold {
  id: string;
  householdId: string;
  submittedAt: Date;
  lastUpdatedAt: Date;
  /** Sum of exact pricing-response totals across non-deleted medicines only. */
  totalPrice: number;
  deleted: boolean;
  members: Member[];
  priceComparisonStatus: PriceComparisonStatus;
  priceComparisons: PriceComparisonRecommendation[];
}

/** Summary shape for GET /prescriptions. */
export interface PrescriptionSummary {
  id: string;
  submittedAt: Date;
  lastUpdatedAt: Date;
  totalPrice: number;
}
