import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { readTicketKey } from './config.ts';
import { seed } from './seed.ts';

const exec = promisify(execFile);

export type Context = { url: string; dir: string; token: string; port: number; name: string; email: string };
export type HiveConfig = { contexts: Record<string, Context>; projects: Record<string, string> };
export type Io = { home: string; cwd: string; env: NodeJS.ProcessEnv; ask: (q: string) => Promise<string>; log: (line: string) => void };

const gitEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ ...env, GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' });
const git = async (args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> =>
  (await exec('git', args, { cwd, env: gitEnv(env) })).stdout.trim();

const SSH_ONLY = 'context repo must be an SSH URL like git@github.com:owner/repo.git';
const PART = /^[A-Za-z0-9._-]+$/;

export function parseSshUrl(url: string): { owner: string; repo: string } {
  const m = /^git@[A-Za-z0-9.-]+:([^/]+)\/([^/]+)$/.exec(url) ?? /^ssh:\/\/git@[A-Za-z0-9.-]+(?::\d+)?\/([^/]+)\/([^/]+)$/.exec(url);
  const [owner, repo] = [m?.[1], m?.[2]?.replace(/\.git$/, '')];
  if (!owner || !repo || ![owner, repo].every((p) => PART.test(p) && p !== '.' && p !== '..')) throw new Error(SSH_ONLY);
  return { owner, repo };
}

export function serverName(owner: string, repo: string): string {
  return `hive-${owner}-${repo.replace(/\.git$/, '')}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

export async function readHiveConfig(home: string): Promise<HiveConfig> {
  try {
    return JSON.parse(await readFile(join(home, '.hive', 'config.json'), 'utf8')) as HiveConfig;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { contexts: {}, projects: {} };
    throw e;
  }
}

export async function writeHiveConfig(home: string, cfg: HiveConfig): Promise<void> {
  const dir = join(home, '.hive');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // ponytail: no lock; concurrent installs on one machine can lose an entry — add a lock file if it happens
  const tmp = join(dir, `.config.json.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  await writeFile(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, join(dir, 'config.json'));
  await chmod(join(dir, 'config.json'), 0o600);
}

const listens = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });

export async function freePort(taken: number[]): Promise<number> {
  for (let p = 4000; p < 65536; p++) if (!taken.includes(p) && (await listens(p))) return p;
  throw new Error('no free port');
}

export async function ensureClone(url: string, dir: string, env: NodeJS.ProcessEnv): Promise<'cloned' | 'existing'> {
  if (existsSync(dir)) {
    // raw config value: `remote get-url` would apply url.*.insteadOf rewrites
    const origin = await git(['config', '--get', 'remote.origin.url'], dir, env).catch(() => '');
    if (origin !== url) throw new Error(`${dir} exists and its origin is not ${url}; move it or pick another context repo`);
    return 'existing';
  }
  await mkdir(dirname(dir), { recursive: true });
  await git(['clone', '-q', url, dir], dirname(dir), env);
  return 'cloned';
}

