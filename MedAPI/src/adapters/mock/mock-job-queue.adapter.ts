import type { PriceComparisonJobMessage, JobQueue } from '../../ports/job-queue.port';
import { logger } from '../../common/logger';
import mockData from '../../../mock-json/mock-data.json';

const enqueueResponse = mockData.calls.enqueuePriceComparisonJob.response;

// No real SQS call — logs the message that would have been sent.
export class MockJobQueueAdapter implements JobQueue {
  async enqueuePriceComparisonJob(message: PriceComparisonJobMessage): Promise<void> {
    logger.info('[mock] would enqueue getPriceComparison job', {
      ...message,
      mockMessageId: `${enqueueResponse.messageIdPrefix}${message.prescriptionId}`,
    });
  }
}
