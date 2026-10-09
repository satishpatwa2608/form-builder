import { expect, test, type Page } from '@playwright/test';
import { addMember, call, createOrg, formUrl, label, signIn, watchForProblems, type Org } from './helpers';

/** An address kept once in the library and used on three forms: changed once, every form follows when it is next published. */

let org: Org;
let designer: Awaited<ReturnType<typeof addMember>>;
const ids: Record<string, string> = {};

const base = { businessId: '', access: 'PUBLIC', submission: { method: 'POST', endpointId: 'default-submit' } };
const draft = async (definition: Record<string, unknown>) =>
  (await call<{ definition: { id: string } }>(201, '/forms', { method: 'POST', token: org.token, body: { folderId: org.folderId, definition: { ...base, ...definition } } })).definition.id;
const definition = async (id: string) => (await call<{ definition: { fields: { name: string; label?: string }[] } }>(200, `/forms/${id}`, { token: org.token })).definition;
const names = async (id: string) => (await definition(id)).fields.map((f) => f.name);
const publish = (id: string) => call(200, `/forms/${id}/publish`, { method: 'POST', token: org.token });
const nextVersion = async (code: string) => {
  const forms = await call<{ id: string; code: string }[]>(200, '/forms', { token: org.token });
  return (await call<{ definition: { id: string } }>(200, `/forms/${forms.find((f) => f.code === code)!.id}/new-version`, { method: 'POST', token: org.token })).definition.id;
};
const canvas = (page: Page) => page.locator('.fb-canvas, [aria-label="Form canvas"]').first();
const customer = { id: 'who', type: 'TEXT', name: 'customer', label: 'Customer', required: true };

test.beforeAll(async () => {
  org = await createOrg('Trading');
  designer = await addMember(org, 'Dev Designer', 'DESIGNER');
});

test('an admin turns a section of one form into a fragment with one button', async ({ page }) => {
  const problems = watchForProblems(page);
  ids.order = await draft({
    name: 'Order',
    code: 'ORDER',
    fields: [
      customer,
      { id: 'addr', type: 'SECTION', name: 'delivery', label: 'Delivery address' },
      { id: 'l1', type: 'TEXT', name: 'line1', label: 'Address line', required: true, parentId: 'addr' },
      { id: 'c1', type: 'TEXT', name: 'city', label: 'City', required: true, parentId: 'addr' },
    ],
  });
  await signIn(page, org.email);
  await page.goto(`/forms/${ids.order}/edit`);
  await canvas(page).getByText('Delivery address', { exact: true }).click();
  await page.getByRole('button', { name: 'Save as fragment' }).click();
  await page.getByLabel('Name in the library').fill('Address');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('"Address" is in the library. This section is now a copy of it.')).toBeVisible();
  await expect(page.getByText('A copy of the fragment Address.')).toBeVisible();
  await page.getByRole('button', { name: 'Publish' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText(/Published ORDER v1/)).toBeVisible();
  expect(await names(ids.order)).toEqual(['customer', 'delivery', 'line1', 'city']);
  expect(problems).toEqual([]);
});

