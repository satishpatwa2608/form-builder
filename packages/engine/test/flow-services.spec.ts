import { describe, expect, it } from 'vitest';
import { flowAddressLabel, isFlowAddress, validateFormDefinition, type FormDefinition } from '../src';
import base from './fixtures/customer-complaint-basic.json';

describe('addresses of automation tools', () => {
  it('each tool has its own, and only its own', () => {
    expect(isFlowAddress('POWER_AUTOMATE', 'https://prod-12.centralindia.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?api-version=2016-06-01&sig=XYZ')).toBe(true);
    expect(isFlowAddress('POWER_AUTOMATE', 'https://0123456789abcdef0123456789abcd.ef.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/abc/triggers/manual/paths/invoke?sig=XYZ')).toBe(true);
    expect(isFlowAddress('WORKFRONT_FUSION', 'https://hook.fusion.adobe.com/abc123')).toBe(true);
    expect(isFlowAddress('WORKFRONT_FUSION', 'https://hook.app.workfrontfusion.com/abc123')).toBe(true);
    expect(isFlowAddress('ZAPIER', 'https://hooks.zapier.com/hooks/catch/1/abc/')).toBe(true);
    expect(isFlowAddress('MAKE', 'https://hook.eu1.make.com/abc')).toBe(true);
    // One tool's address is not another's.
    expect(isFlowAddress('ZAPIER', 'https://hook.eu1.make.com/abc')).toBe(false);
    expect(isFlowAddress('POWER_AUTOMATE', 'https://hooks.zapier.com/hooks/catch/1/abc/')).toBe(false);
  });

  it.each([
    ['plain http', 'http://hooks.zapier.com/hooks/catch/1/abc/'],
    ['a look-alike host', 'https://hooks.zapier.com.evil.example/x'],
    ['the real host as a user name', 'https://hooks.zapier.com@evil.example/x'],
    ['the real host after a user name', 'https://evil.example@hooks.zapier.com/x'],
    ['the real host in the path', 'https://evil.example/hooks.zapier.com/x'],
    ['another port', 'https://hooks.zapier.com:8443/x'],
    ['a backslash', 'https://hooks.zapier.com\\@evil.example/x'],
    ['an address inside the network', 'https://169.254.169.254/latest'],
    ['nothing', ''],
    ['not an address', 'hooks.zapier.com/x'],
  ])('refuses %s', (_name, url) => {
    expect(isFlowAddress('ZAPIER', url)).toBe(false);
  });

  it('shows where a flow goes without the secret in its address', () => {
    expect(flowAddressLabel('https://prod-12.centralindia.logic.azure.com:443/workflows/abc?sig=SECRET')).toBe('prod-12.centralindia.logic.azure.com');
    expect(flowAddressLabel('nonsense')).toBe('');
  });

  it('a draft may hold a half-set step; publishing asks for a real address of that tool', () => {
    const def = (url: string) => ({ ...(base as unknown as FormDefinition), automations: [{ id: 'a', name: 'To the team', enabled: true, when: 'SUBMITTED' as const, actions: [{ type: 'FLOW' as const, service: 'POWER_AUTOMATE' as const, url }] }] });
    const issues = (url: string, level: 'shape' | 'publish') => {
      const r = validateFormDefinition(def(url), level);
      return r.success ? [] : r.issues.map((i) => i.message);
    };
    expect(issues('', 'shape')).toEqual([]);
    expect(issues('', 'publish')).toEqual(expect.arrayContaining([expect.stringContaining("paste the Power Automate flow's address")]));
    expect(issues('https://hooks.zapier.com/hooks/catch/1/abc/', 'publish')).toEqual(expect.arrayContaining([expect.stringContaining('that is not a Power Automate address')]));
    expect(issues('https://prod-12.centralindia.logic.azure.com:443/workflows/abc?sig=x', 'publish')).toEqual([]);
  });
});
