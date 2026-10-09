import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import { API, readState, RUNTIME } from '../stack';

export const PASSWORD = 'correct horse battery';

interface CallOptions {
  method?: string;
  body?: unknown;
  token?: string;
}

/** A call to the real API. Returns the status and the parsed body. */
export async function api<T = any>(path: string, { method = 'GET', body, token }: CallOptions = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: parsed as T };
}

/** The same, expecting a particular status. */
export async function call<T = any>(expected: number, path: string, options: CallOptions = {}): Promise<T> {
  const res = await api<T>(path, options);
  expect(res.status, `${options.method ?? 'GET'} ${path} -> ${JSON.stringify(res.body).slice(0, 400)}`).toBe(expected);
  return res.body;
}

/** Every email the API has "sent" (it prints them to its log in this setup), oldest first. */
export function mails(): { to: string; subject: string; text: string }[] {
  const log = readFileSync(readState().apiLog, 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
  const out: { to: string; subject: string; text: string }[] = [];
  const marker = /\[Mail\] to=(\S+) subject="([^"]*)"(?: attachments=[^\n]*)?\n/g;
  const starts = [...log.matchAll(marker)];
  starts.forEach((m, i) => {
    const from = m.index! + m[0].length;
    const next = log.indexOf('[Nest]', from);
    const end = i + 1 < starts.length ? Math.min(starts[i + 1].index!, next === -1 ? Infinity : next) : next === -1 ? log.length : next;
    out.push({ to: m[1], subject: m[2], text: log.slice(from, end).trim() });
  });
  return out;
}

export async function waitForMail(to: string, subject: RegExp, ms = 10_000) {
  const end = Date.now() + ms;
  for (;;) {
    const found = mails().filter((m) => m.to === to && subject.test(m.subject)).at(-1);
    if (found) return found;
    if (Date.now() > end) throw new Error(`No mail to ${to} matching ${subject}. Mails: ${JSON.stringify(mails().map((m) => [m.to, m.subject]))}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function tokenFromMail(to: string, path: string): Promise<string> {
  const end = Date.now() + 10_000;
  for (;;) {
    const mail = mails().filter((m) => m.to === to && m.text.includes(path)).at(-1);
    const token = mail?.text.match(/token=([A-Za-z0-9_-]+)/)?.[1];
    if (token) return token;
    if (Date.now() > end) throw new Error(`No ${path} mail for ${to}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

export interface Org {
  email: string;
  token: string;
  orgId: string;
  folderId: string;
}

let orgCount = 0;

/** A new organisation with its owner signed up and verified, and one folder to keep forms in. */
export async function createOrg(name = 'Acme'): Promise<Org> {
  const email = `owner${++orgCount}-${Date.now()}@e2e.test`;
  await call(202, '/auth/signup', { method: 'POST', body: { name: 'Asha Rao', email, password: PASSWORD, orgName: `${name} ${orgCount}` } });
  await call(200, '/auth/verify-email', { method: 'POST', body: { token: await tokenFromMail(email, '/verify-email') } });
  const login = await call<{ accessToken: string }>(200, '/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  const me = await call<{ org: { id: string } }>(200, '/auth/me', { token: login.accessToken });
  const folders = await call<{ id: string }[]>(201, '/folders', { method: 'POST', token: login.accessToken, body: { name: 'E2E' } });
  return { email, token: login.accessToken, orgId: me.org.id, folderId: folders[0].id };
}

/** Invites someone into the org with a role; they accept. Returns their email. */
export async function addMember(org: Org, name: string, role: string): Promise<{ email: string; token: string; userId: string }> {
  const email = `${name.toLowerCase().replace(/\W+/g, '.')}-${Date.now()}@e2e.test`;
  await call(201, '/invitations', { method: 'POST', token: org.token, body: { email, role } });
  await call(200, '/invitations/accept', { method: 'POST', body: { token: await tokenFromMail(email, '/accept-invite'), name, password: PASSWORD } });
  const login = await call<{ accessToken: string }>(200, '/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  const members = await call<{ userId: string; email: string }[]>(200, '/members', { token: org.token });
  return { email, token: login.accessToken, userId: members.find((m) => m.email === email)!.userId };
}

/** Saves a form as a draft and publishes it. Returns its id. */
export async function publishForm(org: Org, definition: Record<string, unknown>): Promise<string> {
  const base = { businessId: '', access: 'PUBLIC', submission: { method: 'POST', endpointId: 'default-submit' } };
  const created = await call<{ definition: { id: string } }>(201, '/forms', { method: 'POST', token: org.token, body: { folderId: org.folderId, definition: { ...base, ...definition } } });
  await call(200, `/forms/${created.definition.id}/publish`, { method: 'POST', token: org.token });
  return created.definition.id;
}

/** The public page of a published form. */
export const formUrl = (org: Org, code: string, query = '') => `${RUNTIME}/f/${org.orgId}/${code}${query}`;

/** Stored submissions of a form, newest first. */
export async function submissions(org: Org, formId: string): Promise<{ uuid: string; ref?: string; priority?: string; status?: string; payload: Record<string, any> }[]> {
  return (await call<{ rows: any[] }>(200, `/forms/${formId}/submissions`, { token: org.token })).rows;
}

/** Signs in to the builder through its own login page. */
export async function signIn(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** Problems the page itself reported while a test ran: uncaught errors and failed requests to our own servers. */
export function watchForProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text())) problems.push(`console error: ${m.text().slice(0, 300)}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 500 && r.url().startsWith(API)) problems.push(`${r.status()} from ${r.url()}`);
  });
  return problems;
}

/**
 * Matches a field by the start of its label. A required field's label ends
 * with a "*", and other controls may mention the same words further in
 * ("Or type your name to sign..."), so neither an exact nor a loose match will do.
 */
export const label = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
