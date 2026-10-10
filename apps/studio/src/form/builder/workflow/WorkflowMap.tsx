import { ArrowRight, Play } from 'lucide-react';
import type { FormDefinition } from '../../types';
import { automationLanes, describeMoves, workflowMoves } from './workflow-map';

interface WorkflowMapProps {
  form: FormDefinition;
  /** A box or a lane was clicked: open the tab where it is edited. */
  onOpen: (tab: 'process' | 'automations', automation?: number) => void;
}

const BOX_W = 160;
const BOX_H = 56;
const GAP = 76;
const PAD = 24;
const STEP = 24;

/**
 * The whole workflow as one picture: the statuses a record passes through, left to right, with an arrow for
 * every button that moves it; under that, each automation as a row of steps. It lays itself out, so nobody has
 * to place boxes; clicking anything opens the tab where it is changed.
 */
export function WorkflowMap({ form, onOpen }: WorkflowMapProps) {
  const wf = form.workflow;
  const lanes = automationLanes(form);
  if (!wf?.enabled) {
    return (
      <div className="fb-settings" style={{ gap: 12 }}>
        <p className="fb-muted">This form does not track its responses yet. Switch tracking on under Process and the picture of the workflow appears here.</p>
        {lanes.length > 0 && <Lanes lanes={lanes} onOpen={onOpen} />}
      </div>
    );
  }

  const { moves, free } = workflowMoves(wf);
  const x = (key: string) => PAD + wf.statuses.findIndex((s) => s.key === key) * (BOX_W + GAP);
  // Forward moves arc over the boxes, moves back arc under them; each gets its own height so labels do not sit on each other.
  const arcs = moves.flatMap((m, i) => {
    const targets = m.any && m.from.length > 3 ? [] : m.from;
    return [
      ...targets.map((from) => ({ key: `${i}-${from}`, from, to: m.to, label: m.label + (m.needsApproval ? ' ✓' : ''), dashed: false })),
      ...(m.onReject ? m.from.slice(0, 1).map((from) => ({ key: `${i}-rej-${from}`, from, to: m.onReject!, label: 'rejected', dashed: true })) : []),
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
  const width = PAD * 2 + wf.statuses.length * BOX_W + Math.max(0, wf.statuses.length - 1) * GAP;
  const height = topRoom + BOX_H + bottomRoom;
  const sentences = describeMoves(wf);

  return (
    <div className="fb-settings" style={{ gap: 16 }}>
      <div className="fb-map" role="group" aria-label="The process">
        <svg className="fb-map__svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`The process: ${wf.statuses.map((s) => s.label).join(', then ')}. ${sentences.join('. ')}.`}>
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
            return (
              <g key={a.key} className={`fb-map__move${a.dashed ? ' fb-map__move--dashed' : ''}`}>
                <path d={`M ${x1} ${y} C ${x1} ${y + reach * 1.33}, ${x2} ${y + reach * 1.33}, ${x2} ${y}`} markerEnd="url(#fb-map-arrow)" />
                {a.label && (
                  <text x={(x1 + x2) / 2} y={y + reach + (a.forward ? -4 : 12)} textAnchor="middle">
                    {a.label}
                  </text>
                )}
              </g>
            );
          })}
          {fromAny.map((m, i) => (
            <g key={`any-${i}`} className="fb-map__move">
              <path d={`M ${x(m.to) + BOX_W / 2} ${topRoom - 26} L ${x(m.to) + BOX_W / 2} ${topRoom}`} markerEnd="url(#fb-map-arrow)" />
              <text x={x(m.to) + BOX_W / 2} y={topRoom - 32} textAnchor="middle">
                {m.label + (m.needsApproval ? ' ✓' : '')} (from any status)
              </text>
            </g>
          ))}
          {wf.statuses.map((s, i) => (
            <g key={s.key} className={`fb-map__status fb-map__status--${s.category}`} transform={`translate(${x(s.key)}, ${topRoom})`} onClick={() => onOpen('process')}>
              <rect width={BOX_W} height={BOX_H} rx={12} />
              <text x={BOX_W / 2} y={i === 0 || s.slaHours ? 24 : 33} textAnchor="middle" className="fb-map__name">
                {s.label}
              </text>
              {(i === 0 || s.slaHours) && (
                <text x={BOX_W / 2} y={42} textAnchor="middle" className="fb-map__note">
                  {[i === 0 ? 'starts here' : '', s.slaHours ? `${s.slaHours} h allowed` : ''].filter(Boolean).join(' · ')}
                </text>
              )}
            </g>
          ))}
        </svg>
      </div>
      <p className="fb-muted">
        {free ? 'Staff can move a record to any status. Add buttons under Process to say which moves are allowed, and they are drawn here.' : '✓ needs approval first. A dashed arrow is where a rejected approval sends the record.'}{' '}
        <button type="button" className="fb-link" onClick={() => onOpen('process')}>
          Change the process
        </button>
      </p>
      {/* The same picture in words. */}
      <ul className="fb-map__words" aria-label="The process in words">
        {sentences.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
      <Lanes lanes={lanes} onOpen={onOpen} />
    </div>
  );
}

function Lanes({ lanes, onOpen }: { lanes: ReturnType<typeof automationLanes>; onOpen: WorkflowMapProps['onOpen'] }) {
  return (
    <div className="fb-settings" style={{ gap: 10 }} role="group" aria-label="What happens by itself">
      <div className="fb-panel__title">What happens by itself</div>
      {lanes.length === 0 && (
        <p className="fb-muted">
          Nothing yet.{' '}
          <button type="button" className="fb-link" onClick={() => onOpen('automations')}>
            Add an automation
          </button>{' '}
          to send emails, ask for approvals or tell your own systems.
        </p>
      )}
      {lanes.map((lane) => (
        <button key={lane.index} type="button" className={`fb-lane${lane.off ? ' fb-lane--off' : ''}`} aria-label={`Open the automation ${lane.name}`} onClick={() => onOpen('automations', lane.index)}>
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
      ))}
    </div>
  );
}
