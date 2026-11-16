import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { buildDeveloperTable } from '../src/auth.ts';
import { createHiveServer } from '../src/server.ts';

const TOKEN = 'x'.repeat(40);
const server = createHiveServer(
  buildDeveloperTable({ [TOKEN]: { name: 'Ada', email: 'ada@example.com' } }),
);
let url = '';

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

test('no Authorization → 401', async () => {
  const res = await fetch(url);
  expect(res.status).toBe(401);
  expect(res.headers.get('www-authenticate')).toBe('Bearer');
  expect(await res.text()).toBe('{"error":"unauthorized"}');
});

test('unknown token → identical 401', async () => {
  const res = await fetch(url, { headers: { Authorization: 'Bearer nope' } });
  expect(res.status).toBe(401);
  expect(await res.text()).toBe('{"error":"unauthorized"}');
});

test('valid token → 200 developer', async () => {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ name: 'Ada', email: 'ada@example.com' });
});
