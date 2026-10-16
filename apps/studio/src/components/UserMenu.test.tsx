import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { UserMenu } from './UserMenu';

const signOut = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../lib/auth', () => ({
  useAuth: () => ({ me: { user: { name: 'Satish Narayan', email: 'satish@acme.test' } }, signOut }),
}));

function Where() {
  const at = useLocation();
  return <div data-testid="at">{at.pathname + at.hash}</div>;
}

const show = () =>
  render(
    <MemoryRouter initialEntries={['/']}>
      <UserMenu />
      <Routes>
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );

describe('the account menu, top right', () => {
  it('opens from the name, says who is signed in, and goes to the profile', async () => {
    const user = userEvent.setup();
    show();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Satish Narayan: your account' }));
    expect(screen.getByRole('menu', { name: 'Your account' })).toHaveTextContent('satish@acme.test');
    expect(screen.getByRole('menuitem', { name: 'Your profile' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Account & security' })).toHaveFocus();
    await user.click(screen.getByRole('menuitem', { name: 'Your profile' }));
    expect(screen.getByTestId('at')).toHaveTextContent('/account#profile');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes with Escape or a click outside; signs out', async () => {
    const user = userEvent.setup();
    show();
    const button = screen.getByRole('button', { name: /your account/ });
    await user.click(button);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
    await user.click(button);
    await user.click(screen.getByTestId('at'));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await user.click(button);
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalled();
    expect(screen.getByTestId('at')).toHaveTextContent('/login');
  });
});
