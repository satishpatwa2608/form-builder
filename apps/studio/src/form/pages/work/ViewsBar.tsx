import { useState, type ReactNode } from 'react';
import { Bookmark, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@ui/button';
import { Checkbox } from '@ui/checkbox';
import { Input } from '@ui/input';
import { filtersToQuery, queryToFilters, useDeleteWorkView, useSaveWorkView, useWorkViews, type InboxFilters } from '../../adapters/workflow';
import { messageOf } from '../../adapters/backend';
import { VISIBLE_BORDER } from '../../runtime/styles';

/** Views everyone has; saved views sit next to them. */
export const BUILT_IN_VIEWS: { key: string; name: string; filters: InboxFilters }[] = [
  { key: 'mine', name: 'My open', filters: { page: 1, assignee: 'me', open: true } },
  { key: 'approvals', name: 'Waiting for my approval', filters: { page: 1, waiting: true, assignee: '' } },
  { key: 'unassigned', name: 'Unassigned', filters: { page: 1, assignee: 'unassigned', open: true } },
  { key: 'reports', name: "My team's work", filters: { page: 1, assignee: 'reports', open: true } },
  { key: 'shared', name: 'Shared with me', filters: { page: 1, assignee: 'shared', open: true } },
  { key: 'overdue', name: 'Overdue', filters: { page: 1, assignee: '', overdue: true, sort: 'due' } },
  { key: 'all', name: 'Everything', filters: { page: 1, assignee: '' } },
];

/** Same filters (ignoring page)? Used to highlight the view you're on. */
const same = (a: InboxFilters, b: InboxFilters) => JSON.stringify(filtersToQuery(a)) === JSON.stringify(filtersToQuery(b));

interface ViewsBarProps {
  filters: InboxFilters;
  onPick: (filters: InboxFilters) => void;
  /** Form admins: see everything unassigned and save views. Others see their own work, their team's queue and their people's work. */
  admin?: boolean;
}

/** Built-in and saved views as chips, plus "Save view" (admins) for the current filters. */
export function ViewsBar({ filters, onPick, admin = true }: ViewsBarProps) {
  const { data: saved = [] } = useWorkViews();
  const save = useSaveWorkView();
  const remove = useDeleteWorkView();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);

  const chip = (key: string, label: string, target: InboxFilters, extra?: ReactNode) => (
    <span key={key} className={`fb-view-chip${same(filters, target) ? ' fb-view-chip--on' : ''}`}>
      <button type="button" aria-pressed={same(filters, target)} onClick={() => onPick(target)}>
        {label}
      </button>
      {extra}
    </span>
  );

  return (
    <div className="fb-settings" style={{ gap: 8 }}>
      <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }} role="group" aria-label="Views">
        {/* For someone who is not an administrator, what nobody holds is their team's queue: the work they may take. */}
        {BUILT_IN_VIEWS.map((v) => chip(v.key, !admin && v.key === 'unassigned' ? "My team's queue" : v.name, v.filters))}
        {saved.map((v) =>
          chip(
            v.uuid,
            `${v.name}${v.shared ? ' (shared)' : ''}`,
            queryToFilters(v.filters),
            v.mine && (
              <button
                type="button"
                aria-label={`Delete view ${v.name}`}
                onClick={() => void remove.mutateAsync(v.uuid).then(() => toast.success('View deleted'), (e) => toast.error(messageOf(e)))}
              >
                <X size={12} />
              </button>
            ),
          ),
        )}
        {admin && !naming && (
          <Button type="button" variant="outline" size="sm" onClick={() => setNaming(true)}>
            <Bookmark /> Save view
          </Button>
        )}
      </div>
      {naming && (
        <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
          <Input aria-label="View name" placeholder="View name, e.g. Denim critical" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 280 }} />
          <label className="flex items-center gap-2 text-sm">
            <Checkbox className={VISIBLE_BORDER} checked={shared} onCheckedChange={(c) => setShared(c === true)} />
            Share with everyone
          </label>
          <Button
            type="button"
            size="sm"
            disabled={!name.trim() || save.isPending}
            onClick={async () => {
              try {
                await save.mutateAsync({ id: 'new', name: name.trim(), shared, filters });
                toast.success('View saved');
                setNaming(false);
                setName('');
                setShared(false);
              } catch (e) {
                toast.error(messageOf(e));
              }
            }}
          >
            Save
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setNaming(false)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
