#!/usr/bin/env node
import { runHive } from './run.ts';

const USAGE = `usage:
  npx hive-collab-context <ssh-url>   set up Hive for this project (git@host:owner/repo.git)
  npx hive-collab-context start       start this project's Hive
`;

const [arg] = process.argv.slice(2);
try {
  if (arg === undefined || arg === '--help') console.log(USAGE);
  else if (arg === 'start') await runHive(process.env);
  else throw new Error(USAGE);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
