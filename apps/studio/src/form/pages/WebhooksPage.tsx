import { useMemo, useState } from 'react';
import { format } from 'date-fns';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@ui/button';
import { Checkbox } from '@ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@ui/dialog';
import { SmartTable, type SmartTableColumn } from '@ui/smart-table';
import { useDeleteWebhook, useSaveWebhook, useWebhooks, type Webhook, type WebhookInput } from '../adapters/workflow';
import { messageOf, USE_API } from '../adapters/backend';
import { useFormDefinitions } from '../adapters/registry/useFormRegistry';
import { useFormPermissions } from '../hooks/useFormPermissions';
import { Setting, SwitchSetting, TextSetting } from '../builder/components/settings';
import { ConfirmDialog, type ConfirmRequest } from '../builder/components/ConfirmDialog';
import { VISIBLE_BORDER } from '../runtime/styles';
import '../styles/form-builder.css';

const sampleBody = (withData: boolean) =>
  JSON.stringify(
    {
      event: 'status.changed',
      occurredAt: '2026-09-29T17:05:00.000Z',
      record: { id: '8f1c…', ref: 'CMP-000042', formCode: 'CUSTOMER_COMPLAINT', formVersion: 3, status: 'INVESTIGATING', priority: 'HIGH', assigneeId: '34a8…', source: 'PUBLIC_FORM' },
      by: '34a8…',
      message: '',
      data: { from: 'NEW', to: 'INVESTIGATING', fromLabel: 'New', toLabel: 'Investigating' },
      ...(withData ? { values: { customer: 'Asha Textiles', email: 'asha@example.com', issue: 'Shade variation' }, work: { rootCause: 'Wrong dye lot' } } : {}),
    },
    null,
    2,
  );

