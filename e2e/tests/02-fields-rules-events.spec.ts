import { expect, test, type Page } from '@playwright/test';
import { createOrg, formUrl, label, publishForm, submissions, watchForProblems, type Org } from './helpers';

const rooms = [{ label: 'Standard', value: 'STD' }, { label: 'Deluxe', value: 'DLX' }, { label: 'Suite', value: 'SUITE' }];
const days = [{ label: 'Friday', value: 'FRI' }, { label: 'Saturday', value: 'SAT' }, { label: 'Sunday', value: 'SUN' }];
const ZONE = 'Pacific/Kiritimati'; // 14 hours ahead of UTC: its date is never the server's by accident

const booking = {
  name: 'Room booking',
  code: 'BOOKING',
  timeZone: ZONE,
  fields: [
    { id: 't', type: 'TABS', name: 'parts', label: 'Booking' },
    { id: 's1', type: 'SECTION', name: 'you', label: 'About you', parentId: 't' },
    { id: 'n', type: 'TEXT', name: 'guest', label: 'Guest name', required: true, parentId: 's1' },
    { id: 'v', type: 'SWITCH', name: 'vip', label: 'Member', parentId: 's1' },
    { id: 'pk', type: 'TEXT', name: 'perk', label: 'Member number', parentId: 's1' },
    { id: 'nt', type: 'TEXTAREA', name: 'notes', label: 'Requests', parentId: 's1' },
    { id: 's2', type: 'SECTION', name: 'stay', label: 'Your stay', parentId: 't' },
    { id: 'd', type: 'CHECKBOX_GROUP', name: 'nights', label: 'Nights', parentId: 's2', dataSource: { type: 'STATIC', options: days }, validation: { min: 1, max: 2 } },
    { id: 'g', type: 'STEPPER', name: 'guests', label: 'Guests', parentId: 's2', validation: { min: 1, max: 4 }, props: { step: 1 } },
    { id: 'r', type: 'DROPDOWN', name: 'room', label: 'Room', parentId: 's2', required: true, dataSource: { type: 'STATIC', options: rooms } },
    { id: 'a', type: 'DATE', name: 'arrive', label: 'Arrival', parentId: 's2', required: true },
    { id: 'c', type: 'NUMBER', name: 'cost', label: 'Cost', parentId: 's2' },
    { id: 'im', type: 'IMAGE', name: 'map', label: 'How to find us', props: { src: 'https://cdn.example.invalid/map.png', alt: 'Map of the hotel' } },
    { id: 'ok', type: 'CONSENT', name: 'terms', label: 'I accept the booking terms', required: true, props: { text: 'Cancel 24 hours ahead.\n<b>No refunds after.</b>' } },
  ],
  rules: [
    { id: 'cost', then: [{ type: 'SET_VALUE', target: 'cost', value: 'guests * length(nights) * 100' }] },
    { id: 'member', when: { field: 'vip', operator: 'equals', value: true }, then: [{ type: 'SHOW', target: 'perk' }, { type: 'REQUIRE', target: 'perk' }, { type: 'ENABLE', target: 'notes' }] },
    { id: 'big', when: { expr: 'guests > 2' }, then: [{ type: 'SET_OPTIONS', target: 'room', values: ['DLX', 'SUITE'] }] },
    { id: 'past', when: { expr: 'arrive < today()' }, then: [{ type: 'ERROR', target: 'arrive', message: 'Arrival cannot be in the past' }] },
  ],
  events: [
    { id: 'open', on: { type: 'LOAD' }, do: [{ type: 'SET_VALUE', target: 'arrive', value: 'dateAdd(today(), 7)' }] },
    { id: 'member', on: { type: 'SUBMIT_SUCCESS' }, when: { expr: 'vip' }, do: [{ type: 'REDIRECT', url: '/members/thanks' }] },
    { id: 'plain', on: { type: 'SUBMIT_SUCCESS' }, when: { expr: '!vip' }, do: [{ type: 'SHOW_MESSAGE', message: 'Booked. See you soon.' }] },
    { id: 'down', on: { type: 'SUBMIT_ERROR' }, do: [{ type: 'SHOW_MESSAGE', message: 'We could not take your booking. Please call 1800 000 000.' }] },
  ],
};

