/**
 * One submission as a printable page (the browser's "Save as PDF" makes the
 * PDF). Built with DOM nodes and textContent only - answers are untrusted text.
 */
export interface PrintableSubmission {
  formName: string;
  code: string;
  ref?: string;
  submittedAt: string;
  submittedBy?: string;
  version: number;
  channel?: string;
  answers: { label: string; value: string }[];
  orgName?: string;
}

const CSS = `
  body { font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #111827; margin: 32px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { color: #6b7280; font-size: 12px; margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; vertical-align: top; padding: 8px 10px; border-bottom: 1px solid #e5e7eb; }
  th { width: 35%; color: #374151; font-weight: 600; }
  td { white-space: pre-wrap; word-break: break-word; }
  footer { margin-top: 24px; color: #9ca3af; font-size: 11px; }
  @page { margin: 16mm; }
`;

export function printSubmission(s: PrintableSubmission) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  Object.assign(frame.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0' });
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.title = `${s.code}${s.ref ? ` ${s.ref}` : ''}`;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, parent: HTMLElement = doc.body) => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    parent.appendChild(node);
    return node;
  };
  el('style', CSS, doc.head);
  el('h1', s.formName);
  const meta = [s.ref && `Reference ${s.ref}`, `Submitted ${new Date(s.submittedAt).toLocaleString()}`, s.submittedBy && `by ${s.submittedBy}`, `form ${s.code} v${s.version}`, s.channel].filter(Boolean).join(' · ');
  el('div', meta).className = 'meta';
  const table = el('table');
  const body = el('tbody', undefined, table);
  for (const a of s.answers) {
    const tr = el('tr', undefined, body);
    el('th', a.label, tr);
    el('td', a.value || '—', tr);
  }
  el('footer', `${s.orgName ? `${s.orgName} · ` : ''}Printed ${new Date().toLocaleString()}`);
  const win = frame.contentWindow!;
  win.addEventListener('afterprint', () => frame.remove());
  setTimeout(() => {
    win.focus();
    win.print();
    // Browsers without afterprint.
    setTimeout(() => frame.isConnected && frame.remove(), 60_000);
  }, 50);
}
