import { useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { ArrowLeft, ArrowRight, Play, Plus, Trash2, X } from 'lucide-react';
import { Button } from '@ui/button';
import { Input } from '@ui/input';
import type { AutomationAction, FormDefinition, StatusCategory, WorkflowConfig } from '../../types';
import type { CustomWorkflow, Person } from '../../adapters/workflow';
import { ChoiceSelect, SelectSetting, Setting } from '../components/settings';
import { StartSettings, StepSettings, STEP_ICON } from './FlowEditor';
import { ActionSettings } from './ProcessExtras';
import { automationLanes, describeMoves, workflowMoves } from './workflow-map';
import {
  ACTION_LABEL,
  addStatus,
  connectStatuses,
  disconnectStatuses,
  insertStep,
  moveStatus,
  moveStep,
  newAutomation,
  newStep,
  removeStatus,
  renameStatus,
  STARTER_WORKFLOW,
  toggleMove,
  UNAVAILABLE_ACTIONS,
  WORKFLOW_ONLY_ACTIONS,
} from './workflow-edits';

/** What the picture needs to be the place the workflow is built, not only looked at. */
export interface MapEditing {
  people: Person[];
  customWorkflows: CustomWorkflow[];
  /** Status keys already published: records may be in them, so they are kept. */
  publishedKeys: ReadonlySet<string>;
  onChange: (changes: Partial<FormDefinition>) => void;
}

interface WorkflowMapProps {
  form: FormDefinition;
  /** A box or a lane was clicked: open the tab where it is edited. */
  onOpen: (tab: 'process' | 'automations', automation?: number) => void;
  /** Given, boxes and arrows can be added, joined, changed and removed here. Left out (a published form), it only shows. */
  edit?: MapEditing;
}

/** What is selected in the picture, and so shown in the panel beside it. */
type Picked =
  | { kind: 'status'; key: string }
  | { kind: 'move'; action: number; from?: string }
  | { kind: 'allowed'; from: string; to: string }
  | { kind: 'start'; flow: number }
  | { kind: 'step'; flow: number; index: number };

const CATEGORIES: { label: string; value: StatusCategory }[] = [
  { label: 'Open', value: 'OPEN' },
  { label: 'In progress', value: 'IN_PROGRESS' },
  { label: 'Done (closes it)', value: 'DONE' },
];

/** Enter or Space on something drawn does what a click does. */
const onKey = (run: () => void) => (e: KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    run();
  }
};

const BOX_W = 160;
const BOX_H = 56;
const GAP = 76;
const PAD = 24;
const STEP = 24;

/**
 * The whole workflow as one picture: the statuses a record passes through, left to right, with an arrow for
 * every button that moves it; under that, each automation as a row of steps. It lays itself out, so nobody has
 * to place boxes.
 *
 * With `edit`, it is also where the workflow is built: click a box or an arrow and its settings open beside the
 * picture; drag the dot on a box's edge onto another box to add a move; "+" adds a status, a step or an automation.
 * Everything that can be dragged can also be done from the panel, with the keyboard.
 */
