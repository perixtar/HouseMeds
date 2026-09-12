import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { PriceComparisonJobMessage, JobQueue } from '../../ports/job-queue.port';
import { requireEnv } from '../../config/env';

const client = new SQSClient({});

export class SqsJobQueueAdapter implements JobQueue {
  async enqueuePriceComparisonJob(message: PriceComparisonJobMessage): Promise<void> {
    await client.send(
      new SendMessageCommand({
        QueueUrl: requireEnv('PRICE_COMPARISON_QUEUE_URL'),
        MessageBody: JSON.stringify(message),
      }),
    );
  }
}