export async function ensureContext(dir: string, io: Io): Promise<string> {
  const born = await git(['rev-parse', '--verify', '-q', 'HEAD'], dir, io.env).then(() => true, () => false);
  let key: string;
  if (!born) {
    key = (await io.ask('Ticket key for this new context repo (e.g. HIVE): ')).trim();
    await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], dir, io.env);
    await seed(dir, { key });
  } else {
    const problems: string[] = [];
    const found = readTicketKey(dir, problems);
    if (found === undefined) throw new Error(`${problems.join('; ')}; add ticket_key to project.md`);
    key = found;
  }
  // a previous run may have seeded but failed to push
  const branch = await git(['symbolic-ref', '--short', 'HEAD'], dir, io.env);
  const pushed = await git(['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`], dir, io.env).then(() => true, () => false);
  if (!pushed) await git(['push', '-q', '-u', 'origin', branch], dir, io.env);
  return key;
}

const CLAUDE_FAILED = 'could not register';

export async function registerClaude(io: Io, root: string, name: string, url: string, token: string): Promise<string | null> {
  if (!existsSync(join(io.home, '.claude'))) return null;
  const run = (...args: string[]): Promise<{ stdout: string }> => exec('claude', ['mcp', ...args], { cwd: root, env: io.env });
  const got = await run('get', name).then((r) => r.stdout, () => null);
  if (got !== null && got.includes(url)) return 'Claude Code: already registered';
  if (got !== null) await run('remove', name).catch(() => undefined);
  try {
    await run('add', '--transport', 'http', '-s', 'local', name, url, '--header', `Authorization: Bearer ${token}`);
  } catch {
    // never echo the error: argv holds the token
    throw new Error(CLAUDE_FAILED);
  }
  return `Claude Code: registered ${name}`;
}

export function upsertCodexTable(toml: string, name: string, block: string): string {
  const lines = toml.split('\n');
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const header = new RegExp(`^\\s*\\[\\s*mcp_servers\\.(?:"${n}"|${n})\\s*\\]\\s*(?:#.*)?$`);
  const i = lines.findIndex((l) => header.test(l));
  if (i < 0) return toml === '' ? block : `${toml}${toml.endsWith('\n') ? '' : '\n'}\n${block}`;
  let j = lines.findIndex((l, k) => k > i && /^\s*\[/.test(l));
  if (j < 0) j = lines.length;
  const before = i ? `${lines.slice(0, i).join('\n')}\n` : '';
  return before + block + (j < lines.length ? `\n${lines.slice(j).join('\n')}` : '');
}

export async function registerCodex(io: Io, name: string, url: string, token: string): Promise<string | null> {
  if (!existsSync(join(io.home, '.codex'))) return null;
  const help = await exec('codex', ['mcp', 'add', '--help'], { env: io.env }).then((r) => r.stdout, () => '');
  if (!help.includes('--url')) return 'Codex: version too old for HTTP MCP — update Codex, then re-run';
  const file = join(io.home, '.codex', 'config.toml');
  const text = await readFile(file, 'utf8').catch(() => '');
  const block = `[mcp_servers.${name}]\nurl = "${url}"\nhttp_headers = { Authorization = "Bearer ${token}" }\n`;
  await writeFile(file, upsertCodexTable(text, name, block), { mode: 0o600 });
  await chmod(file, 0o600);
  return `Codex: registered ${name}`;
}

const BEGIN = '<!-- BEGIN:hive -->';
const END = '<!-- END:hive -->';

export function upsertBlock(text: string, block: string): string {
  const [b, e] = [text.indexOf(BEGIN), text.indexOf(END)];
  if (b >= 0 && e > b) return text.slice(0, b) + block + text.slice(e + END.length);
  return text === '' ? `${block}\n` : `${text}${text.endsWith('\n') ? '' : '\n'}\n${block}\n`;
}

const agentsBlock = (name: string): string => `${BEGIN}
## Hive

Shared project context (tickets, specs, decisions, sessions) lives in Hive, MCP server \`${name}\`. Start it with \`npx hive-collab-context start\`.

- Start a session: call \`hive_workflow\` with name \`start\`.
- File a ticket: \`hive_workflow\` with name \`new\` and \`{ "title": "…" }\`.
- Work a ticket: \`hive_workflow\` with name \`work\` and \`{ "key": "…" }\`.
- End a session: \`hive_workflow\` with name \`end\`.

### Tier rules
<!-- HIVE-018 -->
${END}`;

const STUB_ARGS: Record<string, string> = { new: ' and {"title": "$ARGUMENTS"}', work: ' and {"key": "$ARGUMENTS"}' };
const STUB_MARK = 'Call the `hive_workflow` tool';

// True when nothing on the way to rel (inside root) is a symlink and the target is absent or a regular file.
async function safeToWrite(root: string, rel: string): Promise<boolean> {
  const segs = rel.split('/');
  for (let i = 1; i <= segs.length; i++) {
    const st = await lstat(join(root, ...segs.slice(0, i))).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
    if (!st) return true;
    if (st.isSymbolicLink() || (i < segs.length ? !st.isDirectory() : !st.isFile())) return false;
  }
  return true;
}

export async function writeProjectFiles(root: string, name: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const out: string[] = [];
  const created: string[] = [];
  const owned: string[] = [];
  const put = async (rel: string, next: (cur: string) => string, ours?: (cur: string) => boolean): Promise<boolean> => {
    if (!(await safeToWrite(root, rel))) {
      out.push(`skipped ${rel}: symlink or not a regular file`);
      return false;
    }
    const file = join(root, rel);
    const cur = await readFile(file, 'utf8').catch(() => null);
    if (cur !== null && ours && !ours(cur)) {
      out.push(`kept ${rel}: not written by Hive`);
      return false;
    }
    if (cur === null) created.push(rel);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, next(cur ?? ''));
    return true;
  };
  const tracked = (rel: string): Promise<boolean> => git(['ls-files', '--error-unmatch', '--', rel], root, env).then(() => true, () => false);
  const agents = await put('AGENTS.md', (cur) => upsertBlock(cur, agentsBlock(name)));
  await put('CLAUDE.md', (cur) => (/^@AGENTS\.md[ \t]*$/m.test(cur) ? cur : `${cur}${cur === '' || cur.endsWith('\n') ? '' : '\n'}@AGENTS.md\n`));
  for (const w of ['start', 'new', 'work', 'end']) {
    const rel = `.claude/commands/hive-${w}.md`;
    const text = `${STUB_MARK} of the \`${name}\` MCP server with name \`${w}\`${STUB_ARGS[w] ?? ''}, then follow the returned instructions.\n`;
    if (await put(rel, () => text, (cur) => cur.startsWith(STUB_MARK))) owned.push(rel);
  }
  const untracked: string[] = [];
  for (const rel of new Set([...created, ...owned])) if (!(await tracked(rel))) untracked.push(rel);
  if (untracked.length) {
    const file = resolve(root, await git(['rev-parse', '--git-path', 'info/exclude'], root, env));
    const cur = await readFile(file, 'utf8').catch(() => '');
    const have = new Set(cur.split('\n'));
    const add = untracked.map((r) => `/${r}`).filter((l) => !have.has(l));
    if (add.length) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, `${cur}${cur === '' || cur.endsWith('\n') ? '' : '\n'}${add.join('\n')}\n`);
    }
  }
  if (agents && !created.includes('AGENTS.md') && (await tracked('AGENTS.md'))) out.push('AGENTS.md is tracked: added the Hive block');
  return out;
}

