import { execFileSync } from 'node:child_process';
import { chmodSync, readdirSync, symlinkSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { PROVIDERS } from '../src/tiers.ts';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ensureClone, ensureContext, freePort, install, parseSshUrl, readHiveConfig, registerClaude, registerCodex, serverName, startEnv, upsertBlock, upsertCodexTable, writeHiveConfig, writeProjectFiles, type Io } from '../src/install.ts';

const URL_ = 'git@github.com:acme/ctx.git';
let root: string;
let home: string;
let project: string;
let remote: string;
let fakeBin: string;
let asked: string[];
let lines: string[];

const run = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const envFor = (map: Array<[string, string]>): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PATH: `${fakeBin}:${process.env.PATH}`, GIT_CONFIG_COUNT: String(map.length) };
  map.forEach(([u, r], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = `url.${r}.insteadOf`;
    env[`GIT_CONFIG_VALUE_${i}`] = u;
  });
  return env;
};
const bare = (name: string): string => {
  const p = join(root, name);
  run(root, 'init', '-q', '--bare', '-b', 'main', p);
  return p;
};
const mkIo = (env: NodeJS.ProcessEnv, answer = 'ACME'): Io => ({
  home,
  cwd: project,
  env,
  ask: (q) => {
    asked.push(q);
    return Promise.resolve(answer);
  },
  log: (l) => lines.push(l),
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hive-install-'));
  [home, project, fakeBin] = ['home', 'project', 'bin'].map((d) => join(root, d)) as [string, string, string];
  [home, project, fakeBin].forEach((d) => mkdirSync(d));
  run(project, 'init', '-q', '-b', 'main');
  run(project, 'config', 'user.name', 'Ada');
  run(project, 'config', 'user.email', 'ada@example.com');
  run(project, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(project, 'a.txt'), 'a');
  run(project, 'add', '.');
  run(project, 'commit', '-qm', 'init');
  remote = bare('remote.git');
  asked = [];
  lines = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('url, config file, port', () => {
  test('parseSshUrl accepts both SSH forms', () => {
    expect(parseSshUrl('git@github.com:acme/ctx.git')).toEqual({ owner: 'acme', repo: 'ctx' });
    expect(parseSshUrl('ssh://git@github.com/acme/ctx')).toEqual({ owner: 'acme', repo: 'ctx' });
  });

  test.each(['https://github.com/o/r.git', 'git@h:../r', 'git@h:o/r;x', 'git@h:./r', 'file:///x/y'])('parseSshUrl rejects %s', (u) => {
    expect(() => parseSshUrl(u)).toThrow(/context repo must be an SSH URL like git@github.com:owner\/repo.git/);
  });

  test('serverName', () => {
    expect(serverName('Acme', 'Hive.Context-Sample.git')).toBe('hive-acme-hive-context-sample');
  });

  test('writeHiveConfig is 0700 dir, 0600 file, and round-trips', async () => {
    expect(await readHiveConfig(root)).toEqual({ contexts: {}, projects: {} });
    const cfg = { contexts: {}, projects: { '/p': 'a/b' } };
    await writeHiveConfig(root, cfg);
    expect(statSync(join(root, '.hive')).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, '.hive/config.json')).mode & 0o777).toBe(0o600);
    expect(await readHiveConfig(root)).toEqual(cfg);
  });

  test('freePort skips taken and busy ports', async () => {
    const p = await freePort([]);
    expect(p).toBeGreaterThanOrEqual(4000);
    expect(await freePort([p])).toBeGreaterThan(p);
    const s = createServer();
    await new Promise<void>((r) => s.listen(p, '127.0.0.1', r));
    try {
      expect(await freePort([])).not.toBe(p);
    } finally {
      s.close();
    }
  });
});

