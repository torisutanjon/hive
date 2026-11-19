import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Developer } from './auth.ts';
import { ContextError, listDir, readContext, searchContext } from './context.ts';
import type { Repo } from './repo.ts';
import { loadWorkflows, render, type Workflows } from './workflow.ts';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const v = await fn();
    return { content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }] };
  } catch (e) {
    // raw errors may hold absolute paths: only ContextError messages are safe
    const text = e instanceof ContextError ? e.message : 'internal error';
    return { isError: true, content: [{ type: 'text', text }] };
  }
}

function author(extra: { authInfo?: { extra?: Record<string, unknown> } }): Developer {
  const d = extra.authInfo?.extra?.developer as Developer | undefined;
  if (!d) throw new ContextError('unauthenticated');
  return d;
}

export function createMcpServer(contextDir: string, repo: Repo, ticketKey: string, workflows: Workflows): McpServer {
  const server = new McpServer({ name: 'hive', version: '0.0.0' });
  server.registerTool(
    'hive_whoami',
    { description: 'Who Hive thinks you are, and whether the context repo is shared (has an origin).' },
    async (extra) => {
      const dev = extra.authInfo?.extra?.developer as Developer | undefined;
      return {
        content: [
          { type: 'text', text: JSON.stringify(dev ? { name: dev.name, email: dev.email, shared: await repo.shared() } : null) },
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
  server.registerTool(
    'hive_write',
    {
      description:
        'Create or overwrite a file in the shared context as one git commit by you. Creating: omit base (fails if the file exists). Overwriting: pass base = the version from hive_read (fails if the file changed since). Returns {path, version, commit}.',
      inputSchema: {
        path: z.string(),
        content: z.string(),
        message: z.string(),
        base: z.string().optional(),
      },
    },
    ({ path, content, message, base }, extra) =>
      run(() => repo.write(path, content, message, author(extra), base)),
  );
  server.registerTool(
    'hive_delete',
    {
      description:
        'Delete a file from the shared context as one git commit by you. Returns {path, version: null, commit}.',
      inputSchema: { path: z.string(), message: z.string() },
    },
    ({ path, message }, extra) => run(() => repo.delete(path, message, author(extra))),
  );
  server.registerTool(
    'hive_history',
    {
      description:
        'Commits that touched a path in the shared context (or the whole repo if path is omitted), newest first: [{commit, author:{name,email}, date, message}].',
      inputSchema: { path: z.string().optional(), limit: z.number().int().min(1).max(200).optional() },
    },
    ({ path, limit }) => run(() => repo.history(path, limit)),
  );
  server.registerTool(
    'hive_revert',
    {
      description:
        'Undo a commit by adding a revert commit authored by you. Fails without changing anything if later changes conflict. Returns {reverted, commit} (commit null if there was nothing to undo).',
      inputSchema: { commit: z.string() },
    },
    ({ commit }, extra) => run(() => repo.revert(commit, author(extra))),
  );
  server.registerTool(
    'hive_new_ticket',
    {
      description:
        'Create the next ticket (KEY-###) in the shared context as one commit by you. Numbers are assigned under the write lock, never reused. Returns {key, path, version, commit}.',
      inputSchema: { title: z.string() },
    },
    ({ title }, extra) => run(() => repo.newTicket(ticketKey, title, author(extra))),
  );
  for (const wf of workflows.valid) {
    server.registerPrompt(
      wf.name,
      {
        description: wf.description,
        argsSchema: Object.fromEntries(
          wf.arguments.map((a) => [a.name, (a.required ? z.string() : z.string().optional()).describe(a.description ?? a.name)]),
        ),
      },
      (args) => ({
        messages: [
          { role: 'user', content: { type: 'text', text: render(wf, args as Record<string, string | undefined>) } },
        ],
      }),
    );
  }
  server.registerTool(
    'hive_workflow',
    {
      description:
        'Render a shared workflow step (same text as the MCP prompt of that name). For clients without prompt support.',
      inputSchema: { name: z.string(), args: z.record(z.string(), z.string()).optional() },
    },
    ({ name, args }) =>
      run(async () => {
        const all = await loadWorkflows(contextDir);
        const wf = all.valid.find((w) => w.name === name);
        if (wf) return render(wf, args ?? {});
        const bad = all.invalid.find((w) => w.name === name);
        if (bad) throw new ContextError(`workflow ${name} is invalid: ${bad.error}`);
        throw new ContextError(`unknown workflow; available: ${all.valid.map((w) => w.name).join(', ') || 'none'}`);
      }),
  );
  return server;
}
