import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { seedLocalEmails } from '../adapters/email-templates';
import { EmailComposer } from './work/EmailComposer';
import EmailTemplatesPage from './EmailTemplatesPage';

const admin = { value: true };
vi.mock('../../lib/auth', () => ({ useAuth: () => ({ me: { user: { id: 'u1', name: 'Asha', email: 'a@x.test' } }, can: () => admin.value }) }));
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});
beforeEach(() => {
  admin.value = true;
  seedLocalEmails([]);
});
const wrap = (node: React.ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);
const docs = { id: 'm1', name: 'Documents needed', subject: 'We need a few more documents', body: 'Please send the documents listed below.' };

describe('Email templates page', () => {
  it('saves an email once it has a name, a subject and a message', async () => {
    wrap(<EmailTemplatesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'New email' }));
    const dialog = await screen.findByRole('dialog');
    const add = within(dialog).getByRole('button', { name: 'Add to the library' });
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Thank you');
    await userEvent.type(within(dialog).getByLabelText('Subject'), 'Thank you for writing');
    expect(add).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Message'), 'We have your request.');
    await userEvent.click(add);
    const row = await screen.findByRole('row', { name: /Thank you/ });
    expect(row).toHaveTextContent('Thank you for writing');
    expect(row).toHaveTextContent('We have your request.');
  });

  it('people who cannot manage the library can read it only', async () => {
    admin.value = false;
    seedLocalEmails([docs]);
    wrap(<EmailTemplatesPage />);
    expect(await screen.findByRole('row', { name: /Documents needed/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New email' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change Documents needed' })).toBeNull();
  });
});

describe('Writing to a requester from a record', () => {
  it('offers the form\'s own emails and the organisation\'s saved ones, and sends the words chosen', async () => {
    seedLocalEmails([docs, { id: 'm2', name: 'Own one', subject: 'From the library', body: 'x' }]);
    const sent = vi.fn(async () => undefined);
    wrap(<EmailComposer to="ravi@example.test" templates={[{ key: 'own', name: 'Own one', subject: 'From the form', body: 'The form\'s words.' }]} busy={false} onSend={sent} />);
    await userEvent.click(screen.getByRole('button', { name: /Email requester/ }));
    await userEvent.click(await screen.findByRole('combobox'));
    // One of each name: the form's own wins over a saved email of the same name.
    expect(screen.getAllByRole('option').map((o) => o.textContent).filter((t) => t === 'Own one')).toHaveLength(1);
    await userEvent.click(screen.getByRole('option', { name: 'Documents needed' }));
    await userEvent.click(screen.getByRole('button', { name: /^Send/ }));
    // A saved email is not one of the form's templates, so it is sent as written words, not by key.
    expect(sent).toHaveBeenCalledWith({ subject: 'We need a few more documents', body: 'Please send the documents listed below.', templateKey: undefined, requestInfo: undefined });
  });
});