describe('clone, seed, push', () => {
  const dir = (): string => join(home, '.hive/acme/ctx');

  test('empty remote: asks the key once, seeds and pushes', async () => {
    const io = mkIo(envFor([[URL_, remote]]));
    expect(await ensureClone(URL_, dir(), io.env)).toBe('cloned');
    expect(await ensureContext(dir(), io)).toBe('ACME');
    expect(asked).toHaveLength(1);
    expect(run(root, '--git-dir', remote, 'show', 'main:project.md')).toContain('ticket_key: "ACME"');
  });

  test('non-empty remote: reads the key, asks nothing', async () => {
    const io = mkIo(envFor([[URL_, remote]]), 'OPS');
    await ensureClone(URL_, dir(), io.env);
    await ensureContext(dir(), io);
    asked = [];
    const other = join(root, 'again');
    const key = await (async (): Promise<string> => {
      await ensureClone(URL_, other, io.env);
      return ensureContext(other, io);
    })();
    expect(key).toBe('OPS');
    expect(asked).toEqual([]);
    expect(await ensureClone(URL_, other, io.env)).toBe('existing');
  });

  test('existing folder with another origin is refused and untouched', async () => {
    mkdirSync(dir(), { recursive: true });
    run(dir(), 'init', '-q', '-b', 'main');
    run(dir(), 'remote', 'add', 'origin', 'git@github.com:evil/ctx.git');
    const before = readFileSync(join(dir(), '.git/config'), 'utf8');
    await expect(ensureClone(URL_, dir(), envFor([[URL_, remote]]))).rejects.toThrow(/origin/);
    expect(readFileSync(join(dir(), '.git/config'), 'utf8')).toBe(before);
    mkdirSync(join(root, 'plain'));
    await expect(ensureClone(URL_, join(root, 'plain'), envFor([[URL_, remote]]))).rejects.toThrow();
  });

  test('non-empty remote without ticket_key throws', async () => {
    const env = envFor([[URL_, remote]]);
    const w = join(root, 'w');
    run(root, 'clone', '-q', remote, w);
    writeFileSync(join(w, 'project.md'), '---\ntitle: x\n---\n');
    run(w, 'add', '.');
    run(w, '-c', 'user.name=T', '-c', 'user.email=t@x', 'commit', '-qm', 'p');
    run(w, 'push', '-q', 'origin', 'HEAD:main');
    await ensureClone(URL_, dir(), env);
    await expect(ensureContext(dir(), mkIo(env))).rejects.toThrow(/ticket_key/);
    expect(asked).toEqual([]);
    expect(existsSync(join(dir(), 'project.md'))).toBe(true);
  });
});

const TOKEN = 'a'.repeat(64);
const MCP = 'http://127.0.0.1:4000/mcp';
const BLOCK = `[mcp_servers.hive-ctx]\nurl = "${MCP}"\nhttp_headers = { Authorization = "Bearer ${TOKEN}" }\n`;

function fakes(codexHelp = '  --url <URL>'): { log: () => string; state: string } {
  const [log, state] = [join(root, 'calls.log'), join(root, 'claude.state')];
  const script = (body: string): string => `#!/bin/sh\nprintf '%s %s\\n' "$(basename "$0")" "$*" >> '${log}'\n${body}\n`;
  writeFileSync(
    join(fakeBin, 'claude'),
    script(`case "$1 $2" in\n"mcp get") [ -f '${state}' ] && { cat '${state}'; exit 0; }; exit 1;;\n"mcp add") printf '%s\\n' "$*" > '${state}';;\n"mcp remove") rm -f '${state}';;\nesac`),
  );
  writeFileSync(join(fakeBin, 'codex'), script(`[ "$1 $2 $3" = "mcp add --help" ] && echo '${codexHelp}'; exit 0`));
  chmodSync(join(fakeBin, 'claude'), 0o755);
  chmodSync(join(fakeBin, 'codex'), 0o755);
  return { log: () => (existsSync(log) ? readFileSync(log, 'utf8') : ''), state };
}

