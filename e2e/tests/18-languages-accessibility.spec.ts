import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { call, createOrg, formUrl, signIn, submissions, watchForProblems, type Org } from './helpers';

/** One form in English, Hindi and Arabic; and every kind of field checked for accessibility. */

let org: Org;
let formId: string;
const base = { businessId: '', access: 'PUBLIC', submission: { method: 'POST', endpointId: 'default-submit' } };
const levels = [{ label: 'Meeting', value: 'MEET' }, { label: 'Delivery', value: 'DELIVER' }];

test.beforeAll(async () => {
  org = await createOrg('Front desk');
  formId = (
    await call<{ definition: { id: string } }>(201, '/forms', {
      method: 'POST',
      token: org.token,
      body: {
        folderId: org.folderId,
        definition: {
          ...base,
          name: 'Visitor pass',
          code: 'VISITOR_PASS_ML',
          fields: [
            { id: 'a', type: 'TEXT', name: 'visitor', label: 'Visitor name', required: true },
            { id: 'b', type: 'RADIO', name: 'purpose', label: 'Purpose', dataSource: { type: 'STATIC', options: levels } },
          ],
        },
      },
    })
  ).definition.id;
});

test('a designer adds languages, translates on screen, and hands the rest to a translator as a spreadsheet', async ({ page }) => {
  const problems = watchForProblems(page);
  await signIn(page, org.email);
  await page.goto(`/forms/${formId}/edit`);
  await page.getByLabel('Form settings').getByRole('button', { name: 'Languages and translations' }).click();
  const dialog = page.getByRole('dialog', { name: 'Languages' });
  await expect(dialog.getByText('Add a language to translate the form into it.')).toBeVisible();

  for (const name of ['हिन्दी (hi)', 'العربية (ar)']) {
    await dialog.getByRole('combobox', { name: 'Add a language' }).click();
    await page.getByRole('option', { name }).click();
  }
  await dialog.getByRole('button', { name: /^हिन्दी · 0 of 5/ }).click();
  const hindi = dialog.getByRole('table', { name: 'Translations into हिन्दी' });
  await hindi.getByRole('textbox', { name: 'हिन्दी: Visitor name' }).fill('आगंतुक का नाम');
  await hindi.getByRole('textbox', { name: 'हिन्दी: Meeting' }).fill('बैठक');
  await expect(dialog.getByRole('button', { name: /^हिन्दी · 2 of 5/ })).toBeVisible();

  // The spreadsheet a translator fills in: a row per piece of wording, a column per language.
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Export for a translator' }).click()]);
  expect(download.suggestedFilename()).toBe('VISITOR_PASS_ML-translations.csv');
  const csv = readFileSync(await download.path(), 'utf8').replace(/^﻿/, '');
  expect(csv.split('\r\n')[0]).toBe('key,where,en,hi,ar');
  expect(csv).toContain('field.visitor.label,Label,Visitor name,आगंतुक का नाम,');

  // It comes back with Arabic filled in.
  const filled = csv
    .replace('form.name,The form\'s title,Visitor pass,,', 'form.name,The form\'s title,Visitor pass,,تصريح زائر')
    .replace('field.visitor.label,Label,Visitor name,आगंतुक का नाम,', 'field.visitor.label,Label,Visitor name,आगंतुक का नाम,اسم الزائر')
    .replace('field.purpose.label,Label,Purpose,,', 'field.purpose.label,Label,Purpose,,الغرض');
  const path = join(tmpdir(), `fb-e2e-${Date.now()}-translations.csv`);
  writeFileSync(path, filled);
  await dialog.getByLabel('Translations file (.csv)').setInputFiles(path);
  await expect(page.getByText('5 translations read.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^العربية · 3 of 5/ })).toBeVisible();
  await page.keyboard.press('Escape');

  // The preview speaks each language.
  await page.getByRole('button', { name: 'Preview' }).click();
  const preview = page.getByRole('dialog', { name: 'Preview' });
  await preview.getByRole('combobox', { name: 'Preview in' }).click();
  await page.getByRole('option', { name: 'हिन्दी' }).click();
  await expect(preview.getByRole('textbox', { name: /^आगंतुक का नाम/ })).toBeVisible();
  await expect(preview.getByRole('button', { name: 'जमा करें' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Publish' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText(/Published VISITOR_PASS_ML v1/)).toBeVisible();
  expect(problems).toEqual([]);
});

test('the same form in English, Hindi and Arabic: wording, messages, direction; answers stored the same', async ({ page }) => {
  const problems = watchForProblems(page);
  await page.goto(formUrl(org, 'VISITOR_PASS_ML'));
  await expect(page.getByRole('textbox', { name: /^Visitor name/ })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');

  await page.getByRole('combobox', { name: 'Language' }).selectOption('hi');
  await expect(page.getByRole('textbox', { name: /^आगंतुक का नाम/ })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'hi');
  await page.getByRole('button', { name: 'जमा करें' }).click();
  await expect(page.getByText('आगंतुक का नाम आवश्यक है').first()).toBeVisible();

  // Arabic reads right to left, and what is not translated falls back to English.
  await page.getByRole('combobox', { name: 'भाषा' }).selectOption('ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page).toHaveTitle('تصريح زائر');
  const visitor = page.getByRole('textbox', { name: /^اسم الزائر/ });
  await expect(visitor).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Meeting' })).toBeVisible();
  // The label sits to the right of where it sat in English: the page really is mirrored.
  const box = await page.getByText('اسم الزائر').first().boundingBox();
  const card = await page.locator('.fp-public__card').boundingBox();
  expect(box!.x + box!.width / 2).toBeGreaterThan(card!.x + card!.width / 2);
  await page.screenshot({ path: 'test-results/arabic-form.png' });

  // A link can ask for a language; one the form does not have gets the form's own.
  await page.goto(formUrl(org, 'VISITOR_PASS_ML', '?lang=hi'));
  await page.getByRole('textbox', { name: /^आगंतुक का नाम/ }).fill('आशा राव');
  await page.getByRole('radio', { name: 'बैठक' }).click();
  await page.getByRole('button', { name: 'जमा करें' }).click();
  await expect(page.getByText('धन्यवाद। आपका उत्तर जमा हो गया है।')).toBeVisible();
  const stored = (await submissions(org, formId))[0] as unknown as { language: string; payload: Record<string, unknown> };
  expect(stored).toMatchObject({ language: 'hi', payload: { visitor: 'आशा राव', purpose: 'MEET' } });
  await page.goto(formUrl(org, 'VISITOR_PASS_ML', '?lang=fr'));
  await expect(page.getByRole('textbox', { name: /^Visitor name/ })).toBeVisible();
  expect(problems).toEqual([]);
});

const everyField = [
  { id: 't', type: 'TEXT', name: 'fullName', label: 'Full name', required: true, helpText: 'As on your ID' },
  { id: 'ta', type: 'TEXTAREA', name: 'about', label: 'About you' },
  { id: 'n', type: 'NUMBER', name: 'age', label: 'Age' },
  { id: 'e', type: 'EMAIL', name: 'email', label: 'Email' },
  { id: 'p', type: 'PHONE', name: 'phone', label: 'Phone' },
  { id: 'd', type: 'DATE', name: 'dob', label: 'Date of birth' },
  { id: 'dt', type: 'DATETIME', name: 'slot', label: 'Appointment' },
  { id: 'c', type: 'CHECKBOX', name: 'news', label: 'Send me news' },
  { id: 'sw', type: 'SWITCH', name: 'urgent', label: 'Urgent' },
  { id: 'r', type: 'RADIO', name: 'purpose', label: 'Purpose', dataSource: { type: 'STATIC', options: levels } },
  { id: 'dd', type: 'DROPDOWN', name: 'city', label: 'City', dataSource: { type: 'STATIC', options: [{ label: 'Pune', value: 'PUNE' }, { label: 'Kochi', value: 'KOCHI' }] } },
  { id: 'ms', type: 'MULTI_SELECT', name: 'langs', label: 'Languages', dataSource: { type: 'STATIC', options: [{ label: 'Hindi', value: 'HI' }, { label: 'Tamil', value: 'TA' }] } },
  { id: 'cg', type: 'CHECKBOX_GROUP', name: 'days', label: 'Days', dataSource: { type: 'STATIC', options: [{ label: 'Monday', value: 'MON' }, { label: 'Tuesday', value: 'TUE' }] } },
  { id: 'st', type: 'STEPPER', name: 'guests', label: 'Guests', validation: { min: 0, max: 5 } },
  { id: 'f', type: 'FILE', name: 'proof', label: 'Proof' },
  { id: 'sg', type: 'SIGNATURE', name: 'sign', label: 'Signature' },
  { id: 'co', type: 'CONSENT', name: 'terms', label: 'I accept the terms', required: true, props: { text: 'Visitors must wear a badge at all times.' } },
  { id: 'h', type: 'HTML', name: 'note', props: { content: '<p>Thank you for visiting.</p>' } },
  { id: 'sec', type: 'SECTION', name: 'more', label: 'More details', props: { collapsible: true } },
  { id: 'in', type: 'TEXT', name: 'company', label: 'Company', parentId: 'sec' },
  { id: 'rp', type: 'REPEAT', name: 'items', label: 'Items carried' },
  { id: 'it', type: 'TEXT', name: 'item', label: 'Item', parentId: 'rp' },
  { id: 'tb', type: 'TABS', name: 'tabs', label: 'Extra' },
  { id: 't1', type: 'SECTION', name: 'tab1', label: 'Vehicle', parentId: 'tb' },
  { id: 'v', type: 'TEXT', name: 'vehicle', label: 'Vehicle number', parentId: 't1' },
  { id: 't2', type: 'SECTION', name: 'tab2', label: 'Host', parentId: 'tb' },
  { id: 'ho', type: 'TEXT', name: 'host', label: 'Host name', parentId: 't2' },
  { id: 'ac', type: 'ACCORDION', name: 'acc', label: 'Help' },
  { id: 'a1', type: 'SECTION', name: 'acc1', label: 'Parking', parentId: 'ac' },
  { id: 'pk', type: 'TEXT', name: 'parking', label: 'Parking bay', parentId: 'a1' },
];

/** Problems an automated check can find, of the kinds that stop people using a form. */
async function accessibilityProblems(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.help} (${v.nodes.length}) e.g. ${v.nodes[0]?.html.slice(0, 120)} :: ${v.nodes.map((n) => n.any[0]?.message ?? '').join(' | ').slice(0, 400)}`);
}

test('every kind of field passes an automated accessibility check: empty, with mistakes showing, and right to left', async ({ page }) => {
  const id = (
    await call<{ definition: { id: string } }>(201, '/forms', {
      method: 'POST',
      token: org.token,
      body: { folderId: org.folderId, definition: { ...base, name: 'Every field', code: 'EVERY_FIELD_A11Y', languages: { default: 'en', others: ['ar'] }, fields: everyField } },
    })
  ).definition.id;
  await call(200, `/forms/${id}/publish`, { method: 'POST', token: org.token });

  await page.goto(formUrl(org, 'EVERY_FIELD_A11Y'));
  await expect(page.getByRole('textbox', { name: /^Full name/ })).toBeVisible();
  expect(await accessibilityProblems(page)).toEqual([]);

  // With the mistakes showing: messages must be tied to their fields and readable.
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByText('Full name is required').first()).toBeVisible();
  expect(await accessibilityProblems(page)).toEqual([]);

  await page.getByRole('combobox', { name: 'Language' }).selectOption('ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  expect(await accessibilityProblems(page)).toEqual([]);
});
