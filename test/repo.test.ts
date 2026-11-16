import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ContextError } from '../src/context.ts';
import { createRepo, type Repo } from '../src/repo.ts';

const ada = { name: 'Ada', email: 'ada@example.com' };
const sha = (s: string): string => createHash('sha256').update(Buffer.from(s)).digest('hex');

let root = '';
let repo: Repo;
const g = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hive-repo-'));
  g('init', '-q');
  writeFileSync(join(root, 'a.md'), 'one\n');
  g('add', '-A');
  g('-c', 'user.name=Seed', '-c', 'user.email=seed@x', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init');
  repo = createRepo(root);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('write', () => {
  test('create', async () => {
    const r = await repo.write('notes/new.md', 'hi\n', 'add new', ada);
    expect(existsSync(join(root, 'notes/new.md'))).toBe(true);
    expect(g('log', '-1', '--format=%an <%ae>|%cn|%s')).toBe('Ada <ada@example.com>|Hive|add new');
    expect(r).toEqual({ path: 'notes/new.md', version: sha('hi\n'), commit: g('rev-parse', 'HEAD') });
  });

  test('create over existing rejects', async () => {
    await expect(repo.write('a.md', 'x', 'm', ada)).rejects.toMatchObject({
      name: 'ContextError',
      message: expect.stringMatching(/exists/),
    });
  });

  test('update with correct base', async () => {
    const r = await repo.write('a.md', 'two\n', 'edit', ada, sha('one\n'));
    expect(r.version).toBe(sha('two\n'));
    expect(g('log', '-1', '--format=%s')).toBe('edit');
  });

  test('wrong base', async () => {
    await expect(repo.write('a.md', 'two\n', 'edit', ada, 'f'.repeat(64))).rejects.toThrow(/changed/);
  });

  test('base for a missing file', async () => {
    await expect(repo.write('missing.md', 'x', 'm', ada, sha('x'))).rejects.toBeInstanceOf(ContextError);
  });

  test('manual edits are committed first', async () => {
    writeFileSync(join(root, 'a.md'), 'edited\n');
    await repo.write('b.md', 'b\n', 'add b', ada);
    expect(g('log', '-2', '--format=%s|%an').split('\n')).toEqual(['add b|Ada', 'manual edits|Hive']);
  });

  test('no-op makes no commit', async () => {
    const head = g('rev-parse', 'HEAD');
    const r = await repo.write('a.md', 'one\n', 'same', ada, sha('one\n'));
    expect(r.commit).toBeNull();
    expect(g('rev-parse', 'HEAD')).toBe(head);
  });

  test('empty message', async () => {
    await expect(repo.write('x.md', 'x', '  ', ada)).rejects.toThrow(/message/);
  });
});

describe('delete', () => {
  test('removes file and commits as author', async () => {
    const r = await repo.delete('a.md', 'remove a', ada);
    expect(existsSync(join(root, 'a.md'))).toBe(false);
    expect(g('log', '-1', '--format=%s|%an')).toBe('remove a|Ada');
    expect(r.version).toBeNull();
  });

  test('missing file', async () => {
    await expect(repo.delete('nope.md', 'm', ada)).rejects.toThrow(/not found/);
  });

  test('empty message', async () => {
    await expect(repo.delete('a.md', '  ', ada)).rejects.toThrow(/message/);
  });
});

describe('guards', () => {
  test('rejected paths leave nothing behind', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'hive-repo-out-'));
    try {
      symlinkSync(outside, join(root, 'out'));
      symlinkSync(join(root, '.git'), join(root, 'gl'));
      for (const p of ['../x.md', '.git/hooks/pre-commit', '.GIT/config', '', 'out/x.md', 'gl/hooks/pre-commit']) {
        await expect(repo.write(p, 'x', 'm', ada), p).rejects.toBeInstanceOf(ContextError);
      }
      expect(g('status', '--porcelain')).toBe('');
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('pathspec magic', () => {
  test('a file named like a pathspec is treated literally', async () => {
    const magic = ':(glob)**';
    expect((await repo.write(magic, 'x\n', 'add magic', ada)).path).toBe(magic);
    await repo.delete(magic, 'rm magic', ada);
    expect(existsSync(join(root, 'a.md'))).toBe(true);
    expect(g('ls-files').split('\n')).toContain('a.md');
    expect(g('show', '--name-only', '--format=', 'HEAD')).toBe(magic);
  });
});

describe('concurrency', () => {
  test('five parallel writes serialize', async () => {
    await Promise.all([0, 1, 2, 3, 4].map((i) => repo.write(`c${i}.md`, `${i}\n`, `c${i}`, ada)));
    expect(g('rev-list', '--count', 'HEAD')).toBe('6');
    expect(g('status', '--porcelain')).toBe('');
  });
});
