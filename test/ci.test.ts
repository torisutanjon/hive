import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';

interface Step {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}
interface Workflow {
  on: { push: { branches: string[] }; pull_request: { branches: string[] } };
  permissions: Record<string, string>;
  jobs: Record<string, { steps: Step[] }>;
}

const wf = parse(
  readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'),
) as Workflow;
const jobs = Object.values(wf.jobs);
const steps = jobs[0]?.steps ?? [];

describe('ci workflow', () => {
  test('runs on develop pushes and PRs only', () => {
    expect(wf.on.push.branches).toEqual(['develop']);
    expect(wf.on.pull_request.branches).toEqual(['develop']);
  });

  test('token is read-only', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
  });

  test('one job with pinned actions, safe checkout, node 22', () => {
    expect(jobs).toHaveLength(1);
    for (const s of steps.filter((x) => x.uses)) {
      expect(s.uses).toMatch(/^[\w-]+\/[\w-]+@v\d+$/);
    }
    const checkout = steps.find((s) => s.uses?.startsWith('actions/checkout@v'));
    expect(checkout?.with?.['persist-credentials']).toBe(false);
    const node = steps.find((s) => s.uses?.startsWith('actions/setup-node@v'));
    expect(String(node?.with?.['node-version'])).toBe('22');
  });

  test('runs install, type-check, lint, test in order', () => {
    expect(steps.filter((s) => s.run).map((s) => s.run)).toEqual([
      'yarn install --frozen-lockfile',
      'yarn type-check',
      'yarn lint',
      'yarn test',
    ]);
  });
});
