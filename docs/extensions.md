# Extensions: your own code in Form Builder

_For developers at a customer organisation, and for whoever deploys their code._

Most things are set up on screen: rules, formulas, workflows, approvals,
connectors. An **extension** is for the rest: logic only code can express. It
is a small service that belongs to one organisation. You write it against the
Form Builder SDK; it runs in a container of its own beside the product, never
inside it; and what it offers appears in the builder for your organisation
only.

You never receive or change Form Builder's own code, and your code never runs
inside Form Builder's servers.

## What an extension can offer

| You declare | A designer uses it | It runs |
|---|---|---|
| A **workflow step** | Workflow → Automations → add a step → Custom API | In the background, after a submission or a status change |
| A **list** | A dropdown's settings → Options come from → An API | When someone opens the dropdown |
| A **check** | Form settings → Checks from your extension | Before a submission is accepted, while the person waits |

Custom field types in the browser are not part of extensions.

## Writing one

Start from `examples/extension-starter` (`pnpm stack ext init <directory>`
makes a copy that stands on its own). It is a complete project: one step,
one list, one check.

```ts
import { createExtension } from '@fb/sdk';

const ext = createExtension({ name: 'Acme rules' });

ext.step({ key: 'risk-score', label: 'Score the risk', outputs: ['score', 'band'] }, async ({ values, record }) => {
  const score = Math.min(100, Math.round(Number(values.amount) / 1000));
  return { summary: `Risk ${score}`, data: { score, band: score >= 70 ? 'HIGH' : 'LOW' } };
});

ext.list({ key: 'branches', label: 'Branches', params: ['city'] }, async ({ params }) =>
  BRANCHES.filter((b) => !params.city || b.city === params.city),   // rows of { value, label, ... }
);

ext.check({ key: 'gstin', label: 'GST number is genuine' }, async ({ values }) =>
  isGstin(values.gstin) ? undefined : { errors: { gstin: 'This is not a valid GST number.' } },
);

ext.listen();   // PORT (default 8080), FB_EXTENSION_SECRET
```

### Steps

- You receive the record (`id`, `ref`, `status`, `priority`, `assigneeId`,
  `submittedAt`), the answers (`values`), what the team filled in on the work
  item (`work`), the form, what started the flow (`trigger`) and what earlier
  steps returned (`steps`).
- Return a line for the record's timeline, or `{ summary, data }`. The fields
  of `data` you list in `outputs` are offered to the steps after yours: in a
  message as `{{$steps.<step>.<field>}}`, and in conditions ("band equals
  HIGH").
- Throw to fail the step. Your message is shown on the record's timeline.
- You have 15 seconds. The step runs from a queue; nobody is waiting on it.

### Lists

- Return rows with `value` and `label`. Other properties are allowed.
- `params` are names of answers the form may pass in, for a dropdown that
  depends on another field. Only parameters you declared reach your code, and
  one that is not answered yet is left out.
- The server asks your list again when a form is submitted, to make sure the
  chosen value is one you offered.
- You have 5 seconds. A person is looking at the dropdown.

### Checks

- A check runs only after the form's own rules have passed.
- Return nothing to accept. Return `{ errors: { fieldName: 'message' } }` to
  put a message under a field (`lines.0.qty` for a row of a repeating
  section), or `{ message }` to refuse with one message for the whole form.
- You have 5 seconds. **If your check cannot be reached or fails, the
  submission is refused**, and the person is asked to try again. Nothing is
  let through unchecked.
- A check must not change anything: it may run for a submission that is then
  refused for another reason. Do work in a step.

### Rules for keys

Keys (`risk-score`) are stored in the forms and workflows that use them. Use
lower-case letters, digits and `-`. Never rename a key that is in use: add a
new one and move forms over.

## How it is deployed

1. You keep your extension in a repository of your own. It contains only your
   code: `package.json`, `tsconfig.json` and `src/`.
2. We build it and run it beside Form Builder, in a container that only Form
   Builder can reach: not the internet, not other customers. It cannot reach
   Form Builder's database, and by default cannot make outbound calls; access
   to your own systems is agreed with us.
3. The first delivery installs it for your organisation and issues its
   secret, which the container is started with. You never handle it.
4. What you declared appears under **Administration → Extensions** and in the
   builder. Each later delivery replaces the running version and updates what
   is offered. If a new version does not start, the previous one keeps
   running.

Your plan must include extensions. The same repository works whether you are
on the shared installation or one of your own. For how we run this, see
[hosting.md](hosting.md).

## Security

- **Every request is signed.** Form Builder signs the method, path, body and
  time with your extension's secret (`X-FB-Signature`). The SDK refuses
  anything unsigned, altered, or more than five minutes old, before your code
  sees it. Only `/fb/health` answers without a signature, and it says nothing.
- **One organisation.** With `FB_ORG_ID` set, the SDK refuses requests made
  for any other organisation.
- **Nothing about the extension is shown** to the public or to your own
  users: not its address, not its secret, not its error messages on public
  forms.
- The secret is shown once, when the extension is installed. To replace it,
  the extension is removed and installed again.
- Requests and replies are limited to 1 MB.

## Testing your code

`ext.handle({ method, path, headers, body })` answers one request without a
server, and `sign(secret, { method, path, body })` produces the header, so a
unit test can call a step exactly as Form Builder would:

```ts
const body = JSON.stringify({ orgId: 'o1', values: { amount: 90000 }, record: { ref: 'LN-1' } });
const res = await ext.handle({ method: 'POST', path: '/fb/steps/risk-score', headers: { 'x-fb-signature': sign(SECRET, { method: 'POST', path: '/fb/steps/risk-score', body }) }, body });
```

## The contract (version 1)

For anyone writing an extension without the SDK, in any language.

| Request | Body | Reply |
|---|---|---|
| `GET /fb/health` (unsigned) | – | `{ "ok": true }` |
| `GET /fb/manifest` | – | `{ contract: 1, name, steps: [{ key, label, description?, outputs? }], lists: [{ key, label, description?, params? }], checks: [{ key, label, description? }] }` |
| `POST /fb/steps/<key>` | `{ orgId, trigger, form, record, values, work, steps, stepKey }` | `{ summary?, data? }` |
| `POST /fb/lists/<key>` | `{ orgId, params }` | `{ rows: [{ value, label, ... }] }` |
| `POST /fb/checks/<key>` | `{ orgId, form, values }` | `{ errors: { field: message }, message }` |

Signature header: `X-FB-Signature: t=<unix seconds>,v1=<hex>` where `v1` is
HMAC-SHA256, keyed with the secret, of `<t>.<METHOD>.<path>.<body>`. A failure
is any status of 400 or above with `{ "error": "message" }`.
