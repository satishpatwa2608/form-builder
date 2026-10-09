import { format } from 'date-fns';
import { toast } from 'sonner';
import { Button } from '@ui/button';
import { useRecordSignatures, type RecordSignature } from '../../adapters/workflow';

const REQUEST_LABEL: Record<RecordSignature['status'], string> = { WAITING: 'Waiting for signatures', SIGNED: 'Signed by everyone', DECLINED: 'Declined', EXPIRED: 'Not signed in time' };
const when = (at?: string | null) => (at ? format(new Date(at), 'dd MMM yyyy, HH:mm') : '');

/** One signer, in plain words: what they did and when, or what they are waiting for. */
export function signerLine(s: RecordSignature['signers'][number], request: Pick<RecordSignature, 'status'>): string {
  if (s.status === 'SIGNED') return `Signed${s.name ? ` as ${s.name}` : ''}${s.signedAt ? ` on ${when(s.signedAt)}` : ''}`;
  if (s.status === 'DECLINED') return `Declined${s.signedAt ? ` on ${when(s.signedAt)}` : ''}${s.declineReason ? ` - "${s.declineReason}"` : ''}`;
  if (request.status !== 'WAITING') return 'Did not sign';
  return s.status === 'SENT' ? 'Asked, not signed yet' : 'Waiting for their turn';
}

/** Documents of this record that were sent out for signature: who has signed, and the signed PDF once all have. */
export function SignaturesSection({ recordId, reference }: { recordId: string | undefined; reference?: string }) {
  const { data: requests = [] } = useRecordSignatures(recordId);
  if (!requests.length) return null;

  // Fetched with the session and saved as a file: a plain link could not carry the sign-in.
  const download = async (request: RecordSignature) => {
    try {
      const { apiFile } = await import('../../../lib/api');
      const url = URL.createObjectURL(await apiFile(`/records/${encodeURIComponent(recordId!)}/signatures/${encodeURIComponent(request.id)}/document`));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${(reference || 'document').replace(/[^A-Za-z0-9._-]/g, '_')}-signed.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : "Couldn't get the signed PDF");
    }
  };

  return (
    <section className="fb-settings" style={{ gap: 10 }} aria-label="Signatures">
      {requests.map((r) => (
        <div key={r.id} className="fb-panel fb-settings" style={{ gap: 8 }}>
          <div className="flex items-center gap-2" style={{ flexWrap: 'wrap', justifyContent: 'space-between' }}>
            <strong>{r.title}</strong>
            <span className="fb-muted">
              {REQUEST_LABEL[r.status]}
              {r.status === 'WAITING' ? ` · open until ${format(new Date(r.expiresAt), 'dd MMM yyyy')}` : ''}
            </span>
          </div>
          <ul className="fb-settings" style={{ gap: 4, listStyle: 'none', padding: 0, margin: 0 }}>
            {r.signers.map((s, i) => (
              <li key={`${s.email}-${i}`} className="text-sm">
                {r.order === 'IN_ORDER' && r.signers.length > 1 ? `${i + 1}. ` : ''}
                {s.email} <span className="fb-muted">- {signerLine(s, r)}</span>
              </li>
            ))}
          </ul>
          {r.hasSignedDocument && (
            <div>
              <Button type="button" variant="outline" size="sm" onClick={() => void download(r)}>
                Download signed PDF
              </Button>
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
