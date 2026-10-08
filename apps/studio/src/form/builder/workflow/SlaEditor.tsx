import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@ui/button';
import { Checkbox } from '@ui/checkbox';
import type { EscalationLevel, FormDefinition, Priority, SlaConfig, WorkflowConfig } from '../../types';
import type { Person } from '../../adapters/workflow';
import { VISIBLE_BORDER } from '../../runtime/styles';
import { SelectSetting, Setting, SwitchSetting } from '../components/settings';
import { PersonSelect } from './PersonSelect';
import { RecipientsEditor } from './RecipientsEditor';
import { PRIORITY_LABEL } from './workflow-edits';

interface SlaEditorProps {
  form: FormDefinition;
  people: Person[];
  onChange: (wf: WorkflowConfig) => void;
}

const PRIORITIES = Object.keys(PRIORITY_LABEL) as Priority[];

function Hours({ label, value, onChange }: { label: string; value: number | undefined; onChange: (v: number | undefined) => void }) {
  return (
    <input
      aria-label={label}
      type="number"
      min={0}
      step="any"
      className="fb-number"
      placeholder="—"
      value={value ?? ''}
      onChange={(e) => onChange(Number(e.target.value) > 0 ? Number(e.target.value) : undefined)}
    />
  );
}

/**
 * Response and resolution targets (optionally per priority), counted in
 * working time or 24x7, paused in waiting statuses, with an early warning and
 * escalation levels after a missed resolution time.
 */
