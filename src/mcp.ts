import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Developer } from './auth.ts';

export function createMcpServer(): McpServer {
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
  return server;
}
