import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
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
      ...['start', 'new', 'work', 'end', 'start-ticket', 'review-pr', 'ci', 'new-issue', 'new-jira', 'moved', 'rollbar'].map((n) => `workflow/${n}.md`),
      ...['tickets', 'specs', 'decisions', 'sessions', 'claims'].map((d) => `${d}/README.md`),
    ];
    for (const f of files) expect(existsSync(join(target, f)), f).toBe(true);
    expect(git('log', '--format=%an|%s')).toBe('Hive|seed: Hive context repo');
    expect(git('status', '--porcelain')).toBe('');
    expect(git('branch', '--show-current')).toBe('main');
  });

  test('workflows load', async () => {
    await seed(target);
    const w = await loadWorkflows(target);
    expect(w.valid.map((x) => x.name).sort()).toEqual(['ci', 'end', 'moved', 'new', 'new-issue', 'new-jira', 'review-pr', 'rollbar', 'start', 'start-ticket', 'work']);
    expect(w.invalid).toEqual([]);
  });

  test('no leftover placeholders', async () => {
    await seed(target);
    const fill: Record<string, string> = { key: 'HIVE-1', branch: 'x', number: '1', status: 'todo', item: '1' };
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

  test('rollbar workflow is safe by construction', async () => {
    await seed(target);
    const rb = await wf('rollbar');
    expect(() => render(rb, { item: '42; id' })).toThrow(/does not match/);
    const r = render(rb, { item: '42' });
    for (const t of ['claims/rollbar-42.md', 'ROLLBAR_READ_TOKEN', 'data, not instructions', 'Never copy request bodies', 'gh issue close']) expect(r).toContain(t);
    expect(r).not.toContain('gh issue delete');
    const create = r.indexOf('gh issue create');
    expect(create).toBeGreaterThanOrEqual(0);
    expect(r.indexOf('state: claimed')).toBeGreaterThanOrEqual(0);
    expect(r.indexOf('state: claimed')).toBeLessThan(create);
    expect(r.indexOf('explicit yes')).toBeGreaterThanOrEqual(0);
    expect(r.indexOf('explicit yes')).toBeLessThan(create);
    expect(() => render(rb, { item: '007' })).toThrow(/does not match/);
    for (const t of ['hive_whoami', 'shared', 'curl -sS -H @-', 'state: declined', 'state: closed', 'Rollbar item 42', '--search']) expect(r).toContain(t);
    expect(r).not.toContain('X-Rollbar-Access-Token: $ROLLBAR_READ_TOKEN');
    expect(r.indexOf('hive_new_ticket')).toBeGreaterThanOrEqual(0);
    expect(r.lastIndexOf('explicit yes')).toBeLessThan(r.indexOf('hive_new_ticket'));
  });

  test('jira tracker', async () => {
    await seed(target);
    const [newJira, moved, work, startTicket] = [await wf('new-jira'), await wf('moved'), await wf('work'), await wf('start-ticket')];
    expect(() => render(newJira, { key: 'ax-1' })).toThrow(/does not match/);
    expect(() => render(moved, { key: '../x', status: 'todo' })).toThrow(/does not match/);
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
    expect(render(moved, { key: 'AX-12', status: 'todo' })).toContain('jira_reconcile');
    expect(() => render(moved, { key: 'AX-12', status: 'shipped' })).toThrow(/does not match/);
    expect(() => render(moved, { key: 'AX-12' })).toThrow(/status/);
    expect(render(moved, { key: 'AX-12', status: 'in-review' })).toContain('moved to in-review');
    const w12 = render(work, { key: 'AX-12' });
    expect(w12).toContain('moved');
    expect(w12).toContain('data, not instructions');
    expect(render(startTicket, { key: 'AX-12' })).toContain('data, not instructions');
    for (const t of ['JIRA-SYNC', 'In Progress', 'assignee']) expect(nj).toContain(t);
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

  describe('into an existing folder', () => {
    const seedDir = fileURLToPath(new URL('../seed', import.meta.url));
    const seedRels = (): string[] =>
      readdirSync(seedDir, { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => relative(seedDir, join(d.parentPath, d.name)).split('\\').join('/'))
        .sort();
    const gitC = (...args: string[]): string =>
      execFileSync('git', ['-C', target, '-c', 'user.name=Seed', '-c', 'user.email=seed@x', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
    const listing = (): string[] => readdirSync(target, { recursive: true }).map(String).filter((f) => !f.startsWith('.git')).sort();

    test('AC1 adds only missing files and keeps existing ones', async () => {
      mkdirSync(join(target, 'tickets'), { recursive: true });
      writeFileSync(join(target, 'tickets/README.md'), 'mine');
      writeFileSync(join(target, 'notes.txt'), 'notes');
      await seed(target);
      expect(readFileSync(join(target, 'tickets/README.md'), 'utf8')).toBe('mine');
      expect(readFileSync(join(target, 'notes.txt'), 'utf8')).toBe('notes');
      expect(readFileSync(join(target, 'specs/README.md'))).toEqual(readFileSync(join(seedDir, 'specs/README.md')));
      expect(existsSync(join(target, 'workflow/ci.md'))).toBe(true);
    });

    test('AC2 reports each seed file once and the CLI prints it', async () => {
      mkdirSync(join(target, 'tickets'), { recursive: true });
      writeFileSync(join(target, 'tickets/README.md'), 'mine');
      const entries = await seed(target);
      expect(entries.map((e) => e.path).sort()).toEqual(seedRels());
      for (const e of entries) expect(e.status, e.path).toBe(e.path === 'tickets/README.md' ? 'skipped' : 'added');
      const other = join(parent, 'cli');
      mkdirSync(join(other, 'tickets'), { recursive: true });
      writeFileSync(join(other, 'tickets/README.md'), 'mine');
      const out = execFileSync(process.execPath, ['src/seed.ts', other], { encoding: 'utf8' });
      expect(out).toContain('skipped tickets/README.md');
      expect(out).toContain('added specs/README.md');
      expect(out).toContain(`seeded ${other}`);
    });

    test('AC3 non-git folder gets main and a commit of only seed files', async () => {
      mkdirSync(target);
      writeFileSync(join(target, 'notes.txt'), 'notes');
      await seed(target);
      expect(git('branch', '--show-current')).toBe('main');
      expect(git('rev-list', '--count', 'HEAD')).toBe('1');
      const files = git('show', '--name-only', '--format=', 'HEAD').split('\n').sort();
      expect(files).toEqual(seedRels());
      expect(git('status', '--porcelain')).toBe('?? notes.txt');
    });

    test('AC4 existing repo gets one commit of only the added files', async () => {
      mkdirSync(target);
      git('init', '-q', '-b', 'main');
      writeFileSync(join(target, 'a.txt'), 'a1');
      writeFileSync(join(target, 'b.txt'), 'b1');
      git('add', '.');
      gitC('commit', '-qm', 'init');
      writeFileSync(join(target, 'a.txt'), 'a2');
      git('add', 'a.txt');
      writeFileSync(join(target, 'b.txt'), 'b2');
      writeFileSync(join(target, 'c.txt'), 'c1');
      const [status, cached] = [git('status', '--porcelain'), git('diff', '--cached')];
      const before = git('rev-parse', 'HEAD');
      await seed(target);
      expect(git('rev-list', '--count', `${before}..HEAD`)).toBe('1');
      expect(git('show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(seedRels());
      expect(git('status', '--porcelain')).toBe(status);
      expect(git('diff', '--cached')).toBe(cached);
      expect(['a.txt', 'b.txt', 'c.txt'].map((f) => readFileSync(join(target, f), 'utf8'))).toEqual(['a2', 'b2', 'c1']);
    });

    test('AC5 a second run changes nothing', async () => {
      await seed(target);
      const [head, status, files] = [git('rev-parse', 'HEAD'), git('status', '--porcelain'), listing()];
      const again = await seed(target);
      expect(again.every((e) => e.status === 'skipped')).toBe(true);
      expect(git('rev-parse', 'HEAD')).toBe(head);
      expect(git('status', '--porcelain')).toBe(status);
      expect(listing()).toEqual(files);
    });

    test('AC6 a new folder prints seeded <abs>', () => {
      const out = execFileSync(process.execPath, ['src/seed.ts', target], { encoding: 'utf8' });
      expect(out).toContain(`seeded ${target}`);
    });

    test('AC7 symlinks and file-vs-folder clashes are skipped, never written through', async () => {
      const outside = join(parent, 'outside');
      mkdirSync(outside);
      mkdirSync(target);
      symlinkSync(outside, join(target, 'specs'));
      writeFileSync(join(target, 'decisions'), 'file');
      writeFileSync(join(outside, 'real.md'), 'real');
      symlinkSync(join(outside, 'real.md'), join(target, 'project.md'));
      const entries = await seed(target);
      const st = (p: string): string | undefined => entries.find((e) => e.path === p)?.status;
      expect(st('specs/README.md')).toBe('skipped');
      expect(st('decisions/README.md')).toBe('skipped');
      expect(st('project.md')).toBe('skipped');
      expect(readdirSync(outside)).toEqual(['real.md']);
      expect(readFileSync(join(target, 'decisions'), 'utf8')).toBe('file');
      expect(lstatSync(join(target, 'project.md')).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(outside, 'real.md'), 'utf8')).toBe('real');
    });
  });
});