export function WorkflowMap({ form, onOpen, edit }: WorkflowMapProps) {
  const wf = form.workflow;
  const lanes = automationLanes(form);
  const [picked, setPicked] = useState<Picked>();
  const [pulling, setPulling] = useState<{ from: string; x: number; y: number }>();
  const svg = useRef<SVGSVGElement>(null);
  const lanesProps = { form, lanes, onOpen, edit, picked, setPicked };
  if (!wf?.enabled) {
    return (
      <div className="fb-settings" style={{ gap: 12 }}>
        <p className="fb-muted">This form does not track its responses yet. Switch tracking on{edit ? '' : ' under Process'} and the picture of the workflow appears here.</p>
        {edit && (
          <Button type="button" variant="outline" size="sm" style={{ alignSelf: 'flex-start' }} onClick={() => edit.onChange({ workflow: wf ? { ...wf, enabled: true } : STARTER_WORKFLOW })}>
            <Play /> Start tracking responses
          </Button>
        )}
        {(lanes.length > 0 || edit) && (
          <div className={`fb-canvas${edit && picked ? ' fb-canvas--open' : ''}`}>
            <Lanes {...lanesProps} />
            {edit && picked && <Panel form={form} edit={edit} picked={picked} setPicked={setPicked} />}
          </div>
        )}
      </div>
    );
  }

  const setWf = (next: WorkflowConfig) => edit?.onChange({ workflow: next });
  const is = (p: Picked) => JSON.stringify(p) === JSON.stringify(picked);
  /** Joins two statuses and opens the move that was made, so it can be named straight away. */
  const connect = (from: string, to: string) => {
    if (!edit || from === to) return;
    const made = connectStatuses(wf, from, to);
    setWf(made.wf);
    setPicked(made.action !== undefined ? { kind: 'move', action: made.action } : { kind: 'allowed', from, to });
  };
  /** The dot on a box's edge was pressed: a line follows the pointer until it is let go, over another box or not. */
  const pull = (from: string) => (e: ReactPointerEvent) => {
    if (!edit) return;
    e.preventDefault();
    e.stopPropagation();
    const at = (ev: { clientX: number; clientY: number }) => {
      const box = svg.current?.getBoundingClientRect();
      return { x: ev.clientX - (box?.left ?? 0), y: ev.clientY - (box?.top ?? 0) };
    };
    setPulling({ from, ...at(e) });
    const move = (ev: PointerEvent) => {
      // Near an edge of the picture, it scrolls, so a box that is out of sight can still be reached.
      const frame = svg.current?.parentElement;
      const edge = frame?.getBoundingClientRect();
      if (frame && edge) {
        if (ev.clientX > edge.right - 36) frame.scrollLeft += 24;
        else if (ev.clientX < edge.left + 36) frame.scrollLeft -= 24;
      }
      setPulling({ from, ...at(ev) });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setPulling(undefined);
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-status]')?.getAttribute('data-status');
      if (over) connect(from, over);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const { moves, free } = workflowMoves(wf);
  const pickOf = (action: number | undefined, from: string, to: string): Picked => (action !== undefined ? { kind: 'move', action, from } : { kind: 'allowed', from, to });
  const nameOf = (key: string) => wf.statuses.find((st) => st.key === key)?.label ?? key;
  const x = (key: string) => PAD + wf.statuses.findIndex((s) => s.key === key) * (BOX_W + GAP);
  // Forward moves arc over the boxes, moves back arc under them; each gets its own height so labels do not sit on each other.
  const arcs = moves.flatMap((m, i) => {
    const targets = m.any && m.from.length > 3 ? [] : m.from;
    return [
      ...targets.map((from) => ({ key: `${i}-${from}`, from, to: m.to, label: m.label + (m.needsApproval ? ' ✓' : ''), dashed: false, pick: pickOf(m.action, from, m.to) })),
      ...(m.onReject ? m.from.slice(0, 1).map((from) => ({ key: `${i}-rej-${from}`, from, to: m.onReject!, label: 'rejected', dashed: true, pick: pickOf(m.action, from, m.to) })) : []),
    ];
  });
  const fromAny = moves.filter((m) => m.any && m.from.length > 3);
  // Each side keeps its arrows apart: an arrow takes the lowest height not already used by one it would cross.
  const taken: Record<'over' | 'under', { lo: number; hi: number; level: number }[]> = { over: [], under: [] };
  const drawn = arcs
    .filter((a) => a.from !== a.to)
    .map((a) => {
      const forward = x(a.to) > x(a.from);
      const side = taken[forward ? 'over' : 'under'];
      const lo = Math.min(x(a.from), x(a.to));
      const hi = Math.max(x(a.from), x(a.to));
      let level = 0;
      while (side.some((t) => t.level === level && t.lo < hi && lo < t.hi)) level++;
      side.push({ lo, hi, level });
      return { ...a, forward, level };
    });
  const levels = (side: 'over' | 'under') => (taken[side].length ? Math.max(...taken[side].map((t) => t.level)) + 1 : 0);
  const over = levels('over');
  const under = levels('under');
  const topRoom = 30 + Math.max(over, fromAny.length ? 1 : 0) * STEP + 14;
  const bottomRoom = 20 + under * STEP + 14;
  // Room for the "add a status" box at the end, when the picture can be changed.
  const boxes = wf.statuses.length + (edit ? 1 : 0);
  const width = PAD * 2 + boxes * BOX_W + Math.max(0, boxes - 1) * GAP;
  const addX = PAD + wf.statuses.length * (BOX_W + GAP);
  const height = topRoom + BOX_H + bottomRoom;
  const sentences = describeMoves(wf);

  return (
    <div className="fb-settings" style={{ gap: 16 }}>
      <div className={`fb-canvas${edit && picked ? ' fb-canvas--open' : ''}`}>
        <div className="fb-settings" style={{ gap: 16, minWidth: 0 }}>
          <div className="fb-map" role="group" aria-label="The process">
            <svg ref={svg} className="fb-map__svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role={edit ? 'group' : 'img'} aria-label={`${edit ? 'Picture of the process' : 'The process'}: ${wf.statuses.map((s) => s.label).join(', then ')}. ${sentences.join('. ')}.`}>
              <defs>
                <marker id="fb-map-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" className="fb-map__head" />
                </marker>
              </defs>
              {drawn.map((a) => {
                const x1 = x(a.from) + BOX_W / 2 + (a.forward ? 18 : -18);
                const x2 = x(a.to) + BOX_W / 2 + (a.forward ? -18 : 18);
                const y = a.forward ? topRoom : topRoom + BOX_H;
                const reach = (22 + a.level * STEP) * (a.forward ? -1 : 1);
                const d = `M ${x1} ${y} C ${x1} ${y + reach * 1.33}, ${x2} ${y + reach * 1.33}, ${x2} ${y}`;
                const on = !!picked && picked.kind === a.pick.kind && (a.pick.kind === 'move' ? picked.kind === 'move' && picked.action === a.pick.action : is(a.pick));
                return (
                  <g key={a.key} className={`fb-map__move${a.dashed ? ' fb-map__move--dashed' : ''}${on ? ' fb-map__move--picked' : ''}`}>
                    <path d={d} markerEnd="url(#fb-map-arrow)" />
                    {a.label && (
                      <text x={(x1 + x2) / 2} y={y + reach + (a.forward ? -4 : 12)} textAnchor="middle">
                        {a.label}
                      </text>
                    )}
                    {/* A wide, unseen stroke over the arrow, so it is easy to click. */}
                    {edit && !a.dashed && (
                      <path
                        d={d}
                        className="fb-map__hit"
                        role="button"
                        tabIndex={0}
                        aria-pressed={on}
                        aria-label={`Move${a.label ? ` ${a.label.replace(' ✓', '')}` : ''}: ${nameOf(a.from)} to ${nameOf(a.to)}`}
                        onClick={() => setPicked(a.pick)}
                        onKeyDown={onKey(() => setPicked(a.pick))}
                      />
                    )}
                  </g>
                );
              })}
              {fromAny.map((m, i) => (
                <g
                  key={`any-${i}`}
                  className={`fb-map__move${edit ? ' fb-map__move--click' : ''}`}
                  {...(edit && m.action !== undefined
                    ? { role: 'button', tabIndex: 0, 'aria-label': `Move ${m.label}: any status to ${nameOf(m.to)}`, onClick: () => setPicked({ kind: 'move', action: m.action! }), onKeyDown: onKey(() => setPicked({ kind: 'move', action: m.action! })) }
                    : {})}
                >
                  <path d={`M ${x(m.to) + BOX_W / 2} ${topRoom - 26} L ${x(m.to) + BOX_W / 2} ${topRoom}`} markerEnd="url(#fb-map-arrow)" />
                  <text x={x(m.to) + BOX_W / 2} y={topRoom - 32} textAnchor="middle">
                    {m.label + (m.needsApproval ? ' ✓' : '')} (from any status)
                  </text>
                </g>
              ))}
              {wf.statuses.map((s, i) => {
                const on = picked?.kind === 'status' && picked.key === s.key;
                const open = () => (edit ? setPicked({ kind: 'status', key: s.key }) : onOpen('process'));
                return (
                  <g
                    key={s.key}
                    data-status={s.key}
                    className={`fb-map__status fb-map__status--${s.category}${on ? ' fb-map__status--picked' : ''}${pulling && pulling.from !== s.key ? ' fb-map__status--target' : ''}`}
                    transform={`translate(${x(s.key)}, ${topRoom})`}
                    onClick={open}
                    {...(edit ? { role: 'button', tabIndex: 0, 'aria-pressed': on, 'aria-label': `Status ${s.label}`, onKeyDown: onKey(open) } : {})}
                  >
                    <rect width={BOX_W} height={BOX_H} rx={12} />
                    <text x={BOX_W / 2} y={i === 0 || s.slaHours ? 24 : 33} textAnchor="middle" className="fb-map__name">
                      {s.label}
                    </text>
                    {(i === 0 || s.slaHours) && (
                      <text x={BOX_W / 2} y={42} textAnchor="middle" className="fb-map__note">
                        {[i === 0 ? 'starts here' : '', s.slaHours ? `${s.slaHours} h allowed` : ''].filter(Boolean).join(' · ')}
                      </text>
                    )}
                    {edit && (
                      <circle className="fb-map__handle" cx={BOX_W} cy={BOX_H / 2} r={7} onPointerDown={pull(s.key)} onClick={(e) => e.stopPropagation()}>
                        <title>{`Drag onto another status to add a move from ${s.label}`}</title>
                      </circle>
                    )}
                  </g>
                );
              })}
              {edit && (
                <g
                  className="fb-map__add"
                  transform={`translate(${addX}, ${topRoom})`}
                  role="button"
                  tabIndex={0}
                  aria-label="Add a status"
                  {...(() => {
                    const add = () => {
                      const next = addStatus(wf);
                      const made = next.statuses.find((st) => !wf.statuses.some((old) => old.key === st.key));
                      setWf(next);
                      if (made) setPicked({ kind: 'status', key: made.key });
                    };
                    return { onClick: add, onKeyDown: onKey(add) };
                  })()}
                >
                  <rect width={BOX_W} height={BOX_H} rx={12} />
                  <text x={BOX_W / 2} y={33} textAnchor="middle" className="fb-map__name">
                    + Add a status
                  </text>
                </g>
              )}
              {pulling && (
                <path
                  className="fb-map__pull"
                  d={`M ${x(pulling.from) + BOX_W} ${topRoom + BOX_H / 2} L ${pulling.x} ${pulling.y}`}
                  markerEnd="url(#fb-map-arrow)"
                />
              )}
            </svg>
          </div>
          <p className="fb-muted">
            {edit ? 'Click a box or an arrow to change it. To add a move, drag the dot on a box\'s edge onto another box, or pick the box and choose where it leads. ' : ''}
            {free ? `Staff can move a record to any status. ${edit ? 'Draw a move' : 'Add buttons under Process'} to say which moves are allowed${edit ? '' : ', and they are drawn here'}.` : '✓ needs approval first. A dashed arrow is where a rejected approval sends the record.'}{' '}
            <button type="button" className="fb-link" onClick={() => onOpen('process')}>
              {edit ? 'Everything about the process' : 'Change the process'}
            </button>
          </p>
          {/* The same picture in words. */}
          <ul className="fb-map__words" aria-label="The process in words">
            {sentences.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          <Lanes {...lanesProps} />
        </div>
        {edit && picked && <Panel form={form} edit={edit} picked={picked} setPicked={setPicked} onConnect={connect} />}
      </div>
    </div>
  );
}

interface PanelProps {
  form: FormDefinition;
  edit: MapEditing;
  picked: Picked;
  setPicked: (p: Picked | undefined) => void;
  onConnect?: (from: string, to: string) => void;
}

/** Beside the picture: the settings of whatever is selected in it. */
function Panel({ form, edit, picked, setPicked, onConnect }: PanelProps) {
  const wf = form.workflow;
  const automations = form.automations ?? [];
  const setWf = (workflow: WorkflowConfig) => edit.onChange({ workflow });
  const close = () => setPicked(undefined);
  const shell = (title: string, body: React.ReactNode) => (
    <aside className="fb-canvas__panel fb-settings" style={{ gap: 10 }} aria-label={title}>
      <div className="flex items-center gap-2">
        <div className="fb-panel__title" style={{ flex: 1 }}>
          {title}
        </div>
        <button type="button" className="fb-icon-btn" aria-label="Close" onClick={close}>
          <X size={14} />
        </button>
      </div>
      {body}
    </aside>
  );

  if (picked.kind === 'status' && wf) {
    const i = wf.statuses.findIndex((s) => s.key === picked.key);
    const s = wf.statuses[i];
    if (!s) return null;
    const published = edit.publishedKeys.has(s.key);
    const { moves } = workflowMoves(wf);
    const leaving = moves.filter((m) => m.from.includes(s.key));
    const others = wf.statuses.filter((o) => o.key !== s.key).map((o) => ({ label: o.label, value: o.key }));
    const patch = (changes: Partial<typeof s>) => setWf({ ...wf, statuses: wf.statuses.map((x, j) => (j === i ? { ...x, ...changes } : x)) });
    const shift = (delta: -1 | 1) => setWf(moveStatus(wf, i, delta));
    return shell(
      'Status',
      <>
        <Setting label="Name">
          {(id) => (
            <Input
              id={id}
              value={s.label}
              onChange={(e) => {
                // The key follows the name until a published version uses it, so what is selected is found again by its place.
                const next = renameStatus(wf, i, e.target.value, edit.publishedKeys);
                setWf(next);
                setPicked({ kind: 'status', key: next.statuses[i]!.key });
              }}
            />
          )}
        </Setting>
        <Setting label="Kind" hint={i === 0 ? 'New records start here.' : undefined}>
          {() => <ChoiceSelect<StatusCategory> ariaLabel="Kind" value={s.category} options={CATEGORIES} onChange={(category) => patch({ category, slaHours: category === 'DONE' ? undefined : s.slaHours })} />}
        </Setting>
        {s.category !== 'DONE' && (
          <Setting label="Hours allowed here" hint="Left empty, no time limit.">
            {(id) => (
              <Input
                id={id}
                type="number"
                min={1}
                value={s.slaHours ?? ''}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  patch({ slaHours: e.target.value && n > 0 ? n : undefined });
                }}
              />
            )}
          </Setting>
        )}
        <div className="fb-panel__title">Moves from here</div>
        {leaving.length === 0 && <p className="fb-muted">None yet.</p>}
        {leaving.map((m, n) => (
          <button
            key={n}
            type="button"
            className="fb-link"
            style={{ textAlign: 'left' }}
            onClick={() => setPicked(m.action !== undefined ? { kind: 'move', action: m.action, from: s.key } : { kind: 'allowed', from: s.key, to: m.to })}
          >
            {m.label || 'Move'} → {wf.statuses.find((o) => o.key === m.to)?.label ?? m.to}
          </button>
        ))}
        {onConnect && others.length > 0 && (
          <SelectSetting label="Add a move to" value={undefined} options={others} onChange={(to) => onConnect(s.key, to)} hint="The same as dragging the dot on this box onto the other one." />
        )}
        <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
          <Button type="button" variant="outline" size="sm" disabled={i === 0} onClick={() => shift(-1)}>
            <ArrowLeft /> Earlier
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={i === wf.statuses.length - 1} onClick={() => shift(1)}>
            Later <ArrowRight />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={wf.statuses.length <= 1 || published}
            title={published ? 'A published version uses this status, and records may be in it' : undefined}
            onClick={() => {
              setWf(removeStatus(wf, i));
              close();
            }}
          >
            <Trash2 /> Delete this status
          </Button>
        </div>
        {published && <span className="fb-setting__hint">A published version uses this status, so it cannot be deleted: records may be in it.</span>}
      </>,
    );
  }

  if (picked.kind === 'move' && wf) {
    const a = wf.actions?.[picked.action];
    if (!a) return null;
    const from = picked.from;
    return shell(
      'Move',
      <>
        <p className="fb-muted">A button staff press to move a record. Its arrows show where it can be pressed and where it leads.</p>
        <ActionSettings bare form={form} wf={wf} index={picked.action} people={edit.people} onChange={setWf} />
        {from && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => {
              setWf(disconnectStatuses(wf, picked.action, from));
              close();
            }}
          >
            <Trash2 /> Remove this arrow
          </Button>
        )}
      </>,
    );
  }

  if (picked.kind === 'allowed' && wf) {
    const name = (key: string) => wf.statuses.find((s) => s.key === key)?.label ?? key;
    if (!wf.transitions?.[picked.from]?.includes(picked.to)) return null;
    return shell(
      'Allowed move',
      <>
        <p className="fb-muted">
          A record in <strong>{name(picked.from)}</strong> may be moved to <strong>{name(picked.to)}</strong>. This workflow lists its allowed moves; to give a move a button of its own, with an approval or a comment, add a
          button under Process.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => {
            setWf(toggleMove(wf, picked.from, picked.to, false));
            close();
          }}
        >
          <Trash2 /> Remove this move
        </Button>
      </>,
    );
  }

  if (picked.kind === 'start' || picked.kind === 'step') {
    const flow = automations[picked.flow];
    if (!flow) return null;
    const setFlow = (changes: Partial<typeof flow>) => edit.onChange({ automations: automations.map((x, j) => (j === picked.flow ? { ...x, ...changes } : x)) });
    if (picked.kind === 'start') {
      return shell(
        'When it starts',
        <StartSettings
          form={form}
          flow={flow}
          onChange={setFlow}
          onDelete={() => {
            const left = automations.filter((_, j) => j !== picked.flow);
            edit.onChange({ automations: left.length ? left : undefined });
            close();
          }}
        />,
      );
    }
    const step = flow.actions[picked.index];
    if (!step) return null;
    const shift = (delta: -1 | 1) => {
      setFlow({ actions: moveStep(flow.actions, picked.index, delta) });
      setPicked({ ...picked, index: picked.index + delta });
    };
    return shell(
      `Step ${picked.index + 1}`,
      <>
        <StepSettings form={form} steps={flow.actions} index={picked.index} people={edit.people} customWorkflows={edit.customWorkflows} onChange={(next) => setFlow({ actions: flow.actions.map((x, j) => (j === picked.index ? next : x)) })} />
        <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
          <Button type="button" variant="outline" size="sm" disabled={picked.index === 0} onClick={() => shift(-1)}>
            <ArrowLeft /> Earlier
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={picked.index === flow.actions.length - 1} onClick={() => shift(1)}>
            Later <ArrowRight />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setFlow({ actions: flow.actions.filter((_, j) => j !== picked.index) });
              close();
            }}
          >
            <Trash2 /> Delete this step
          </Button>
        </div>
      </>,
    );
  }
  return null;
}

