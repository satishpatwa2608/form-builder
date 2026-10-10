import { describe, expect, it } from 'vitest';

/**
 * In the job that exists to test the connectors against real databases (REQUIRE_DATABASES), every one of them
 * must be named: the tests that use them skip themselves quietly when their address is missing, and a job that
 * skipped them all would look just as green.
 */
describe.skipIf(!process.env.REQUIRE_DATABASES)('the real-database job', () => {
  it('has every database it is there to test', () => {
    for (const name of ['PG_TEST', 'MYSQL_TEST', 'MSSQL_TEST', 'ORACLE_TEST']) expect(process.env[name], name).toMatch(/^[^:]+:\d+:.+$/);
  });
});
