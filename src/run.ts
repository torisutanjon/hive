import { ConfigError, loadConfig, type Config } from './config.ts';
import { checkOrigin } from './repo.ts';
import { createHiveServer } from './server.ts';

export async function runHive(env: NodeJS.ProcessEnv): Promise<void> {
  let config: Config;
  try {
    config = loadConfig(env);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }

  const problem = await checkOrigin(config.contextDir);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }

  createHiveServer(config).listen(config.port, '127.0.0.1', () =>
    console.log(`hive listening on http://127.0.0.1:${config.port}`),
  );
}
