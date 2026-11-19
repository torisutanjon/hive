import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, test } from 'vitest';
import { DESC, guardCommand, HANDS, PROVIDERS, TIER_RULES, type FileSpec, type Provider } from '../src/tiers.ts';

const [claude, codex] = PROVIDERS as [Provider, Provider];
const spec = (p: Provider, rel: string, guard: string | null = 'node g'): FileSpec => {
  const f = p.files({ home: '/h', guard }).find((x) => x.rel === rel);
  if (!f) throw new Error(`no ${rel}`);
  return f;
};

describe('claude files', () => {
  test('hands agents carry the aliases', () => {
    expect(spec(claude, '.claude/agents/hands-careful.md').next('')).toMatch(/^---\nname: hands-careful\ndescription: .+\nmodel: sonnet\n---\n/);
    expect(spec(claude, '.claude/agents/hands-mechanical.md').next('')).toContain('model: haiku');
    expect(spec(claude, '.claude/agents/hands-careful.md').owned?.('my own agent')).toBe(false);
  });

  test('front matter is valid YAML even with colons in the description', () => {
    for (const [t, m] of [['careful', 'sonnet'], ['mechanical', 'haiku']] as const) {
      const text = spec(claude, `.claude/agents/hands-${t}.md`).next('');
      const fm = parse(/^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '') as Record<string, string>;
      expect(fm).toEqual({ name: `hands-${t}`, description: DESC[t], model: m });
    }
  });

  test('settings merge pins opus, keeps other keys, no duplicate hook', () => {
    const f = spec(claude, '.claude/settings.local.json');
    const cur = JSON.stringify({ permissions: { allow: ['x'] }, model: 'fable', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'foreign' }] }] } });
    const out = JSON.parse(f.next(cur)) as { permissions: unknown; model: string; hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> } };
    expect(out.permissions).toEqual({ allow: ['x'] });
    expect(out.model).toBe('opus');
    expect(out.hooks.PreToolUse.map((e) => e.hooks[0]?.command)).toEqual(['foreign', 'node g']);
    const again = f.next(f.next(cur));
    expect(again).toBe(f.next(cur));
    expect(f.next('')).toContain('"model": "opus"');
  });

  test('no guard: model only; invalid JSON is not owned and stays unchanged', () => {
    const f = spec(claude, '.claude/settings.local.json', null);
    expect(JSON.parse(f.next(''))).toEqual({ model: 'opus' });
    expect(f.owned?.('{nope')).toBe(false);
    expect(f.next('{nope')).toBe('{nope');
  });
});

describe('codex files', () => {
  test('agents toml', () => {
    const t = spec(codex, '.codex/agents/hands-careful.toml').next('');
    expect(t.split('\n')[0]).toMatch(/^# hive:/);
    expect(t).toContain('name = "hands-careful"');
    expect(t).toContain('model = "gpt-6.1-terra"');
    expect(t).toContain('developer_instructions = """');
    expect(spec(codex, '.codex/agents/hands-mechanical.toml').next('')).toContain('model = "gpt-6-luna"');
    expect(spec(codex, '.codex/agents/hands-careful.toml').owned?.('name = "mine"\n')).toBe(false);
  });

  test('config.toml pins the brain model: replaces a top-level model line, else prepends', () => {
    const f = spec(codex, '.codex/config.toml');
    expect(f.next('')).toBe('model = "gpt-6.2-sol"\n');
    expect(f.next('[a]\nx = 1\n')).toBe('model = "gpt-6.2-sol"\n[a]\nx = 1\n');
    expect(f.next('a = 1\nmodel = "gpt-6.1-terra"\nb = 2\n[a]\n')).toBe('a = 1\nmodel = "gpt-6.2-sol"\nb = 2\n[a]\n');
    expect(f.next('[a]\nmodel = "x"\n')).toContain('model = "gpt-6.2-sol"\n[a]');
  });

  test('hooks.json merge keeps entries, no duplicate; absent without guard', () => {
    const f = spec(codex, '.codex/hooks.json');
    const cur = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'x', hooks: [] }], Stop: [] } });
    const out = JSON.parse(f.next(cur)) as { hooks: { PreToolUse: Array<{ matcher: string }>; Stop: unknown[] } };
    expect(out.hooks.PreToolUse.map((e) => e.matcher)).toEqual(['x', '^(Bash|apply_patch)$']);
    expect(out.hooks.Stop).toEqual([]);
    expect(f.next(f.next(cur))).toBe(f.next(cur));
    expect(codex.files({ home: '/h', guard: null }).some((x) => x.rel === '.codex/hooks.json')).toBe(false);
  });
});

test('guard commands', () => {
  expect(guardCommand(claude, '/h')).toBe("node '/h/.hive/bin/guard.mjs' claude hands-careful,hands-mechanical");
  expect(guardCommand(codex, '/h')).toBe("node '/h/.hive/bin/guard.mjs' codex gpt-6.1-terra,gpt-6-luna");
  expect(guardCommand(claude, '/a b')).toBe("node '/a b/.hive/bin/guard.mjs' claude hands-careful,hands-mechanical");
  expect(HANDS).toEqual(['hands-careful', 'hands-mechanical']);
});

test('tier rules name no model or provider', () => {
  expect(TIER_RULES).not.toMatch(/opus|sonnet|haiku|gpt-|claude|codex|fable|astra/i);
});

test('a hostile home path is single-quoted and still runs', () => {
  const root = mkdtempSync(join(tmpdir(), 'hive-q-'));
  try {
    const home = join(root, "a b$(x)'c");
    mkdirSync(join(home, '.hive/bin'), { recursive: true });
    copyFileSync('hooks/guard.mjs', join(home, '.hive/bin/guard.mjs'));
    const cmd = guardCommand(claude, home);
    const quoted = `'${join(home, '.hive/bin/guard.mjs').replace(/'/g, "'\\''")}'`;
    expect(cmd).toContain(quoted);
    const r = spawnSync('/bin/sh', ['-c', cmd], { input: '{"tool_name":"Read"}', encoding: 'utf8' });
    expect([r.status, r.stderr]).toEqual([0, '']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
