import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@ui/button';
import { messageOf } from '../../adapters/backend';
import { useBulkRecords, type BulkRecordAction, type InboxPage, type Person } from '../../adapters/workflow';
import { ChoiceSelect } from '../../builder/components/settings';
import { PRIORITIES, type Priority } from '../../types';
import { PRIORITY_LABEL } from '../RecordDrawer';

interface BulkBarProps {
  ids: string[];
  /** The page being shown: for the reference numbers in what is said afterwards, and to know what can be done. */
  data: InboxPage | undefined;
  people: Person[];
  onDone: () => void;
}

/**
 * What can be done to every ticked item at once. Each item still follows its own rules, so afterwards this says
 * how many were done and, for any that were not, which and why.
 */
export function BulkBar({ ids, data, people, onDone }: BulkBarProps) {
  const bulk = useBulkRecords();
  const [to, setTo] = useState('');
  const rows = (data?.rows ?? []).filter((r) => ids.includes(r.uuid));
  const refOf = (id: string) => rows.find((r) => r.uuid === id)?.ref || 'one item';
  const anyUnassigned = rows.some((r) => !r.assigneeId);
  const anyWaiting = rows.some((r) => data?.waitingOnMe.includes(r.uuid));

  const run = async (action: BulkRecordAction, done: string) => {
    try {
      const result = await bulk.mutateAsync({ ids, ...action });
      if (result.done) toast.success(`${done}: ${result.done} ${result.done === 1 ? 'item' : 'items'}`);
      if (result.failed.length) toast.error(`Not done: ${result.failed.map((f) => `${refOf(f.id)} (${f.error ?? 'that did not work'})`).join('; ')}`, { duration: 12_000 });
      setTo('');
      onDone();
    } catch (e) {
      toast.error(messageOf(e));
    }
  };

  return (
    <div className="wi-bulk" role="group" aria-label="Ticked items">
      <strong>
        {ids.length} ticked
      </strong>
      <ChoiceSelect<string>
        ariaLabel="Give ticked items to"
        value={to}
        placeholder="Give to…"
        disabled={bulk.isPending}
        options={people.map((p) => ({ label: p.name || p.email, value: p.uuid }))}
        onChange={(userId) => {
          setTo(userId);
          void run({ op: 'assign', userId }, 'Given');
        }}
      />
      <ChoiceSelect<Priority>
        ariaLabel="Set priority of ticked items"
        value={undefined}
        placeholder="Priority…"
        disabled={bulk.isPending}
        options={PRIORITIES.map((p) => ({ label: PRIORITY_LABEL[p], value: p }))}
        onChange={(priority) => void run({ op: 'priority', priority }, `Priority ${PRIORITY_LABEL[priority]}`)}
      />
      {anyUnassigned && (
        <Button type="button" size="sm" variant="outline" disabled={bulk.isPending} onClick={() => void run({ op: 'take' }, 'Taken')}>
          Take them
        </Button>
      )}
      {anyWaiting && (
        <>
          <Button type="button" size="sm" disabled={bulk.isPending} onClick={() => void run({ op: 'decide', decision: 'APPROVED' }, 'Approved')}>
            Approve
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={bulk.isPending} onClick={() => void run({ op: 'decide', decision: 'REJECTED' }, 'Rejected')}>
            Reject
          </Button>
        </>
      )}
      <Button type="button" size="sm" variant="ghost" disabled={bulk.isPending} onClick={onDone}>
        Clear
      </Button>
    </div>
  );
}
