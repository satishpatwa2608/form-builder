/**
 * Operator tool, after SECRET_KEY was changed (the old one moved to SECRET_KEY_PREVIOUS, the API restarted):
 * seals again with the new key everything only an old key opens.
 *   node dist/cli/rotate-secrets.js [--check]
 * Reads MONGODB_URL, SECRET_KEY and SECRET_KEY_PREVIOUS from the environment. When a run finds nothing more to
 * do, SECRET_KEY_PREVIOUS can be removed. See docs/operations.md, "Keys".
 */
import mongoose from 'mongoose';
import { installationBox, previousKeys } from '../common/crypto';
import { rotateSecrets } from '../common/rotate-secrets';

async function main() {
  const check = process.argv.includes('--check');
  for (const name of ['MONGODB_URL', 'SECRET_KEY'] as const) if (!process.env[name]) throw new Error(`Set ${name}`);
  const config = { SECRET_KEY: process.env.SECRET_KEY!, SECRET_KEY_PREVIOUS: process.env.SECRET_KEY_PREVIOUS };
  if (!previousKeys(config).length) throw new Error('Set SECRET_KEY_PREVIOUS to the key (or keys) being replaced');
  await mongoose.connect(process.env.MONGODB_URL!);
  const report = await rotateSecrets(mongoose.connection.db!, installationBox(config), check);
  const total = Object.values(report.resealed).reduce((a, b) => a + b, 0);
  for (const [name, n] of Object.entries(report.resealed)) console.log(`${name}: ${n}`);
  if (check) console.log(total ? `${total} value(s) are still sealed with a previous key.` : 'Nothing is sealed with a previous key: SECRET_KEY_PREVIOUS can be removed.');
  else console.log(`${total} value(s) sealed again with the current key.${report.skipped ? ` ${report.skipped} changed while this ran: run it again.` : ''}`);
  await mongoose.disconnect();
}
main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
