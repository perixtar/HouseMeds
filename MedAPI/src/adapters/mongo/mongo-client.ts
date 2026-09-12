import { MongoClient, type Db } from 'mongodb';
import { getMongoUri } from '../../config/env';

// Module-scope singleton — created once, reused across warm invocations.
let clientPromise: Promise<MongoClient> | undefined;

async function getClient(): Promise<MongoClient> {
  if (!clientPromise) {
    // Fail fast and loggably instead of hanging if Atlas is unreachable.
    clientPromise = getMongoUri()
      .then((uri) =>
        new MongoClient(uri, {
          serverSelectionTimeoutMS: 5000,
          connectTimeoutMS: 5000,
          socketTimeoutMS: 10000,
        }).connect(),
      )
      .catch((err) => {
        // Don't let one failed attempt poison this warm container.
        clientPromise = undefined;
        throw err;
      });
  }
  return clientPromise;
}

export async function getDb(): Promise<Db> {
  const client = await getClient();
  return client.db('medhouse');
}
