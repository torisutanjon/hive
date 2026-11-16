import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import type { Developer } from './auth.ts';
import { ContextError, resolveForWrite } from './context.ts';

const exec = promisify(execFile);
const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

export type WriteResult = { path: string; version: string | null; commit: string | null };
export type Repo = {
  write(path: string, content: string, message: string, author: Developer, base?: string): Promise<WriteResult>;
  delete(path: string, message: string, author: Developer): Promise<WriteResult>;
};

const code = (e: unknown): string | number | undefined => (e as { code?: string | number }).code;

export function createRepo(root: string): Repo {
  let tail: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn, fn);
    tail = next.catch(() => undefined);
    return next;
  };

  const git = async (args: string[]): Promise<string> =>
    (
      await exec(
        'git',
        ['-c', 'user.name=Hive', '-c', 'user.email=hive@localhost', '-c', 'commit.gpgsign=false', ...args],
        { cwd: root, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      )
    ).stdout;

  const commitManualEdits = async (): Promise<void> => {
    if ((await git(['status', '--porcelain'])).trim()) {
      await git(['add', '-A']);
      await git(['commit', '-q', '-m', 'manual edits', '--author', 'Hive <hive@localhost>']);
    }
  };

  const commitStaged = async (message: string, author: Developer): Promise<string | null> => {
    try {
      await git(['diff', '--cached', '--quiet']);
      return null;
    } catch (e) {
      if (code(e) !== 1) throw e;
    }
    await git(['commit', '-q', '-m', message, '--author', `${author.name} <${author.email}>`]);
    return (await git(['rev-parse', 'HEAD'])).trim();
  };

  const requireMessage = (m: string): void => {
    if (!m.trim()) throw new ContextError('message must not be empty');
  };

  // Returns the file's version, or null if it does not exist.
  const currentVersion = async (abs: string): Promise<string | null> => {
    try {
      return sha256(await readFile(abs));
    } catch (e) {
      if (code(e) === 'EISDIR') throw new ContextError('not a file');
      if (code(e) === 'ENOENT') return null;
      throw e;
    }
  };

  return {
    async write(path, content, message, author, base) {
      requireMessage(message);
      return locked(async () => {
        await commitManualEdits();
        const { abs, rel } = await resolveForWrite(root, path);
        const current = await currentVersion(abs);
        if (base === undefined && current !== null) {
          throw new ContextError('file exists; pass base (its current version) to overwrite');
        }
        if (base !== undefined && current === null) throw new ContextError('not found');
        if (base !== undefined && base !== current) {
          throw new ContextError(`file changed since base; current version ${current}`);
        }
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content);
        await git(['add', '--', rel]);
        const commit = await commitStaged(message, author);
        return { path: rel, version: sha256(content), commit };
      });
    },
    async delete(path, message, author) {
      requireMessage(message);
      return locked(async () => {
        await commitManualEdits();
        const { abs, rel } = await resolveForWrite(root, path);
        if ((await currentVersion(abs)) === null) throw new ContextError('not found');
        await git(['rm', '-q', '--', rel]);
        return { path: rel, version: null, commit: await commitStaged(message, author) };
      });
    },
  };
}
