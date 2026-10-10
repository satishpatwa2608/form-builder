import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDLE_NOTE, IdleSignOut } from './IdleSignOut';

const state = vi.hoisted(() => ({ minutes: 15 as number | undefined, signOut: vi.fn(async () => undefined), refresh: vi.fn(async () => 'token') }));
vi.mock('../lib/auth', () => ({ useAuth: () => ({ me: { org: { idleMinutes: state.minutes } }, signOut: state.signOut }) }));
vi.mock('../lib/api', () => ({ refreshSession: state.refresh }));

beforeEach(() => {
  vi.useFakeTimers();
  state.minutes = 15;
  state.signOut.mockClear();
  state.refresh.mockClear();
  window.sessionStorage.clear();
});
afterEach(() => vi.useRealTimers());
const pass = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const MIN = 60_000;

describe('signing out after time away', () => {
  it('says nothing while the person is at work, and tells the server they are there', () => {
    render(<IdleSignOut />);
    for (let i = 0; i < 20; i++) {
      pass(MIN);
      fireEvent.keyDown(window, { key: 'a' });
      pass(5000);
    }
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(state.signOut).not.toHaveBeenCalled();
    expect(state.refresh.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('warns a minute before, and "Stay signed in" starts the time again', () => {
    render(<IdleSignOut />);
    pass(14 * MIN - 5000);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    pass(10_000);
    expect(screen.getByRole('alertdialog', { name: 'Are you still there?' })).toHaveTextContent(/signed out in \d+ seconds/);
    fireEvent.click(screen.getByRole('button', { name: 'Stay signed in' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(state.refresh).toHaveBeenCalled();
    pass(10 * MIN);
    expect(state.signOut).not.toHaveBeenCalled();
  });

  it('signs out when the time is up, and leaves a note for the sign-in page', () => {
    render(<IdleSignOut />);
    pass(15 * MIN + 5000);
    expect(state.signOut).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(IDLE_NOTE)).toBe('15');
    // Nothing is told to the server on behalf of someone who is not there.
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it('an organisation that chose "never" signs nobody out', () => {
    state.minutes = 0;
    render(<IdleSignOut />);
    pass(24 * 60 * MIN);
    expect(state.signOut).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