export async function projectRoot(cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    return await git(['rev-parse', '--show-toplevel'], cwd, env);
  } catch {
    throw new Error('not a git repository: run this at the root of your project');
  }
}

export async function install(url: string, io: Io): Promise<void> {
  const root = await projectRoot(io.cwd, io.env);
  const { owner, repo } = parseSshUrl(url);
  const [id, dir, name] = [`${owner}/${repo}`, join(io.home, '.hive', owner, repo), serverName(owner, repo)];
  await ensureClone(url, dir, io.env);
  await ensureContext(dir, io);

  const cfg = await readHiveConfig(io.home);
  let ctx = Object.hasOwn(cfg.contexts, id) ? cfg.contexts[id] : undefined;
  if (!ctx) {
    const conf = (k: string): Promise<string> => git(['config', k], root, io.env).catch(() => '');
    const [n, e] = [await conf('user.name'), await conf('user.email')];
    ctx = {
      url,
      dir,
      token: randomBytes(32).toString('hex'),
      port: await freePort(Object.values(cfg.contexts).map((c) => c.port)),
      name: n || (await io.ask('Your name for Hive commits: ')).trim(),
      email: e || (await io.ask('Your email for Hive commits: ')).trim(),
    };
  }
  cfg.contexts[id] = ctx;
  cfg.projects[root] = id;
  await writeHiveConfig(io.home, cfg);

  const mcp = `http://127.0.0.1:${ctx.port}/mcp`;
  let failed = false;
  const attempt = async (agent: string, register: () => Promise<string | null>): Promise<void> => {
    try {
      const line = await register();
      if (line) io.log(line);
    } catch (e) {
      failed = true;
      io.log(`${agent}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  await attempt('Claude Code', () => registerClaude(io, root, name, mcp, ctx.token));
  await attempt('Codex', () => registerCodex(io, name, mcp, ctx.token));
  io.log(`Other MCP clients: ${mcp} with header Authorization: Bearer <token from ~/.hive/config.json>`);
  for (const line of await writeProjectFiles(root, name, io.env)) io.log(line);
  io.log('Start Hive: npx hive-collab-context start');
  if (failed) throw new Error('some agents need repair: see above');
}

export function startEnv(cfg: HiveConfig, root: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const id = Object.hasOwn(cfg.projects, root) ? cfg.projects[root] : undefined;
  const ctx = id !== undefined && Object.hasOwn(cfg.contexts, id) ? cfg.contexts[id] : undefined;
  if (!ctx) throw new Error('not set up here: run npx hive-collab-context <ssh-url> first');
  return {
    ...env,
    HIVE_CONTEXT_DIR: env.HIVE_CONTEXT_DIR ?? ctx.dir,
    HIVE_TOKENS: env.HIVE_TOKENS ?? JSON.stringify({ [ctx.token]: { name: ctx.name, email: ctx.email } }),
    PORT: env.PORT ?? String(ctx.port),
  };
}
