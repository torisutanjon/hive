import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { buildDeveloperTable } from '../src/auth.ts';
import { createHiveServer } from '../src/server.ts';

const TOKEN = 'x'.repeat(40);
const server = createHiveServer(
  buildDeveloperTable({ [TOKEN]: { name: 'Ada', email: 'ada@example.com' } }),
);
let base = '';

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

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
