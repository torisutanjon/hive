import { createServer, type Server } from 'node:http';
import { authenticate, type DeveloperTable } from './auth.ts';

export function createHiveServer(developers: DeveloperTable): Server {
  return createServer((req, res) => {
    const dev = authenticate(req.headers.authorization, developers);
    if (!dev) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' });
      res.end('{"error":"unauthorized"}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ name: dev.name, email: dev.email }));
  });
}
