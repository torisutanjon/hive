import { lstatSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { buildDeveloperTable, type Developer, type DeveloperTable } from './auth.ts';

export type Config = { contextDir: string; developers: DeveloperTable; ticketKey: string; port: number };

export const KEY = /^[A-Z][A-Z0-9]*$/;
const KEY_FORMAT = 'uppercase letters/digits starting with a letter, e.g. HIVE';

// Read ticket_key from <contextDir>/project.md frontmatter. Returns the key or pushes a problem.
export function readTicketKey(contextDir: string, problems: string[]): string | undefined {
  const p = join(contextDir, 'project.md');
  if (!lstatSync(p, { throwIfNoEntry: false })?.isFile()) {
    problems.push(`project.md: missing or not a regular file; it must set ticket_key (${KEY_FORMAT})`);
    return undefined;
  }
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(readFileSync(p, 'utf8').replace(/\r\n/g, '\n'));
  let key: unknown;
  try {
    if (m) key = (parse(m[1] as string) as { ticket_key?: unknown } | null)?.ticket_key;
  } catch {
    // fall through to the format problem
  }
  if (typeof key !== 'string' || !KEY.test(key)) {
    problems.push(`project.md: ticket_key must be ${KEY_FORMAT}`);
    return undefined;
  }
  return key;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const problems: string[] = [];

  let ticketKey: string | undefined;
  const contextDir = env.HIVE_CONTEXT_DIR;
  if (!contextDir) problems.push('HIVE_CONTEXT_DIR: required');
  else if (!statSync(contextDir, { throwIfNoEntry: false })?.isDirectory()) {
    problems.push('HIVE_CONTEXT_DIR: not an existing directory');
  } else if (!statSync(join(contextDir, '.git'), { throwIfNoEntry: false })) {
    problems.push('HIVE_CONTEXT_DIR: not a git repository (no .git)');
  } else ticketKey = readTicketKey(contextDir, problems);

  let tokens: Record<string, unknown> = {};
  if (!env.HIVE_TOKENS) problems.push('HIVE_TOKENS: required');
  else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(env.HIVE_TOKENS);
    } catch {
      // never surface the parse error: V8 echoes the input
      problems.push('HIVE_TOKENS: not valid JSON');
    }
    if (parsed !== undefined) {
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
        problems.push('HIVE_TOKENS: must be a JSON object with at least one token');
      } else {
        tokens = parsed as Record<string, unknown>;
        Object.entries(tokens).forEach(([token, value], idx) => {
          const i = idx + 1;
          if (token.length < 32) problems.push(`HIVE_TOKENS: token #${i} is shorter than 32 characters`);
          const d = value as Partial<Developer> | null;
          const ok =
            typeof d === 'object' &&
            d !== null &&
            typeof d.name === 'string' &&
            d.name !== '' &&
            typeof d.email === 'string' &&
            d.email.includes('@');
          if (!ok) problems.push(`HIVE_TOKENS: entry #${i} needs a name and an email`);
        });
      }
    }
  }

  const port = Number(env.PORT);
  if (!/^\d+$/.test(env.PORT ?? '') || port < 1 || port > 65535) {
    problems.push('PORT: must be an integer 1-65535');
  }

  if (problems.length) throw new ConfigError('Invalid Hive config:\n' + problems.map((p) => `- ${p}`).join('\n'));

  return {
    contextDir: contextDir as string,
    developers: buildDeveloperTable(tokens as Record<string, Developer>),
    ticketKey: ticketKey as string,
    port,
  };
}
