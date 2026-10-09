import { createExtension, fieldPage, type CheckResult } from '@fb/sdk';

/**
 * Your organisation's own code for Form Builder.
 *
 * Declare what you offer here. After a deployment, an admin opens
 * Administration > Extensions and chooses "Read again"; what is declared then
 * appears in the builder for your organisation only.
 *
 * Keys are stored in the forms that use them: never rename one in use.
 */
const ext = createExtension({ name: 'Acme rules' });

// ── A workflow step ────────────────────────────────────────────────────────
// Designers add it under Workflow > Automations > Custom API. What it returns
// in `data` can be used by the steps after it: {{$steps.<step>.band}}, or a
// condition such as "band equals HIGH".
ext.step(
  { key: 'risk-score', label: 'Score the risk', description: 'Scores a request from its amount', outputs: ['score', 'band'] },
  async ({ values, record }) => {
    const amount = Number(values.amount) || 0;
    const score = Math.min(100, Math.round(amount / 1000));
    const band = score >= 70 ? 'HIGH' : score >= 30 ? 'MEDIUM' : 'LOW';
    // Throw to fail the step; the message is shown on the record's timeline.
    if (amount < 0) throw new Error(`${record.ref}: the amount cannot be negative`);
    return { summary: `Risk ${band} (${score})`, data: { score, band } };
  },
);

// ── A list for dropdowns ───────────────────────────────────────────────────
// Designers choose it as the place a dropdown's options come from. `params`
// are the answers the form passes in, here the city chosen in another field.
const BRANCHES = [
  { value: 'PUN-CAMP', label: 'Pune Camp', city: 'Pune' },
  { value: 'PUN-KOTHRUD', label: 'Pune Kothrud', city: 'Pune' },
  { value: 'MUM-FORT', label: 'Mumbai Fort', city: 'Mumbai' },
];
ext.list({ key: 'branches', label: 'Branches', description: 'Our branches, by city', params: ['city'] }, async ({ params }) =>
  params.city ? BRANCHES.filter((b) => b.city === params.city) : BRANCHES,
);

// ── A check before a submission is accepted ────────────────────────────────
// Designers tick it in the form's settings. It runs after the form's own
// rules pass, while the person waits: keep it fast. Return nothing to accept.
const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** The 15th character of a GSTIN is a check digit over the first fourteen. */
export function gstinCheckDigit(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = GSTIN_CHARS.indexOf(first14[i]!) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36]!;
}
ext.check({ key: 'gstin', label: 'GST number is genuine', description: 'Checks the GSTIN in the field named "gstin"' }, async ({ values }): Promise<CheckResult> => {
  const gstin = String(values.gstin ?? '').trim().toUpperCase();
  if (!gstin) return undefined;
  const wellFormed = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(gstin);
  if (!wellFormed || gstinCheckDigit(gstin.slice(0, 14)) !== gstin[14]) return { errors: { gstin: 'This is not a valid GST number. Please check it against your certificate.' } };
  return undefined;
});

// ── A field of your own ────────────────────────────────────────────────────
// Designers add it from the palette under "Your extension". The page runs in
// a locked frame on the form: it can draw and react, and tell the form its
// answer as text with fb.setValue. It cannot load anything from the network,
// so everything it needs is in the page itself.
ext.field(
  { key: 'stars', label: 'Star rating', description: 'One to five stars; the answer is the number', height: 48 },
  fieldPage({
    style: `
      .stars { display: flex; gap: 4px; }
      .stars button { font-size: 26px; line-height: 1; padding: 4px; border: 0; background: none; color: #c4c4c4; cursor: pointer; }
      .stars button[aria-pressed="true"] { color: #e0a100; }
      .stars button:disabled { cursor: default; opacity: 0.6; }`,
    body: '<div class="stars" role="group" aria-label="Stars"></div>',
    script: `
      var box = document.querySelector('.stars'), current = 0;
      var draw = function () {
        Array.prototype.forEach.call(box.children, function (b, i) { b.setAttribute('aria-pressed', String(i < current)); });
      };
      for (var n = 1; n <= 5; n++) (function (n) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = '\\u2605';
        b.setAttribute('aria-label', n + (n === 1 ? ' star' : ' stars'));
        b.onclick = function () { current = current === n ? 0 : n; draw(); fb.setValue(current ? String(current) : ''); };
        box.appendChild(b);
      })(n);
      var lock = function (readOnly) { Array.prototype.forEach.call(box.children, function (b) { b.disabled = readOnly; }); };
      fb.onInit(function (state) { current = Number(state.value) || 0; draw(); lock(state.readOnly); });
      fb.onReadOnly(lock);`,
  }),
);

// The secret comes from FB_EXTENSION_SECRET, the port from PORT (default 8080).
if (require.main === module) {
  void ext.listen().then(() => console.log('Extension listening'));
}

export default ext;
