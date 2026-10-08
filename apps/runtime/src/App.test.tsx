import { describe, expect, it } from 'vitest';
import { parseDomainPath, parseFormPath } from './App';

describe('public form links', () => {
  it('accept /f/:org/:code only, with the engine code format', () => {
    expect(parseFormPath('/f/5b1e-org/CUSTOMER_COMPLAINT')).toEqual({ org: '5b1e-org', code: 'CUSTOMER_COMPLAINT' });
    expect(parseFormPath('/f/org/CODE/')).toEqual({ org: 'org', code: 'CODE' });
    expect(parseFormPath('/f/org/lowercase')).toBeNull();
    expect(parseFormPath('/f/../CODE')).toBeNull();
    expect(parseFormPath('/f/org')).toBeNull();
    expect(parseFormPath('/')).toBeNull();
  });

  it('on a custom domain, the path is just the form code', () => {
    expect(parseDomainPath('/CUSTOMER_COMPLAINT')).toEqual({ code: 'CUSTOMER_COMPLAINT' });
    expect(parseDomainPath('/lower')).toBeNull();
    expect(parseDomainPath('/f/org/CODE')).toBeNull();
  });
});
