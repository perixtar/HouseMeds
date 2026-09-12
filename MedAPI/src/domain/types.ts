// Core domain types — separate from route DTOs and Mongo document shapes.

export interface Household {
  id: string;
  email: string;
  /** Cognito `sub` — Cognito is the sole credential store. */
  cognitoSub: string;
  createdAt: Date;
}

export interface Medicine {
  id: string;
  name: string;
  genericName: string;
  quantity: number;
  /** Verbatim from the pricing API's response — never computed or reused. */
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
  /** Sum of (quantity * unitPrice) across non-deleted medicines only. */
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
