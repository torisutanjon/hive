import { describe, expect, test } from 'vitest';
import { authenticate, buildDeveloperTable, hashToken } from '../src/auth.ts';

const TOKEN = 'x'.repeat(40);
const ada = { name: 'Ada', email: 'ada@example.com' };
const table = buildDeveloperTable({ [TOKEN]: ada });

describe('hashToken', () => {
  test('is 64 hex chars, deterministic, not the token', () => {
    const h = hashToken(TOKEN);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(TOKEN)).toBe(h);
    expect(h).not.toBe(TOKEN);
  });
});

describe('authenticate', () => {
  test('rejects missing, wrong-scheme, empty and unknown', () => {
    expect(authenticate(undefined, table)).toBeNull();
    expect(authenticate('Basic abc', table)).toBeNull();
    expect(authenticate('Bearer', table)).toBeNull();
    expect(authenticate('Bearer nope', table)).toBeNull();
  });

  test('accepts valid token, scheme case-insensitive', () => {
    expect(authenticate(`Bearer ${TOKEN}`, table)).toEqual(ada);
    expect(authenticate(`bearer ${TOKEN}`, table)).toEqual(ada);
  });
});