interface LanesProps {
  form: FormDefinition;
  lanes: ReturnType<typeof automationLanes>;
  onOpen: WorkflowMapProps['onOpen'];
  edit?: MapEditing;
  picked?: Picked;
  setPicked?: (p: Picked | undefined) => void;
}

function Lanes({ form, lanes, onOpen, edit, picked, setPicked }: LanesProps) {
  const [addingTo, setAddingTo] = useState<number>();
  const automations = form.automations ?? [];
  const tracked = !!form.workflow?.enabled;
  const stepTypes = (Object.keys(ACTION_LABEL) as AutomationAction['type'][]).filter((t) => !UNAVAILABLE_ACTIONS.has(t) && (tracked || !WORKFLOW_ONLY_ACTIONS.has(t)));
  const addFlow = () => {
    if (!edit) return onOpen('automations');
    edit.onChange({ automations: [...automations, newAutomation(automations)] });
    setPicked?.({ kind: 'start', flow: automations.length });
  };
  const addStep = (flow: number, type: AutomationAction['type']) => {
    const a = automations[flow];
    if (!edit || !a) return;
    edit.onChange({ automations: automations.map((x, j) => (j === flow ? { ...x, actions: insertStep(x.actions, x.actions.length, newStep(type, form, x.actions)) } : x)) });
    setPicked?.({ kind: 'step', flow, index: a.actions.length });
    setAddingTo(undefined);
  };
  return (
    <div className="fb-settings" style={{ gap: 10 }} role="group" aria-label="What happens by itself">
      <div className="fb-panel__title">What happens by itself</div>
      {lanes.length === 0 && (
        <p className="fb-muted">
          Nothing yet.{' '}
          <button type="button" className="fb-link" onClick={addFlow}>
            Add an automation
          </button>{' '}
          to send emails, ask for approvals or tell your own systems.
        </p>
      )}
      {lanes.map((lane) =>
        edit ? (
          <div key={lane.index} className={`fb-lane fb-lane--edit${lane.off ? ' fb-lane--off' : ''}`} role="group" aria-label={`Automation ${lane.name}`}>
            <span className="fb-lane__name">
              {lane.name}
              {lane.off && <span className="fb-chip">Off</span>}
              <button type="button" className="fb-link" style={{ marginLeft: 'auto', fontWeight: 400 }} onClick={() => onOpen('automations', lane.index)}>
                Open with its branches
              </button>
            </span>
            <span className="fb-lane__flow">
              <button
                type="button"
                className={`fb-lane__box fb-lane__box--start${picked?.kind === 'start' && picked.flow === lane.index ? ' fb-lane__box--picked' : ''}`}
                aria-pressed={picked?.kind === 'start' && picked.flow === lane.index}
                aria-label={`${lane.name}: ${lane.when}`}
                onClick={() => setPicked?.({ kind: 'start', flow: lane.index })}
              >
                <Play size={12} aria-hidden /> {lane.when}
              </button>
              {lane.steps.map((step, i) => {
                const on = picked?.kind === 'step' && picked.flow === lane.index && picked.index === i;
                return (
                  <span key={i} className="fb-lane__step">
                    <ArrowRight size={14} aria-hidden className="fb-lane__arrow" />
                    <button
                      type="button"
                      className={`fb-lane__box${step.conditional ? ' fb-lane__box--if' : ''}${on ? ' fb-lane__box--picked' : ''}`}
                      aria-pressed={on}
                      aria-label={`${lane.name}, step ${i + 1}: ${step.label}`}
                      onClick={() => setPicked?.({ kind: 'step', flow: lane.index, index: i })}
                    >
                      {STEP_ICON[step.type]}
                      {step.label}
                      {step.conditional && <span className="fb-lane__if">only if…</span>}
                    </button>
                  </span>
                );
              })}
              <span className="fb-lane__step">
                <ArrowRight size={14} aria-hidden className="fb-lane__arrow" />
                <button type="button" className="fb-flow__add" aria-label={`Add a step to ${lane.name}`} aria-expanded={addingTo === lane.index} onClick={() => setAddingTo(addingTo === lane.index ? undefined : lane.index)}>
                  {addingTo === lane.index ? <X size={14} /> : <Plus size={14} />}
                </button>
              </span>
            </span>
            {addingTo === lane.index && (
              <div className="fb-flow__picker" role="group" aria-label="Choose a step">
                {stepTypes.map((t) => (
                  <button key={t} type="button" className="fb-flow__pick" onClick={() => addStep(lane.index, t)}>
                    {STEP_ICON[t]}
                    {ACTION_LABEL[t]}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <ViewLane key={lane.index} lane={lane} onOpen={onOpen} />
        ),
      )}
      {edit && lanes.length > 0 && (
        <Button type="button" variant="outline" size="sm" style={{ alignSelf: 'flex-start' }} onClick={addFlow}>
          <Plus /> Add an automation
        </Button>
      )}
    </div>
  );
}

/** A lane that is only looked at: one button that opens it where it is edited. */
function ViewLane({ lane, onOpen }: { lane: ReturnType<typeof automationLanes>[number]; onOpen: WorkflowMapProps['onOpen'] }) {
  return (
    <button type="button" className={`fb-lane${lane.off ? ' fb-lane--off' : ''}`} aria-label={`Open the automation ${lane.name}`} onClick={() => onOpen('automations', lane.index)}>
      <span className="fb-lane__name">
        {lane.name}
        {lane.off && <span className="fb-chip">Off</span>}
      </span>
      <span className="fb-lane__flow">
        <span className="fb-lane__box fb-lane__box--start">
          <Play size={12} aria-hidden /> {lane.when}
        </span>
        {lane.steps.map((step, i) => (
          <span key={i} className="fb-lane__step">
            <ArrowRight size={14} aria-hidden className="fb-lane__arrow" />
            <span className={`fb-lane__box${step.conditional ? ' fb-lane__box--if' : ''}`}>
              {step.label}
              {step.conditional && <span className="fb-lane__if">only if…</span>}
            </span>
          </span>
        ))}
        {lane.steps.length === 0 && <span className="fb-muted">no steps yet</span>}
      </span>
    </button>
  );
}
