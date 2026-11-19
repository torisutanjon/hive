import { execFileSync } from 'node:child_process';
import { chmodSync, readdirSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
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
    expect(serverName('Hive.Context-Sample.git')).toBe('hive-hive-context-sample');
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
    writeFileSync(cfg, other, { mode: 0o640 });
    const io = mkIo(envFor([]));
    expect(await registerCodex(io, 'hive-ctx', MCP, TOKEN)).toBe('Codex: registered hive-ctx');
    await registerCodex(io, 'hive-ctx', MCP, TOKEN);
    const text = readFileSync(cfg, 'utf8');
    expect(text.startsWith(other)).toBe(true);
    expect(text.match(/\[mcp_servers\.hive-ctx\]/g)).toHaveLength(1);
    expect(text).toContain(BLOCK);
    expect(statSync(cfg).mode & 0o777).toBe(0o640);
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
    expect(readFileSync(join(home, '.codex/config.toml'), 'utf8').match(/\[mcp_servers\.hive-ctx\]/g)).toHaveLength(1);
    expect(readFileSync(join(home, '.codex/config.toml'), 'utf8')).toContain('[mcp_servers.playwright]');
    const ex = readFileSync(join(project, '.git/info/exclude'), 'utf8').split('\n');
    expect(new Set(ex).size).toBe(ex.length);
    expect(lines).toContain('Claude Code: already registered');

    rmSync(f.state);
    lines = [];
    await install(URL_, mkIo(env));
    expect(lines).toContain('Claude Code: registered hive-ctx');
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
