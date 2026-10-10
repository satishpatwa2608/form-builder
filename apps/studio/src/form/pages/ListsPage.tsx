import { useState } from 'react';
import { ListPlus, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@ui/dialog';
import { Input } from '@ui/input';
import { SmartTable, type SmartTableColumn } from '@ui/smart-table';
import { Textarea } from '@ui/textarea';
import { messageOf } from '../adapters/backend';
import { useDeleteList, useLists, useSaveList, type ListItem, type SharedList } from '../adapters/lists';
import { useFormPermissions } from '../hooks/useFormPermissions';
import { ConfirmDialog, type ConfirmRequest } from '../builder/components/ConfirmDialog';
import { ChoiceSelect, SelectSetting, TextSetting } from '../builder/components/settings';
import { VISIBLE_BORDER } from '../runtime/styles';
import '../styles/form-builder.css';

const live = (l: SharedList) => l.items.filter((i) => !i.retired);

/** A list being made or changed: its name, the list it depends on (if any), and its items one to a row. */
function ListDialog({ list, all, onClose }: { list?: SharedList; all: SharedList[]; onClose: () => void }) {
  const save = useSaveList();
  const [name, setName] = useState(list?.name ?? '');
  const [description, setDescription] = useState(list?.description ?? '');
  const [dependsOn, setDependsOn] = useState(list?.dependsOn ?? '');
  const [items, setItems] = useState<ListItem[]>(list ? live(list) : [{ label: '' }]);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState('');
  const parent = all.find((l) => l.key === dependsOn);
  const parents = parent ? live(parent).map((i) => ({ label: i.label, value: i.value! })) : [];
  const filled = items.filter((i) => i.label.trim());
  const untied = !!parent && filled.some((i) => !parents.some((p) => p.value === i.parent));
  const setItem = (n: number, change: Partial<ListItem>) => setItems((rows) => rows.map((r, i) => (i === n ? { ...r, ...change } : r)));

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent style={{ width: 'min(720px, 96vw)', maxWidth: '96vw', maxHeight: '92vh', overflowY: 'auto' }}>
        <DialogHeader>
          <DialogTitle>{list ? list.name : 'New list'}</DialogTitle>
          <DialogDescription>Choices kept once and used by dropdowns on any number of forms. Change the list and every form that uses it shows the change at once.</DialogDescription>
        </DialogHeader>
        <div className="fb-settings">
          <TextSetting label="Name" value={name} onChange={setName} placeholder="Branches" />
          <TextSetting label="What it is for" value={description} onChange={setDescription} />
          <SelectSetting
            label="Depends on another list"
            value={dependsOn || 'NONE'}
            options={[{ label: 'No: it stands on its own', value: 'NONE' }, ...all.filter((l) => l.id !== list?.id && l.dependsOn !== list?.key).map((l) => ({ label: `Yes: ${l.name}`, value: l.key }))]}
            onChange={(v) => {
              setDependsOn(v === 'NONE' ? '' : v);
              setItems((rows) => rows.map(({ parent: _was, ...r }) => r));
            }}
            hint={parent ? `Each item below belongs to one of "${parent.name}". A form then offers only the items for what the person chose there (the branches of the city they picked).` : 'For example: branches depend on cities, models depend on makes.'}
          />
          <div className="fb-setting">
            <span className="fb-setting__label">Items</span>
            <div className="fb-list-items" role="group" aria-label="Items">
              {items.map((item, n) => (
                <div key={n} className="fb-list-items__row">
                  <Input className={VISIBLE_BORDER} aria-label={`Item ${n + 1}`} value={item.label} placeholder="Name of the choice" onChange={(e) => setItem(n, { label: e.target.value })} />
                  {parent && <ChoiceSelect ariaLabel={`Item ${n + 1} belongs to`} value={item.parent} placeholder={`Which of ${parent.name}`} options={parents} onChange={(p) => setItem(n, { parent: p })} />}
                  <Button type="button" variant="ghost" size="sm" aria-label={`Remove item ${n + 1}`} disabled={items.length === 1} onClick={() => setItems((rows) => rows.filter((_, i) => i !== n))}>
                    <Trash2 />
                  </Button>
                </div>
              ))}
            </div>
            <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
              <Button type="button" variant="outline" size="sm" onClick={() => setItems((rows) => [...rows, { label: '', ...(parent && rows.at(-1)?.parent ? { parent: rows.at(-1)!.parent } : {}) }])}>
                <Plus /> Add an item
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setPasting((v) => !v)}>
                <ListPlus /> Paste many
              </Button>
            </div>
            {pasting && (
              <>
                <Textarea className={VISIBLE_BORDER} rows={5} aria-label="Items to add, one on each line" placeholder={'One on each line, for example copied from a spreadsheet column'} value={pasted} onChange={(e) => setPasted(e.target.value)} />
                <Button
                  type="button"
                  size="sm"
                  style={{ alignSelf: 'flex-start' }}
                  disabled={!pasted.trim()}
                  onClick={() => {
                    const have = new Set(items.map((i) => i.label.trim().toLowerCase()));
                    const more = [...new Set(pasted.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))].filter((l) => !have.has(l.toLowerCase())).map((label) => ({ label }));
                    setItems((rows) => [...rows.filter((r) => r.label.trim()), ...more]);
                    setPasted('');
                    setPasting(false);
                  }}
                >
                  Add these
                </Button>
              </>
            )}
            {list && <span className="fb-setting__hint">An item you remove is no longer offered, but answers already given with it still read properly.</span>}
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!name.trim() || !filled.length || untied || save.isPending}
            title={untied ? `Say which of "${parent!.name}" each item belongs to` : undefined}
            onClick={() =>
              void save
                .mutateAsync({ id: list?.id, name: name.trim(), description: description.trim(), dependsOn, items: filled.map((i) => ({ ...i, label: i.label.trim() })) })
                .then(() => {
                  toast.success(list ? 'Saved. Forms that use it show the change now.' : `"${name.trim()}" is in the library. On a dropdown, choose it under "Options come from".`);
                  onClose();
                })
                .catch((e) => toast.error(messageOf(e)))
            }
          >
            {list ? 'Save' : 'Add to the library'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Master data: lists of choices kept once and used by dropdowns on many forms. Admins manage it; every member can look. */
export default function ListsPage() {
  const { canManagePages } = useFormPermissions();
  const { data = [], isLoading } = useLists();
  const remove = useDeleteList();
  const [editing, setEditing] = useState<SharedList | 'new' | undefined>(undefined);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  const columns: SmartTableColumn<SharedList>[] = [
    {
      title: 'List',
      dataIndex: 'name',
      render: (name: string, l) => (
        <span>
          <strong>{name}</strong>
          {l.description && <span className="fb-muted" style={{ display: 'block' }}>{l.description}</span>}
        </span>
      ),
    },
    {
      title: 'Items',
      dataIndex: 'items',
      render: (_: unknown, l) => {
        const items = live(l);
        return `${items.length}: ${items.slice(0, 4).map((i) => i.label).join(', ')}${items.length > 4 ? ', …' : ''}`;
      },
    },
    { title: 'Depends on', dataIndex: 'dependsOn', render: (key: string) => data.find((l) => l.key === key)?.name ?? '—' },
    { title: 'Used by', dataIndex: 'usedBy', render: (uses: SharedList['usedBy']) => (uses.length ? [...new Set(uses.map((u) => u.name))].join(', ') : 'No form yet') },
    {
      title: '',
      dataIndex: 'id',
      width: 150,
      render: (_: string, l) =>
        canManagePages ? (
          <span className="flex items-center gap-2">
            <button type="button" className="fb-link" aria-label={`Change ${l.name}`} onClick={() => setEditing(l)}>
              Change
            </button>
            <button
              type="button"
              className="fb-link"
              aria-label={`Delete ${l.name}`}
              onClick={() =>
                l.usedBy.length
                  ? toast.error(`"${l.name}" is used by ${[...new Set(l.usedBy.map((u) => u.name))].join(', ')}. Change those fields first.`)
                  : setConfirm({ title: `Delete "${l.name}"?`, description: 'It is removed from the library.', confirmLabel: 'Delete', destructive: true, onConfirm: () => void remove.mutateAsync(l.id).catch((e) => toast.error(messageOf(e))) })
              }
            >
              Delete
            </button>
          </span>
        ) : null,
    },
  ];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4" style={{ flexWrap: 'wrap' }}>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-gray-900">Lists</h1>
          <p className="text-sm text-muted-foreground">Your master data: branches, departments, products, cities. Keep each list here once, and use it on the dropdowns of any number of forms. A change here shows on every form at once.</p>
          <p className="text-sm text-muted-foreground">
            <strong>To use one:</strong> in a form, select a dropdown and under "Options come from" choose the list.
          </p>
        </div>
        {canManagePages && (
          <Button type="button" onClick={() => setEditing('new')}>
            New list
          </Button>
        )}
      </div>
      <SmartTable<SharedList> data={data} columns={columns} loading={isLoading} rowKey="id" pagination={false} emptyText={canManagePages ? 'No lists yet. Choose New list.' : 'No lists yet. An administrator can add them.'} />
      {editing && <ListDialog key={editing === 'new' ? 'new' : editing.id} list={editing === 'new' ? undefined : editing} all={data} onClose={() => setEditing(undefined)} />}
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
