import { getDbClient } from '../adapters/db/db-client';
import { isMockTarget } from '../config/env';

// Postgres-backed idempotency, keyed off the Idempotency-Key header — replaces
// the DynamoDB-backed @aws-lambda-powertools/idempotency layer. Claims the key
// with an atomic insert; a concurrent/retried request with the same key waits
// for and replays the first call's stored response instead of re-running it.
// Skipped under TARGET_SOURCE=mock — there's no database to back it with.
export function withIdempotency<TPayload extends { idempotencyKey: string }, TResult>(
  fn: (payload: TPayload) => Promise<TResult>,
): (payload: TPayload) => Promise<TResult> {
  if (isMockTarget()) return fn;

  return async (payload: TPayload): Promise<TResult> => {
    const sql = await getDbClient();
    const claimed = await sql<{ key: string }[]>`
      insert into idempotency_records (key)
      values (${payload.idempotencyKey})
      on conflict (key) do nothing
      returning key
    `;

    if (claimed.length === 0) {
      // Someone already claimed this key — poll briefly for their result
      // rather than re-running a non-idempotent side effect twice.
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const [existing] = await sql<{ response: TResult | null }[]>`
          select response from idempotency_records where key = ${payload.idempotencyKey}
        `;
        if (existing?.response != null) return existing.response;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(`Idempotency key ${payload.idempotencyKey} is still processing`);
    }

    try {
      const result = await fn(payload);
      await sql`
        update idempotency_records set response = ${JSON.stringify(result)}::jsonb
        where key = ${payload.idempotencyKey}
      `;
      return result;
    } catch (err) {
      // Release the claim so a retry after a failed attempt isn't stuck forever.
      await sql`delete from idempotency_records where key = ${payload.idempotencyKey}`;
      throw err;
    }
  };
}
