import { expect, test, type Locator, type Page } from '@playwright/test';
import { createOrg, formUrl, label, signIn, submissions, watchForProblems, type Org } from './helpers';

/** A designer builds a form from nothing in the builder, publishes it, and it works for the public. */

let org: Org;

test.beforeAll(async () => {
  org = await createOrg('Builder');
});

const palette = (page: Page) => page.getByLabel('Field palette');
const settings = (page: Page) => page.getByLabel('Field settings');
const add = (page: Page, type: string) => palette(page).getByRole('button', { name: type, exact: true }).click();

/** Types into one of the settings boxes on the right, replacing what is there. */
async function setting(scope: Locator, name: string, value: string) {
  const box = scope.getByLabel(name, { exact: true });
  await box.fill(value);
}

/** A real drag with the mouse: press, move off in small steps so the drag starts, hover the target, release. */
async function drag(page: Page, from: Locator, to: Locator) {
  await from.scrollIntoViewIfNeeded();
  const a = (await from.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 20, a.y + a.height / 2 + 10, { steps: 5 });
  await to.scrollIntoViewIfNeeded();
  const b = (await to.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.move(b.x + b.width / 2 + 2, b.y + b.height / 2 + 2, { steps: 2 });
  await page.mouse.up();
}

async function pick(scope: Locator | Page, page: Page, select: string, option: string) {
  await scope.getByRole('combobox', { name: select, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

test('build an order form with a repeating section, a rule and an event, publish it, and fill it in', async ({ page, context }) => {
  const problems = watchForProblems(page);
  await signIn(page, org.email);
  await page.goto('/forms');
  await page.getByRole('button', { name: 'New form' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Stationery order');
  await expect(page.getByLabel('Code', { exact: true })).toHaveValue('STATIONERY_ORDER');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByText('"Stationery order" was created as a draft.')).toBeVisible();
  await page.getByText('Stationery order', { exact: true }).click();
  await expect(page).toHaveURL(/\/forms\/[^/]+\/edit$/);
  await expect(palette(page)).toBeVisible();

  // A text field for who is ordering.
  await add(page, 'Text');
  await setting(settings(page), 'Label', 'Ordered by');
  await setting(settings(page), 'Field key', 'orderedBy');
  await settings(page).getByRole('switch', { name: 'Required' }).click();

  // A repeating section: it arrives with one field inside.
  await add(page, 'Repeating section');
  await expect(settings(page)).toContainText('Repeating section block');
  await setting(settings(page), 'Title', 'Items');
  await setting(settings(page), 'Block key', 'items');
  await setting(settings(page), 'Add button text', 'Add an item');

  const canvas = page.getByLabel('Form canvas');
  // The field that came with it: name it.
  await canvas.getByText('Item', { exact: true }).click();
  await setting(settings(page), 'Field key', 'item');
  await settings(page).getByRole('switch', { name: 'Required' }).click();

  // Two numbers and a line total, dragged into the section.
  for (const [labelText, key] of [['Quantity', 'qty'], ['Price', 'price'], ['Line total', 'lineTotal']] as const) {
    await drag(page, palette(page).getByRole('button', { name: 'Number', exact: true }), canvas.locator('.fb-section-body .fb-drop-end').last());
    await expect(settings(page)).toContainText('Number field');
    await setting(settings(page), 'Label', labelText);
    await setting(settings(page), 'Field key', key);
  }
  await expect(canvas.locator('.fb-section-body').getByText('Line total')).toBeVisible();

  // A grand total outside the section.
  await add(page, 'Number');
  await setting(settings(page), 'Label', 'Order total');
  await setting(settings(page), 'Field key', 'orderTotal');

  // Total the line totals under the rows.
  await canvas.getByText('Items', { exact: true }).click();
  await settings(page).getByRole('switch', { name: 'Line total' }).click();

  // Rules: a row's total, and the order total.
  await page.getByRole('button', { name: /^Rules/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Rules' });
  for (const [name, target, formula] of [['Line total', 'Line total', 'qty * price'], ['Order total', 'Order total', 'sum(lineTotal)']] as const) {
    await dialog.getByRole('button', { name: 'Add rule' }).click();
    const card = dialog.getByRole('region').last();
    await card.getByLabel('Rule name').fill(name);
    await pick(card, page, 'When', 'Always');
    await pick(card, page, 'Action', 'Set the value of');
    await pick(card, page, 'Field', target);
    await card.getByLabel('Formula').fill(formula);
    await expect(card.getByRole('alert')).toHaveCount(0);
  }
  // A formula that is wrong says so as it is typed.
  await dialog.getByRole('button', { name: 'Add rule' }).click();
  const scratch = dialog.getByRole('region').last();
  await pick(scratch, page, 'When', 'When a formula is true');
  await scratch.getByLabel('Condition formula').fill('orderTotal >');
  await expect(scratch.getByText('Expression is incomplete').first()).toBeVisible();
  await scratch.getByLabel('Condition formula').fill('orderTotal > 1000');
  await pick(scratch, page, 'Action', 'Show an error on');
  await pick(scratch, page, 'Field', 'Order total');
  await scratch.getByLabel('Error message').fill('Orders above 1,000 need a purchase request');

  // An event: a different ending for a small order.
  await dialog.getByRole('tab', { name: /Events/ }).click();
  await dialog.getByRole('button', { name: 'Add event' }).click();
  const event = dialog.getByRole('region').last();
  await event.getByLabel('Message').fill('Ordered. It will be at your desk tomorrow.');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: /^Rules/ })).toContainText('4');

  // Preview shows the form working before it is saved.
  await page.getByRole('button', { name: 'Preview' }).click();
  const preview = page.getByRole('dialog');
  await preview.getByRole('group', { name: 'Items row 1' }).getByLabel(label('Quantity')).fill('3');
  await preview.getByRole('group', { name: 'Items row 1' }).getByLabel(label('Price')).fill('20');
  await expect(preview.getByRole('group', { name: 'Items row 1' }).getByLabel(label('Line total'))).toHaveValue('60');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved')).toBeVisible();
  await page.getByRole('button', { name: 'Publish' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText(/Published STATIONERY_ORDER v1/)).toBeVisible();
  await expect(page.getByText(/it's published, so it can't be changed/)).toBeVisible();

  // The public fills it in.
  const form = await context.newPage();
  const formProblems = watchForProblems(form);
  await form.goto(formUrl(org, 'STATIONERY_ORDER'));
  await form.getByLabel(label('Ordered by')).fill('Meera');
  const row1 = form.getByRole('group', { name: 'Items row 1' });
  await row1.getByLabel(label('Item')).fill('Notebook');
  await row1.getByLabel(label('Quantity')).fill('5');
  await row1.getByLabel(label('Price')).fill('40');
  await form.getByRole('button', { name: 'Add an item' }).click();
  const row2 = form.getByRole('group', { name: 'Items row 2' });
  await row2.getByLabel(label('Item')).fill('Printer');
  await row2.getByLabel(label('Quantity')).fill('1');
  await row2.getByLabel(label('Price')).fill('9000');
  await expect(form.getByLabel(label('Order total'))).toHaveValue('9200');
  await form.getByRole('button', { name: 'Submit' }).click();
  await expect(form.getByRole('alert').filter({ hasText: 'Please fix' })).toContainText('Orders above 1,000 need a purchase request');
  await form.getByRole('button', { name: 'Remove row 2 of Items' }).click();
  await expect(form.getByLabel(label('Order total'))).toHaveValue('200');
  await form.getByRole('button', { name: 'Submit' }).click();
  await expect(form.getByText('Ordered. It will be at your desk tomorrow.')).toBeVisible();

  const forms = await (await fetch(`http://127.0.0.1:4198/forms`, { headers: { authorization: `Bearer ${org.token}` } })).json();
  const formId = forms.find((f: { code: string }) => f.code === 'STATIONERY_ORDER').id;
  expect((await submissions(org, formId))[0].payload).toEqual({ orderedBy: 'Meera', items: [{ item: 'Notebook', qty: 5, price: 40, lineTotal: 200 }], orderTotal: 200 });
  expect(problems).toEqual([]);
  expect(formProblems).toEqual([]);
});
