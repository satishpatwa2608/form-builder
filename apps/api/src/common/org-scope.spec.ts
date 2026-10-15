import mongoose, { Schema } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { renderMetrics } from './metrics';
import { OrgScopeError, orgScopePlugin, setOrgScopeMode } from './org-scope';

describe('the organisation guard', () => {
  let mongo: MongoMemoryServer;
  let conn: mongoose.Connection;
  let Things: mongoose.Model<{ orgId?: string | null; name?: string | null }>;
  let Jobs: mongoose.Model<{ orgId?: string | null; name?: string | null }>;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    conn = await mongoose.createConnection(mongo.getUri()).asPromise();
    conn.plugin(orgScopePlugin);
    Things = conn.model('Thing', new Schema({ orgId: String, name: String }), 'things');
    Jobs = conn.model('Job', new Schema({ orgId: String, name: String }), 'jobs');
    await Things.create([{ orgId: 'a', name: 'one' }, { orgId: 'b', name: 'two' }]);
  });
  afterAll(async () => {
    setOrgScopeMode('refuse');
    await conn.close();
    await mongo.stop();
  });

  it('refuses a query on an organisation\'s data that names no organisation', async () => {
    setOrgScopeMode('refuse');
    await expect(Things.find({ name: 'one' })).rejects.toBeInstanceOf(OrgScopeError);
    await expect(Things.updateMany({}, { $set: { name: 'x' } })).rejects.toBeInstanceOf(OrgScopeError);
    await expect(Things.aggregate([{ $match: { name: 'one' } }])).rejects.toBeInstanceOf(OrgScopeError);
  });

  it('lets through one that names it, one marked as working across organisations, and the reviewed global collections', async () => {
    setOrgScopeMode('refuse');
    expect(await Things.find({ orgId: 'a' })).toHaveLength(1);
    expect(await Things.find({ $and: [{ orgId: 'b' }, { name: 'two' }] })).toHaveLength(1);
    expect(await Things.find({ name: 'one' }).comment('across-orgs: a nightly sweep')).toHaveLength(1);
    expect(await Things.aggregate([{ $match: { orgId: 'a' } }])).toHaveLength(1);
    expect(await Jobs.find({})).toEqual([]);
  });

  it('in production it reports instead: once in the log per place, and every time in the numbers', async () => {
    setOrgScopeMode('report');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      for (let i = 0; i < 3; i++) expect(await Things.find({ name: 'one' })).toHaveLength(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(renderMetrics()).toMatch(/fb_unscoped_queries_total\{collection="things"\} 3/);
    } finally {
      warn.mockRestore();
    }
  });
});
