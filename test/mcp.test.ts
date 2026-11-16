import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { buildDeveloperTable } from '../src/auth.ts';
import type { Config } from '../src/config.ts';
import { createHiveServer } from '../src/server.ts';

const TOKEN = 'x'.repeat(40);
const contextDir = mkdtempSync(join(tmpdir(), 'hive-mcp-'));
mkdirSync(join(contextDir, 'notes'));
writeFileSync(join(contextDir, 'notes/a.md'), 'Hello World\n');
const g = (...args: string[]): string => execFileSync('git', args, { cwd: contextDir, encoding: 'utf8' }).trim();
const WF_HEAD = '---\ndescription: Start work on a ticket\narguments:\n  - name: key\n    description: Ticket key\n    required: true\n---\n';
mkdirSync(join(contextDir, 'workflow'));
writeFileSync(join(contextDir, 'workflow/start-ticket.md'), WF_HEAD + 'Read tickets/{{key}}.md first.\n');
writeFileSync(join(contextDir, 'workflow/hello.md'), '---\ndescription: Say hello\n---\nHello from Hive.\n');
g('init', '-q');
g('add', '-A');
g('-c', 'user.name=Seed', '-c', 'user.email=seed@x', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init');
const config: Config = {
  contextDir,
  developers: buildDeveloperTable({ [TOKEN]: { name: 'Ada', email: 'ada@example.com' } }),
  ticketKey: 'HIVE',
  port: 0,
};
const server = createHiveServer(config);
let base = '';

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(contextDir, { recursive: true, force: true });
});

function transport(withToken: boolean): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL('/mcp', base), {
    requestInit: withToken ? { headers: { Authorization: 'Bearer ' + TOKEN } } : {},
  });
}

test('with token: lists hive_whoami', async () => {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport(true));
  try {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('hive_whoami');
  } finally {
    await client.close();
  }
});

test('with token: hive_whoami returns the caller', async () => {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport(true));
  try {
    const result = await client.callTool({ name: 'hive_whoami', arguments: {} });
    const first = (result.content as { type: string; text: string }[])[0];
    expect(first?.type).toBe('text');
    expect(JSON.parse(first?.text ?? '')).toEqual({ name: 'Ada', email: 'ada@example.com' });
  } finally {
    await client.close();
  }
});

test('without token: connect rejects', async () => {
  const client = new Client({ name: 'test', version: '0.0.0' });
  try {
    await expect(client.connect(transport(false))).rejects.toThrow();
  } finally {
    await client.close();
  }
});

type Called = { isError?: boolean; text: string };

async function call(name: string, args: Record<string, unknown>): Promise<Called> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport(true));
  try {
    const result = await client.callTool({ name, arguments: args });
    const first = (result.content as { type: string; text: string }[])[0];
    return { isError: result.isError as boolean | undefined, text: first?.text ?? '' };
  } finally {
    await client.close();
  }
}

test('listTools includes the read tools and whoami', async () => {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport(true));
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['hive_list', 'hive_read', 'hive_search', 'hive_whoami']));
  } finally {
    await client.close();
  }
});

test('hive_list root', async () => {
  const r = await call('hive_list', {});
  expect(JSON.parse(r.text)).toContainEqual({ name: 'notes', type: 'dir' });
});

test('hive_list notes', async () => {
  const r = await call('hive_list', { dir: 'notes' });
  expect(JSON.parse(r.text)).toEqual([{ name: 'a.md', type: 'file' }]);
});

test('hive_read returns content and version', async () => {
  const r = await call('hive_read', { path: 'notes/a.md' });
  const body = JSON.parse(r.text) as { content: string; version: string };
  expect(body.content).toBe('Hello World\n');
  expect(body.version).toMatch(/^[0-9a-f]{64}$/);
});

test('hive_search finds the line', async () => {
  const r = await call('hive_search', { query: 'hello world' });
  expect(JSON.parse(r.text)).toEqual([{ path: 'notes/a.md', line: 1, text: 'Hello World' }]);
});

