import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ContextError, listDir, readContext, resolveSafe, searchContext } from '../src/context.ts';

let root = '';
let outside = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'hive-ctx-'));
  outside = mkdtempSync(join(tmpdir(), 'hive-out-'));
  mkdirSync(join(root, 'notes'));
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, 'notes/a.md'), 'Hello World\nsecond line\n');
  writeFileSync(join(root, 'b.md'), 'nothing here\n');
  writeFileSync(join(root, 'big.md'), 'match me\n'.repeat(60));
  writeFileSync(join(root, '.git/config'), 'hello secret\n');
  writeFileSync(join(root, '.git/x.md'), 'hello in git\n');
  writeFileSync(join(outside, 'secret.md'), 'hello outside\n');
  symlinkSync(outside, join(root, 'escape'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('resolveSafe', () => {
  test.each(['../x', '/etc/passwd', '.git/config', 'notes/../../x', 'escape/secret.md', 'a\0b'])(
    'rejects %j',
    async (p) => {
      const err = await resolveSafe(root, p).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ContextError);
      expect((err as Error).message).not.toContain(root);
    },
  );

  test('accepts notes/a.md and empty', async () => {
    await expect(resolveSafe(root, 'notes/a.md')).resolves.toContain('a.md');
    await expect(resolveSafe(root, '')).resolves.toBeTypeOf('string');
  });
});

describe('listDir', () => {
  test('root listing', async () => {
    const list = await listDir(root);
    expect(list).toContainEqual({ name: 'notes', type: 'dir' });
    expect(list).toContainEqual({ name: 'b.md', type: 'file' });
    expect(list.map((e) => e.name)).not.toContain('.git');
    const names = list.map((e) => e.name);
    expect(names).toEqual([...names].sort());
  });
  test('subdir', async () => {
    expect(await listDir(root, 'notes')).toEqual([{ name: 'a.md', type: 'file' }]);
  });
  test('file is an error', async () => {
    await expect(listDir(root, 'b.md')).rejects.toBeInstanceOf(ContextError);
  });
});

describe('readContext', () => {
  test('content and version', async () => {
    const text = 'Hello World\nsecond line\n';
    const r = await readContext(root, 'notes/a.md');
    expect(r.content).toBe(text);
    expect(r.version).toBe(createHash('sha256').update(text).digest('hex'));
    writeFileSync(join(root, 'notes/a.md'), 'changed\n');
    expect((await readContext(root, 'notes/a.md')).version).not.toBe(r.version);
    writeFileSync(join(root, 'notes/a.md'), text);
  });
  test('missing', async () => {
    await expect(readContext(root, 'missing.md')).rejects.toMatchObject({
      name: 'ContextError',
      message: 'not found',
    });
  });
  test('directory', async () => {
    await expect(readContext(root, 'notes')).rejects.toBeInstanceOf(ContextError);
  });
});

describe('searchContext', () => {
  test('case-insensitive, skips .git and escapes', async () => {
    expect(await searchContext(root, 'HELLO')).toEqual([
      { path: 'notes/a.md', line: 1, text: 'Hello World' },
    ]);
  });
  test('caps at 50', async () => {
    expect(await searchContext(root, 'match me')).toHaveLength(50);
  });
  test('empty query', async () => {
    await expect(searchContext(root, '')).rejects.toBeInstanceOf(ContextError);
  });
});