describe('agents', () => {
  test('upsertCodexTable replaces only our table, appends when absent, is idempotent', () => {
    const other = '[mcp_servers.playwright]\ncommand = "npx"\n';
    const tail = '\n[other]\nx = 1\n';
    const old = `${other}\n[mcp_servers.hive-ctx]\nurl = "old"\n${tail}`;
    const out = upsertCodexTable(old, 'hive-ctx', BLOCK);
    expect(out).toBe(`${other}\n${BLOCK}${tail}`);
    expect(upsertCodexTable(out, 'hive-ctx', BLOCK)).toBe(out);
    expect(upsertCodexTable(other, 'hive-ctx', BLOCK)).toBe(`${other}\n${BLOCK}`);
    expect(upsertCodexTable('', 'hive-ctx', BLOCK)).toBe(BLOCK);
    expect(upsertCodexTable(`${old.trimEnd()}`, 'hive-ctx', BLOCK).startsWith(other)).toBe(true);
  });

  test('upsertCodexTable tolerates comments, quoted keys and indented neighbours', () => {
    const other = '[mcp_servers.playwright]\ncommand = "npx"\n';
    const a = upsertCodexTable(`${other}\n[mcp_servers.hive-ctx] # mine\nurl = "old"\n`, 'hive-ctx', BLOCK);
    expect(a).toBe(`${other}\n${BLOCK}`);
    const b = upsertCodexTable(`${other}\n[ mcp_servers."hive-ctx" ]\nurl = "old"\n\n  [other]\nx = 1\n`, 'hive-ctx', BLOCK);
    expect(b.match(/hive-ctx/g)).toHaveLength(1);
    expect(b).toBe(`${other}\n${BLOCK}\n  [other]\nx = 1\n`);
  });

  test('no agent dirs: nothing is called', async () => {
    const f = fakes();
    const io = mkIo(envFor([]));
    expect(await registerClaude(io, project, 'hive-ctx', MCP, TOKEN)).toBeNull();
    expect(await registerCodex(io, 'hive-ctx', MCP, TOKEN)).toBeNull();
    expect(f.log()).toBe('');
  });

  test('Claude: add with header and -s local, then already registered, then repair a wrong url', async () => {
    const f = fakes();
    mkdirSync(join(home, '.claude'));
    const io = mkIo(envFor([]));
    expect(await registerClaude(io, project, 'hive-ctx', MCP, TOKEN)).toBe('Claude Code: registered hive-ctx');
    expect(f.log()).toContain(`claude mcp add --transport http -s local hive-ctx ${MCP} --header Authorization: Bearer ${TOKEN}`);
    expect(await registerClaude(io, project, 'hive-ctx', MCP, TOKEN)).toBe('Claude Code: already registered');
    const moved = 'http://127.0.0.1:4001/mcp';
    expect(await registerClaude(io, project, 'hive-ctx', moved, TOKEN)).toBe('Claude Code: registered hive-ctx');
    expect(f.log()).toContain('claude mcp remove');
    expect(readFileSync(f.state, 'utf8')).toContain(moved);
    expect(readFileSync(join(root, 'calls.log'), 'utf8')).not.toContain('codex');
  });

  test('Codex: keeps other tables, exactly one hive table, mode kept', async () => {
    const f = fakes();
    mkdirSync(join(home, '.codex'));
    const cfg = join(home, '.codex/config.toml');
    const other = 'model = "x"\n\n[mcp_servers.playwright]\ncommand = "npx"\nargs = ["a"]\n';
    writeFileSync(cfg, other, { mode: 0o644 });
    chmodSync(cfg, 0o644);
    const io = mkIo(envFor([]));
    expect(await registerCodex(io, 'hive-ctx', MCP, TOKEN)).toBe('Codex: registered hive-ctx');
    await registerCodex(io, 'hive-ctx', MCP, TOKEN);
    const text = readFileSync(cfg, 'utf8');
    expect(text.startsWith(other)).toBe(true);
    expect(text.match(/\[mcp_servers\.hive-ctx\]/g)).toHaveLength(1);
    expect(text).toContain(BLOCK);
    expect(statSync(cfg).mode & 0o777).toBe(0o600);
    expect(f.log()).not.toContain('claude');
  });

  test('old Codex: message, config untouched, token never logged', async () => {
    fakes('');
    mkdirSync(join(home, '.codex'));
    const cfg = join(home, '.codex/config.toml');
    writeFileSync(cfg, 'a = 1\n');
    const io = mkIo(envFor([]));
    expect(await registerCodex(io, 'hive-ctx', MCP, TOKEN)).toBe('Codex: version too old for HTTP MCP — update Codex, then re-run');
    expect(readFileSync(cfg, 'utf8')).toBe('a = 1\n');
    expect(lines.join('\n')).not.toContain(TOKEN);
  });
});