test('hive_read ../x is a safe tool error', async () => {
  const r = await call('hive_read', { path: '../x' });
  expect(r.isError).toBe(true);
  expect(r.text).toContain('outside');
  expect(r.text).not.toContain(contextDir);
});

test('listTools includes the write tools', async () => {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport(true));
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['hive_write', 'hive_delete']));
  } finally {
    await client.close();
  }
});

test('write, conflict, overwrite with base, delete', async () => {
  const w = await call('hive_write', { path: 'notes/new.md', content: 'hi\n', message: 'add new' });
  expect(w.isError).toBeFalsy();
  const body = JSON.parse(w.text) as { path: string; version: string; commit: string };
  expect(body.path).toBe('notes/new.md');
  expect(body.version).toMatch(/^[0-9a-f]{64}$/);
  expect(body.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(g('log', '-1', '--format=%an <%ae>|%s')).toBe('Ada <ada@example.com>|add new');

  const again = await call('hive_write', { path: 'notes/new.md', content: 'x\n', message: 'again' });
  expect(again.isError).toBe(true);
  expect(again.text).toMatch(/exists/);

  const read = JSON.parse((await call('hive_read', { path: 'notes/new.md' })).text) as { version: string };
  const over = await call('hive_write', {
    path: 'notes/new.md',
    content: 'hi2\n',
    message: 'over',
    base: read.version,
  });
  expect(over.isError).toBeFalsy();

  const del = await call('hive_delete', { path: 'notes/new.md', message: 'rm' });
  expect(del.isError).toBeFalsy();
  expect(existsSync(join(contextDir, 'notes/new.md'))).toBe(false);
});

test('hive_write ../x is a safe tool error', async () => {
  const r = await call('hive_write', { path: '../x.md', content: 'x', message: 'm' });
  expect(r.isError).toBe(true);
  expect(r.text).not.toContain(contextDir);
});

test('listTools includes history and revert', async () => {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport(true));
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['hive_history', 'hive_revert']));
  } finally {
    await client.close();
  }
});

test('history, limit validation, revert', async () => {
  await call('hive_write', { path: 'notes/h.md', content: 'v1\n', message: 'add h' });
  const h = JSON.parse((await call('hive_history', { path: 'notes/h.md' })).text) as {
    commit: string;
    author: { name: string; email: string };
    date: string;
    message: string;
  }[];
  expect(h[0]?.message).toBe('add h');
  expect(h[0]?.author).toEqual({ name: 'Ada', email: 'ada@example.com' });
  expect(h[0]?.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(isNaN(Date.parse(h[0]?.date ?? ''))).toBe(false);

  const one = JSON.parse((await call('hive_history', { limit: 1 })).text) as unknown[];
  expect(one).toHaveLength(1);
  for (const limit of [0, 1.5, 500]) {
    expect((await call('hive_history', { limit })).isError).toBe(true);
  }

  const read = JSON.parse((await call('hive_read', { path: 'notes/h.md' })).text) as { version: string };
  const edit = JSON.parse(
    (await call('hive_write', { path: 'notes/h.md', content: 'v2\n', message: 'edit h', base: read.version })).text,
  ) as { commit: string };
  const rev = JSON.parse((await call('hive_revert', { commit: edit.commit })).text) as {
    reverted: string;
    commit: string;
  };
  expect(rev.reverted).toBe(edit.commit);
  expect(rev.commit).toMatch(/^[0-9a-f]{40}$/);
  const after = JSON.parse((await call('hive_read', { path: 'notes/h.md' })).text) as { content: string };
  expect(after.content).toBe('v1\n');
});

test('hive_revert malformed commit is a tool error', async () => {
  const r = await call('hive_revert', { commit: '--abort' });
  expect(r.isError).toBe(true);
  expect(r.text).toMatch(/commit/);
});

test('hive_history ../x is a safe tool error', async () => {
  const r = await call('hive_history', { path: '../x' });
  expect(r.isError).toBe(true);
  expect(r.text).not.toContain(contextDir);
});

test('listTools includes hive_new_ticket', async () => {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport(true));
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('hive_new_ticket');
  } finally {
    await client.close();
  }
});

