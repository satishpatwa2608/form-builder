import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PRESET_STYLES, useStyleMaster } from '../adapters/styles/style-master';
import StylesPage from './StylesPage';

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
  useStyleMaster.setState({ styles: PRESET_STYLES });
});
const open = () => render(<QueryClientProvider client={new QueryClient()}><StylesPage /></QueryClientProvider>);

describe('Styles page', () => {
  it('lists each look with a small example of it', async () => {
    open();
    const list = await screen.findByRole('list', { name: 'Styles' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(PRESET_STYLES.length);
    expect(within(list).getByLabelText(`How ${PRESET_STYLES[0]!.name} looks`)).toBeInTheDocument();
  });

  it('makes a style from colours, sizes and picks; the example beside it changes as they do; no CSS is typed', async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'New style' }));
    const editor = screen.getByRole('region', { name: 'Style editor' });
    await user.click(within(editor).getByRole('button', { name: 'Save style' }));
    expect(within(editor).getByRole('alert')).toHaveTextContent('Give the style a name');

    await user.type(within(editor).getByLabelText('Name'), 'Warning box');
    await user.click(within(editor).getByRole('combobox', { name: 'Shadow' }));
    await user.click(await screen.findByRole('option', { name: 'Soft' }));
    await user.click(within(editor).getByRole('combobox', { name: 'Weight' }));
    await user.click(await screen.findByRole('option', { name: 'Bold' }));
    // The example is drawn with the very CSS a form would get.
    const example = within(editor).getByLabelText('How Warning box looks');
    expect(example.querySelector('style')!.textContent).toContain('font-weight:700');
    expect(example.querySelector('style')!.textContent).toContain('box-shadow');

    await user.click(within(editor).getByRole('button', { name: 'Save style' }));
    const made = useStyleMaster.getState().styles.find((s) => s.name === 'Warning box')!;
    expect(made).toMatchObject({ id: 'warning-box', props: { shadow: 'md', fontWeight: 700, borderWidth: 1 } });
    expect(await screen.findByRole('button', { name: 'Edit Warning box' })).toBeInTheDocument();
  });

  it('changes one that exists and keeps its id (forms refer to it); deleting asks first', async () => {
    const user = userEvent.setup();
    open();
    const first = PRESET_STYLES[0]!;
    await user.click(await screen.findByRole('button', { name: `Edit ${first.name}` }));
    const editor = screen.getByRole('region', { name: 'Style editor' });
    await user.clear(within(editor).getByLabelText('Name'));
    await user.type(within(editor).getByLabelText('Name'), 'Renamed');
    await user.click(within(editor).getByRole('button', { name: 'Save style' }));
    expect(useStyleMaster.getState().styles.find((s) => s.id === first.id)!.name).toBe('Renamed');

    await user.click(await screen.findByRole('button', { name: 'Delete Renamed' }));
    expect(useStyleMaster.getState().styles.some((s) => s.id === first.id)).toBe(true);
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await vi.waitFor(() => expect(useStyleMaster.getState().styles.some((s) => s.id === first.id)).toBe(false));
  });

  it('someone who cannot manage the organisation may look, and nothing more', async () => {
    admin.value = false;
    const user = userEvent.setup();
    open();
    expect(screen.queryByRole('button', { name: 'New style' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: `View ${PRESET_STYLES[0]!.name}` }));
    const editor = screen.getByRole('region', { name: 'Style editor' });
    expect(within(editor).queryByRole('button', { name: 'Save style' })).not.toBeInTheDocument();
    expect(within(editor).getByLabelText('Name')).toBeDisabled();
  });
});
