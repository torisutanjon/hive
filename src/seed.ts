import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const SEED_DIR = fileURLToPath(new URL('../seed', import.meta.url));
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' };
const GIT_INHERITED = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX'];

export type SeedEntry = { path: string; status: 'added' | 'skipped' };
type Git = (args: string[]) => Promise<string>;

const code = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code;

async function seedFiles(): Promise<string[]> {
  const all = await readdir(SEED_DIR, { recursive: true, withFileTypes: true });
  return all
    .filter((d) => d.isFile())
    .map((d) => relative(SEED_DIR, join(d.parentPath, d.name)).replaceAll('\\', '/'))
    .sort();
}

// Copy one seed file into dir unless anything is in the way. Never overwrite, never follow a symlink.
async function place(dir: string, rel: string, skip: (rel: string) => boolean): Promise<SeedEntry['status']> {
  if (skip(rel)) return 'skipped';
  const segs = rel.split('/');
  for (let i = 1; i < segs.length; i++) {
    try {
      const st = await lstat(join(dir, ...segs.slice(0, i)));
      if (st.isSymbolicLink() || !st.isDirectory()) return 'skipped';
    } catch (e) {
      if (code(e) === 'ENOENT') break;
      throw e;
    }
  }
  const dst = join(dir, ...segs);
  try {
    await lstat(dst);
    return 'skipped';
  } catch (e) {
    if (code(e) !== 'ENOENT') throw e;
  }
  await mkdir(dirname(dst), { recursive: true });
  try {
    await copyFile(join(SEED_DIR, ...segs), dst, constants.COPYFILE_EXCL);
  } catch (e) {
    if (code(e) === 'EEXIST') return 'skipped';
    throw e;
  }
  return 'added';
}

// True when dir is itself the root of a git repo (a parent repo does not count).
async function isRepoRoot(dir: string, git: Git): Promise<boolean> {
  try {
    const top = (await git(['rev-parse', '--show-toplevel'])).trim();
    if ((await realpath(top)).toLowerCase() !== (await realpath(dir)).toLowerCase()) return false;
    const [a, b] = [await stat(top), await stat(dir)];
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

export async function seed(target: string): Promise<SeedEntry[]> {
  const dir = resolve(target);
  await mkdir(dir, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, ...GIT_ENV };
  for (const k of GIT_INHERITED) Reflect.deleteProperty(env, k);
  const git: Git = async (args) =>
    (await exec('git', ['-c', 'user.name=Hive', '-c', 'user.email=hive@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, env })).stdout;
  const root = await isRepoRoot(dir, git);
  const known = new Set<string>();
  if (root) {
    for (const args of [['ls-files', '-z', '--cached'], ['diff', '--cached', '--no-renames', '--name-only', '-z']])
      for (const p of (await git(args)).split('\0')) if (p) known.add(p.toLowerCase());
  }
  const skip = (rel: string): boolean => known.has(rel.toLowerCase());
  const entries: SeedEntry[] = [];
  for (const path of await seedFiles()) entries.push({ path, status: await place(dir, path, skip) });
  const added = entries.filter((e) => e.status === 'added').map((e) => e.path);
  if (!added.length) return entries;
  if (!root) await git(['init', '-q', '-b', 'main']);
  try {
    await git(['add', '-f', '--', ...added]);
    await git(['commit', '-q', '-m', 'seed: Hive context repo', '--', ...added]);
  } catch (e) {
    await git(['rm', '-q', '--cached', '--ignore-unmatch', '--', ...added]).catch(() => undefined);
    for (const p of added) await rm(join(dir, p), { force: true });
    throw e;
  }
  return entries;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: yarn seed <dir>');
    process.exit(1);
  }
  seed(target).then(
    (entries) => {
      for (const e of entries) console.log(`${e.status} ${e.path}`);
      console.log(`seeded ${resolve(target)}`);
    },
    (e: Error) => {
      console.error(e.message);
      process.exit(1);
    },
  );
}
