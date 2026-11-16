import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Developer } from './auth.ts';
import { ContextError, listDir, readContext, searchContext } from './context.ts';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await fn()) }] };
  } catch (e) {
    // raw errors may hold absolute paths: only ContextError messages are safe
    const text = e instanceof ContextError ? e.message : 'internal error';
    return { isError: true, content: [{ type: 'text', text }] };
  }
}

export function createMcpServer(contextDir: string): McpServer {
  const server = new McpServer({ name: 'hive', version: '0.0.0' });
  server.registerTool(
    'hive_whoami',
    { description: 'Who Hive thinks you are: the developer your token belongs to.' },
    (extra) => {
      const dev = extra.authInfo?.extra?.developer as Developer | undefined;
      return {
        content: [
          { type: 'text', text: JSON.stringify(dev ? { name: dev.name, email: dev.email } : null) },
        ],
      };
    },
  );
  server.registerTool(
    'hive_list',
    {
      description: 'List one folder of the shared context (default: root). Returns [{name, type}].',
      inputSchema: { dir: z.string().optional() },
    },
    ({ dir }) => run(() => listDir(contextDir, dir ?? '')),
  );
  server.registerTool(
    'hive_read',
    {
      description:
        'Read a file from the shared context. Returns {content, version}; pass version as base when writing.',
      inputSchema: { path: z.string() },
    },
    ({ path }) => run(() => readContext(contextDir, path)),
  );
  server.registerTool(
    'hive_search',
    {
      description:
        'Case-insensitive plain-text search over the shared context markdown. Returns up to 50 [{path, line, text}].',
      inputSchema: { query: z.string() },
    },
    ({ query }) => run(() => searchContext(contextDir, query)),
  );
  return server;
}
