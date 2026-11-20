import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

const cli = join(import.meta.dirname, '../src/cli.ts');
const PROMPT = 'Context repo SSH URL (git@host:owner/repo.git): ';
const SSH_ERR = 'context repo must be an SSH URL like git@github.com:owner/repo.git';
const hasScript = spawnSync('script', ['--version']).error === undefined;

const dirs: string[] = [];
const sandbox = (): { proj: string; env: NodeJS.ProcessEnv } => {
  const proj = mkdtempSync(join(tmpdir(), 'hive-cli-proj-'));
  const home = mkdtempSync(join(tmpdir(), 'hive-cli-home-'));
  dirs.push(proj, home);
  spawnSync('git', ['init', '-q'], { cwd: proj });
  mkdirSync(home, { recursive: true });
  return { proj, env: { ...process.env, HOME: home } };
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const pty = (args: string, input: string, proj: string, env: NodeJS.ProcessEnv) =>
  spawnSync('script', ['-qec', `${process.execPath} ${cli} ${args}`, '/dev/null'], { cwd: proj, env, input, encoding: 'utf8', timeout: 20_000 });

describe('cli url prompt', () => {
  test.skipIf(!hasScript)('AC1 AC4 no argument on a TTY prompts for the URL and validates the answer', () => {
    const { proj, env } = sandbox();
    const r = pty('', 'https://github.com/owner/repo.git\n', proj, env);
    expect(r.stdout).toContain(PROMPT);
    expect(r.stdout).toContain(SSH_ERR);
    expect(r.status).toBe(1);
  });

  test('AC3 no argument with a silent open pipe prints usage and exits 0', async () => {
    const { proj, env } = sandbox();
    const child = spawn(process.execPath, [cli], { cwd: proj, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d));
    const code = await new Promise<number | null>((resolve, reject) => {
      const t = setTimeout(() => {
        child.stdin.end();
        child.kill();
        reject(new Error('timed out waiting for usage'));
      }, 10_000);
      child.on('close', (c) => {
        clearTimeout(t);
        resolve(c);
      });
    });
    child.stdin.end();
    expect(code).toBe(0);
    expect(out).toContain('usage:');
    expect(out).not.toContain('Context repo SSH URL');
  });

  test.skipIf(!hasScript)('AC2 --help prints usage without prompting', () => {
    const { proj, env } = sandbox();
    const r = pty('--help', '', proj, env);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('usage:');
    expect(r.stdout).not.toContain('Context repo SSH URL');
  });

  test('AC4 AC5 a positional URL skips the prompt', () => {
    const { proj, env } = sandbox();
    const r = spawnSync(process.execPath, [cli, 'https://github.com/owner/repo.git'], { cwd: proj, env, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(SSH_ERR);
    expect(r.stdout).not.toContain('Context repo SSH URL');
  });
});
