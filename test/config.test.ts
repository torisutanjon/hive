import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { authenticate } from '../src/auth.ts';
import { ConfigError, loadConfig } from '../src/config.ts';

const dir = mkdtempSync(join(tmpdir(), 'hive-'));
const TOKEN = 'x'.repeat(40);
const ada = { name: 'Ada', email: 'ada@example.com' };
const valid = {
  HIVE_CONTEXT_DIR: dir,
  HIVE_TOKENS: JSON.stringify({ [TOKEN]: ada }),
  HIVE_TICKET_KEY: 'HIVE',
  PORT: '4000',
};

function message(env: NodeJS.ProcessEnv): string {
  try {
    loadConfig(env);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as Error).message;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  test('valid env', () => {
    const c = loadConfig(valid);
    expect(c.contextDir).toBe(dir);
    expect(c.ticketKey).toBe('HIVE');
    expect(c.port).toBe(4000);
    expect(authenticate(`Bearer ${TOKEN}`, c.developers)).toEqual(ada);
  });

  test('empty env collects every problem', () => {
    const m = message({});
    for (const n of ['HIVE_CONTEXT_DIR', 'HIVE_TOKENS', 'HIVE_TICKET_KEY', 'PORT']) {
      expect(m).toContain(n);
    }
  });

  test('missing context dir', () => {
    expect(message({ ...valid, HIVE_CONTEXT_DIR: join(dir, 'nope') })).toContain('HIVE_CONTEXT_DIR');
  });

  test('invalid JSON never echoed', () => {
    const m = message({ ...valid, HIVE_TOKENS: 'not json {secret-abc}' });
    expect(m).toContain('HIVE_TOKENS');
    expect(m).not.toContain('secret-abc');
  });

  test.each(['{}', '[]'])('tokens %s rejected', (t) => {
    expect(message({ ...valid, HIVE_TOKENS: t })).toContain('HIVE_TOKENS');
  });

  test('short token rejected and not echoed', () => {
    const m = message({ ...valid, HIVE_TOKENS: JSON.stringify({ 'short-secret-token': ada }) });
    expect(m).toContain('HIVE_TOKENS');
    expect(m).not.toContain('short-secret-token');
  });

  test.each([{ name: 'Ada' }, { name: 'Ada', email: 'no-at' }])('bad entry %j', (v) => {
    expect(message({ ...valid, HIVE_TOKENS: JSON.stringify({ [TOKEN]: v }) })).toContain('HIVE_TOKENS');
  });

  test.each(['hive', '1AB'])('bad ticket key %s', (k) => {
    expect(message({ ...valid, HIVE_TICKET_KEY: k })).toContain('HIVE_TICKET_KEY');
  });

  test.each(['0', '70000', 'abc', '80.5'])('bad port %s', (p) => {
    expect(message({ ...valid, PORT: p })).toContain('PORT');
  });
});
