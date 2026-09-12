export interface PriceComparisonJobMessage {
  prescriptionId: string;
  householdId: string;
}

// API Lambda enqueues after saving a prescription; worker Lambda consumes it.
export interface JobQueue {
  enqueuePriceComparisonJob(message: PriceComparisonJobMessage): Promise<void>;
}
