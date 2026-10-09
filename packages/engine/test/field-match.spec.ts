import { describe, expect, it } from 'vitest';
import { guessSource, mappedValues, matchFields } from '../src';

describe('which answer fills which field of another system', () => {
  const answers = ['email', 'last_name', 'companyName', 'phone', 'notes'];

  it('matches the same name, then the same name read loosely', () => {
    expect(guessSource('email', answers)).toBe('email');
    expect(guessSource('Email', answers)).toBe('email');
    expect(guessSource('LastName', answers)).toBe('last_name');
    expect(guessSource('Company_Name__c', answers)).toBe('companyName');
    expect(guessSource('Street', answers)).toBeUndefined();
    // An exact name wins over a loose one; two loose ones are nobody's guess.
    expect(guessSource('Phone', ['phone', 'Phone'])).toBe('Phone');
    expect(guessSource('Phone', ['phone', 'PHONE'])).toBeUndefined();
    expect(guessSource('__c', answers)).toBeUndefined();
  });

  it('a choice made by hand wins, "leave empty" is a choice, and a choice for an answer that is gone falls back to the guess', () => {
    const targets = ['Email', 'LastName', 'Description', 'Phone'];
    expect(matchFields(targets, answers)).toEqual({ Email: 'email', LastName: 'last_name', Phone: 'phone' });
    expect(matchFields(targets, answers, { Description: 'notes', Phone: '', Email: 'removed_field' })).toEqual({ Email: 'email', LastName: 'last_name', Description: 'notes' });
  });

  it('sends each matched answer under the other system\'s name, and nothing else', () => {
    const values = { email: 'a@b.test', last_name: 'Rao', notes: 'Call me', internal: 'secret', phone: undefined };
    expect(mappedValues(['Email', 'LastName', 'Description', 'Phone'], values, { Description: 'notes' })).toEqual({ Email: 'a@b.test', LastName: 'Rao', Description: 'Call me' });
  });
});
