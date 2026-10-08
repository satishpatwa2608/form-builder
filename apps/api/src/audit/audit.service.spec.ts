import { redact } from './audit.service';

describe('audit redaction', () => {
  it('hides secrets but keeps identifiers readable', () => {
    expect(
      redact({ code: 'CUSTOMER_COMPLAINT', key: 'brand', password: 'x', newPassword: 'y', refreshToken: 't', tokenHash: 'h', apiKey: 'k', recoveryCodes: ['a'], secret: 's', version: 2 }),
    ).toEqual({
      code: 'CUSTOMER_COMPLAINT',
      key: 'brand',
      password: '[redacted]',
      newPassword: '[redacted]',
      refreshToken: '[redacted]',
      tokenHash: '[redacted]',
      apiKey: '[redacted]',
      recoveryCodes: '[redacted]',
      secret: '[redacted]',
      version: 2,
    });
  });
});
