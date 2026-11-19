import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { Developer } from './auth.ts';
import { checkPath, ContextError, resolveForWrite } from './context.ts';

const exec = promisify(execFile);
const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

export type WriteResult = { path: string; version: string | null; commit: string | null };
export type HistoryEntry = { commit: string; author: { name: string; email: string }; date: string; message: string };
export type RevertResult = { reverted: string; commit: string | null };
export type TicketResult = { key: string; path: string; version: string; commit: string | null };
export type RepoOptions = { pullTtlMs?: number };
export type Repo = {
  refresh(): Promise<void>;
  write(path: string, content: string, message: string, author: Developer, base?: string): Promise<WriteResult>;
  delete(path: string, message: string, author: Developer): Promise<WriteResult>;
  history(path?: string, limit?: number): Promise<HistoryEntry[]>;
  revert(commit: string, author: Developer): Promise<RevertResult>;
  newTicket(key: string, title: string, author: Developer): Promise<TicketResult>;
};

const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_LITERAL_PATHSPECS: '1',
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes -o ConnectTimeout=10',
});

export async function checkOrigin(root: string): Promise<string | null> {
  try {
    await exec('git', ['remote', 'get-url', 'origin'], { cwd: root, env: gitEnv() });
  } catch {
    return null;
  }
  try {
    await exec('git', ['ls-remote', '--heads', 'origin'], { cwd: root, env: gitEnv() });
    return null;
  } catch {
    return "cannot reach the context repo's origin; check the remote URL and your SSH key";
  }
}

const code = (e: unknown): string | number | undefined => (e as { code?: string | number }).code;

export function createRepo(root: string, opts: RepoOptions = {}): Repo {
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
        { cwd: root, env: gitEnv() },
      )
    ).stdout;

  let lastPull = 0;
  let origin: boolean | undefined;
  const hasOrigin = async (): Promise<boolean> => {
    if (origin === undefined) {
      try {
        await git(['remote', 'get-url', 'origin']);
        origin = true;
      } catch {
        origin = false;
      }
    }
    return origin;
  };
  const branch = async (): Promise<string> => (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const pull = async (): Promise<void> => {
    try {
      await git(['pull', '-q', '--rebase', 'origin', await branch()]);
    } catch {
      try {
        await git(['rebase', '--abort']);
      } catch {
        throw new ContextError("can't reach origin; nothing written");
      }
      throw new ContextError('context repo diverged from origin; resolve it by hand in the context repo');
    }
    lastPull = Date.now();
  };
  const push = async (): Promise<boolean> => {
    try {
      await git(['push', '-q', 'origin', await branch()]);
      return true;
    } catch (e) {
      if (/rejected|non-fast-forward|fetch first/i.test((e as { stderr?: string }).stderr ?? '')) return false;
      throw new ContextError("can't reach origin; nothing written");
    }
  };
  const ahead = async (): Promise<boolean> =>
    Number((await git(['rev-list', '--count', `origin/${await branch()}..HEAD`])).trim()) > 0;
  const mutate = <T extends { commit: string | null }>(op: () => Promise<T>): Promise<T> =>
    locked(async () => {
      await commitManualEdits();
      if (!(await hasOrigin())) return op();
      await pull();
      for (let i = 0; i < 3; i++) {
        const r = await op();
        if (!(await ahead())) return r;
        try {
          if (await push()) return r;
        } catch (e) {
          if (r.commit) await git(['reset', '-q', '--hard', 'HEAD~1']);
          throw e;
        }
        if (r.commit) await git(['reset', '-q', '--hard', 'HEAD~1']);
        await pull();
      }
      throw new ContextError('origin is busy; try again');
    });

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

  const writeUnlocked = async (
    path: string,
    content: string,
    message: string,
    author: Developer,
    base?: string,
  ): Promise<WriteResult> => {
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
  };

  return {
    refresh: () =>
      locked(async () => {
        if (!(await hasOrigin()) || Date.now() - lastPull < (opts.pullTtlMs ?? 30_000)) return;
        await commitManualEdits();
        try {
          await pull();
        } catch (e) {
          console.warn(`hive: pull failed: ${(e as Error).message}`);
          lastPull = Date.now();
        }
      }),
    async write(path, content, message, author, base) {
      requireMessage(message);
      return mutate(async () => {
        return writeUnlocked(path, content, message, author, base);
      });
    },
    async newTicket(key, title, author) {
      if (!/^[A-Z][A-Z0-9]*$/.test(key)) throw new ContextError('ticket key must be uppercase letters/digits');
      const t = title.trim();
      if (!t || /[\r\n]/.test(title) || t.length > 200) {
        throw new ContextError('title must be one non-empty line of at most 200 characters');
      }
      return mutate(async () => {
        const re = new RegExp(`^${key}-(\\d{3,})\\.md$`);
        const names = new Set<string>();
        try {
          for (const n of await readdir(join(root, 'tickets'))) names.add(n);
        } catch (e) {
          if (code(e) !== 'ENOENT') throw e;
        }
        const added = await git(['log', '--format=', '--name-only', '--diff-filter=A', '--', 'tickets/']);
        for (const line of added.split('\n')) if (line) names.add(basename(line));
        const max = Math.max(
          0,
          ...[...names].map((n) => re.exec(n)?.[1]).filter(Boolean).map(Number),
        );
        const k = `${key}-${String(max + 1).padStart(3, '0')}`;
        const content = `---\ntitle: ${JSON.stringify(t)}\nstatus: todo\nassignee: ""\nlinks: []\n---\n\n# ${k}: ${t}\n`;
        const r = await writeUnlocked(`tickets/${k}.md`, content, `${k}: new ticket`, author);
        return { key: k, path: r.path, version: r.version as string, commit: r.commit };
      });
    },
    async delete(path, message, author) {
      requireMessage(message);
      return mutate(async () => {
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
      return mutate(async () => {
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
