import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordSignature } from '../../adapters/workflow';
import { SignaturesSection, signerLine } from './SignaturesSection';

const state = vi.hoisted(() => ({ requests: [] as unknown[], files: [] as string[] }));
vi.mock('../../adapters/workflow', () => ({ useRecordSignatures: () => ({ data: state.requests }) }));
vi.mock('../../../lib/api', () => ({
  apiFile: async (path: string) => {
    state.files.push(path);
    return new Blob(['%PDF'], { type: 'application/pdf' });
  },
}));

const request = (over: Partial<RecordSignature> = {}): RecordSignature => ({
  id: 'sig1',
  title: 'Loan agreement LN-000001',
  status: 'WAITING',
  order: 'IN_ORDER',
  expiresAt: '2026-11-01T00:00:00.000Z',
  hasSignedDocument: false,
  signers: [
    { email: 'asha@example.com', name: 'Asha Rao', status: 'SIGNED', signedAt: '2026-10-09T10:00:00.000Z' },
    { email: 'ravi@example.com', name: '', status: 'SENT' },
    { email: 'meena@example.com', name: '', status: 'WAITING' },
  ],
  ...over,
});

beforeEach(() => {
  state.requests = [];
  state.files = [];
  URL.createObjectURL = vi.fn(() => 'blob:signed');
  URL.revokeObjectURL = vi.fn();
});

describe('signatures on a record', () => {
  it('shows nothing when nothing was sent for signature', () => {
    const { container } = render(<SignaturesSection recordId="r1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists the signers in order with how far each has got', () => {
    state.requests = [request()];
    render(<SignaturesSection recordId="r1" reference="LN-000001" />);
    const section = screen.getByRole('region', { name: 'Signatures' });
    expect(within(section).getByText('Loan agreement LN-000001')).toBeInTheDocument();
    expect(within(section).getByText(/Waiting for signatures · open until 01 Nov 2026/)).toBeInTheDocument();
    const items = within(section).getAllByRole('listitem').map((li) => li.textContent);
    expect(items[0]).toMatch(/^1\. asha@example\.com - Signed as Asha Rao on 09 Oct 2026/);
    expect(items[1]).toBe('2. ravi@example.com - Asked, not signed yet');
    expect(items[2]).toBe('3. meena@example.com - Waiting for their turn');
    expect(within(section).queryByRole('button', { name: 'Download signed PDF' })).toBeNull();
  });

  it('offers the signed PDF once everyone has signed, fetched with the session', async () => {
    state.requests = [request({ status: 'SIGNED', hasSignedDocument: true })];
    render(<SignaturesSection recordId="r1" reference="LN-000001" />);
    expect(screen.getByText('Signed by everyone')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Download signed PDF' }));
    await waitFor(() => expect(state.files).toEqual(['/records/r1/signatures/sig1/document']));
  });

  it('says who declined and why, and who never signed', () => {
    const declined = { status: 'DECLINED' as const };
    expect(signerLine({ email: 'a@x.test', name: '', status: 'DECLINED', signedAt: null, declineReason: 'Wrong amount' }, declined)).toBe('Declined - "Wrong amount"');
    expect(signerLine({ email: 'b@x.test', name: '', status: 'WAITING' }, declined)).toBe('Did not sign');
    expect(signerLine({ email: 'b@x.test', name: '', status: 'SENT' }, { status: 'EXPIRED' })).toBe('Did not sign');
  });
});
