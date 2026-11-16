import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';

test('bad config exits 1 with a clear message', () => {
  const r = spawnSync(process.execPath, ['src/index.ts'], { encoding: 'utf8', env: {} });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('HIVE_TOKENS');
  expect(r.stderr).toContain('HIVE_CONTEXT_DIR');
  expect(r.stdout).not.toContain('listening');
});
