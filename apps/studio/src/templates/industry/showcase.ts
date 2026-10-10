import type { IndustryTemplate } from './kit';

/**
 * What happens after a form is sent, added to the forms where each thing has a real use: emails at the moments
 * people wait for, a task for whoever must act, a manager's approval where money is involved, a document sent
 * for signature, and alarms when a service time is about to be or has been missed. Kept here, apart from the
 * forms themselves, so the whole of it can be read in one place.
 */
type Step = Record<string, unknown>;
type Cond = Record<string, unknown>;
const assignee = [{ kind: 'ASSIGNEE' }];
const manager = [{ kind: 'MANAGER' }];
const mail = (field: string, subject: string, body: string): Step => ({ type: 'EMAIL', to: [{ kind: 'FIELD', field }], subject, body });
const notify = (message: string, to: Step[] = assignee): Step => ({ type: 'NOTIFY', to, message });
// Form Builder has no separate task list: what someone must do reaches them as a notification on the record.
const task = (title: string, dueInHours: number, description?: string): Step => notify(`To do within ${dueInHours} hour${dueInHours === 1 ? '' : 's'}: ${title}.${description ? ` ${description}` : ''}`);
const sign = (field: string, title: string, message: string): Step => ({ type: 'SIGN', to: [{ kind: 'FIELD', field }], title, message, expiresInDays: 14 });
const approve = (title: string, instructions: string): Step => ({ type: 'APPROVAL', to: manager, title, instructions, dueInHours: 24 });

let n = 0;
const auto = (name: string, when: string, actions: Step[], more: Record<string, unknown> = {}) => ({ id: `show_${++n}`, name, enabled: true, when, actions, ...more });
const onSubmit = (name: string, actions: Step[], cond?: Cond) => auto(name, 'SUBMITTED', actions, cond ? { if: cond } : {});
const onStatus = (name: string, toStatus: string, actions: Step[], cond?: Cond) => auto(name, 'STATUS_CHANGED', actions, { toStatus, ...(cond ? { if: cond } : {}) });
const onLate = (name: string, sla: 'RESPONSE' | 'RESOLUTION', actions: Step[]) => auto(name, 'SLA_BREACHED', actions, { sla });
const onNearlyLate = (name: string, sla: 'RESPONSE' | 'RESOLUTION', actions: Step[]) => auto(name, 'SLA_APPROACHING', actions, { sla });
const onFilled = (name: string, field: string, actions: Step[]) => auto(name, 'FIELD_UPDATED', actions, { field });
const is = (field: string, value: unknown): Cond => ({ field, operator: 'equals', value });
const filled = (field: string): Cond => ({ field, operator: 'isNotEmpty' });
const atLeast = (field: string, value: number): Cond => ({ field, operator: 'greaterThanOrEqual', value });

interface Extra {
  automations?: ReturnType<typeof auto>[];
  /** For a button on a record: who must agree before it takes effect, where a refusal sends it, and when it is needed. */
  approvals?: Record<string, { onReject?: string; if?: Cond }>;
  /** Ready-made emails the team can send from a record. */
  emailTemplates?: { key: string; name: string; subject: string; body: string }[];
}

