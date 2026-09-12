import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance, token: string;

beforeAll(async () => {
  process.env.TARGET_SOURCE = 'mock';
  process.env.NODE_ENV = 'test';
  const { buildApp } = await import('../../src/app');
  app = buildApp();
  await app.ready();
  const email = 'normalization-e2e@example.test',
    password = 'correct-horse-battery-staple';
  const registered = await app.inject({
    method: 'POST',
    url: '/register',
    payload: { email, password },
  });
  expect(registered.statusCode).toBe(201);
  const login = await app.inject({
    method: 'POST',
    url: '/login',
    payload: { email, password },
  });
  expect(login.statusCode).toBe(200);
  token = login.json().idToken;
});
afterAll(async () => {
  await app.close();
});

describe('incoming canonical medication HTTP flow', () => {
  it('searches a canonical id and saves a server-resolved medicine line', async () => {
    const search = await app.inject({
      method: 'GET',
      url: '/medications?q=lisinopril',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(search.statusCode).toBe(200);
    expect(search.json().items).toEqual([
      {
        medicationId: '2',
        name: 'Lisinopril 20 mg tablet',
        genericName: 'lisinopril',
        strength: '20 mg',
        form: 'tablet',
        route: 'oral',
        releaseType: 'immediate',
        rxnormRxcui: null,
      },
    ]);
    const saved = await app.inject({
      method: 'POST',
      url: '/prescriptions',
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': 'incoming-normalization-e2e',
      },
      payload: {
        members: [
          {
            nickname: 'Test member',
            medicines: [{ medicationId: '2', quantity: 90, quantityUnit: 'tablet' }],
          },
        ],
      },
    });
    expect(saved.statusCode, saved.body).toBe(201);
    const medicine = saved.json().members[0].medicines[0];
    expect(medicine).toMatchObject({
      medicationId: '2',
      name: 'Lisinopril 20 mg tablet',
      genericName: 'lisinopril',
      strength: '20 mg',
      form: 'tablet',
      quantity: 90,
      quantityUnit: 'tablet',
      unitPrice: 8.75,
      total: 787.5,
    });
    expect(medicine.id).not.toBe(medicine.medicationId);
  });

  it('rejects the legacy free-text prescription contract', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/prescriptions',
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': 'legacy-contract-e2e',
      },
      payload: {
        members: [
          {
            nickname: 'Test member',
            medicines: [{ name: 'Lisinopril', genericName: 'lisinopril', quantity: 90 }],
          },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
  });
});
