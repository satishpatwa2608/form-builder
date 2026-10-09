import { describe, expect, it } from 'vitest';
import { createVisit } from './visit';

describe('what a visit is counted as', () => {
  it('values that arrive before the person touches the page are not theirs', () => {
    const visit = createVisit();
    expect(visit.values({ name: '' })).toBe(false);
    // Filled in on opening (a default, a date set by the form).
    expect(visit.values({ name: '', arrival: '2026-10-09' })).toBe(false);
    expect(visit.summary(false)).toBeNull();
  });

  it('starts at the first answer, and counts each question once', () => {
    const visit = createVisit();
    visit.values({ name: '', email: '' });
    visit.interact();
    expect(visit.values({ name: 'A', email: '' }, 'name')).toBe(true);
    expect(visit.values({ name: 'Asha', email: '' }, 'name')).toBe(false);
    expect(visit.values({ name: 'Asha', email: 'a@x.test' }, 'email')).toBe(false);
    expect(visit.summary(true)).toEqual({ answered: ['name', 'email'], mistakes: [] });
  });

  it('leaving says where: the question being worked on, not one a rule changed with it', () => {
    const visit = createVisit();
    visit.values({ country: '', state: 'KA', total: 0 });
    visit.interact();
    // Choosing a country clears the state and recalculates the total.
    visit.values({ country: 'IN', state: '', total: 5 }, 'country');
    expect(visit.summary(false)).toEqual({ answered: ['country', 'total'], mistakes: [], leftAt: 'country' });
  });

  it('an answer that was typed and then emptied was touched but is not answered', () => {
    const visit = createVisit();
    visit.values({ name: '', tags: [] });
    visit.interact();
    visit.values({ name: 'A', tags: [] }, 'name');
    visit.values({ name: '', tags: [] }, 'name');
    expect(visit.summary(false)).toEqual({ answered: [], mistakes: [], leftAt: 'name' });
  });

  it('mistakes are counted by question, rows of a repeating section under the section', () => {
    const visit = createVisit();
    visit.values({ name: '' });
    visit.interact();
    visit.values({ name: 'A' });
    visit.problems(['email', 'items.0.qty', 'items.1.qty', 'email']);
    expect(visit.summary(true)).toEqual({ answered: ['name'], mistakes: ['email', 'items'] });
  });
});