const EXTRAS: Record<string, Extra> = {
  'bank-loan': {
    approvals: { sanction: { onReject: 'REJECTED', if: atLeast('amount', 2_500_000) } },
    automations: [
      onStatus('Send the sanction letter for signature', 'SANCTIONED', [sign('email', 'Loan sanction letter', 'Please read the terms of your loan and sign to accept them.'), mail('email', 'Your loan has been sanctioned', 'Good news: your loan has been sanctioned. We have sent you the sanction letter to sign.')]),
      onStatus('Tell the applicant about the money', 'DISBURSED', [mail('email', 'Your loan has been disbursed', 'The loan amount has been paid out. Your first instalment falls due next month.')]),
      onFilled('Tell the credit officer when the score is in', 'creditScore', [notify('The credit score has been recorded: the appraisal can go on.')]),
      onNearlyLate('Warn before the appraisal runs late', 'RESOLUTION', [notify('This loan application is close to its service time.')]),
      onLate('Raise a late application', 'RESOLUTION', [notify('A loan application has passed its service time.', manager)]),
    ],
    emailTemplates: [{ key: 'documents_needed', name: 'Documents needed', subject: 'We need a few more documents', body: 'To go on with your loan application we need the documents listed below. Please reply with them attached.' }],
  },
  'hr-expense-claim': {
    approvals: { approve: { onReject: 'REJECTED' } },
    automations: [
      onSubmit('A large claim is looked at first', [notify('A claim above ₹50,000 has been submitted.', manager)], atLeast('billsTotal', 50_000)),
      onStatus('Tell the employee it is paid', 'PAID', [mail('workEmail', 'Your expense claim has been paid', 'Your claim has been paid with this month\'s salary or by transfer to your account.')]),
      onStatus('Tell the employee why not', 'REJECTED', [mail('workEmail', 'Your expense claim was not approved', 'Your claim was not approved. The reason is on the claim; speak to your manager if you want it looked at again.')]),
    ],
  },
  'bank-fund-transfer': {
    approvals: { send: { onReject: 'REFUSED', if: atLeast('amount', 1_000_000) } },
    automations: [
      onStatus('Confirm to the customer', 'SENT', [mail('email', 'Your transfer has been sent', 'Your money transfer has been sent. The reference number is on your statement.')]),
      onStatus('Say when it came back', 'RETURNED', [mail('email', 'Your transfer was returned', 'The payee\'s bank returned your transfer and the amount has been credited back to your account. Please check the account details.'), task('Call the customer about the returned transfer', 4)]),
    ],
  },
  'property-rental-application': {
    automations: [
      onStatus('Send the lease for signature', 'APPROVED', [sign('email', 'Lease agreement', 'Your application has been approved. Please read the lease and sign it.'), mail('email', 'Your rental application is approved', 'Your application has been approved. We have sent you the lease to sign.')]),
      onStatus('Welcome the tenant', 'LEASED', [mail('email', 'Welcome to your new home', 'The lease is signed. We will be in touch to hand over the keys.'), task('Arrange the handover of keys and the meter readings', 48)]),
    ],
  },
  'hire-job-application': {
    automations: [
      onStatus('Arrange the interviews', 'INTERVIEW', [task('Schedule the interview and tell the candidate', 24), mail('email', 'We would like to meet you', 'Thank you for applying. We would like to invite you to an interview; a recruiter will call you to agree a time.')]),
      onStatus('Send the offer for signature', 'OFFER', [sign('email', 'Offer of employment', 'We are delighted to offer you the role. Please read the offer and sign to accept it.')]),
      onStatus('Tell the candidate', 'REJECTED', [mail('email', 'Your application', 'Thank you for your interest and the time you gave us. We will not be taking your application further this time, and we wish you well.')]),
      onSubmit('Referred candidates are seen first', [notify('A candidate referred by an employee has applied.')], is('heardFrom', 'AN_EMPLOYEE')),
    ],
  },
  'hr-joining': {
    automations: [onSubmit('Get things ready for the first day', [task('Order the laptop and create the accounts', 24, 'Laptop choice and T-shirt size are on the form.'), task('Add the new joiner to the health plan with their family', 72), notify('A new joiner has completed the joining form.')])],
  },
  'care-hospital': {
    automations: [
      onSubmit('An emergency is on its way', [notify('An emergency patient has registered and is on the way.'), task('Prepare triage for the arriving patient', 1)], is('visitType', 'EMERGENCY')),
      onStatus('Confirm to the patient', 'CONFIRMED', [mail('email', 'Your visit is confirmed', 'Your registration is confirmed. Please bring your photo identity and any earlier reports.')], filled('email')),
      onStatus('Prepare the bed', 'CONFIRMED', [task('Prepare the bed and inform the ward', 4)], is('visitType', 'ADMISSION')),
    ],
  },
  'ins-health-claim': {
    automations: [
      onStatus('Tell the policyholder it is paid', 'PAID', [mail('email', 'Your claim has been paid', 'Your claim has been settled and the amount paid into your bank account.')]),
      onStatus('Tell the policyholder what is needed', 'DOCUMENTS', [mail('email', 'We need more documents for your claim', 'To go on with your claim we need the documents our assessor has listed. Please send them within 15 days.')]),
      onNearlyLate('Warn before a claim runs late', 'RESOLUTION', [notify('This claim is close to the time allowed to settle it.')]),
      onLate('Raise a late claim', 'RESOLUTION', [notify('A claim has passed the time allowed to settle it.', manager)]),
    ],
    approvals: { approve: { onReject: 'ASSESSMENT', if: atLeast('amountClaimed', 200_000) } },
    emailTemplates: [
      { key: 'query', name: 'Query to the hospital', subject: 'A question about a claim', body: 'We are assessing a claim for a patient treated at your hospital and need the following clarification.' },
      { key: 'short_payment', name: 'Why less was paid', subject: 'How your claim was settled', body: 'Your claim has been settled for less than you claimed. The deductions and the reason for each are set out below.' },
    ],
  },
  'ins-motor-claim': {
    automations: [
      onStatus('Send the surveyor', 'SURVEY', [task('Inspect the vehicle and estimate the loss', 48), mail('email', 'A surveyor has been appointed', 'A surveyor will inspect your vehicle within two days. Please do not start repairs before then.')]),
      onSubmit('Someone was hurt', [notify('A motor claim with an injury has been intimated.', manager)], is('anyoneHurt', 'YES')),
      onLate('Raise a late claim', 'RESPONSE', [notify('A motor claim has not been acknowledged in time.', manager)]),
    ],
  },
  'gov-grievance': {
    automations: [
      onStatus('Tell the citizen it is done', 'RESOLVED', [mail('email', 'Your complaint has been resolved', 'The problem you reported has been attended to. If it has not been put right, reply within 15 days and we will reopen it.')], filled('email')),
      onNearlyLate('Warn the field team', 'RESOLUTION', [notify('This complaint is close to its service time.')]),
      onLate('Raise a late complaint', 'RESOLUTION', [notify('A complaint has passed its service time.', manager)]),
      onSubmit('Danger to people', [notify('A complaint has been marked as a danger to people.', manager), task('Make the place safe', 2)], is('severity', 'DANGER')),
    ],
    emailTemplates: [{ key: 'need_location', name: 'Where exactly?', subject: 'We could not find the place', body: 'Our team went to the place you described and could not find the problem. Could you send a landmark, a map link or a photograph?' }],
  },
  'gov-trade-licence': {
    automations: [
      onStatus('Arrange the inspection', 'INSPECTION', [task('Inspect the premises', 40), mail('email', 'A site inspection is due', 'An officer will visit your premises in the next few days. Please keep the originals of your documents ready.')]),
      onStatus('Ask for the fee', 'PAYMENT', [mail('email', 'Your trade licence: fee to pay', 'Your application has been cleared. Please pay the licence fee to receive the licence.')]),
      onStatus('Send the licence', 'ISSUED', [mail('email', 'Your trade licence has been issued', 'Your licence has been issued. Display it at your premises.')]),
    ],
  },
  'gov-vehicle-registration': {
    automations: [onStatus('Tell the owner the number', 'NUMBER_ALLOTTED', [mail('email', 'Your registration number', 'A registration number has been allotted to your vehicle. Your registration certificate follows by post.')])],
  },
  'travel-visa-application': {
    automations: [
      onStatus('Call for biometrics', 'BIOMETRICS', [mail('email', 'Your biometrics appointment', 'Please book your biometrics appointment within 15 days and bring your passport.')]),
      onStatus('Give the decision', 'GRANTED', [mail('email', 'A decision has been made on your visa application', 'A decision has been made. Please collect your passport from the application centre.')]),
      onStatus('Give the decision', 'REFUSED', [mail('email', 'A decision has been made on your visa application', 'A decision has been made. The letter with your passport explains it.')]),
      onSubmit('Express applications go first', [notify('An express visa application has been submitted.')], is('express', true)),
    ],
  },
  'safety-incident-report': {
    automations: [
      onSubmit('A serious incident', [notify('A serious incident has been reported.', manager), task('Secure the area and begin the investigation', 2)], atLeast('severity', 4)),
      onStatus('Follow the corrective actions', 'ACTIONS', [task('Check that the corrective actions are done', 240)]),
      onLate('Raise a late investigation', 'RESOLUTION', [notify('An incident investigation has passed its time.', manager)]),
    ],
  },
  'energy-new-connection': {
    automations: [
      onStatus('Send the quotation', 'QUOTATION', [mail('email', 'Quotation for your electricity connection', 'The survey is done. Please pay the charges in the quotation to go ahead.')]),
      onStatus('Fit the meter', 'PAID', [task('Fit the meter and seal it', 40)]),
      onStatus('Supply is on', 'ENERGISED', [mail('email', 'Your electricity supply is on', 'Your connection has been released. Your first bill will follow at the end of the billing month.')]),
    ],
  },
  'retail-dealer-application': {
    automations: [
      onStatus('Ask the head of sales', 'APPROVAL', [approve('Appoint this dealer?', 'The site visit report and the grading are on the record. Approve to appoint, or reject with your reason.')]),
      onStatus('Welcome the dealer', 'APPOINTED', [mail('email', 'Welcome to our network', 'We are glad to appoint you. Your dealer code and the agreement follow.'), task('Send the dealer agreement and the first price list', 48)]),
    ],
  },
  'it-access-request': {
    approvals: { manager: { onReject: 'REFUSED' }, owner: { onReject: 'REFUSED' } },
    automations: [onStatus('Tell the requester', 'PROVISIONED', [mail('workEmail', 'The access you asked for is ready', 'The access has been given. Sign out and in again to see it.')])],
  },
};

