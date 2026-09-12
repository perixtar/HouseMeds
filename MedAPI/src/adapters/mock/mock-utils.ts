import { createHash, randomUUID } from 'node:crypto';

// Shared helpers for the TARGET_SOURCE=mock adapters — no network calls.

export interface PriceLookupFixture {
  prices: Record<string, number>;
  default: number;
}

/** Case-insensitive lookup, falling back to `default`. */
export function lookupPrice(fixture: PriceLookupFixture, name: string): number {
  return fixture.prices[name.toLowerCase()] ?? fixture.default;
}

/** Deterministic pseudo Cognito `sub` — same email, same sub every time. */
export function mockCognitoSub(email: string, prefix: string): string {
  const hash = createHash('sha256')
    .update(email.toLowerCase())
    .digest('hex')
    .slice(0, 16);
  return `${prefix}${hash}`;
}

// Unsigned, JWT-shaped token so common/auth.ts's sub-extraction works unchanged.
export function buildMockToken(prefix: string, sub: string, email: string): string {
  const header = base64url({ alg: 'none', typ: 'JWT' });
  const payload = base64url({ sub, email, mock: true });
  return `${prefix}${header}.${payload}.mocksignature-${randomUUID()}`;
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
