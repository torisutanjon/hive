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
  const r = await call('hive_search', { query: 'hello' });
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