describe('project files', () => {
  const FILES = ['AGENTS.md', 'CLAUDE.md', ...['start', 'new', 'work', 'end'].map((w) => `.claude/commands/hive-${w}.md`)];
  const exclude = (): string[] => readFileSync(join(project, '.git/info/exclude'), 'utf8').split('\n');
  const read = (f: string): string => readFileSync(join(project, f), 'utf8');

  test('upsertBlock replaces in place or appends', () => {
    const b = '<!-- BEGIN:hive -->\nx\n<!-- END:hive -->';
    expect(upsertBlock('', b)).toBe(`${b}\n`);
    expect(upsertBlock('mine\n', b)).toBe(`mine\n\n${b}\n`);
    expect(upsertBlock(`a\n${b}\nz\n`, '<!-- BEGIN:hive -->\ny\n<!-- END:hive -->')).toBe('a\n<!-- BEGIN:hive -->\ny\n<!-- END:hive -->\nz\n');
  });

  test('fresh project: six files, all excluded, .gitignore untouched, no workflow text', async () => {
    await writeProjectFiles(project, 'hive-ctx', envFor([]));
    await writeProjectFiles(project, 'hive-ctx', envFor([]));
    for (const f of FILES) expect(existsSync(join(project, f)), f).toBe(true);
    for (const f of FILES) expect(exclude().filter((l) => l === `/${f}`), f).toHaveLength(1);
    expect(existsSync(join(project, '.gitignore'))).toBe(false);
    expect(read('AGENTS.md')).not.toContain('MOVE THESE IN JIRA');
    expect(read('AGENTS.md').match(/BEGIN:hive/g)).toHaveLength(1);
    expect(read('AGENTS.md')).toContain('hive-ctx');
    expect(read('AGENTS.md')).not.toMatch(/127\.0\.0\.1|:4000/);
    expect(read('CLAUDE.md')).toBe('@AGENTS.md\n');
    expect(read('.claude/commands/hive-new.md')).toBe('Call the `hive_workflow` tool of the `hive-ctx` MCP server with name `new` and {"title": "$ARGUMENTS"}, then follow the returned instructions.\n');
    expect(read('.claude/commands/hive-end.md')).toBe('Call the `hive_workflow` tool of the `hive-ctx` MCP server with name `end`, then follow the returned instructions.\n');
    expect(run(project, 'status', '--porcelain')).toBe('');
  });

  test('tracked AGENTS.md keeps its text, gets one block, is not excluded', async () => {
    writeFileSync(join(project, 'AGENTS.md'), 'my rules\n');
    run(project, 'add', 'AGENTS.md');
    run(project, 'commit', '-qm', 'agents');
    const out = await writeProjectFiles(project, 'hive-ctx', envFor([]));
    await writeProjectFiles(project, 'hive-ctx', envFor([]));
    expect(out).toContain('AGENTS.md is tracked: added the Hive block');
    expect(read('AGENTS.md').startsWith('my rules\n')).toBe(true);
    expect(read('AGENTS.md').match(/BEGIN:hive/g)).toHaveLength(1);
    expect(exclude()).not.toContain('/AGENTS.md');
  });

  test('symlinked files and folders are never written through', async () => {
    const outside = join(root, 'outside.txt');
    writeFileSync(outside, 'keep');
    symlinkSync(outside, join(project, 'AGENTS.md'));
    const outDir = join(root, 'outdir');
    mkdirSync(outDir);
    mkdirSync(join(project, '.claude'));
    symlinkSync(outDir, join(project, '.claude/commands'));
    const out = await writeProjectFiles(project, 'hive-ctx', envFor([]));
    expect(readFileSync(outside, 'utf8')).toBe('keep');
    expect(out).toContain('skipped AGENTS.md: symlink or not a regular file');
    expect(out).toContain('skipped .claude/commands/hive-start.md: symlink or not a regular file');
    expect(readdirSync(outDir)).toEqual([]);
    expect(read('CLAUDE.md')).toBe('@AGENTS.md\n');
  });

  test('a custom stub is kept, an installer stub is rewritten', async () => {
    mkdirSync(join(project, '.claude/commands'), { recursive: true });
    writeFileSync(join(project, '.claude/commands/hive-work.md'), 'my own work command\n');
    writeFileSync(join(project, '.claude/commands/hive-end.md'), 'Call the `hive_workflow` tool of the `old` MCP server with name `end`, then follow the returned instructions.\n');
    const out = await writeProjectFiles(project, 'hive-ctx', envFor([]));
    expect(read('.claude/commands/hive-work.md')).toBe('my own work command\n');
    expect(out).toContain('kept .claude/commands/hive-work.md: not written by Hive');
    expect(read('.claude/commands/hive-end.md')).toContain('`hive-ctx`');
    expect(exclude()).not.toContain('/.claude/commands/hive-work.md');
  });

  test('a deleted exclude file is rebuilt for installer stubs without duplicates', async () => {
    await writeProjectFiles(project, 'hive-ctx', envFor([]));
    rmSync(join(project, '.git/info/exclude'));
    await writeProjectFiles(project, 'hive-ctx', envFor([]));
    await writeProjectFiles(project, 'hive-ctx', envFor([]));
    for (const w of ['start', 'new', 'work', 'end']) expect(exclude().filter((l) => l === `/.claude/commands/hive-${w}.md`)).toHaveLength(1);
  });

  test('existing CLAUDE.md gets the line once and keeps its text', async () => {
    writeFileSync(join(project, 'CLAUDE.md'), '# mine\nrules');
    await writeProjectFiles(project, 'hive-ctx', envFor([]));
    await writeProjectFiles(project, 'hive-ctx', envFor([]));
    expect(read('CLAUDE.md')).toBe('# mine\nrules\n@AGENTS.md\n');
    expect(exclude()).not.toContain('/CLAUDE.md');
  });
});

