// Core domain types — separate from route DTOs and Postgres row shapes.

export interface Household {
  id: string;
  email: string;
  /** Cognito `sub` — Cognito is the sole credential store. */
  cognitoSub: string;
  createdAt: Date;
}

export type MedicineForm =
  | 'tablet'
  | 'capsule'
  | 'liquid'
  | 'cream'
  | 'ointment'
  | 'gel'
  | 'solution'
  | 'suspension'
  | 'inhaler'
  | 'spray'
  | 'drops'
  | 'patch'
  | 'injection'
  | 'suppository'
  | 'powder'
  | 'lozenge';

export type StrengthUnit = 'mcg' | 'mg' | 'g' | 'mL' | 'L' | 'units' | 'IU' | 'mEq' | '%';

export type DosageUnit =
  | 'tablet'
  | 'capsule'
  | 'mL'
  | 'g'
  | 'patch'
  | 'inhaler'
  | 'vial'
  | 'syringe'
  | 'pen'
  | 'ampule'
  | 'suppository'
  | 'lozenge'
  | 'dose';

export interface Medicine {
  id: string;
  name: string;
  genericName: string;
  form: MedicineForm;
  /** e.g. 500mg means strength 500, strengthUnit 'mg'. */
  strength: number;
  strengthUnit: StrengthUnit;
  dosageUnit: DosageUnit;
  /** e.g. 500 capsules means quantity 500, dosageUnit 'capsule'. */
  quantity: number;
  frequency: string;
  prescriberName: string;
  /** Number of times this prescription can be refilled. */
  refills: number;
  medId: string;
  /** Verbatim from fetchPrice's response — never computed or reused. */
  unitPrice: number;
  /** quantity * unitPrice, recalculated server-side on every save. */
  total: number;
  deleted: boolean;
}

export interface Member {
  id: string;
  nickname: string;
  medicines: Medicine[];
}

export type PriceComparisonStatus = 'ready' | 'unavailable';

/** What fetchPrice was asked for one medicine line. */
export interface FetchPriceRequestItem {
  medicineId: string;
  name: string;
  form: MedicineForm;
  dosageUnit: DosageUnit;
  quantity: number;
  strength: number;
  strengthUnit: StrengthUnit;
}

/** One pharmacy's offer for a medicine — echoes the request, plus the quote itself. */
export interface FetchPriceQuote extends FetchPriceRequestItem {
  rxNormId: string;
  medId: string;
  /** Verbatim from fetchPrice's response — never computed or altered. */
  price: number;
  pharmacy: string;
}

export interface PrescriptionHousehold {
  id: string;
  householdId: string;
  submittedAt: Date;
  lastUpdatedAt: Date;
  /** Sum of (quantity * unitPrice) across non-deleted medicines only. */
  totalPrice: number;
  deleted: boolean;
  members: Member[];
  priceComparisonStatus: PriceComparisonStatus;
  /** fetchPrice + comparePrices output — one entry per pharmacy offer. */
  priceComparisons: FetchPriceQuote[];
}

/** Summary shape for GET /prescriptions. */
export interface PrescriptionSummary {
  id: string;
  submittedAt: Date;
  lastUpdatedAt: Date;
  totalPrice: number;
}