function WebhookDialog({ initial, events, onClose }: { initial: Webhook | null; events: string[]; onClose: () => void }) {
  const save = useSaveWebhook();
  const { data: forms = [] } = useFormDefinitions();
  const codes = useMemo(() => [...new Map(forms.filter((f) => f.workflow?.enabled).map((f) => [f.code, f.name])).entries()], [forms]);
  const [draft, setDraft] = useState<WebhookInput>(
    initial
      ? { name: initial.name, url: initial.url, events: initial.events, formCodes: initial.formCodes, active: initial.active, includeData: initial.includeData }
      : { name: '', url: 'https://', events: [], formCodes: [], active: true, includeData: false },
  );
  const [secret, setSecret] = useState<string | undefined>(undefined);
  const toggle = (list: string[], item: string, on: boolean) => (on ? [...list, item] : list.filter((x) => x !== item));

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent style={{ maxHeight: 'calc(100vh - 2rem)', overflowY: 'auto' }}>
        <DialogHeader>
          <DialogTitle>{initial ? 'Edit webhook' : 'New webhook'}</DialogTitle>
          <DialogDescription>
            Tells another system (CRM, ERP, reporting) when something happens to work items of the forms you pick - whatever each form's own workflow
            is. Each event is POSTed as JSON to an https address on the server's allow-list (FORM_WEBHOOK_ALLOWLIST). To call a system at a set point
            in one form's process (and use its reply), use the "Call a webhook" step in that form's automations instead.
          </DialogDescription>
        </DialogHeader>
        <div className="fb-settings" style={{ gap: 12 }}>
          <TextSetting label="Name" value={draft.name} onChange={(name) => setDraft({ ...draft, name })} />
          <TextSetting label="URL" value={draft.url} placeholder="https://..." onChange={(url) => setDraft({ ...draft, url: url.trim() })} />
          <TextSetting
            label="Signing secret"
            type="password"
            value={secret ?? ''}
            placeholder={initial?.signed ? '(unchanged)' : 'Optional'}
            hint="Signs each body: x-fb-signature: sha256=<HMAC>. Leave empty to keep the current one."
            onChange={setSecret}
          />
          <Setting label="Events" hint="None ticked = all events.">
            {() => (
              <div className="fb-tiles__grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 6 }}>
                {events.map((e) => (
                  <label key={e} className="flex items-center gap-2 text-sm">
                    <Checkbox className={VISIBLE_BORDER} checked={draft.events.includes(e)} onCheckedChange={(c) => setDraft({ ...draft, events: toggle(draft.events, e, c === true) })} />
                    <span className="fb-code">{e}</span>
                  </label>
                ))}
              </div>
            )}
          </Setting>
          {codes.length > 0 && (
            <Setting label="Forms" hint="None ticked = every form.">
              {() => (
                <div className="fb-settings" style={{ gap: 6 }}>
                  {codes.map(([code, name]) => (
                    <label key={code} className="flex items-center gap-2 text-sm">
                      <Checkbox className={VISIBLE_BORDER} checked={draft.formCodes.includes(code)} onCheckedChange={(c) => setDraft({ ...draft, formCodes: toggle(draft.formCodes, code, c === true) })} />
                      {name} <span className="fb-code">{code}</span>
                    </label>
                  ))}
                </div>
              )}
            </Setting>
          )}
          <SwitchSetting
            label="Include answers and work fields"
            checked={draft.includeData}
            hint="Adds values (the form's answers, by field name) and work (fields your team filled in). Off: only the item's key details and what changed."
            onChange={(includeData) => setDraft({ ...draft, includeData })}
          />
          <Setting label="What is sent (example)">
            {() => <pre className="fb-sample">{sampleBody(draft.includeData)}</pre>}
          </Setting>
          <SwitchSetting label="Active" checked={draft.active} onChange={(active) => setDraft({ ...draft, active })} />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={save.isPending || !draft.name.trim()}
            onClick={async () => {
              try {
                await save.mutateAsync({ id: initial?.uuid ?? 'new', input: { ...draft, ...(secret !== undefined && secret !== '' ? { secret } : {}) } });
                toast.success('Webhook saved');
                onClose();
              } catch (e) {
                toast.error(messageOf(e));
              }
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Webhook subscriptions to work item events (record.created, status.changed, sla.breached...). */
export default function WebhooksPage() {
  const { canManagePages } = useFormPermissions();
  const { data, isLoading } = useWebhooks();
  const remove = useDeleteWebhook();
  const [editing, setEditing] = useState<Webhook | null | undefined>(undefined);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  if (!canManagePages) return <p className="p-6 text-sm text-muted-foreground">Managing webhooks needs the Form Admin module.</p>;

  const columns: SmartTableColumn<Webhook>[] = [
    { title: 'Name', dataIndex: 'name', width: 160 },
    { title: 'URL', dataIndex: 'url' },
    { title: 'Events', dataIndex: 'events', render: (ev: string[]) => (ev.length ? ev.join(', ') : 'All') },
    { title: 'Active', dataIndex: 'active', width: 80, render: (a: boolean) => (a ? 'Yes' : 'No') },
    {
      title: 'Last delivery',
      dataIndex: 'lastDeliveryAt',
      width: 220,
      render: (at: string | null, w) => (at ? `${format(new Date(at), 'dd MMM, HH:mm')} · ${w.lastResult}${w.failures ? ` (${w.failures} failed)` : ''}` : '—'),
    },
    {
      title: '',
      dataIndex: 'uuid',
      width: 140,
      render: (_: string, w) => (
        <span className="flex items-center gap-2">
          <button type="button" className="fb-link" onClick={() => setEditing(w)}>
            Edit
          </button>
          <button
            type="button"
            className="fb-link"
            onClick={() =>
              setConfirm({
                title: `Delete "${w.name}"?`,
                description: 'Events stop being sent to it.',
                confirmLabel: 'Delete',
                destructive: true,
                onConfirm: () => void remove.mutateAsync(w.uuid).catch((e) => toast.error(messageOf(e))),
              })
            }
          >
            Delete
          </button>
        </span>
      ),
    },
  ];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4" style={{ flexWrap: 'wrap' }}>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-gray-900">Webhooks</h1>
          <p className="text-sm text-muted-foreground">Send work item events to other systems (CRM, ERP, data warehouse).</p>
        </div>
        {USE_API && (
          <Button type="button" onClick={() => setEditing(null)}>
            <Plus /> New webhook
          </Button>
        )}
      </div>
      {!USE_API ? (
        <p className="fb-muted">Webhooks are kept by the server. This app is running on local storage only.</p>
      ) : (
        <SmartTable<Webhook> data={data?.webhooks ?? []} columns={columns} loading={isLoading} rowKey="uuid" pagination={false} emptyText="No webhooks yet." />
      )}
      {editing !== undefined && <WebhookDialog initial={editing} events={data?.events ?? []} onClose={() => setEditing(undefined)} />}
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