describe('install', () => {
  const dirOf = (o: string, r: string): string => join(home, '.hive', o, r);
  const projectFiles = (): string[] =>
    readdirSync(project, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile() && !join(d.parentPath, d.name).includes('/.git/'))
      .map((d) => join(d.parentPath, d.name));
  const setup = (): { f: ReturnType<typeof fakes>; env: NodeJS.ProcessEnv } => {
    mkdirSync(join(home, '.claude'));
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex/config.toml'), '[mcp_servers.playwright]\ncommand = "npx"\n');
    return { f: fakes(), env: envFor([[URL_, remote]]) };
  };
  const noToken = async (token: string): Promise<void> => {
    expect(lines.join('\n')).not.toContain(token);
    for (const f of projectFiles()) expect(readFileSync(f, 'utf8'), f).not.toContain(token);
  };

  test('end to end, idempotent re-run, half-finished repair', async () => {
    const { f, env } = setup();
    await install(URL_, mkIo(env));
    const cfg = await readHiveConfig(home);
    const ctx = cfg.contexts['acme/ctx'];
    expect(ctx).toMatchObject({ url: URL_, dir: dirOf('acme', 'ctx'), name: 'Ada', email: 'ada@example.com', port: 4000 });
    expect(ctx?.token).toMatch(/^[0-9a-f]{64}$/);
    expect(cfg.projects[project]).toBe('acme/ctx');
    expect(asked).toHaveLength(1);
    expect(f.log()).toContain('claude mcp add');
    expect(lines.some((l) => l.startsWith('Other MCP clients: http://127.0.0.1:4000/mcp with header Authorization: Bearer '))).toBe(true);
    expect(lines.at(-1)).toBe('Start Hive: npx hive-collab-context start');
    await noToken(ctx?.token ?? 'x');

    asked = [];
    lines = [];
    await install(URL_, mkIo(env));
    expect(await readHiveConfig(home)).toEqual(cfg);
    expect(asked).toEqual([]);
    expect(readFileSync(join(project, 'AGENTS.md'), 'utf8').match(/BEGIN:hive/g)).toHaveLength(1);
    expect(readFileSync(join(home, '.codex/config.toml'), 'utf8').match(/\[mcp_servers\.hive-acme-ctx\]/g)).toHaveLength(1);
    expect(readFileSync(join(home, '.codex/config.toml'), 'utf8')).toContain('[mcp_servers.playwright]');
    const ex = readFileSync(join(project, '.git/info/exclude'), 'utf8').split('\n');
    expect(new Set(ex).size).toBe(ex.length);
    expect(lines).toContain('Claude Code: already registered');

    rmSync(f.state);
    lines = [];
    await install(URL_, mkIo(env));
    expect(lines).toContain('Claude Code: registered hive-acme-ctx');
    expect((await readHiveConfig(home)).contexts['acme/ctx']?.token).toBe(ctx?.token);
    await noToken(ctx?.token ?? 'x');
  });

  test('a second context repo gets its own folder, entry and port', async () => {
    setup();
    const two = bare('two.git');
    const env = envFor([[URL_, remote], ['git@github.com:acme/two.git', two]]);
    await install(URL_, mkIo(env));
    await install('git@github.com:acme/two.git', mkIo(env, 'TWO'));
    const cfg = await readHiveConfig(home);
    expect(Object.keys(cfg.contexts).sort()).toEqual(['acme/ctx', 'acme/two']);
    expect(cfg.contexts['acme/two']?.dir).toBe(dirOf('acme', 'two'));
    expect(cfg.contexts['acme/two']?.port).not.toBe(cfg.contexts['acme/ctx']?.port);
    expect(existsSync(join(dirOf('acme', 'two'), 'project.md'))).toBe(true);
  });

  test('a failed first push is retried on re-run without asking again', async () => {
    const { env } = setup();
    const hook = join(remote, 'hooks/pre-receive');
    mkdirSync(join(remote, 'hooks'), { recursive: true });
    writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    chmodSync(hook, 0o755);
    await expect(install(URL_, mkIo(env))).rejects.toThrow();
    expect(asked).toHaveLength(1);
    rmSync(hook);
    await install(URL_, mkIo(env));
    expect(asked).toHaveLength(1);
    expect(run(root, '--git-dir', remote, 'show', 'main:project.md')).toContain('ticket_key: "ACME"');
  });

  test('same repo name under two owners gets two servers and keeps the first token', async () => {
    mkdirSync(join(home, '.codex'));
    fakes();
    const [a, b] = [bare('a.git'), bare('b.git')];
    const env = envFor([['git@github.com:acme/context.git', a], ['git@github.com:ops/context.git', b]]);
    const project2 = join(root, 'project2');
    mkdirSync(project2);
    run(project2, 'init', '-q', '-b', 'main');
    await install('git@github.com:acme/context.git', mkIo(env));
    const first = (await readHiveConfig(home)).contexts['acme/context']?.token ?? '';
    await install('git@github.com:ops/context.git', { ...mkIo(env, 'OPS'), cwd: project2 });
    const toml = readFileSync(join(home, '.codex/config.toml'), 'utf8');
    expect(toml.match(/\[mcp_servers\.hive-acme-context\]/g)).toHaveLength(1);
    expect(toml.match(/\[mcp_servers\.hive-ops-context\]/g)).toHaveLength(1);
    expect(toml).toContain(`Bearer ${first}`);
  });

  test('one agent failing does not stop the others, and the install reports it', async () => {
    const { env } = setup();
    writeFileSync(join(fakeBin, 'claude'), '#!/bin/sh\n[ "$2" = add ] && exit 1\nexit 1\n');
    chmodSync(join(fakeBin, 'claude'), 0o755);
    await expect(install(URL_, mkIo(env))).rejects.toThrow(/need repair/);
    const token = (await readHiveConfig(home)).contexts['acme/ctx']?.token ?? 'x';
    expect(readFileSync(join(home, '.codex/config.toml'), 'utf8')).toContain('[mcp_servers.hive-acme-ctx]');
    expect(existsSync(join(project, 'AGENTS.md'))).toBe(true);
    expect(lines.some((l) => l.startsWith('Claude Code:'))).toBe(true);
    expect(lines.at(-1)).toBe('Start Hive: npx hive-collab-context start');
    await noToken(token);
  });

  test('not a git project and bad url are refused', async () => {
    const io = { ...mkIo(envFor([])), cwd: root };
    await expect(install(URL_, io)).rejects.toThrow(/git/);
    await expect(install('https://github.com/a/b.git', mkIo(envFor([])))).rejects.toThrow(/SSH URL/);
  });

  test('startEnv fills from the entry, env wins, and the server config loads', async () => {
    const { env } = setup();
    await install(URL_, mkIo(env));
    const cfg = await readHiveConfig(home);
    const se = startEnv(cfg, project, {});
    expect(se.HIVE_CONTEXT_DIR).toBe(dirOf('acme', 'ctx'));
    expect(se.PORT).toBe('4000');
    expect(startEnv(cfg, project, { PORT: '5555' }).PORT).toBe('5555');
    expect(loadConfig(se).ticketKey).toBe('ACME');
    expect(() => startEnv(cfg, join(root, 'elsewhere'), {})).toThrow('not set up here: run npx hive-collab-context <ssh-url> first');
  });
});

