import { createHash } from 'node:crypto';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Messages are safe to show clients: never include absolute paths. */
export class ContextError extends Error {
  override name = 'ContextError';
}

export type Entry = { name: string; type: 'file' | 'dir' };
export type Match = { path: string; line: number; text: string };
export const SEARCH_LIMIT = 50;

function outside(root: string, abs: string): boolean {
  const r = relative(root, abs);
  return r === '..' || r.startsWith('..' + sep) || isAbsolute(r);
}

function code(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException).code;
}

export async function resolveSafe(root: string, rel: string): Promise<string> {
  if (rel.includes('\0') || isAbsolute(rel)) throw new ContextError('path outside the context repo');
  const abs = resolve(root, rel);
  if (outside(root, abs)) throw new ContextError('path outside the context repo');
  if (relative(root, abs).split(sep).includes('.git')) {
    throw new ContextError('path inside .git is not allowed');
  }
  let real: string;
  try {
    real = await realpath(abs);
  } catch (e) {
    if (code(e) === 'ENOENT') throw new ContextError('not found');
    throw e;
  }
  if (outside(await realpath(root), real)) throw new ContextError('path outside the context repo');
  return real;
}

export async function listDir(root: string, dir = ''): Promise<Entry[]> {
  const abs = await resolveSafe(root, dir);
  let items;
  try {
    items = await readdir(abs, { withFileTypes: true });
  } catch (e) {
    if (code(e) === 'ENOTDIR') throw new ContextError('not a directory');
    throw e;
  }
  const out: Entry[] = [];
  for (const d of items) {
    if (d.name === '.git') continue;
    if (d.isDirectory()) out.push({ name: d.name, type: 'dir' });
    else if (d.isFile()) out.push({ name: d.name, type: 'file' });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export async function readContext(
  root: string,
  path: string,
): Promise<{ content: string; version: string }> {
  const abs = await resolveSafe(root, path);
  let buf: Buffer;
  try {
    buf = await readFile(abs);
  } catch (e) {
    if (code(e) === 'EISDIR') throw new ContextError('not a file');
    throw e;
  }
  return { content: buf.toString('utf8'), version: createHash('sha256').update(buf).digest('hex') };
}

export async function searchContext(root: string, query: string): Promise<Match[]> {
  if (!query.trim()) throw new ContextError('query must not be empty');
  const files = ((await readdir(root, { recursive: true })) as string[])
    .filter((f) => f.endsWith('.md') && !f.split(sep).includes('.git'))
    .sort();
  const q = query.toLowerCase();
  const matches: Match[] = [];
  for (const rel of files) {
    let abs: string;
    try {
      abs = await resolveSafe(root, rel);
    } catch (e) {
      if (e instanceof ContextError) continue; // symlink escapes
      throw e;
    }
    const lines = (await readFile(abs, 'utf8')).split('\n');
    for (const [i, line] of lines.entries()) {
      if (!line.toLowerCase().includes(q)) continue;
      matches.push({ path: rel.split(sep).join('/'), line: i + 1, text: line.trim() });
      if (matches.length === SEARCH_LIMIT) return matches;
    }
  }
  return matches;
}
