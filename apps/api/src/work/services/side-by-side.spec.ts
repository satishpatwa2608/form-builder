import type { AutomationAction } from '@fb/engine';
import { sideBySideEnd } from './form-automation.service';

const email = (withPrevious = false): AutomationAction => ({ type: 'EMAIL', to: [], subject: 's', body: 'b', ...(withPrevious ? { withPrevious } : {}) });
const notify = (withPrevious = false): AutomationAction => ({ type: 'NOTIFY', to: [], message: 'm', ...(withPrevious ? { withPrevious } : {}) });
const status = (withPrevious = false): AutomationAction => ({ type: 'SET_STATUS', status: 'DONE', ...(withPrevious ? { withPrevious } : {}) });

describe('which steps run together', () => {
  it('a step and those after it marked "with the one before" make one group', () => {
    const steps = [email(), notify(true), email(true), notify()];
    expect(sideBySideEnd(steps, 0)).toBe(2);
    expect(sideBySideEnd(steps, 3)).toBe(3);
  });

  it('a step that changes the record never joins a group, whatever it is marked', () => {
    // Marked, but it changes the status: it waits its turn, and ends the group before it.
    expect(sideBySideEnd([email(), status(true), email(true)], 0)).toBe(0);
    // And nothing runs together with it.
    expect(sideBySideEnd([status(), email(true)], 0)).toBe(0);
    expect(sideBySideEnd([email()], 0)).toBe(0);
  });
});