const dateIn = (zone: string, addDays = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + addDays * 86_400_000));

let org: Org;
let formId: string;

test.beforeAll(async () => {
  org = await createOrg('Hotel');
  formId = await publishForm(org, booking);
});

const tab = (page: Page, name: string | RegExp) => page.getByRole('tab', { name });
const choose = async (page: Page, field: string, option: string) => {
  await page.getByRole('combobox', { name: label(field) }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
};

/** The stay tab filled in validly, from a fresh page. */
async function fillStay(page: Page) {
  await tab(page, 'Your stay').click();
  await page.getByRole('checkbox', { name: 'Friday' }).click();
  await page.getByRole('button', { name: 'Increase Guests' }).click();
  await choose(page, 'Room', 'Standard');
}

test('opening the form fills the arrival date, in the form\'s own time zone', async ({ page }) => {
  await page.goto(formUrl(org, 'BOOKING'));
  await tab(page, 'Your stay').click();
  await expect(page.getByLabel(label('Arrival'))).toHaveValue(dateIn(ZONE, 7));
  // And the person can still change it.
  await expect(page.getByLabel(label('Arrival'))).toBeEnabled();
});

test('tabs keep answers, flag the one with a mistake, and open it from the list', async ({ page }) => {
  const problems = watchForProblems(page);
  await page.goto(formUrl(org, 'BOOKING'));
  await expect(tab(page, 'About you')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel(label('Guest name'))).toBeVisible();
  await expect(page.getByRole('img', { name: 'Map of the hotel' })).toHaveAttribute('src', 'https://cdn.example.invalid/map.png');
  // The terms are shown as text, never as markup.
  await expect(page.getByRole('region', { name: 'Terms' })).toContainText('<b>No refunds after.</b>');

  // Keyboard: arrow keys move between tabs.
  await tab(page, 'About you').focus();
  await page.keyboard.press('ArrowRight');
  await expect(tab(page, 'Your stay')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel(label('Guest name'))).toBeHidden();

  await page.getByRole('checkbox', { name: 'Friday' }).click();
  await page.getByRole('button', { name: 'Increase Guests' }).click();
  await choose(page, 'Room', 'Standard');
  await page.getByRole('checkbox', { name: /I accept the booking terms/ }).click();
  await page.getByRole('button', { name: 'Submit' }).click();

  // The name on the other tab is missing: that tab is flagged, and the list takes you there.
  await expect(tab(page, /About you \(needs attention\)/)).toBeVisible();
  await expect(tab(page, /Your stay/)).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('alert').filter({ hasText: 'Please fix' }).getByRole('button', { name: /Guest name/ }).click();
  await expect(tab(page, /About you/)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel(label('Guest name'))).toBeFocused();

  await page.getByLabel(label('Guest name')).fill('Asha Rao');
  await expect(tab(page, 'About you')).toBeVisible(); // no longer flagged
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByText('Booked. See you soon.')).toBeVisible();

  const [stored] = await submissions(org, formId);
  expect(stored.payload).toEqual({ guest: 'Asha Rao', vip: false, nights: ['FRI'], guests: 1, room: 'STD', arrive: dateIn(ZONE, 7), cost: 100, terms: true });
  expect(problems).toEqual([]);
});