describe('tiers', () => {
  const read = (f: string): string => readFileSync(join(project, f), 'utf8');
  const exclude = (): string[] => read('.git/info/exclude').split('\n');
  const TIER_FILES = ['.claude/agents/hands-careful.md', '.claude/agents/hands-mechanical.md', '.claude/settings.local.json', '.codex/agents/hands-careful.toml', '.codex/agents/hands-mechanical.toml', '.codex/config.toml', '.codex/hooks.json'];
  const setup = (): NodeJS.ProcessEnv => {
    mkdirSync(join(home, '.claude'));
    mkdirSync(join(home, '.codex'));
    fakes();
    return envFor([[URL_, remote]]);
  };
  const guard = (): string => `node '${join(home, '.hive/bin/guard.mjs')}'`;

  test('install writes every tier file, copies the guard, excludes the new files', async () => {
    await install(URL_, mkIo(setup()));
    for (const f of TIER_FILES) expect(existsSync(join(project, f)), f).toBe(true);
    for (const f of TIER_FILES) expect(exclude().filter((l) => l === `/${f}`), f).toHaveLength(1);
    expect(statSync(join(home, '.hive/bin')).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, '.hive/bin/guard.mjs')).mode & 0o777).toBe(0o755);
    expect(read('.claude/agents/hands-careful.md')).toContain('model: sonnet');
    expect(read('.claude/settings.local.json')).toContain(`${guard()} claude hands-careful,hands-mechanical`);
    expect(read('.codex/hooks.json')).toContain(`${guard()} codex gpt-6.1-terra,gpt-6-luna`);
    expect(read('.codex/config.toml')).toBe('model = "gpt-6.2-sol"\n');
    expect(lines).toContain('Codex: run /hooks once in this project to trust the Hive guard');
    expect(run(project, 'status', '--porcelain')).toBe('');
    const before = TIER_FILES.map(read);
    await install(URL_, mkIo(envFor([[URL_, remote]])));
    expect(TIER_FILES.map(read)).toEqual(before);
  });

  test('AGENTS.md has tier rules and no model or provider names', async () => {
    await install(URL_, mkIo(setup()));
    expect(read('AGENTS.md')).toMatch(/careful hands/i);
    expect(read('AGENTS.md')).not.toContain('HIVE-018');
    expect(read('AGENTS.md')).not.toMatch(/opus|sonnet|haiku|gpt-|claude|codex|fable|astra/i);
  });

  test('existing settings and hooks survive; brain model pinned; no duplicate on re-run', async () => {
    const env = setup();
    mkdirSync(join(project, '.claude'));
    writeFileSync(join(project, '.claude/settings.local.json'), JSON.stringify({ permissions: { allow: ['a'] }, model: 'fable', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'foreign' }] }] } }));
    mkdirSync(join(project, '.codex'));
    writeFileSync(join(project, '.codex/config.toml'), 'model = "gpt-6.1-terra"\n[x]\n');
    writeFileSync(join(project, '.codex/hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'z', hooks: [] }] } }));
    await install(URL_, mkIo(env));
    await install(URL_, mkIo(env));
    const s = JSON.parse(read('.claude/settings.local.json')) as { permissions: unknown; model: string; hooks: { PreToolUse: unknown[] } };
    expect(s.permissions).toEqual({ allow: ['a'] });
    expect(s.model).toBe('opus');
    expect(s.hooks.PreToolUse).toHaveLength(2);
    expect(read('.codex/config.toml')).toBe('model = "gpt-6.2-sol"\n[x]\n');
    expect((JSON.parse(read('.codex/hooks.json')) as { hooks: { PreToolUse: unknown[] } }).hooks.PreToolUse).toHaveLength(2);
  });

  test('tracked settings.local.json is not excluded; invalid JSON is left alone and logged', async () => {
    const env = setup();
    mkdirSync(join(project, '.claude'));
    writeFileSync(join(project, '.claude/settings.local.json'), '{"model": "mine"}');
    run(project, 'add', '-f', '.claude/settings.local.json');
    run(project, 'commit', '-qm', 's');
    mkdirSync(join(project, '.codex'));
    writeFileSync(join(project, '.codex/hooks.json'), '{broken');
    await install(URL_, mkIo(env));
    expect(exclude()).not.toContain('/.claude/settings.local.json');
    expect(read('.codex/hooks.json')).toBe('{broken');
    expect(lines).toContain('kept .codex/hooks.json: not written by Hive');
  });

  test('a user guard in ~/.claude/settings.json means no Hive Claude hook', async () => {
    const env = setup();
    writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Edit|Write|Bash', hooks: [{ type: 'command', command: '~/.claude/hooks/brain-hands-guard.sh' }] }] } }));
    await install(URL_, mkIo(env));
    expect(read('.claude/settings.local.json')).not.toContain('hooks');
    expect(read('.claude/settings.local.json')).toContain('"model": "opus"');
    expect(lines).toContain('Claude: your own guard is active; Hive guard not added');
    expect(read('.codex/hooks.json')).toContain("guard.mjs' codex");
  });

  test('a Bash-only user hook named guard does not count', async () => {
    const env = setup();
    writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-guard.sh' }] }] } }));
    await install(URL_, mkIo(env));
    expect(read('.claude/settings.local.json')).toContain('guard.mjs');
    expect(lines).not.toContain('Claude: your own guard is active; Hive guard not added');
  });

  test('a symlinked .codex dir is skipped', async () => {
    const env = setup();
    const out = join(root, 'codexout');
    mkdirSync(out);
    symlinkSync(out, join(project, '.codex'));
    await install(URL_, mkIo(env));
    expect(readdirSync(out)).toEqual([]);
    expect(lines).toContain('skipped .codex/agents/hands-careful.toml: symlink or not a regular file');
    expect(existsSync(join(project, '.claude/agents/hands-careful.md'))).toBe(true);
  });

  test('the context repo is untouched by a re-run that writes tier files', async () => {
    const env = setup();
    await install(URL_, mkIo(env));
    const ctx = join(home, '.hive/acme/ctx');
    const snap = (): string[] => [
      run(ctx, 'rev-parse', 'HEAD'),
      run(ctx, 'status', '--porcelain'),
      ...readdirSync(ctx, { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile() && !join(d.parentPath, d.name).includes('/.git/'))
        .map((d) => join(d.parentPath, d.name))
        .sort()
        .map((f) => `${f} ${createHash('sha256').update(readFileSync(f)).digest('hex')}`),
    ];
    const before = snap();
    rmSync(join(project, '.claude/agents'), { recursive: true });
    rmSync(join(project, '.codex'), { recursive: true });
    await install(URL_, mkIo(env));
    expect(existsSync(join(project, '.codex/hooks.json'))).toBe(true);
    expect(snap()).toEqual(before);
  });

  test('providers are only those detected', () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual(['claude', 'codex']);
  });
});
