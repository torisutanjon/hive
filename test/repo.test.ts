import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

describe('history and revert', () => {
  const bob = { name: 'Bob', email: 'bob@example.com' };

  test('history for a path', async () => {
    await repo.write('h.md', 'v1\n', 'add h', ada);
    await repo.write('h.md', 'v2\n', 'edit h', ada, sha('v1\n'));
    const h = await repo.history('h.md');
    expect(h).toHaveLength(2);
    expect(h[0]?.message).toBe('edit h');
    expect(h[1]?.message).toBe('add h');
    expect(h[0]?.author).toEqual({ name: 'Ada', email: 'ada@example.com' });
    expect(h[0]?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(!isNaN(Date.parse(h[0]?.date ?? ''))).toBe(true);
  });

  test('history without a path ends with init', async () => {
    await repo.write('h.md', 'v1\n', 'add h', ada);
    const h = await repo.history();
    expect(h[h.length - 1]?.message).toBe('init');
  });

  test('history limit', async () => {
    await repo.write('h.md', 'v1\n', 'add h', ada);
    expect(await repo.history(undefined, 1)).toHaveLength(1);
  });

  test('history rejects bad paths', async () => {
    await expect(repo.history('../x')).rejects.toBeInstanceOf(ContextError);
  });

  test('history survives deletion', async () => {
    await repo.write('h.md', 'v1\n', 'add h', ada);
    await repo.delete('h.md', 'rm h', ada);
    expect((await repo.history('h.md'))[0]?.message).toBe('rm h');
  });

  test('revert commits as the caller', async () => {
    await repo.write('r.md', 'one\n', 'add r', ada);
    const c2 = await repo.write('r.md', 'two\n', 'edit r', ada, sha('one\n'));
    const r = await repo.revert(c2.commit as string, bob);
    expect(readFileSync(join(root, 'r.md'), 'utf8')).toBe('one\n');
    expect(g('log', '-1', '--format=%an|%cn|%s')).toBe('Bob|Hive|Revert "edit r"');
    expect(r.commit).toBe(g('rev-parse', 'HEAD'));
    expect(r.reverted).toBe(c2.commit);
    expect((await repo.revert(c2.commit as string, bob)).commit).toBeNull();
  });

  test('malformed commit', async () => {
    for (const c of ['--abort', 'xyz', '']) {
      await expect(repo.revert(c, bob)).rejects.toThrow(/commit/);
    }
  });

  test('unknown commit', async () => {
    await expect(repo.revert('0'.repeat(40), bob)).rejects.toThrow(/unknown commit/);
  });

  test('conflict aborts cleanly', async () => {
    await repo.write('k.md', 'a\n', 'add k', ada);
    const k2 = await repo.write('k.md', 'b\n', 'edit k', ada, sha('a\n'));
    await repo.write('k.md', 'c\n', 'edit k again', ada, sha('b\n'));
    await expect(repo.revert(k2.commit as string, bob)).rejects.toThrow(/conflict/);
    expect(g('status', '--porcelain')).toBe('');
    expect(readFileSync(join(root, 'k.md'), 'utf8')).toBe('c\n');
    expect(existsSync(join(root, '.git/REVERT_HEAD'))).toBe(false);
  });

  test('errors carry no root path', async () => {
    for (const c of ['--abort', '0'.repeat(40)]) {
      const e = await repo.revert(c, bob).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ContextError);
      expect((e as Error).message).not.toContain(root);
    }
  });
});

describe('newTicket', () => {
  const body = (k: string, t: string): string =>
    `---\ntitle: ${JSON.stringify(t)}\nstatus: todo\nassignee: ""\nlinks: []\n---\n\n# ${k}: ${t}\n`;

  test('create', async () => {
    const r = await repo.newTicket('HIVE', 'First ticket', ada);
    expect(r.key).toBe('HIVE-001');
    expect(r.path).toBe('tickets/HIVE-001.md');
    expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(readFileSync(join(root, 'tickets/HIVE-001.md'), 'utf8')).toBe(
      '---\ntitle: "First ticket"\nstatus: todo\nassignee: ""\nlinks: []\n---\n\n# HIVE-001: First ticket\n',
    );
    expect(g('log', '-1', '--format=%an|%s')).toBe('Ada|HIVE-001: new ticket');
  });

  test('next number', async () => {
    await repo.newTicket('HIVE', 'one', ada);
    expect((await repo.newTicket('HIVE', 'two', ada)).key).toBe('HIVE-002');
  });

  test('numbers are not reused after a delete', async () => {
    await repo.newTicket('HIVE', 'one', ada);
    await repo.newTicket('HIVE', 'two', ada);
    await repo.delete('tickets/HIVE-002.md', 'rm', ada);
    expect((await repo.newTicket('HIVE', 'three', ada)).key).toBe('HIVE-003');
  });

  test('existing file not made via newTicket counts', async () => {
    await repo.write('tickets/HIVE-010.md', 'x\n', 'manual', ada);
    expect((await repo.newTicket('HIVE', 'next', ada)).key).toBe('HIVE-011');
  });

  test('other files are ignored', async () => {
    await repo.write('tickets/OTHER-050.md', 'x\n', 'o', ada);
    await repo.write('tickets/HIVE-5.md', 'x\n', 'o', ada);
    expect((await repo.newTicket('HIVE', 'first', ada)).key).toBe('HIVE-001');
  });

  test('concurrent calls get distinct numbers', async () => {
    const rs = await Promise.all([1, 2, 3, 4, 5].map((i) => repo.newTicket('HIVE', `t${i}`, ada)));
    expect(rs.map((r) => r.key).sort()).toEqual(['HIVE-001', 'HIVE-002', 'HIVE-003', 'HIVE-004', 'HIVE-005']);
    expect(g('status', '--porcelain')).toBe('');
  });

  test('title with quotes is JSON-quoted', async () => {
    const title = 'Say "hi" \\ there';
    const r = await repo.newTicket('HIVE', title, ada);
    const line = readFileSync(join(root, r.path), 'utf8').split('\n')[1];
    expect(line).toBe(`title: ${JSON.stringify(title)}`);
    expect(body(r.key, title)).toContain(line);
  });

  test('bad titles rejected', async () => {
    for (const t of ['', '   ', 'a\nb', 'x'.repeat(201)]) {
      await expect(repo.newTicket('HIVE', t, ada)).rejects.toThrow(/title/);
      await expect(repo.newTicket('HIVE', t, ada)).rejects.toBeInstanceOf(ContextError);
    }
  });

  test('bad keys rejected', async () => {
    for (const k of ['hive', '1AB']) {
      await expect(repo.newTicket(k, 'ok', ada)).rejects.toThrow(/key/);
      await expect(repo.newTicket(k, 'ok', ada)).rejects.toBeInstanceOf(ContextError);
    }
  });
});
