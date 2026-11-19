import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
// @ts-expect-error plain JS module with JSDoc, no declaration file
import { decide, readOnly } from '../hooks/guard.mjs';

const HANDS = ['hands-careful', 'hands-mechanical'];
const CODEX_HANDS = ['gpt-6.1-terra', 'gpt-6-luna'];
const claude = (tool_name: string, extra: object = {}): unknown => ({ tool_name, ...extra });
const bash = (command: string, extra: object = {}): unknown => ({ tool_name: 'Bash', tool_input: { command }, ...extra });

const rows: Array<[string, 'claude' | 'codex', unknown, 'allow' | 'deny']> = [
  ['claude Read', 'claude', claude('Read'), 'allow'],
  ['claude Edit brain', 'claude', claude('Edit'), 'deny'],
  ['claude Write brain', 'claude', claude('Write'), 'deny'],
  ['claude NotebookEdit brain', 'claude', claude('NotebookEdit'), 'deny'],
  ['claude MultiEdit brain', 'claude', claude('MultiEdit'), 'deny'],
  ['claude Edit careful hand', 'claude', claude('Edit', { agent_type: 'hands-careful' }), 'allow'],
  ['claude Bash mechanical hand rm', 'claude', bash('rm -rf x', { agent_type: 'hands-mechanical' }), 'allow'],
  ['claude Edit other agent', 'claude', claude('Edit', { agent_type: 'Explore' }), 'deny'],
  ['git status', 'claude', bash('git status'), 'allow'],
  ['git log -5', 'claude', bash('git log --oneline -5'), 'allow'],
  ['git diff piped to head', 'claude', bash('git diff | head -20'), 'allow'],
  ['git branch --list', 'claude', bash('git branch --list'), 'allow'],
  ['git commit', 'claude', bash('git commit -m x'), 'deny'],
  ['git branch -D', 'claude', bash('git branch -D x'), 'deny'],
  ['git branch new', 'claude', bash('git branch newbranch'), 'deny'],
  ['git diff --output', 'claude', bash('git diff --output=out.txt'), 'deny'],
  ['rm -rf', 'claude', bash('rm -rf x'), 'deny'],
  ['ls && rm', 'claude', bash('ls && rm x'), 'deny'],
  ['ls; rm', 'claude', bash('ls; rm x'), 'deny'],
  ['ls || rm', 'claude', bash('ls || rm x'), 'deny'],
  ['ls | xargs rm', 'claude', bash('ls | xargs rm'), 'deny'],
  ['ls newline rm', 'claude', bash('ls\nrm x'), 'deny'],
  ['redirect', 'claude', bash('cat a > b'), 'deny'],
  ['append', 'claude', bash('echo hi >> b'), 'deny'],
  ['command substitution', 'claude', bash('echo $(rm x)'), 'deny'],
  ['backticks', 'claude', bash('echo `rm x`'), 'deny'],
  ['find -delete', 'claude', bash('find . -delete'), 'deny'],
  ['find -exec', 'claude', bash('find . -exec rm {} +'), 'deny'],
  ['find -name', 'claude', bash('find . -name "*.ts"'), 'allow'],
  ['yarn test', 'claude', bash('yarn test'), 'allow'],
  ['yarn type-check', 'claude', bash('yarn type-check'), 'allow'],
  ['yarn add', 'claude', bash('yarn add x'), 'deny'],
  ['npm test', 'claude', bash('npm test'), 'allow'],
  ['node --test', 'claude', bash('node --test'), 'allow'],
  ['sed -i', 'claude', bash('sed -i s/a/b/ f'), 'deny'],
  ['missing tool_name', 'claude', {}, 'allow'],
  ['null input', 'claude', null, 'allow'],
  ['bash without command', 'claude', { tool_name: 'Bash' }, 'deny'],
  ['codex apply_patch sol', 'codex', { tool_name: 'apply_patch', model: 'gpt-6.2-sol' }, 'deny'],
  ['codex apply_patch terra', 'codex', { tool_name: 'apply_patch', model: 'gpt-6.1-terra' }, 'allow'],
  ['codex Bash grep', 'codex', bash('grep -rn x src', { model: 'gpt-6.2-sol' }), 'allow'],
  ['codex Bash sed -i', 'codex', bash('sed -i s/a/b/ f', { model: 'gpt-6.2-sol' }), 'deny'],
  ['codex Bash sed -i luna', 'codex', bash('sed -i s/a/b/ f', { model: 'gpt-6-luna' }), 'allow'],
  ['codex ignores agent_type', 'codex', { tool_name: 'apply_patch', agent_type: 'hands-careful', model: 'gpt-6.2-sol' }, 'deny'],
  ['codex Edit is not a codex edit tool', 'codex', claude('Edit'), 'allow'],
];

describe('decide', () => {
  test.each(rows)('%s', (_n, provider, input, want) => {
    expect(decide(provider, provider === 'claude' ? HANDS : CODEX_HANDS, input)).toBe(want);
  });
});

describe('readOnly', () => {
  test('non-string is false', () => {
    expect(readOnly(undefined)).toBe(false);
    expect(readOnly(5)).toBe(false);
  });
});

describe('guard process', () => {
  const run = (input: string): { status: number | null; stderr: string; stdout: string } =>
    spawnSync(process.execPath, ['hooks/guard.mjs', 'claude', 'hands-careful,hands-mechanical'], { input, encoding: 'utf8' });

  test('deny exits 2 with the message', () => {
    const r = run('{"tool_name":"Edit"}');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Hive: the brain plans; dispatch edits to hands-careful or hands-mechanical');
  });

  test('invalid JSON denies and never echoes the input', () => {
    const r = run('not json SECRET');
    expect(r.status).toBe(2);
    expect(r.stderr).not.toContain('SECRET');
  });

  test('allow exits 0 silently', () => {
    const r = run('{"tool_name":"Read"}');
    expect([r.status, r.stderr, r.stdout]).toEqual([0, '', '']);
  });
});
