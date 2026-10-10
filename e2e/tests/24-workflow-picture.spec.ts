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

  const picture = dialog.getByRole('group', { name: /Picture of the process: New, then Assessing, then Paying, then Closed/ });
  await expect(picture).toBeVisible();
  await expect(picture).toContainText('Approve claim ✓');
  await expect(picture).toContainText('rejected');
  await expect(picture).toContainText('8 h allowed');
  await expect(dialog.getByRole('list', { name: 'The process in words' })).toContainText('Approve claim: Assessing to Paying, once approved (if rejected: New)');
  if (process.env.SHOT_DIR) await dialog.screenshot({ path: `${process.env.SHOT_DIR}/workflow-picture.png` });

  await dialog.getByRole('group', { name: 'Automation Tell them it is paid' }).getByRole('button', { name: 'Open with its branches' }).click();
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

test('a workflow is built on the picture: statuses added, arrows drawn by dragging, a step added, and it is saved', async ({ page }) => {
  const problems = watchForProblems(page);
  const id = (
    await call<{ definition: { id: string } }>(201, '/forms', {
      method: 'POST',
      token: org.token,
      body: { folderId: org.folderId, definition: { name: 'Leave request', code: 'LEAVE', businessId: '', access: 'PUBLIC', submission: { method: 'POST', endpointId: 'default-submit' }, fields: [{ id: 'e', type: 'EMAIL', name: 'email', label: 'Email' }] } },
    })
  ).definition.id;
  await signIn(page, org.email);
  await page.goto(`/forms/${id}/edit`);
  await page.getByRole('button', { name: 'Workflow' }).click();
  const dialog = page.getByRole('dialog', { name: 'Workflow' });
  await dialog.getByRole('tab', { name: 'Picture' }).click();
  await dialog.getByRole('button', { name: 'Start tracking responses' }).click();
  const picture = dialog.getByRole('group', { name: /Picture of the process: New, then In progress, then Closed/ });
  await expect(picture).toBeVisible();

  // A status of our own, named beside the picture.
  await picture.getByRole('button', { name: 'Add a status' }).click();
  const status = dialog.getByRole('complementary', { name: 'Status' });
  await status.getByRole('textbox', { name: 'Name' }).fill('With manager');
  await expect(dialog.getByRole('button', { name: 'Status With manager' })).toBeVisible();

  // An arrow, drawn: press the dot on a box's edge and let go over another box.
  const pull = async (from: string, to: string) => {
    const dot = dialog.getByRole('button', { name: `Status ${from}`, exact: true }).locator('.fb-map__handle');
    const target = dialog.getByRole('button', { name: `Status ${to}`, exact: true });
    await dot.scrollIntoViewIfNeeded();
    const a = (await dot.boundingBox())!;
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + a.width / 2 + 15, a.y + 30, { steps: 4 });
    // A box out of sight is reached by holding the arrow at the picture's edge, which scrolls it.
    const frame = (await dialog.getByRole('group', { name: 'The process', exact: true }).boundingBox())!;
    for (let i = 0; i < 60; i++) {
      const b = (await target.boundingBox())!;
      const middle = b.x + b.width / 2;
      if (middle > frame.x + 40 && middle < frame.x + frame.width - 40) break;
      const edge = middle > frame.x + frame.width / 2 ? frame.x + frame.width - 10 : frame.x + 10;
      await page.mouse.move(edge - (i % 2), a.y + 30);
    }
    // Off the edge first, so the picture stays still while the box is aimed at.
    await page.mouse.move(frame.x + frame.width / 2, a.y + 30);
    const b = (await target.boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 });
    await page.mouse.up();
  };
  await pull('New', 'With manager');
  const move = dialog.getByRole('complementary', { name: 'Move' });
  await expect(move.getByRole('textbox', { name: 'Button label' })).toHaveValue('Move to With manager');
  await move.getByRole('textbox', { name: 'Button label' }).fill('Send to manager');
  await move.getByRole('switch', { name: 'Needs approval' }).click();
  await expect(dialog.getByRole('button', { name: 'Move Send to manager: New to With manager' })).toBeVisible();
  await pull('With manager', 'Closed');
  await expect(dialog.getByRole('complementary', { name: 'Move' }).getByRole('textbox', { name: 'Button label' })).toHaveValue('Move to Closed');
  await dialog.getByRole('complementary', { name: 'Move' }).getByRole('textbox', { name: 'Button label' }).fill('Close');
  // Let go over nothing: no arrow is made.
  const before = await dialog.getByRole('list', { name: 'The process in words' }).getByRole('listitem').count();
  const dot = dialog.getByRole('button', { name: 'Status Closed', exact: true }).locator('.fb-map__handle');
  await dot.scrollIntoViewIfNeeded();
  const c = (await dot.boundingBox())!;
  await page.mouse.move(c.x + 3, c.y + 3);
  await page.mouse.down();
  await page.mouse.move(c.x + 30, c.y + 120, { steps: 5 });
  await page.mouse.up();
  await expect(dialog.getByRole('list', { name: 'The process in words' }).getByRole('listitem')).toHaveCount(before);
  await expect(dialog.getByRole('list', { name: 'The process in words' })).toContainText('Send to manager: New to With manager, once approved');
  await expect(dialog.getByRole('list', { name: 'The process in words' })).toContainText('Close: With manager to Closed');

  // Something that happens by itself, added and set up without leaving the picture.
  await dialog.getByRole('button', { name: 'Add an automation' }).click();
  await expect(dialog.getByRole('complementary', { name: 'When it starts' })).toBeVisible();
  const lane = dialog.getByRole('group', { name: /^Automation / });
  await lane.getByRole('button', { name: /^Add a step to/ }).click();
  await lane.getByRole('group', { name: 'Choose a step' }).getByRole('button', { name: /Notify in Form Builder/ }).click();
  await expect(dialog.getByRole('complementary', { name: 'Step 1' })).toBeVisible();
  await expect(lane.getByRole('button', { name: /step 1: Notify in Form Builder/ })).toHaveAttribute('aria-pressed', 'true');
  if (process.env.SHOT_DIR) await dialog.screenshot({ path: `${process.env.SHOT_DIR}/workflow-canvas.png` });

  // It is kept with the form.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect
    .poll(async () => {
      const saved = await call<{ definition: { workflow?: { statuses: { label: string }[]; actions?: { label: string; from?: string[]; to: string; approval?: unknown }[] }; automations?: { actions: { type: string }[] }[] } }>(200, `/forms/${id}`, { token: org.token });
      return {
        statuses: saved.definition.workflow?.statuses.map((x) => x.label),
        moves: saved.definition.workflow?.actions?.map((x) => `${x.label}: ${x.from?.join('+')} > ${x.to}${x.approval ? ' (approval)' : ''}`),
        steps: saved.definition.automations?.[0]?.actions.map((x) => x.type),
      };
    })
    .toEqual({ statuses: ['New', 'In progress', 'With manager', 'Closed'], moves: ['Send to manager: NEW > WITH_MANAGER (approval)', 'Close: WITH_MANAGER > CLOSED'], steps: ['NOTIFY'] });
  expect(problems).toEqual([]);
});
