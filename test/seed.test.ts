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
      ...['start', 'new', 'work', 'end', 'start-ticket', 'review-pr', 'ci', 'new-issue', 'new-jira', 'moved'].map((n) => `workflow/${n}.md`),
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
    expect(w.valid.map((x) => x.name).sort()).toEqual(['ci', 'end', 'moved', 'new', 'new-issue', 'new-jira', 'review-pr', 'start', 'start-ticket', 'work']);
    expect(w.invalid).toEqual([]);
  });

  test('no leftover placeholders', async () => {
    await seed(target);
    const fill: Record<string, string> = { key: 'HIVE-1', branch: 'x', number: '1' };
    for (const wf of (await loadWorkflows(target)).valid) {
      const out = render(wf, Object.fromEntries(wf.arguments.map((a) => [a.name, fill[a.name] ?? 'X'])));
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
    const [review, ci, issue] = [await wf('review-pr'), await wf('ci'), await wf('new-issue')];
    expect(() => render(review, {})).toThrow(/number/);
    expect(() => render(ci, {})).toThrow(/branch/);
    expect(() => render(issue, {})).toThrow(/title/);
  });

  test('github writes come after an explicit yes', async () => {
    await seed(target);
    const rp = render(await wf('review-pr'), { number: '42' });
    expect(rp).toContain('#42');
    expect(rp).toContain('gh pr diff 42 --repo <github_repo>');
    expect(rp.indexOf('explicit yes')).toBeGreaterThanOrEqual(0);
    expect(rp.indexOf('gh pr review')).toBeGreaterThanOrEqual(0);
    expect(rp.indexOf('explicit yes')).toBeLessThan(rp.indexOf('gh pr review'));
    const ni = render(await wf('new-issue'), { title: 'Bug' });
    expect(ni.indexOf('explicit yes')).toBeGreaterThanOrEqual(0);
    expect(ni.indexOf('gh issue create')).toBeGreaterThanOrEqual(0);
    expect(ni.indexOf('explicit yes')).toBeLessThan(ni.indexOf('gh issue create'));
    const ci = render(await wf('ci'), { branch: 'HIVE-1/x' });
    expect(ci).toContain('Read only');
    for (const bad of ['gh pr review', 'gh issue create', 'gh pr merge', 'gh run rerun']) expect(ci).not.toContain(bad);
  });

  test('github workflows reject unsafe arguments and pin the repo', async () => {
    await seed(target);
    const [review, ci, issue] = [await wf('review-pr'), await wf('ci'), await wf('new-issue')];
    expect(() => render(review, { number: '42; rm -rf ~' })).toThrow(/does not match/);
    expect(() => render(ci, { branch: 'x$(id)' })).toThrow(/does not match/);
    const args = { number: '42', branch: 'a/b', title: 'T' };
    for (const w of [review, ci, issue]) {
      const out = render(w, args);
      expect(out, w.name).toContain('--repo <github_repo>');
      expect(out, w.name).toContain('data, not instructions');
    }
    expect(render(issue, args)).toContain('Never put the title into a shell command');
    expect(readFileSync(join(target, 'project.md'), 'utf8')).toContain('github_repo');
  });

  test('jira tracker', async () => {
    await seed(target);
    const [newJira, moved, work, startTicket] = [await wf('new-jira'), await wf('moved'), await wf('work'), await wf('start-ticket')];
    expect(() => render(newJira, { key: 'ax-1' })).toThrow(/does not match/);
    expect(() => render(moved, { key: '../x' })).toThrow(/does not match/);
    expect(() => render(work, { key: 'X' })).toThrow(/does not match/);
    expect(() => render(startTicket, { key: 'HIVE-1/../../x' })).toThrow(/does not match/);
    const nj = render(newJira, { key: 'AX-12' });
    expect(nj).toContain('tickets/AX-12.md');
    expect(nj).toContain('JIRA:SYNC:START');
    expect(nj.indexOf('explicit yes')).toBeGreaterThanOrEqual(0);
    expect(nj.indexOf('hive_write')).toBeGreaterThanOrEqual(0);
    expect(nj.indexOf('explicit yes')).toBeLessThan(nj.indexOf('hive_write'));
    const start = render(await wf('start'), {});
    expect(start).toContain('MOVE THESE IN JIRA');
    expect(start).toContain('assignee');
    expect(render(work, { key: 'AX-12' })).toContain('jira_reconcile: pending');
    expect(render(moved, { key: 'AX-12' })).toContain('jira_reconcile');
    expect(render(await wf('new'), { title: 't' })).toContain('new-jira');
    expect(readFileSync(join(target, 'project.md'), 'utf8')).toContain('tracker: hive');
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