test('a designer adds it to other forms from the palette; its fields cannot be changed there; twice on one form is kept apart', async ({ page }) => {
  const problems = watchForProblems(page);
  ids.quote = await draft({ name: 'Quote', code: 'QUOTE', fields: [customer] });
  ids.invoice = await draft({ name: 'Invoice', code: 'INVOICE', fields: [customer] });
  await signIn(page, designer.email);

  await page.goto(`/forms/${ids.quote}/edit`);
  const palette = page.getByLabel('Field palette');
  await palette.getByRole('button', { name: 'Address', exact: true }).click();
  await expect(canvas(page).getByText('Address line')).toBeVisible();
  // A designer uses fragments; changing one is for admins.
  await expect(page.getByText('A copy of the fragment Address.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change this fragment' })).toHaveCount(0);
  // A field inside it is shown, with its settings switched off and the reason given.
  await canvas(page).getByText(/^City/).click();
  await expect(page.getByText(/Part of the fragment section Address\. Its fields are changed in the library/)).toBeVisible();
  await expect(page.getByLabel('Label', { exact: true })).toBeDisabled();
  // And on the canvas there is nothing to move, copy or delete inside the section: only the section itself.
  await expect(canvas(page).getByRole('button', { name: 'Delete' })).toHaveCount(2);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved')).toBeVisible();

  await page.goto(`/forms/${ids.invoice}/edit`);
  await palette.getByRole('button', { name: 'Address', exact: true }).click();
  await palette.getByRole('button', { name: 'Address', exact: true }).click();
  // The second copy was given a prefix without being asked.
  await expect(page.getByLabel('Prefix for its field keys')).toHaveValue('address2');
  await page.getByLabel('Prefix for its field keys').fill('shipping');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved')).toBeVisible();

  await publish(ids.quote);
  await publish(ids.invoice);
  expect(await names(ids.quote)).toEqual(['customer', expect.stringMatching(/^section_/), 'line1', 'city']);
  expect((await names(ids.invoice)).filter((n) => !n.startsWith('section_'))).toEqual(['customer', 'line1', 'city', 'shipping_line1', 'shipping_city']);
  expect(problems).toEqual([]);
});

test('changed once, by an admin, in any form that uses it: every form follows when it is next published, and not before', async ({ page }) => {
  const problems = watchForProblems(page);
  await signIn(page, org.email);
  const order = await nextVersion('ORDER');
  await page.goto(`/forms/${order}/edit`);
  await canvas(page).getByText('Delivery address', { exact: true }).click();
  await page.getByRole('button', { name: 'Change this fragment' }).click();
  await canvas(page).getByText(/^City/).click();
  await page.getByLabel('Label', { exact: true }).fill('Town or city');
  await canvas(page).getByText('Delivery address', { exact: true }).click();
  await page.getByRole('button', { name: 'Save to the library' }).click();
  await expect(page.getByText('"Address" saved. Other forms get the change when they are next published.')).toBeVisible();

  // The live Quote form has not changed.
  const live = await page.context().newPage();
  await live.goto(formUrl(org, 'QUOTE'));
  await expect(live.getByLabel(label('City'))).toBeVisible();
  await expect(live.getByLabel(label('Town or city'))).toHaveCount(0);

  // Opening its next version in the builder brings the section up to date; publishing makes it live.
  const quote = await nextVersion('QUOTE');
  await page.goto(`/forms/${quote}/edit`);
  await expect(canvas(page).getByText('Town or city')).toBeVisible();
  await page.getByRole('button', { name: 'Publish' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText(/Published QUOTE v2/)).toBeVisible();
  await live.reload();
  await expect(live.getByLabel(label('Town or city'))).toBeVisible();

  // A form published without ever being opened is brought up to date by the server, both copies of it.
  const invoice = await nextVersion('INVOICE');
  await publish(invoice);
  expect((await definition(invoice)).fields.filter((f) => f.name.endsWith('city')).map((f) => `${f.name}: ${f.label}`)).toEqual(['city: Town or city', 'shipping_city: Town or city']);
  expect(problems).toEqual([]);
});

test('the library lists what uses a fragment and will not delete one in use', async ({ page }) => {
  await signIn(page, org.email);
  await page.getByRole('link', { name: 'Fragments' }).click();
  const row = page.getByRole('row').filter({ hasText: 'Address' });
  await expect(row).toContainText('Address line, Town or city');
  await expect(row).toContainText('Invoice');
  await expect(row).toContainText('Order');
  await expect(row).toContainText('Quote');
  await row.getByRole('button', { name: 'Delete Address' }).click();
  await expect(page.getByText(/"Address" is used by .*Detach it there first\./)).toBeVisible();
  await row.getByRole('button', { name: 'Rename Address' }).click();
  const dialog = page.getByRole('dialog', { name: 'Address' });
  await dialog.getByLabel('Name', { exact: true }).fill('Postal address');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Postal address' })).toBeVisible();
});
