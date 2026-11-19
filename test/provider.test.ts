import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { addProvider, install, listProviders, readHiveConfig, removeProvider, writeHiveConfig, type Io } from '../src/install.ts';

const URL_ = 'git@github.com:acme/ctx.git';
const TOKEN = 'b'.repeat(64);
const URL_MCP = 'http://127.0.0.1:4321/mcp';
let root: string;
let home: string;
let project: string;
let fakeBin: string;
let remote: string;
let lines: string[];

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const mkIo = (env: NodeJS.ProcessEnv = process.env, cwd = project): Io => ({ home, cwd, env, ask: () => Promise.resolve('ACME'), log: (l) => lines.push(l) });
const envFor = (): NodeJS.ProcessEnv => ({
  ...process.env,
  HOME: home,
  PATH: `${fakeBin}:${process.env.PATH}`,
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: `url.${remote}.insteadOf`,
  GIT_CONFIG_VALUE_0: URL_,
});
const script = (name: string, body: string): string => {
  const p = join(root, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
};
// Marks the project as set up, as install would.
const setUp = async (): Promise<void> => {
  const top = git(project, 'rev-parse', '--show-toplevel');
  await writeHiveConfig(home, { contexts: { 'acme/ctx': { url: URL_, dir: join(home, '.hive/acme/ctx'), token: TOKEN, port: 4321, name: 'Ada', email: 'a@b.c' } }, projects: { [top]: 'acme/ctx' } });
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hive-provider-'));
  [home, project, fakeBin] = ['home', 'project', 'bin'].map((d) => join(root, d)) as [string, string, string];
  [home, project, fakeBin].forEach((d) => mkdirSync(d));
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'config', 'user.name', 'Ada');
  git(project, 'config', 'user.email', 'ada@example.com');
  git(project, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(project, 'a.txt'), 'a');
  git(project, 'add', '.');
  git(project, 'commit', '-qm', 'init');
  remote = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  lines = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('provider add / list / remove', () => {
  test.each(['Bad_ID', 'claude', 'codex', '-x', ''])('add refuses id %j', async (id) => {
    await expect(addProvider(id, '~/.kimi', 'x {url}', mkIo())).rejects.toThrow('provider id must be lowercase letters, digits and dashes, and not claude or codex');
  });

  test('add refuses a relative detect and accepts ~/ and absolute', async () => {
    await expect(addProvider('kilo', '.kilo', 'x {url}', mkIo())).rejects.toThrow('detect must be an absolute path or start with ~/');
    await addProvider('kilo', '~/.kilo', 'x {url}', mkIo());
    await addProvider('abs', '/abs/x', 'x {url}', mkIo());
    expect(Object.keys((await readHiveConfig(home)).providers ?? {})).toEqual(['kilo', 'abs']);
  });

  test('add refuses a register command without {url}', async () => {
    await expect(addProvider('kimi', '~/.kimi', 'kimi mcp add', mkIo())).rejects.toThrow('register command must contain {url}');
  });

  test('add outside a set-up project saves and runs nothing', async () => {
    const marker = join(root, 'ran');
    await addProvider('kimi', '~/.kimi', `touch ${marker} {url}`, mkIo());
    expect(lines).toEqual(['kimi: saved; it registers on the next install']);
    expect(existsSync(marker)).toBe(false);
    expect((await readHiveConfig(home)).providers).toEqual({ kimi: { detect: '~/.kimi', register: `touch ${marker} {url}` } });
  });

  test('add in a set-up project runs it now with the real url and token, and never logs the token', async () => {
    await setUp();
    const out = join(root, 'argv');
    const fake = script('reg.sh', `printf '%s\\n' "$@" > '${out}'; echo "$2"; echo "$2" >&2`);
    mkdirSync(join(home, '.kimi'));
    await addProvider('kimi', '~/.kimi', `${fake} {url} {token}`, mkIo());
    expect(readFileSync(out, 'utf8')).toBe(`${URL_MCP}\n${TOKEN}\n`);
    expect(lines).toEqual(['kimi: registered (advisory mode: role rules in AGENTS.md, no guard)']);
    expect(lines.join('\n')).not.toContain(TOKEN);
    expect((await readHiveConfig(home)).providers?.kimi).toBeDefined();
  });

  test('a failing register leaves no token in the error or its cause', async () => {
    await setUp();
    mkdirSync(join(home, '.kimi'));
    const fake = script('bad.sh', `echo "$2" >&2; exit 3`);
    const err = await addProvider('kimi', '~/.kimi', `${fake} {url} {token}`, mkIo()).then(
      () => new Error('did not fail'),
      (e: Error) => e,
    );
    expect(err.message).toBe('register command failed (exit 3)');
    expect(String(err.cause ?? '')).not.toContain(TOKEN);
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(TOKEN);
    expect(JSON.stringify(err.cause ?? null, Object.getOwnPropertyNames(err.cause ?? {}))).not.toContain(TOKEN);
  });

  test('list shows ids and templates, never a token', async () => {
    await setUp();
    await listProviders(mkIo());
    expect(lines).toEqual(['no providers added']);
    lines = [];
    await addProvider('kimi', '~/.kimi', 'kimi mcp add {url} --token {token}', mkIo());
    lines = [];
    await listProviders(mkIo());
    expect(lines).toEqual(['kimi  detect ~/.kimi']);
    expect(lines.join('\n')).not.toContain(TOKEN);
    await addProvider('leaky', '~/.leaky', 'x {url} --header "Authorization: Bearer sk-secret-123"', mkIo());
    lines = [];
    await listProviders(mkIo());
    expect(lines.join('\n')).not.toContain('sk-secret-123');
  });

  test('remove deletes, and an unknown id throws', async () => {
    await addProvider('kimi', '~/.kimi', 'x {url}', mkIo());
    lines = [];
    await removeProvider('kimi', mkIo());
    expect(lines).toEqual(['kimi: removed from Hive (its own registration in that agent stays)']);
    expect((await readHiveConfig(home)).providers).toEqual({});
    await expect(removeProvider('kimi', mkIo())).rejects.toThrow('no provider kimi');
  });
});

describe('install runs user providers', () => {
  const claudeCodex = (): void => {
    mkdirSync(join(home, '.claude'));
    mkdirSync(join(home, '.codex'));
    script('bin/claude', 'exit 0');
    script('bin/codex', `[ "$1 $2 $3" = "mcp add --help" ] && echo '  --url <URL>'; exit 0`);
  };

  test('detect dir present registers; detect dir absent is skipped silently', async () => {
    claudeCodex();
    const out = join(root, 'argv');
    const fake = script('reg.sh', `printf '%s\\n' "$@" > '${out}'`);
    await writeHiveConfig(home, { contexts: {}, projects: {}, providers: { kimi: { detect: '~/.kimi', register: `${fake} {url}` }, ghost: { detect: '/nonexistent-hive-dir', register: `${fake} {url}` } } });
    mkdirSync(join(home, '.kimi'));
    await install(URL_, mkIo(envFor()));
    expect(lines).toContain('kimi: registered (advisory mode: role rules in AGENTS.md, no guard)');
    expect(lines.some((l) => l.startsWith('ghost'))).toBe(false);
    expect(readFileSync(out, 'utf8')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\n$/);
  });

  test('a failing user register is reported by id, install still succeeds, the token never leaks', async () => {
    claudeCodex();
    const fake = script('bad.sh', `echo "$1" >&2; echo "$1"; exit 3`);
    await writeHiveConfig(home, { contexts: {}, projects: {}, providers: { kimi: { detect: '~/.kimi', register: `${fake} {token}` } } });
    mkdirSync(join(home, '.kimi'));
    await install(URL_, mkIo(envFor()));
    const token = (await readHiveConfig(home)).contexts['acme/ctx']?.token ?? 'x';
    expect(token).toHaveLength(64);
    expect(lines).toContain('kimi: register command failed (exit 3)');
    expect(lines).toContain('Codex: registered hive-acme-ctx');
    expect(existsSync(join(project, 'AGENTS.md'))).toBe(true);
    expect(lines.join('\n')).not.toContain(token);
  });

  test('AGENTS.md and the context repo name no provider or model', async () => {
    claudeCodex();
    const fake = script('reg.sh', 'exit 0');
    await writeHiveConfig(home, { contexts: {}, projects: {}, providers: { kimi: { detect: '~/.kimi', register: `${fake} {url}` } } });
    mkdirSync(join(home, '.kimi'));
    await install(URL_, mkIo(envFor()));
    expect(readFileSync(join(project, 'AGENTS.md'), 'utf8')).not.toMatch(/kimi|opus|sonnet|haiku|gpt-/i);
    const ctxDir = join(home, '.hive/acme/ctx');
    for (const d of readdirSync(ctxDir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && !join(e.parentPath, e.name).includes('/.git/')))
      expect(readFileSync(join(d.parentPath, d.name), 'utf8'), d.name).not.toMatch(/kimi/i);
  });
});

describe('cli', () => {
  test('provider add without flags exits 1 and prints usage on stderr', () => {
    const r = spawnSync('node', [join(import.meta.dirname, '../src/cli.ts'), 'provider', 'add'], { encoding: 'utf8', env: { ...process.env, HOME: home } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('usage');
  });
});
