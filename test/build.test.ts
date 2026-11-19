import { execFileSync } from 'node:child_process';
import { expect, test } from 'vitest';

test('AC1 the package builds and the CLI prints usage', () => {
  execFileSync('yarn', ['build'], { encoding: 'utf8', stdio: 'pipe' });
  const out = execFileSync(process.execPath, ['dist/cli.js', '--help'], { encoding: 'utf8' });
  expect(out).toContain('hive-collab-context <ssh-url>');
  expect(out).toContain('start');
}, 120_000);
