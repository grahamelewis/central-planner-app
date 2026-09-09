import { deployRelease, rollbackRelease } from '../lib/deployment.js';

const args = process.argv.slice(2);
const usage = 'Usage: node app/scripts/deploy.mjs --source /absolute/source --installation /absolute/runtime --data-root /absolute/existing-data\n       node app/scripts/deploy.mjs --rollback --installation /absolute/runtime';
try {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--rollback') { opts.rollback = true; continue; }
    if (!['--source', '--installation', '--data-root'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--') || opts[key]) throw new Error(usage);
    opts[key] = args[++i];
  }
  if (!opts['--installation'] || (opts.rollback ? opts['--source'] || opts['--data-root'] : !opts['--source'] || !opts['--data-root'])) throw new Error(usage);
  const result = opts.rollback ? await rollbackRelease(opts['--installation']) : await deployRelease({
    sourceRoot: opts['--source'], installationRoot: opts['--installation'], dataRoot: opts['--data-root'],
  });
  console.log(JSON.stringify(result, null, 2));
  console.log('Release selected. Restart explicitly; existing processes and data were not changed.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
