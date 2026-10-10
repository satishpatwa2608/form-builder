import { describe, expect, it } from 'vitest';
import { fieldsFor, SPECS } from './ConnectorsPage';

const names = (type: keyof typeof SPECS, auth: string) => fieldsFor(SPECS[type].fields, { auth }).map((f) => f.name);

describe('what a new connector asks for', () => {
  it('OData as an application asks for the token address, client ID, scope and secret, and for no password', () => {
    expect(names('odata', 'oauth')).toEqual(['baseUrl', 'auth', 'tokenUrl', 'clientId', 'scope', 'clientSecret']);
    expect(names('odata', 'basic')).toEqual(['baseUrl', 'auth', 'username', 'password']);
    expect(names('odata', 'apiKey')).toEqual(['baseUrl', 'auth', 'apiKeyHeader', 'token']);
    expect(names('odata', 'none')).toEqual(['baseUrl', 'auth']);
  });

  it('a REST API shows only the boxes its way of signing in needs', () => {
    expect(names('rest', 'none')).toEqual(['baseUrl', 'auth', 'resources']);
    expect(names('rest', 'bearer')).toEqual(['baseUrl', 'auth', 'resources', 'token']);
    expect(names('rest', 'basic')).toEqual(['baseUrl', 'auth', 'resources', 'username', 'password']);
    // An API that hands out tokens to applications (OAuth) is signed in to the same way as OData.
    expect(names('rest', 'oauth')).toEqual(['baseUrl', 'auth', 'tokenUrl', 'clientId', 'scope', 'resources', 'clientSecret']);
    // A person signing in also needs the address they are sent to; there is no password to type here.
    expect(names('rest', 'oauthUser')).toEqual(['baseUrl', 'auth', 'authUrl', 'tokenUrl', 'clientId', 'scope', 'resources', 'clientSecret']);
  });

  it('ways of signing in read as words, and every secret is marked as one', () => {
    for (const type of ['rest', 'odata'] as const) {
      const auth = SPECS[type].fields.find((f) => f.name === 'auth')!;
      for (const option of auth.options!) expect(auth.optionLabels![option]).toMatch(/ |None/);
    }
    const secrets = Object.values(SPECS).flatMap((s) => s.fields.filter((f) => /password|secret|token|apiKey$|^uri$|^user$|^username$/i.test(f.name) && f.name !== 'tokenUrl'));
    expect(secrets.filter((f) => !f.secret).map((f) => f.name)).toEqual([]);
  });

  it('SQL Server asks what the other databases ask', () => {
    expect(SPECS.mssql.fields.map((f) => f.name)).toEqual(['host', 'port', 'database', 'schema', 'ssl', 'user', 'password']);
  });
});
