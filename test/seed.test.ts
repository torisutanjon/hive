import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { seed } from '../src/seed.ts';
import { loadWorkflows, render, type Workflow } from '../src/workflow.ts';

let parent: string;
let target: string;

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'hive-seed-'));
  target = join(parent, 'ctx');
});
afterEach(() => rmSync(parent, { recursive: true, force: true }));

async function wf(name: string): Promise<Workflow> {
  const found = (await loadWorkflows(target)).valid.find((x) => x.name === name);
  if (!found) throw new Error(`missing workflow ${name}`);
  return found;
}

const git = (...args: string[]): string => execFileSync('git', ['-C', target, ...args], { encoding: 'utf8' }).trim();

describe('seed', () => {
  test('creates layout and one Hive commit on main', async () => {
    await seed(target);
    const files = [
      'project.md',
      ...['start', 'new', 'work', 'end', 'start-ticket'].map((n) => `workflow/${n}.md`),
      ...['tickets', 'specs', 'decisions', 'sessions'].map((d) => `${d}/README.md`),
    ];
    for (const f of files) expect(existsSync(join(target, f)), f).toBe(true);
    expect(git('log', '--format=%an|%s')).toBe('Hive|seed: Hive context repo');
    expect(git('status', '--porcelain')).toBe('');
    expect(git('branch', '--show-current')).toBe('main');
  });

  test('workflows load', async () => {
    await seed(target);
    const w = await loadWorkflows(target);
    expect(w.valid.map((x) => x.name).sort()).toEqual(['end', 'new', 'start', 'start-ticket', 'work']);
    expect(w.invalid).toEqual([]);
  });

  test('no leftover placeholders', async () => {
    await seed(target);
    for (const wf of (await loadWorkflows(target)).valid) {
      const out = render(wf, Object.fromEntries(wf.arguments.map((a) => [a.name, 'X'])));
      expect(out, wf.name).not.toContain('{{');
    }
  });

  test('start-ticket renders the links path', async () => {
    await seed(target);
    const out = render(await wf('start-ticket'), { key: 'HIVE-001' });
    expect(out).toContain('tickets/HIVE-001.md');
    expect(out).toContain('links');
  });

  test('required arguments', async () => {
    await seed(target);
    const work = await wf('work');
    const create = await wf('new');
    expect(() => render(work, {})).toThrow(/missing required argument: key/);
    expect(() => render(create, {})).toThrow(/title/);
  });

  test('config accepts the seeded dir', async () => {
    await seed(target);
    expect(() =>
      loadConfig({
        HIVE_CONTEXT_DIR: target,
        HIVE_TOKENS: JSON.stringify({ [`${'x'.repeat(40)}`]: { name: 'Ada', email: 'ada@example.com' } }),
        HIVE_TICKET_KEY: 'HIVE',
        PORT: '4000',
      }),
    ).not.toThrow();
  });

  test('accepts an existing empty dir', async () => {
    mkdirSync(target);
    await seed(target);
    expect(existsSync(join(target, 'project.md'))).toBe(true);
  });

  test('refuses a non-empty dir and leaves it untouched', async () => {
    mkdirSync(target);
    writeFileSync(join(target, 'keep.txt'), 'mine');
    await expect(seed(target)).rejects.toThrow(/not empty/);
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('mine');
    expect(existsSync(join(target, 'project.md'))).toBe(false);
  });
});
