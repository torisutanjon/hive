import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

test('AC1 the package builds and the CLI prints usage', () => {
  execFileSync('yarn', ['build'], { encoding: 'utf8', stdio: 'pipe' });
  const out = execFileSync(process.execPath, ['dist/cli.js', '--help'], { encoding: 'utf8' });
  expect(out).toContain('hive-collab-context <ssh-url>');
  expect(out).toContain('start');
}, 120_000);

test('AC1 package.json publishes hive-collab-context', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; bin: Record<string, string>; files: string[] };
  expect(pkg.name).toBe('hive-collab-context');
  expect(pkg.bin['hive-collab-context']).toBe('dist/cli.js');
  expect(pkg.files).toEqual(expect.arrayContaining(['dist', 'seed']));
});

test('HIVE-018 the package ships the tier guard', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { files: string[] };
  expect(pkg.files).toContain('hooks');
  expect(existsSync(new URL('../hooks/guard.mjs', import.meta.url))).toBe(true);
});
