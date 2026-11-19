#!/usr/bin/env node
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { install, projectRoot, readHiveConfig, startEnv } from './install.ts';
import { runHive } from './run.ts';

const USAGE = `usage:
  npx hive-collab-context <ssh-url>   set up Hive for this project (git@host:owner/repo.git)
  npx hive-collab-context start       start this project's Hive
`;

const [arg] = process.argv.slice(2);
try {
  if (arg === undefined || arg === '--help') console.log(USAGE);
  else if (arg === 'start') {
    const root = await projectRoot(process.cwd(), process.env);
    await runHive(startEnv(await readHiveConfig(homedir()), root, process.env));
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      await install(arg, { home: homedir(), cwd: process.cwd(), env: process.env, ask: (q) => rl.question(q), log: (l) => console.log(l) });
    } finally {
      rl.close();
    }
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
