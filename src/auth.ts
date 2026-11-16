import { createHash } from 'node:crypto';

export type Developer = { name: string; email: string };
/** Keyed by sha256 hex of the token, never the token itself. */
export type DeveloperTable = Map<string, Developer>;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function buildDeveloperTable(tokens: Record<string, Developer>): DeveloperTable {
  return new Map(Object.entries(tokens).map(([token, dev]) => [hashToken(token), dev]));
}

export function authenticate(header: string | undefined, developers: DeveloperTable): Developer | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  const token = match?.[1];
  if (!token) return null;
  return developers.get(hashToken(token)) ?? null;
}
