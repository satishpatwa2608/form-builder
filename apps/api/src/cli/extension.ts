/**
 * Operator tool: an organisation's extension container.
 *   node dist/cli/extension.js install <orgId> <http://host:port>   registers it and prints its secret, once
 *   node dist/cli/extension.js sync <orgId> <ref>                   reads what it offers (after it has started)
 *   node dist/cli/extension.js list <orgId>
 *   node dist/cli/extension.js remove <orgId> <ref>
 * And, for the server's deploy service (infra/pilot/ext-deployer.sh), which runs what customers ask for themselves:
 *   node dist/cli/extension.js deploy-next                          takes the next request; prints it as KEY=value lines, or nothing
 *   node dist/cli/extension.js deploy-done <id> <LIVE|FAILED|REMOVED> <message>   records how it went (output on stdin)
 * Uses the API's own environment (MONGODB_URL, SECRET_KEY or KMS_KEY_ID). Recorded in the audit log.
 */
import 'reflect-metadata';
import { userInfo } from 'node:os';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { loadConfig } from '../config';
import { ExtensionDeployService } from '../extensions/extension-deploy.service';
import { ExtensionsService } from '../extensions/extensions.service';

const USAGE = 'usage: extension install <orgId> <http://host:port> | sync <orgId> <ref> | list <orgId> | remove <orgId> <ref>';

async function main() {
  const [command, orgId, arg, more] = process.argv.slice(2);
  const deploying = command === 'deploy-next' || (command === 'deploy-done' && !!orgId && ['LIVE', 'FAILED', 'REMOVED'].includes(arg ?? ''));
  if (!deploying && (!['install', 'sync', 'list', 'remove'].includes(command ?? '') || !orgId || (command !== 'list' && !arg))) {
    console.error(USAGE);
    process.exit(2);
  }
  // This process only writes a row: it must not start taking jobs off the queue.
  const app = await NestFactory.createApplicationContext(AppModule.forRoot(loadConfig({ ...process.env, JOBS_ROLE: 'enqueue' })), { logger: ['error'] });
  try {
    if (command === 'deploy-next') {
      const job = await app.get(ExtensionDeployService).takeNext();
      // Every value has been checked against a strict pattern: nothing here needs quoting.
      if (job) console.log(`ID=${job.id}\nKIND=${job.kind}\nORG=${job.orgId}\nIMAGE=${job.image}`);
      return;
    }
    if (command === 'deploy-done') {
      let output = '';
      if (!process.stdin.isTTY) for await (const chunk of process.stdin) output += chunk;
      await app.get(ExtensionDeployService).finish(orgId!, arg as 'LIVE' | 'FAILED' | 'REMOVED', more ?? '', output);
      return;
    }
    const extensions = app.get(ExtensionsService);
    const operator = userInfo().username;
    if (command === 'install') {
      const made = await extensions.install(orgId, arg!, operator);
      console.log(`Installed as ${made.ref}. Start the container with:\n  FB_EXTENSION_SECRET=${made.secret}\n  FB_ORG_ID=${orgId}\nThe secret is not shown again. Then: extension sync ${orgId} ${made.ref}`);
    } else if (command === 'sync') {
      const view = await extensions.syncByRef(orgId, arg!);
      console.log(`${view.name}: ${view.steps.length} step(s), ${view.lists.length} list(s), ${view.checks.length} check(s)`);
    } else if (command === 'remove') {
      await extensions.uninstall(orgId, arg!, operator);
      console.log(`Removed ${arg}. Forms that used it must be changed before they can be published again.`);
    } else {
      for (const v of await extensions.list(orgId)) console.log(`${v.ref}  ${v.status.padEnd(11)}  ${v.name}  (${v.steps.length} steps, ${v.lists.length} lists, ${v.checks.length} checks)${v.lastError ? `  ${v.lastError}` : ''}`);
    }
  } finally {
    await app.close();
  }
}
main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