/** The form with what happens after it is sent. A form with nothing listed is returned as it is. */
export function withAfterSending(t: IndustryTemplate): IndustryTemplate {
  const extra = EXTRAS[t.key];
  if (!extra) return t;
  const def = t.definition as { automations?: unknown[]; workflow?: { actions?: { key: string; approval?: unknown }[]; emailTemplates?: unknown[] } };
  const workflow = def.workflow && {
    ...def.workflow,
    actions: (def.workflow.actions ?? []).map((a) => (extra.approvals?.[a.key] ? { ...a, approval: { to: manager, ...extra.approvals[a.key] } } : a)),
    ...(extra.emailTemplates ? { emailTemplates: extra.emailTemplates } : {}),
  };
  return { ...t, definition: { ...t.definition, ...(workflow ? { workflow } : {}), automations: [...(def.automations ?? []), ...(extra.automations ?? [])] } };
}

/** Forms that run on the library's "Service request" workflow instead of one of their own, each with its own reference numbers. */
const ON_SERVICE_REQUEST: Record<string, string> = { 'energy-connection-transfer': 'CT', 'bank-account-transfer': 'AT', 'gov-certificate': 'CRT' };

export function withSharedWorkflow(t: IndustryTemplate): IndustryTemplate {
  const refPrefix = ON_SERVICE_REQUEST[t.key];
  if (!refPrefix) return t;
  const { workflow: _own, automations: _steps, ...rest } = t.definition;
  return { ...t, setup: [...t.setup, 'This form uses the shared workflow "Service request" (Workflows): change it there and every form on it follows at its next publish.'], definition: { ...rest, workflowRef: { id: 'tpl-service-request', refPrefix } } };
}
