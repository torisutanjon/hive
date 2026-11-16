import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import type { Developer } from './auth.ts';
import { checkPath, ContextError, resolveForWrite } from './context.ts';

const exec = promisify(execFile);
const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

export type WriteResult = { path: string; version: string | null; commit: string | null };
export type HistoryEntry = { commit: string; author: { name: string; email: string }; date: string; message: string };
export type RevertResult = { reverted: string; commit: string | null };
export type Repo = {
  write(path: string, content: string, message: string, author: Developer, base?: string): Promise<WriteResult>;
  delete(path: string, message: string, author: Developer): Promise<WriteResult>;
  history(path?: string, limit?: number): Promise<HistoryEntry[]>;
  revert(commit: string, author: Developer): Promise<RevertResult>;
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
        { cwd: root, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' } },
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
    async history(path, limit) {
      const rel = path ? checkPath(root, path) : '';
      const n = Math.min(Math.max(Math.trunc(limit ?? 50), 1), 200);
      const out = await git([
        'log',
        `-n${n}`,
        '--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e',
        ...(rel ? ['--', rel] : []),
      ]);
      return out
        .split('\x1e')
        .map((r) => r.trim())
        .filter(Boolean)
        .map((r) => {
          const [commit = '', name = '', email = '', date = '', message = ''] = r.split('\x1f');
          return { commit, author: { name, email }, date, message };
        });
    },
    async revert(commit, author) {
      if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new ContextError('commit must be a hex commit id');
      return locked(async () => {
        await commitManualEdits();
        let sha: string;
        try {
          sha = (await git(['rev-parse', '--verify', '--quiet', `${commit}^{commit}`])).trim();
        } catch {
          throw new ContextError('unknown commit');
        }
        if (!sha) throw new ContextError('unknown commit');
        const subject = (await git(['log', '-1', '--format=%s', sha])).trim();
        try {
          await git(['revert', '--no-commit', sha]);
        } catch {
          await git(['revert', '--abort']).catch(() => undefined);
          throw new ContextError(`revert of ${sha.slice(0, 7)} conflicts with later changes; edit the file instead`);
        }
        const made = await commitStaged(`Revert "${subject}"\n\nThis reverts commit ${sha}.`, author);
        if (made === null) await git(['revert', '--quit']).catch(() => undefined);
        return { reverted: sha, commit: made };
      });
    },
  };
}
