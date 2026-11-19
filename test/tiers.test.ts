import { describe, expect, test } from 'vitest';
import { guardCommand, HANDS, PROVIDERS, TIER_RULES, type FileSpec, type Provider } from '../src/tiers.ts';

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

  test('settings merge keeps other keys, adds model only when absent, no duplicate hook', () => {
    const f = spec(claude, '.claude/settings.local.json');
    const cur = JSON.stringify({ permissions: { allow: ['x'] }, model: 'fable', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'foreign' }] }] } });
    const out = JSON.parse(f.next(cur)) as { permissions: unknown; model: string; hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> } };
    expect(out.permissions).toEqual({ allow: ['x'] });
    expect(out.model).toBe('fable');
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

  test('config.toml model only when no top-level model before the first table', () => {
    const f = spec(codex, '.codex/config.toml');
    expect(f.next('')).toBe('model = "gpt-6.2-sol"\n');
    expect(f.next('[a]\nx = 1\n')).toBe('model = "gpt-6.2-sol"\n[a]\nx = 1\n');
    expect(f.next('model = "x"\n[a]\n')).toBe('model = "x"\n[a]\n');
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
  expect(guardCommand(claude, '/h')).toBe('node /h/.hive/bin/guard.mjs claude hands-careful,hands-mechanical');
  expect(guardCommand(codex, '/h')).toBe('node /h/.hive/bin/guard.mjs codex gpt-6.1-terra,gpt-6-luna');
  expect(guardCommand(claude, '/a b')).toBe('node "/a b/.hive/bin/guard.mjs" claude hands-careful,hands-mechanical');
  expect(HANDS).toEqual(['hands-careful', 'hands-mechanical']);
});

test('tier rules name no model or provider', () => {
  expect(TIER_RULES).not.toMatch(/opus|sonnet|haiku|gpt-|claude|codex|fable|astra/i);
});
