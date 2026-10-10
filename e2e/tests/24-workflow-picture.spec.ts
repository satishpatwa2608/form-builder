import { expect, test } from '@playwright/test';
import { call, createOrg, signIn, watchForProblems, type Org } from './helpers';

/** The workflow as a picture: what a designer sees first when they open a form's workflow. */
let org: Org;
let formId: string;

test.beforeAll(async () => {
  org = await createOrg('Claims');
  formId = (
    await call<{ definition: { id: string } }>(201, '/forms', {
      method: 'POST',
      token: org.token,
      body: {
        folderId: org.folderId,
        definition: {
          name: 'Claim',
          code: 'CLAIM',
          businessId: '',
          access: 'PUBLIC',
          submission: { method: 'POST', endpointId: 'default-submit' },
          fields: [{ id: 'e', type: 'EMAIL', name: 'email', label: 'Email' }],
          workflow: {
            enabled: true,
            refPrefix: 'CLM',
            statuses: [
              { key: 'NEW', label: 'New', category: 'OPEN', slaHours: 8 },
              { key: 'ASSESS', label: 'Assessing', category: 'IN_PROGRESS' },
              { key: 'PAY', label: 'Paying', category: 'IN_PROGRESS' },
              { key: 'CLOSED', label: 'Closed', category: 'DONE' },
            ],
            actions: [
              { key: 'assess', label: 'Assess', from: ['NEW'], to: 'ASSESS' },
              { key: 'approve', label: 'Approve claim', from: ['ASSESS'], to: 'PAY', approval: { to: [{ kind: 'MANAGER' }], onReject: 'NEW' } },
              { key: 'paid', label: 'Mark paid', from: ['PAY'], to: 'CLOSED' },
              { key: 'more', label: 'Ask for more', from: ['ASSESS'], to: 'NEW' },
            ],
          },
          automations: [
            { id: 'a1', name: 'Thank the customer', enabled: true, when: 'SUBMITTED', actions: [{ id: 'm', type: 'EMAIL', to: [{ kind: 'FIELD', field: 'email' }], subject: 'We have your claim', body: 'Thank you.' }] },
            {
              id: 'a3',
              name: 'Large claims',
              enabled: true,
              when: 'STATUS_CHANGED',
              toStatus: 'ASSESS',
              actions: [
                { id: 'ask', type: 'APPROVAL', to: [{ kind: 'MANAGER' }], title: 'Large claim {{$record.ref}}', dueInHours: 48 },
                { id: 'ok', type: 'EMAIL', to: [{ kind: 'FIELD', field: 'email' }], subject: 'Your claim is approved', body: 'We will pay it shortly.', if: { field: '$steps.ask.decision', operator: 'equals', value: 'APPROVED' } },
                { id: 'no', type: 'EMAIL', to: [{ kind: 'FIELD', field: 'email' }], subject: 'About your claim', body: 'We could not approve it.', if: { field: '$steps.ask.decision', operator: 'equals', value: 'REJECTED' } },
                { id: 'log', type: 'NOTIFY', to: [{ kind: 'ASSIGNEE' }], message: 'The manager has answered.' },
              ],
            },
            { id: 'a2', name: 'Tell them it is paid', enabled: true, when: 'STATUS_CHANGED', toStatus: 'CLOSED', actions: [{ id: 'm', type: 'EMAIL', to: [{ kind: 'FIELD', field: 'email' }], subject: 'Paid', body: 'Your claim is paid.' }] },
          ],
        },
      },
    })
  ).definition.id;
});

test('opening a workflow shows it as a picture, and clicking a part opens where it is changed', async ({ page }) => {
  const problems = watchForProblems(page);
  await signIn(page, org.email);
  await page.goto(`/forms/${formId}/edit`);
  await page.getByRole('button', { name: 'Workflow' }).click();
  const dialog = page.getByRole('dialog', { name: 'Workflow' });
  await expect(dialog.getByRole('tab', { name: 'Picture' })).toHaveAttribute('aria-selected', 'true');

  const picture = dialog.getByRole('img', { name: /The process: New, then Assessing, then Paying, then Closed/ });
  await expect(picture).toBeVisible();
  await expect(picture).toContainText('Approve claim ✓');
  await expect(picture).toContainText('rejected');
  await expect(picture).toContainText('8 h allowed');
  await expect(dialog.getByRole('list', { name: 'The process in words' })).toContainText('Approve claim: Assessing to Paying, once approved (if rejected: New)');
  if (process.env.SHOT_DIR) await dialog.screenshot({ path: `${process.env.SHOT_DIR}/workflow-picture.png` });

  await dialog.getByRole('button', { name: 'Open the automation Tell them it is paid' }).click();
  await expect(dialog.getByRole('tab', { name: /Automations/ })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByRole('tab', { name: /Tell them it is paid/ })).toHaveAttribute('aria-selected', 'true');

  // An approval's two outcomes are drawn side by side, each with its own steps; what follows runs either way.
  await dialog.getByRole('tab', { name: /Large claims/ }).click();
  const approved = dialog.getByRole('group', { name: 'If approved, after step 1' });
  const rejected = dialog.getByRole('group', { name: 'If rejected, after step 1' });
  await expect(approved).toContainText('2. Send an email');
  await expect(rejected).toContainText('3. Send an email');
  await expect(approved).not.toContainText('4.');
  if (process.env.SHOT_DIR) await dialog.screenshot({ path: `${process.env.SHOT_DIR}/workflow-branches.png` });
  await rejected.getByRole('button', { name: /Add a step when rejected/ }).click();
  await rejected.getByRole('group', { name: 'Choose a step' }).getByRole('button', { name: /Notify in Form Builder/ }).click();
  await expect(dialog.getByRole('group', { name: 'If rejected, after step 1' })).toContainText('4. Notify in Form Builder');
  expect(problems).toEqual([]);
});