test('stepper, tick boxes and a calculated cost; a larger party narrows the rooms', async ({ page }) => {
  await page.goto(formUrl(org, 'BOOKING'));
  await tab(page, 'Your stay').click();
  const guests = page.getByLabel(label('Guests'));
  const more = page.getByRole('button', { name: 'Increase Guests' });
  await more.click();
  await expect(guests).toHaveValue('1');
  await page.getByRole('checkbox', { name: 'Friday' }).click();
  await page.getByRole('checkbox', { name: 'Saturday' }).click();
  await expect(page.getByLabel(label('Cost'))).toHaveValue('200');
  await expect(page.getByLabel(label('Cost'))).toBeDisabled();

  await choose(page, 'Room', 'Standard');
  await more.click();
  await more.click();
  await expect(guests).toHaveValue('3');
  await expect(page.getByLabel(label('Cost'))).toHaveValue('600');
  // Standard is no longer offered for three guests, and the choice of it is dropped.
  await expect(page.getByRole('combobox', { name: label('Room') })).not.toContainText('Standard');
  await page.getByRole('combobox', { name: label('Room') }).click();
  await expect(page.getByRole('option')).toHaveText(['Deluxe', 'Suite']);
  await page.getByRole('option', { name: 'Suite' }).click();

  await more.click();
  await expect(guests).toHaveValue('4');
  await expect(more).toBeDisabled();
  await page.getByRole('button', { name: 'Decrease Guests' }).click();
  await expect(guests).toHaveValue('3');

  // A third night is one too many.
  await page.getByRole('checkbox', { name: 'Sunday' }).click();
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Please fix' })).toContainText('Select at most 2');
});

test('a member sees and must give a member number, may write requests, and is sent on afterwards', async ({ page }) => {
  await page.goto(formUrl(org, 'BOOKING'));
  await expect(page.getByLabel(label('Member number'))).toHaveCount(0);
  await expect(page.getByLabel(label('Requests'))).toBeDisabled();
  await page.getByLabel(label('Guest name')).fill('Vikram');
  await page.getByRole('switch', { name: /Member/ }).click();
  await expect(page.getByLabel(label('Member number'))).toBeVisible();
  await expect(page.getByLabel(label('Requests'))).toBeEnabled();
  await page.getByLabel(label('Requests')).fill('High floor');

  await fillStay(page);
  await page.getByRole('checkbox', { name: /I accept the booking terms/ }).click();
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Please fix' })).toContainText('Member number is required');

  await tab(page, /About you/).click();
  await page.getByLabel(label('Member number')).fill('M-1001');
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page).toHaveURL(/\/members\/thanks$/);
  expect((await submissions(org, formId))[0].payload).toMatchObject({ guest: 'Vikram', vip: true, perk: 'M-1001', notes: 'High floor' });
});

test('an arrival in the past is refused, by the page and by the server on its own', async ({ page }) => {
  await page.goto(formUrl(org, 'BOOKING'));
  await page.getByLabel(label('Guest name')).fill('Late');
  await fillStay(page);
  await page.getByLabel(label('Arrival')).fill(dateIn(ZONE, -2));
  await page.getByRole('checkbox', { name: /I accept the booking terms/ }).click();
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Please fix' })).toContainText('Arrival cannot be in the past');

  // Straight to the API, claiming a zone where that date would still be "today or later" makes no difference:
  // the form's own zone decides.
  const res = await fetch(`http://127.0.0.1:4198/public/forms/BOOKING/submissions?org=${org.orgId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values: { guest: 'Late', nights: ['FRI'], guests: 1, room: 'STD', arrive: dateIn(ZONE, -1), terms: true }, timeZone: 'Etc/GMT+12' }),
  });
  expect(res.status).toBe(422);
  expect((await res.json()).errors).toEqual([{ field: 'arrive', message: 'Arrival cannot be in the past' }]);
});

test('when the submit fails the form shows its own message and keeps the answers', async ({ page }) => {
  await page.goto(formUrl(org, 'BOOKING'));
  await page.getByLabel(label('Guest name')).fill('Unlucky');
  await fillStay(page);
  await page.getByRole('checkbox', { name: /I accept the booking terms/ }).click();
  await page.route('**/public/forms/BOOKING/submissions**', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Internal server error' }) }));
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByText('We could not take your booking. Please call 1800 000 000.')).toBeVisible();
  await expect(page.getByText('Internal server error')).toHaveCount(0);
  await tab(page, /About you/).click();
  await expect(page.getByLabel(label('Guest name'))).toHaveValue('Unlucky');

  // The connection comes back: the same answers go through.
  await page.unroute('**/public/forms/BOOKING/submissions**');
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByText('Booked. See you soon.')).toBeVisible();
});
