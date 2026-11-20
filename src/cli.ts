#!/usr/bin/env node
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { addProvider, install, listProviders, removeProvider, projectRoot, readHiveConfig, startEnv } from './install.ts';
import { runHive } from './run.ts';

const USAGE = `usage:
  npx hive-collab-context <ssh-url>   set up Hive for this project (git@host:owner/repo.git)
  npx hive-collab-context start       start this project's Hive
  npx hive-collab-context provider add <id> --detect <dir> --register "<cmd>"   add another agent ({url}, {token} in <cmd>)
  npx hive-collab-context provider list
  npx hive-collab-context provider remove <id>
`;

const PROMPT = 'Context repo SSH URL (git@host:owner/repo.git): ';

const [arg, ...rest] = process.argv.slice(2);
try {
  if (arg === '--help' || (arg === undefined && !process.stdin.isTTY)) console.log(USAGE);
  else if (arg === 'provider') {
    const io = { home: homedir(), cwd: process.cwd(), env: process.env, ask: () => Promise.resolve(''), log: (l: string) => console.log(l) };
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { detect: { type: 'string' }, register: { type: 'string' } } });
    const [sub, id] = positionals;
    if (sub === 'add' && id && values.detect && values.register) await addProvider(id, values.detect, values.register, io);
    else if (sub === 'list') await listProviders(io);
    else if (sub === 'remove' && id) await removeProvider(id, io);
    else throw new Error(USAGE);
  } else if (arg === 'start') {
    const root = await projectRoot(process.cwd(), process.env);
    await runHive(startEnv(await readHiveConfig(homedir()), root, process.env));
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const url = arg ?? (await rl.question(PROMPT)).trim();
      await install(url, { home: homedir(), cwd: process.cwd(), env: process.env, ask: (q) => rl.question(q), log: (l) => console.log(l) });
    } finally {
      rl.close();
    }
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