test('hive_new_ticket creates the note', async () => {
  const r = await call('hive_new_ticket', { title: 'From MCP' });
  expect(r.isError).toBeFalsy();
  const t = JSON.parse(r.text) as { key: string; path: string };
  expect(t.key).toMatch(/^HIVE-\d{3}$/);
  expect(t.path).toBe(`tickets/${t.key}.md`);
  const read = JSON.parse((await call('hive_read', { path: t.path })).text) as { content: string };
  expect(read.content).toContain('title: "From MCP"');
});

test('hive_new_ticket empty title is a tool error', async () => {
  const r = await call('hive_new_ticket', { title: '' });
  expect(r.isError).toBe(true);
  expect(r.text).toMatch(/title/);
});

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport(true));
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

const RENDERED = 'Read tickets/HIVE-001.md first.\n';

test('listPrompts includes start-ticket', async () => {
  const { prompts } = await withClient((c) => c.listPrompts());
  expect(prompts.find((p) => p.name === 'start-ticket')).toMatchObject({
    description: 'Start work on a ticket',
    arguments: [{ name: 'key', required: true }],
  });
});

test('getPrompt renders the workflow', async () => {
  const r = await withClient((c) => c.getPrompt({ name: 'start-ticket', arguments: { key: 'HIVE-001' } }));
  expect(r.messages[0]?.content).toMatchObject({ type: 'text', text: RENDERED });
});

test('hive_workflow returns identical raw text', async () => {
  const r = await withClient((c) =>
    c.callTool({ name: 'hive_workflow', arguments: { name: 'start-ticket', args: { key: 'HIVE-001' } } }),
  );
  expect(r.isError).toBeFalsy();
  expect((r.content as { text: string }[])[0]?.text).toBe(RENDERED);
});

test('getPrompt without required arg rejects', async () => {
  await expect(withClient((c) => c.getPrompt({ name: 'start-ticket' }))).rejects.toThrow();
});

test('hive_workflow unknown name lists available', async () => {
  const r = await withClient((c) => c.callTool({ name: 'hive_workflow', arguments: { name: 'nope' } }));
  expect(r.isError).toBe(true);
  expect((r.content as { text: string }[])[0]?.text).toContain('start-ticket');
});

test('workflow edits on disk apply to a new client', async () => {
  writeFileSync(join(contextDir, 'workflow/start-ticket.md'), WF_HEAD + 'Changed {{key}}.\n');
  const r = await withClient((c) => c.getPrompt({ name: 'start-ticket', arguments: { key: 'HIVE-001' } }));
  expect(r.messages[0]?.content).toMatchObject({ text: 'Changed HIVE-001.\n' });
});

const HELLO = 'Hello from Hive.\n';

test('zero-arg workflow is listed without arguments', async () => {
  const { prompts } = await withClient((c) => c.listPrompts());
  const p = prompts.find((x) => x.name === 'hello');
  expect(p).toBeDefined();
  expect((p?.arguments ?? []).length).toBe(0);
});

test('zero-arg getPrompt works with no arguments key', async () => {
  const r = await withClient((c) => c.getPrompt({ name: 'hello' }));
  expect(r.messages[0]?.content).toMatchObject({ text: HELLO });
});

test('zero-arg getPrompt works with empty arguments', async () => {
  const r = await withClient((c) => c.getPrompt({ name: 'hello', arguments: {} }));
  expect(r.messages[0]?.content).toMatchObject({ text: HELLO });
});

test('zero-arg hive_workflow', async () => {
  const r = await withClient((c) => c.callTool({ name: 'hive_workflow', arguments: { name: 'hello' } }));
  expect((r.content as { text: string }[])[0]?.text).toBe(HELLO);
});
