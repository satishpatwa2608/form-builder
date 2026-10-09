import { format } from 'date-fns';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@ui/button';
import { messageOf } from '../adapters/backend';
import { useExtensions, useRefreshExtension, type ExtensionInfo, type ExtensionOffer } from '../adapters/extensions';
import { useFormPermissions } from '../hooks/useFormPermissions';
import '../styles/form-builder.css';

const STATUS: Record<ExtensionInfo['status'], string> = { NEW: 'Not started yet', OK: 'Running', UNREACHABLE: 'Not answering' };

function Offers({ title, where, items }: { title: string; where: string; items: ExtensionOffer[] }) {
  if (!items.length) return null;
  return (
    <div>
      <div className="fb-panel__title">{title}</div>
      <p className="fb-muted">{where}</p>
      <ul className="fb-offers">
        {items.map((item) => (
          <li key={item.key}>
            <strong>{item.label}</strong>
            {item.description && <span className="fb-muted"> — {item.description}</span>}
            {!!item.outputs?.length && <span className="fb-muted"> · returns {item.outputs.join(', ')}</span>}
            {!!item.params?.length && <span className="fb-muted"> · filtered by {item.params.join(', ')}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The organisation's own code: what its extension offers to forms and workflows. Installing one is done by us. */
export default function ExtensionsPage() {
  const { canManagePages } = useFormPermissions();
  const { data = [], isLoading } = useExtensions();
  const refresh = useRefreshExtension();

  if (!canManagePages) return <p className="p-6 text-sm text-muted-foreground">Extensions are managed by your organisation's administrators.</p>;

  return (
    <div className="p-6 space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold text-gray-900">Extensions</h1>
        <p className="text-sm text-muted-foreground">
          Your own code, for what cannot be set up on screen: steps in a workflow, lists for dropdowns, and checks before a submission is accepted. It runs in a service of its own, for your
          organisation only.
        </p>
      </div>
      {!isLoading && !data.length && (
        <div className="fb-banner">
          No extension is set up for your organisation. Your developers write one with the Form Builder SDK; we deploy it for you. Once it is running, what it offers appears here and in the
          builder.
        </div>
      )}
      {data.map((ext) => (
        <section key={ext.id} className="fb-extension" aria-label={ext.name}>
          <div className="flex items-center justify-between gap-4" style={{ flexWrap: 'wrap' }}>
            <div>
              <h2 className="text-lg font-semibold text-gray-900">{ext.name}</h2>
              <p className="fb-muted">
                <span data-status={ext.status} className="fb-extension__status">
                  {STATUS[ext.status]}
                </span>
                {ext.lastSyncedAt && ` · last read ${format(new Date(ext.lastSyncedAt), 'dd MMM yyyy, HH:mm')}`}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={refresh.isPending}
              title="After a new version has been deployed"
              onClick={() =>
                void refresh
                  .mutateAsync(ext.id)
                  .then((v) => toast.success(`${v.name}: ${v.steps.length} step(s), ${v.lists.length} list(s), ${v.checks.length} check(s)`))
                  .catch((e) => toast.error(messageOf(e)))
              }
            >
              <RefreshCw /> Read again
            </Button>
          </div>
          {ext.lastError && (
            <div className="fb-issues" role="alert">
              {ext.lastError}
              {ext.status === 'UNREACHABLE' && '. Forms that depend on it cannot take submissions until it answers again.'}
            </div>
          )}
          <Offers title="Workflow steps" where="In a form's Workflow, under Automations: add a step and choose Custom API." items={ext.steps} />
          <Offers title="Lists for dropdowns" where="In a dropdown's settings, as the place its options come from." items={ext.lists} />
          <Offers title="Fields of your own" where="In the builder's palette, under Your extension." items={ext.fields ?? []} />
          <Offers title="Checks before a submission is accepted" where="In a form's settings, under Checks from your extension." items={ext.checks} />
          {ext.status === 'NEW' && <p className="fb-muted">It has been registered but has not answered yet. Choose Read again once it is running.</p>}
        </section>
      ))}
    </div>
  );
}
