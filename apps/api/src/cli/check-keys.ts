/**
 * Restore drill, with the installation's real keys: does everything sealed in the database open?
 *   node dist/cli/check-keys.js
 * Reads MONGODB_URL, SECRET_KEY (and SECRET_KEY_PREVIOUS), and KMS_KEY_ID with AWS_REGION when data keys are
 * wrapped by KMS. Prints counts only. Exits 1 when anything does not open. See docs/operations.md, "Getting it back".
 */
import mongoose from 'mongoose';
import { installationBox, previousKeys } from '../common/crypto';
import { checkKeys } from '../common/check-keys';
import { KmsKeyProvider, LocalKeyProvider } from '../common/key-provider';

async function main() {
  for (const name of ['MONGODB_URL', 'SECRET_KEY'] as const) if (!process.env[name]) throw new Error(`Set ${name}`);
  const config = { SECRET_KEY: process.env.SECRET_KEY!, SECRET_KEY_PREVIOUS: process.env.SECRET_KEY_PREVIOUS };
  const keys = process.env.KMS_KEY_ID ? new KmsKeyProvider(process.env.KMS_KEY_ID, process.env.AWS_REGION ?? 'ap-south-1') : new LocalKeyProvider(Buffer.from(config.SECRET_KEY, 'base64'), previousKeys(config));
  await mongoose.connect(process.env.MONGODB_URL!);
  const r = await checkKeys(mongoose.connection.db!, installationBox(config), keys);
  await mongoose.disconnect();
  console.log(`SECRET_KEY opened ${r.installation.opened} of ${r.installation.sealed}; ${keys.name} data keys opened ${r.dataKeys.opened} of ${r.dataKeys.sealed}`);
  for (const [where, n] of Object.entries(r.failed)) console.log(`did not open: ${where}: ${n}`);
  if (Object.keys(r.failed).length) process.exit(1);
}
main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
