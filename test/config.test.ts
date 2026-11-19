import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { authenticate } from '../src/auth.ts';
import { ConfigError, loadConfig } from '../src/config.ts';

const dir = mkdtempSync(join(tmpdir(), 'hive-'));
mkdirSync(join(dir, '.git'));
writeFileSync(join(dir, 'project.md'), '---\nticket_key: HIVE\n---\n');
const TOKEN = 'x'.repeat(40);
const ada = { name: 'Ada', email: 'ada@example.com' };
const valid = {
  HIVE_CONTEXT_DIR: dir,
  HIVE_TOKENS: JSON.stringify({ [TOKEN]: ada }),
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
    for (const n of ['HIVE_CONTEXT_DIR', 'HIVE_TOKENS', 'PORT']) {
      expect(m).toContain(n);
    }
  });

  test('missing context dir', () => {
    expect(message({ ...valid, HIVE_CONTEXT_DIR: join(dir, 'nope') })).toContain('HIVE_CONTEXT_DIR');
  });

  test('context dir without .git', () => {
    const m = message({ ...valid, HIVE_CONTEXT_DIR: mkdtempSync(join(tmpdir(), 'hive-nogit-')) });
    expect(m).toContain('HIVE_CONTEXT_DIR');
    expect(m).toContain('git');
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

  const ctx = (projectMd?: string): string => {
    const d = mkdtempSync(join(tmpdir(), 'hive-key-'));
    mkdirSync(join(d, '.git'));
    if (projectMd !== undefined) writeFileSync(join(d, 'project.md'), projectMd);
    return d;
  };
  const fm = (v: string): string => `---\nticket_key: ${v}\n---\n`;

  test('AC1 key comes from project.md, HIVE_TICKET_KEY is ignored', () => {
    const d = ctx(fm('OPS2'));
    expect(loadConfig({ ...valid, HIVE_CONTEXT_DIR: d }).ticketKey).toBe('OPS2');
    expect(loadConfig({ ...valid, HIVE_CONTEXT_DIR: d, HIVE_TICKET_KEY: 'OTHER' }).ticketKey).toBe('OPS2');
  });

  test.each(['H', 'HIVE2'])('AC2 key %s accepted', (k) => {
    expect(loadConfig({ ...valid, HIVE_CONTEXT_DIR: ctx(fm(k)) }).ticketKey).toBe(k);
  });

  const bad: [string, () => string][] = [
    ['no project.md', () => ctx()],
    ['no frontmatter', () => ctx('# hi\n')],
    ['no ticket_key', () => ctx('---\nbase_branch: main\n---\n')],
    ['empty key', () => ctx(fm('""'))],
    ['numeric key', () => ctx(fm('12'))],
    ['lowercase', () => ctx(fm('hive'))],
    ['digit first', () => ctx(fm('2HIVE'))],
    ['dash', () => ctx(fm('HI-VE'))],
    [
      'symlinked project.md',
      () => {
        const d = ctx();
        symlinkSync(join(dir, 'project.md'), join(d, 'project.md'));
        return d;
      },
    ],
  ];
  test.each(bad)('AC2 %s rejected', (_n, make) => {
    const m = message({ ...valid, HIVE_CONTEXT_DIR: make() });
    expect(m).toContain('project.md');
    expect(m).toContain('ticket_key');
    expect(m).toContain('uppercase letters/digits starting with a letter');
  });

  test.each(['0', '70000', 'abc', '80.5'])('bad port %s', (p) => {
    expect(message({ ...valid, PORT: p })).toContain('PORT');
  });
});