export function SlaEditor({ form, people, onChange }: SlaEditorProps) {
  const wf = form.workflow;
  if (!wf?.enabled) return <p className="fb-muted">Turn on "Track submissions as records" (Process tab) to set SLAs.</p>;
  const sla: SlaConfig = wf.sla ?? {};
  const setSla = (changes: Partial<SlaConfig>) => {
    const next = { ...sla, ...changes };
    const empty = !next.responseHours && !next.resolutionHours && !next.byPriority && !next.pauseIn?.length && !next.warnAtPercent && !next.calendar;
    onChange({ ...wf, sla: empty ? undefined : next });
  };
  const levels = wf.escalation?.levels ?? [];
  const setLevels = (list: EscalationLevel[]) => onChange({ ...wf, escalation: list.length ? { levels: list } : undefined });
  const setLevel = (i: number, changes: Partial<EscalationLevel>) => setLevels(levels.map((l, j) => (j === i ? { ...l, ...changes } : l)));
  const byPriority = sla.byPriority ?? {};
  const setPriorityTarget = (p: Priority, key: 'responseHours' | 'resolutionHours', v: number | undefined) => {
    const row = { ...byPriority[p], [key]: v };
    const next = { ...byPriority, [p]: row };
    if (!row.responseHours && !row.resolutionHours) delete next[p];
    setSla({ byPriority: Object.keys(next).length ? next : undefined });
  };

  return (
    <div className="fb-settings" style={{ gap: 16 }}>
      <div className="fb-settings" style={{ gap: 10 }}>
        <div className="fb-panel__title">Targets</div>
        <SelectSetting<'24x7' | 'WORKING'>
          label="Count time"
          value={sla.calendar ?? '24x7'}
          options={[
            { label: 'Around the clock (24x7)', value: '24x7' },
            { label: 'Working hours only (the org calendar)', value: 'WORKING' },
          ]}
          hint="Working days, hours and holidays are set in Form → Working time."
          onChange={(calendar) => setSla({ calendar: calendar === '24x7' ? undefined : calendar })}
        />
        <table className="fb-sla-table">
          <thead>
            <tr>
              <th scope="col">Priority</th>
              <th scope="col">First response (h)</th>
              <th scope="col">Resolution (h)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Default</th>
              <td>
                <Hours label="Default response hours" value={sla.responseHours} onChange={(v) => setSla({ responseHours: v })} />
              </td>
              <td>
                <Hours label="Default resolution hours" value={sla.resolutionHours} onChange={(v) => setSla({ resolutionHours: v })} />
              </td>
            </tr>
            {PRIORITIES.map((p) => (
              <tr key={p}>
                <th scope="row">{PRIORITY_LABEL[p]}</th>
                <td>
                  <Hours label={`${PRIORITY_LABEL[p]} response hours`} value={byPriority[p]?.responseHours} onChange={(v) => setPriorityTarget(p, 'responseHours', v)} />
                </td>
                <td>
                  <Hours label={`${PRIORITY_LABEL[p]} resolution hours`} value={byPriority[p]?.resolutionHours} onChange={(v) => setPriorityTarget(p, 'resolutionHours', v)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <span className="fb-setting__hint">
          First response = the first move, action or email by a person. Resolution = reaching a "Done" status. Empty priority rows use the default.
        </span>
        <Setting label="Stop the resolution clock while the item is in">
          {() => (
            <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
              {wf.statuses
                .filter((st) => st.category !== 'DONE')
                .map((st) => (
                  <label key={st.key} className="flex items-center gap-2 text-sm" style={{ marginRight: 10 }}>
                    <Checkbox
                      className={VISIBLE_BORDER}
                      checked={sla.pauseIn?.includes(st.key) ?? false}
                      onCheckedChange={(c) => {
                        const pauseIn = c === true ? [...(sla.pauseIn ?? []), st.key] : (sla.pauseIn ?? []).filter((k) => k !== st.key);
                        setSla({ pauseIn: pauseIn.length ? pauseIn : undefined });
                      }}
                    />
                    {st.label}
                  </label>
                ))}
            </div>
          )}
        </Setting>
        <Setting label="Warn when this much of the resolution time is used (%)" hint='Starts "Resolution due soon" automations.'>
          {(id) => (
            <input
              id={id}
              type="number"
              min={1}
              max={99}
              className="fb-number"
              style={{ maxWidth: 160 }}
              value={sla.warnAtPercent ?? ''}
              onChange={(e) => {
                const n = Math.round(Number(e.target.value));
                setSla({ warnAtPercent: n >= 1 && n <= 99 ? n : undefined });
              }}
            />
          )}
        </Setting>
      </div>

      <div className="fb-settings" style={{ gap: 10 }}>
        <div className="fb-panel__title">Escalation</div>
        <p className="fb-muted">When the resolution time is missed. Each level runs once, the given hours after the miss (0 = straight away).</p>
        {levels.map((l, i) => (
          <div key={i} className="fb-panel fb-settings" style={{ gap: 8, padding: 10 }} aria-label={`Escalation level ${i + 1}`}>
            <div className="flex items-center gap-2">
              <strong className="text-sm" style={{ flex: 1 }}>
                Level {i + 1}
              </strong>
              <button type="button" className="fb-icon-btn fb-icon-btn--danger" aria-label={`Delete escalation level ${i + 1}`} onClick={() => setLevels(levels.filter((_, j) => j !== i))}>
                <Trash2 size={14} />
              </button>
            </div>
            <Setting label="Hours after the miss">
              {(id) => (
                <input
                  id={id}
                  type="number"
                  min={0}
                  step="any"
                  className="fb-number"
                  style={{ maxWidth: 160 }}
                  value={l.afterHours}
                  onChange={(e) => setLevel(i, { afterHours: Math.max(0, Number(e.target.value) || 0) })}
                />
              )}
            </Setting>
            <Setting label="Notify">{() => <RecipientsEditor form={form} people={people} usersOnly value={l.notify} onChange={(notify) => setLevel(i, { notify })} />}</Setting>
            <Setting label="Reassign to">
              {() => <PersonSelect people={people} value={l.reassignTo ?? ''} placeholder="Keep the assignee" onChange={(u) => setLevel(i, { reassignTo: u || undefined })} />}
            </Setting>
            <SwitchSetting label="Raise priority one step" checked={!!l.raisePriority} onChange={(on) => setLevel(i, { raisePriority: on || undefined })} />
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => setLevels([...levels, { afterHours: levels.length ? (levels[levels.length - 1].afterHours || 0) + 4 : 0, notify: [{ kind: 'MANAGER' }] }])}
        >
          <Plus /> Add escalation level
        </Button>
      </div>
    </div>
  );
}
