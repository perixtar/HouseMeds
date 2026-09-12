import { buildApp } from './app';
import { getEnv } from './config/env';

// Local Fastify server (no Lambda wrapper) — npm run dev.
async function main() {
  const app = buildApp();
  const port = 3000;
  await app.listen({ port, host: '0.0.0.0' });
  // eslint-disable-next-line no-console
  console.log(`MedHouse API listening on :${port} (${getEnv().NODE_ENV})`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
