import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRepo, type Repo } from '../src/repo.ts';

const ada = { name: 'Ada', email: 'ada@example.com' };
const bob = { name: 'Bob', email: 'bob@example.com' };
const sha = (s: string): string => createHash('sha256').update(Buffer.from(s)).digest('hex');
const run = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

let tmp = '';
let remote = '';
let A = '';
let B = '';
let a: Repo;
let b: Repo;
const onOrigin = (...args: string[]): string => run(tmp, '--git-dir', remote, ...args);

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'hive-sync-'));
  const w = join(tmp, 'w');
  remote = join(tmp, 'remote.git');
  A = join(tmp, 'A');
  B = join(tmp, 'B');
  run(tmp, 'init', '-q', '-b', 'main', w);
  writeFileSync(join(w, 'a.md'), 'one\n');
  run(w, 'add', '-A');
  run(w, '-c', 'user.name=Seed', '-c', 'user.email=seed@x', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init');
  run(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
  run(w, 'remote', 'add', 'origin', remote);
  run(w, 'push', '-q', 'origin', 'main');
  run(tmp, 'clone', '-q', remote, A);
  run(tmp, 'clone', '-q', remote, B);
  a = createRepo(A, { pullTtlMs: 0 });
  b = createRepo(B, { pullTtlMs: 0 });
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('sync with origin', () => {
  test('concurrent tickets from two clones get distinct numbers', async () => {
    const [x, y] = await Promise.all([a.newTicket('HIVE', 'one', ada), b.newTicket('HIVE', 'two', bob)]);
    expect([x.key, y.key].sort()).toEqual(['HIVE-001', 'HIVE-002']);
    const files = onOrigin('ls-tree', '--name-only', 'main', 'tickets/').split('\n').filter(Boolean);
    expect(files).toEqual(['tickets/HIVE-001.md', 'tickets/HIVE-002.md']);
  });
});
