import { execFileSync } from 'node:child_process';
import { expect, test } from 'vitest';

test('start entry runs', () => {
  const out = execFileSync(process.execPath, ['src/index.ts'], { encoding: 'utf8' });
  expect(out).toContain('hive');
});
