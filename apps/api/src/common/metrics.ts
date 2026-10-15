/**
 * Numbers a monitor can read (GET /metrics, in the Prometheus text format): counters and one histogram, kept in
 * this process. Labels are fixed words (a route pattern, a status, a kind), never anything a customer typed.
 */
type Labels = Record<string, string | number>;

const counters = new Map<string, { help: string; values: Map<string, number> }>();
const BUCKETS = [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const histograms = new Map<string, { help: string; series: Map<string, { buckets: number[]; sum: number; count: number }> }>();

const key = (labels: Labels) =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replace(/["\\\n]/g, '_')}"`)
    .join(',');

/** Declared once with what it counts; counted from anywhere. */
export function counter(name: string, help: string) {
  if (!counters.has(name)) counters.set(name, { help, values: new Map() });
  const c = counters.get(name)!;
  return {
    inc(labels: Labels = {}, by = 1) {
      const k = key(labels);
      c.values.set(k, (c.values.get(k) ?? 0) + by);
    },
  };
}

export function histogram(name: string, help: string) {
  if (!histograms.has(name)) histograms.set(name, { help, series: new Map() });
  const h = histograms.get(name)!;
  return {
    observe(labels: Labels, seconds: number) {
      const k = key(labels);
      const s = h.series.get(k) ?? { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
      BUCKETS.forEach((b, i) => {
        if (seconds <= b) s.buckets[i]!++;
      });
      s.sum += seconds;
      s.count++;
      h.series.set(k, s);
    },
  };
}

export const metrics = {
  requests: histogram('fb_http_request_duration_seconds', 'Time to answer a request, by method, route and status'),
  submissionsAccepted: counter('fb_submissions_accepted_total', 'Responses accepted'),
  submissionsRefused: counter('fb_submissions_refused_total', 'Responses sent back, by why'),
  jobsFinished: counter('fb_jobs_finished_total', 'Background jobs finished, by type and outcome'),
  connectorErrors: counter('fb_connector_errors_total', 'Calls to a connected system that failed, by connector type'),
  extensionErrors: counter('fb_extension_errors_total', 'Calls to an organisation extension that failed'),
};

/** Everything counted so far, plus the gauges given (read at the moment of asking), as Prometheus text. */
export function renderMetrics(gauges: { name: string; help: string; values: { labels: Labels; value: number }[] }[] = []): string {
  const lines: string[] = [];
  for (const [name, c] of counters) {
    lines.push(`# HELP ${name} ${c.help}`, `# TYPE ${name} counter`);
    for (const [k, v] of c.values) lines.push(`${name}${k ? `{${k}}` : ''} ${v}`);
  }
  for (const [name, h] of histograms) {
    lines.push(`# HELP ${name} ${h.help}`, `# TYPE ${name} histogram`);
    for (const [k, s] of h.series) {
      const sep = k ? `${k},` : '';
      BUCKETS.forEach((b, i) => lines.push(`${name}_bucket{${sep}le="${b}"} ${s.buckets[i]}`));
      lines.push(`${name}_bucket{${sep}le="+Inf"} ${s.count}`, `${name}_sum${k ? `{${k}}` : ''} ${s.sum}`, `${name}_count${k ? `{${k}}` : ''} ${s.count}`);
    }
  }
  for (const g of gauges) {
    lines.push(`# HELP ${g.name} ${g.help}`, `# TYPE ${g.name} gauge`);
    for (const v of g.values) {
      const k = key(v.labels);
      lines.push(`${g.name}${k ? `{${k}}` : ''} ${v.value}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
