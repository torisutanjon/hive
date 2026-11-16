import { execFile } from 'node:child_process';
import { cp, mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const SEED_DIR = fileURLToPath(new URL('../seed', import.meta.url));

export async function seed(target: string): Promise<void> {
  const dir = resolve(target);
  let existing: string[] = [];
  try {
    existing = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (existing.length) throw new Error(`target is not empty: ${dir}`);
  await mkdir(dir, { recursive: true });
  await cp(SEED_DIR, dir, { recursive: true });
  const git = (args: string[]): Promise<unknown> =>
    exec('git', ['-c', 'user.name=Hive', '-c', 'user.email=hive@localhost', '-c', 'commit.gpgsign=false', ...args], {
      cwd: dir,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  await git(['init', '-q', '-b', 'main']);
  await git(['add', '-A']);
  await git(['commit', '-q', '-m', 'seed: Hive context repo']);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: yarn seed <dir>');
    process.exit(1);
  }
  seed(target).then(
    () => console.log(`seeded ${resolve(target)}`),
    (e: Error) => {
      console.error(e.message);
      process.exit(1);
    },
  );
}
