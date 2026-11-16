import { createServer, type Server } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { authenticate } from './auth.ts';
import type { Config } from './config.ts';
import { createMcpServer } from './mcp.ts';
import { createRepo } from './repo.ts';

export function createHiveServer(config: Config): Server {
  const repo = createRepo(config.contextDir);
  return createServer(async (req, res) => {
    if (req.headers.origin) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end('{"error":"forbidden"}');
      return;
    }
    const dev = authenticate(req.headers.authorization, config.developers);
    if (!dev) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' });
      res.end('{"error":"unauthorized"}');
      return;
    }
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
      res.end('{"error":"method not allowed"}');
      return;
    }
    const mcp = createMcpServer(config.contextDir, repo);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      // auth.token is deliberately '': never carry the raw token past auth.
      await transport.handleRequest(
        Object.assign(req, { auth: { token: '', clientId: dev.email, scopes: [], extra: { developer: dev } } }),
        res,
      );
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{"jsonrpc":"2.0","error":{"code":-32603,"message":"Internal server error"},"id":null}');
      }
    }
  });
}
