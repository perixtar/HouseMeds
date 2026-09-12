import type { SQSEvent, SQSBatchResponse, Context } from 'aws-lambda';
import { usecases } from './composition';
import { logger } from './common/logger';
import type { PriceComparisonJobMessage } from './ports/job-queue.port';

// SQS entrypoint — runs only getPriceComparison, off the API Lambda's cycle.
export async function handler(
  event: SQSEvent,
  context: Context,
): Promise<SQSBatchResponse> {
  // Mongo's client stays warm across invocations, so the event loop never
  // idles on its own — return on promise settle, not on event-loop drain.
  context.callbackWaitsForEmptyEventLoop = false;

  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];

  for (const record of event.Records) {
    try {
      const message = JSON.parse(record.body) as PriceComparisonJobMessage;
      await usecases.getPriceComparison({
        prescriptionId: message.prescriptionId,
        householdId: message.householdId,
      });
    } catch (err) {
      logger.error('getPriceComparison job failed', {
        messageId: record.messageId,
        error: err instanceof Error ? err.message : String(err),
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}
