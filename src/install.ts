import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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

export function serverName(repo: string): string {
  return `hive-${repo.replace(/\.git$/, '').toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
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
  const tmp = join(dir, '.config.json.tmp');
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
  if (!born) {
    const key = (await io.ask('Ticket key for this new context repo (e.g. HIVE): ')).trim();
    await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], dir, io.env);
    await seed(dir, { key });
    await git(['push', '-q', '-u', 'origin', 'main'], dir, io.env);
    return key;
  }
  const problems: string[] = [];
  const key = readTicketKey(dir, problems);
  if (key === undefined) throw new Error(`${problems.join('; ')}; add ticket_key to project.md`);
  return key;
}

const CLAUDE_FAILED = 'Claude Code: could not register';

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
  const i = lines.findIndex((l) => l.trimEnd() === `[mcp_servers.${name}]`);
  if (i < 0) return toml === '' ? block : `${toml}${toml.endsWith('\n') ? '' : '\n'}\n${block}`;
  let j = lines.findIndex((l, k) => k > i && l.startsWith('['));
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

export async function writeProjectFiles(root: string, name: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const out: string[] = [];
  const created: string[] = [];
  const put = async (rel: string, next: (cur: string) => string): Promise<void> => {
    const file = join(root, rel);
    const cur = await readFile(file, 'utf8').catch(() => null);
    if (cur === null) created.push(rel);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, next(cur ?? ''));
  };
  await put('AGENTS.md', (cur) => upsertBlock(cur, agentsBlock(name)));
  await put('CLAUDE.md', (cur) => (/^@AGENTS\.md[ \t]*$/m.test(cur) ? cur : `${cur}${cur === '' || cur.endsWith('\n') ? '' : '\n'}@AGENTS.md\n`));
  for (const w of ['start', 'new', 'work', 'end']) {
    await put(`.claude/commands/hive-${w}.md`, () => `Call the \`hive_workflow\` tool of the \`${name}\` MCP server with name \`${w}\`${STUB_ARGS[w] ?? ''}, then follow the returned instructions.\n`);
  }
  const untracked: string[] = [];
  for (const rel of created) if (!(await git(['ls-files', '--error-unmatch', '--', rel], root, env).then(() => true, () => false))) untracked.push(rel);
  if (untracked.length) {
    // ponytail: only files created this run are excluded; a crash before this point leaves them unexcluded until deleted and re-run
    const file = resolve(root, await git(['rev-parse', '--git-path', 'info/exclude'], root, env));
    const cur = await readFile(file, 'utf8').catch(() => '');
    const have = new Set(cur.split('\n'));
    const add = untracked.map((r) => `/${r}`).filter((l) => !have.has(l));
    if (add.length) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, `${cur}${cur === '' || cur.endsWith('\n') ? '' : '\n'}${add.join('\n')}\n`);
    }
  }
  if (!created.includes('AGENTS.md') && (await git(['ls-files', '--error-unmatch', '--', 'AGENTS.md'], root, env).then(() => true, () => false))) {
    out.push('AGENTS.md is tracked: added the Hive block');
  }
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
  const [id, dir, name] = [`${owner}/${repo}`, join(io.home, '.hive', owner, repo), serverName(repo)];
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
  for (const line of [await registerClaude(io, root, name, mcp, ctx.token), await registerCodex(io, name, mcp, ctx.token)]) {
    if (line) io.log(line);
  }
  io.log(`Other MCP clients: ${mcp} with header Authorization: Bearer <token from ~/.hive/config.json>`);
  for (const line of await writeProjectFiles(root, name, io.env)) io.log(line);
  io.log('Start Hive: npx hive-collab-context start');
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
