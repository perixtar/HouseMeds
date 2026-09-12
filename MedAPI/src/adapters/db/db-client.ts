import postgres from 'postgres';
import { getSupabaseDbUrl } from '../../config/env';

// Module-scope singleton — created once, reused across warm invocations.
let clientPromise: Promise<postgres.Sql> | undefined;

async function getClient(): Promise<postgres.Sql> {
  if (!clientPromise) {
    // Fail fast and loggably instead of hanging if Supabase is unreachable.
    clientPromise = getSupabaseDbUrl()
      .then((uri) =>
        postgres(uri, {
          ssl: 'require',
          connect_timeout: 5,
          idle_timeout: 20,
          max: 5,
        }),
      )
      .catch((err) => {
        // Don't let one failed attempt poison this warm container.
        clientPromise = undefined;
        throw err;
      });
  }
  return clientPromise;
}

export async function getDbClient(): Promise<postgres.Sql> {
  return getClient();
}
