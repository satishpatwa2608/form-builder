/**
 * Operator tool: put an organisation on a plan (until a billing provider does it).
 *   node dist/cli/set-plan.js <orgId> <FREE|TEAM|BUSINESS|ENTERPRISE>
 * Reads MONGODB_URL from the environment. Records who ran it in the audit log.
 */
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import mongoose from 'mongoose';
import { PLAN_IDS, type PlanId } from '../plans/plans';

async function main() {
  const [orgId, plan] = process.argv.slice(2);
  if (!orgId || !(PLAN_IDS as readonly string[]).includes(plan ?? '')) {
    console.error(`usage: set-plan <orgId> <${PLAN_IDS.join('|')}>`);
    process.exit(2);
  }
  if (!process.env.MONGODB_URL) throw new Error('Set MONGODB_URL');
  await mongoose.connect(process.env.MONGODB_URL);
  const db = mongoose.connection.db!;
  const org = await db.collection('organizations').findOne({ id: orgId });
  if (!org) throw new Error(`No organisation ${orgId}`);
  await db.collection('organizations').updateOne({ id: orgId }, { $set: { plan: plan as PlanId, planChangedAt: new Date() } });
  await db.collection('audit_log').insertOne({
    id: randomUUID(),
    orgId,
    actorId: `operator:${userInfo().username}`,
    action: 'org.plan_changed',
    targetType: 'organization',
    targetId: orgId,
    before: { plan: org.plan || null },
    after: { plan },
    ip: '',
    userAgent: '',
    at: new Date(),
  });
  console.log(`${org.name}: ${org.plan || '(default)'} -> ${plan}. The API picks it up within a minute.`);
  await mongoose.disconnect();
}
main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
