import { statSync } from 'node:fs';
import { join } from 'node:path';
import { buildDeveloperTable, type Developer, type DeveloperTable } from './auth.ts';

export type Config = { contextDir: string; developers: DeveloperTable; ticketKey: string; port: number };

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const problems: string[] = [];

  const contextDir = env.HIVE_CONTEXT_DIR;
  if (!contextDir) problems.push('HIVE_CONTEXT_DIR: required');
  else if (!statSync(contextDir, { throwIfNoEntry: false })?.isDirectory()) {
    problems.push('HIVE_CONTEXT_DIR: not an existing directory');
  } else if (!statSync(join(contextDir, '.git'), { throwIfNoEntry: false })) {
    problems.push('HIVE_CONTEXT_DIR: not a git repository (no .git)');
  }

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

  const ticketKey = env.HIVE_TICKET_KEY;
  if (!ticketKey || !/^[A-Z][A-Z0-9]*$/.test(ticketKey)) {
    problems.push('HIVE_TICKET_KEY: must be uppercase letters/digits starting with a letter, e.g. HIVE');
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
