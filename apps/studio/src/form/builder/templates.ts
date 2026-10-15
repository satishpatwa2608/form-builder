import type { FormDefinition } from '../types';

/**
 * Ready-made processes: a form plus its whole workflow, as configuration only
 * (no code). "New form -> Start from" copies one into a draft; everything
 * stays editable. Org-specific bits (who gets new items, teams, thresholds)
 * are left for the designer - see each template's `setup` notes.
 */
export interface FormTemplate {
  key: string;
  name: string;
  description: string;
  /** What to set before publishing. */
  setup: string[];
  definition: Pick<FormDefinition, 'fields' | 'workflow' | 'automations' | 'access' | 'description' | 'recordAccess'>;
  /** Saved inbox views made with the form (shared with the team), e.g. its overdue work. `formCode` is added. */
  views?: { name: string; filters: Record<string, string> }[];
}

const opts = (...pairs: [string, string][]) => ({ type: 'STATIC' as const, options: pairs.map(([value, label]) => ({ value, label })) });

const complaint: FormTemplate = {
  key: 'customer-complaint',
  name: 'Customer complaint (full process)',
  description: 'Public complaint form with triage, investigation (root cause), resolution with approval, corrective actions, SLA and escalation.',
  setup: [
    'Workflow → Process: choose who new complaints go to (e.g. "Depends on an answer": Business → each business\'s quality head).',
    'Workflow → Process → Who works these records: pick the Quality team if others should not see complaints.',
    'Working time (Form → Working time) is used for the SLA; check the calendar.',
    'Turn on CAPTCHA for a public link (form settings).',
  ],
  definition: {
    access: 'PUBLIC',
    description: 'Tell us what went wrong. You will get a reference number and we will keep you updated by email.',
    fields: [
      { id: 'c_name', type: 'TEXT', name: 'name', label: 'Your name', required: true, prefill: { source: 'USER_NAME' } },
      { id: 'c_company', type: 'TEXT', name: 'company', label: 'Company' },
      { id: 'c_email', type: 'EMAIL', name: 'email', label: 'Email', required: true, prefill: { source: 'USER_EMAIL' } },
      { id: 'c_phone', type: 'PHONE', name: 'phone', label: 'Phone' },
      { id: 'c_business', type: 'DROPDOWN', name: 'business', label: 'Business', required: true, dataSource: opts(['DENIM', 'Denim'], ['COTTON', 'Cotton'], ['YARN', 'Yarn'], ['OTHER', 'Other']) },
      { id: 'c_invoice', type: 'TEXT', name: 'invoiceNo', label: 'Invoice / contract no.' },
      { id: 'c_product', type: 'TEXT', name: 'product', label: 'Product / article' },
      { id: 'c_lot', type: 'TEXT', name: 'lotNo', label: 'Lot / batch no.' },
      { id: 'c_qty', type: 'NUMBER', name: 'quantity', label: 'Quantity affected' },
      {
        id: 'c_category',
        type: 'DROPDOWN',
        name: 'category',
        label: 'What is it about?',
        required: true,
        dataSource: opts(['QUALITY', 'Quality'], ['DELIVERY', 'Delivery / quantity'], ['PACKING', 'Packing / labelling'], ['DOCUMENTS', 'Documents / billing'], ['OTHER', 'Other']),
      },
      { id: 'c_severity', type: 'RADIO', name: 'severity', label: 'How serious is it?', required: true, dataSource: opts(['LOW', 'Minor'], ['MEDIUM', 'Moderate'], ['HIGH', 'Serious'], ['CRITICAL', 'Production stopped']) },
      { id: 'c_desc', type: 'TEXTAREA', name: 'description', label: 'What happened?', required: true },
      { id: 'c_expect', type: 'DROPDOWN', name: 'expected', label: 'What would you like us to do?', dataSource: opts(['INVESTIGATE', 'Investigate'], ['REPLACE', 'Replace the goods'], ['CREDIT', 'Credit note']) },
      { id: 'c_amount', type: 'NUMBER', name: 'amountClaimed', label: 'Amount claimed (INR)' },
    ],
    workflow: {
      enabled: true,
      refPrefix: 'CMP',
      statuses: [
        { key: 'NEW', label: 'New', category: 'OPEN', slaHours: 4 },
        { key: 'WAITING_CUSTOMER', label: 'Waiting for customer', category: 'IN_PROGRESS' },
        { key: 'INVESTIGATION', label: 'Investigation', category: 'IN_PROGRESS' },
        { key: 'RESOLUTION', label: 'Resolution proposed', category: 'IN_PROGRESS' },
        { key: 'CAPA', label: 'Corrective actions', category: 'IN_PROGRESS' },
        { key: 'CLOSED', label: 'Closed', category: 'DONE' },
        { key: 'REJECTED', label: 'Rejected', category: 'DONE' },
      ],
      assignment: { type: 'NONE' },
      priority: {
        default: 'MEDIUM',
        rules: [
          { if: { field: 'severity', operator: 'equals', value: 'CRITICAL' }, priority: 'CRITICAL' },
          { if: { field: 'severity', operator: 'equals', value: 'HIGH' }, priority: 'HIGH' },
          { if: { field: 'severity', operator: 'equals', value: 'LOW' }, priority: 'LOW' },
        ],
      },
      actions: [
        { key: 'accept', label: 'Accept & investigate', from: ['NEW', 'WAITING_CUSTOMER'], to: 'INVESTIGATION' },
        { key: 'reject', label: 'Reject', from: ['NEW', 'WAITING_CUSTOMER'], to: 'REJECTED', requireComment: true },
        {
          key: 'propose',
          label: 'Propose resolution',
          from: ['INVESTIGATION'],
          to: 'RESOLUTION',
          requireFields: ['lotVerified', 'rootCauseCategory', 'rootCause', 'responsibility', 'disposition'],
        },
        {
          key: 'confirm',
          label: 'Confirm resolution',
          from: ['RESOLUTION'],
          to: 'CAPA',
          requireComment: true,
          approval: {
            to: [{ kind: 'MANAGER' }],
            onReject: 'INVESTIGATION',
            if: { field: '$work.compensationAmount', operator: 'greaterThanOrEqual', value: 50000 },
          },
        },
        { key: 'close', label: 'Close', from: ['CAPA'], to: 'CLOSED', requireFields: ['correctiveAction', 'preventiveAction', 'resolutionSummary'] },
      ],
      reopen: { to: 'INVESTIGATION', withinDays: 30 },
      sla: {
        calendar: 'WORKING',
        responseHours: 4,
        resolutionHours: 72,
        byPriority: { CRITICAL: { responseHours: 1, resolutionHours: 24 }, HIGH: { responseHours: 2, resolutionHours: 48 } },
        pauseIn: ['WAITING_CUSTOMER'],
        warnAtPercent: 75,
      },
      escalation: {
        levels: [
          { afterHours: 0, notify: [{ kind: 'MANAGER' }] },
          { afterHours: 24, notify: [{ kind: 'MANAGER' }], raisePriority: true },
        ],
      },
      requestInfoStatus: 'WAITING_CUSTOMER',
      contactEmailField: 'email',
      emailTemplates: [
        {
          key: 'request_info',
          name: 'Ask for details',
          subject: 'About your complaint {{$record.ref}}',
          body: 'Dear {{name}},\n\nTo look into your complaint {{$record.ref}} we need a little more information:\n\n- the lot / batch number and invoice number\n- photos of the problem\n\nPlease reply to this email.',
        },
        {
          key: 'proposal',
          name: 'Resolution proposal',
          subject: 'Proposed resolution for {{$record.ref}}',
          body: 'Dear {{name}},\n\nWe have investigated your complaint {{$record.ref}}.\n\nWhat we found: {{$work.rootCause}}\n\nWhat we propose: {{$work.resolutionSummary}}\n\nPlease let us know if you agree.',
        },
      ],
      workFields: [
        { id: 'w_lot', type: 'CHECKBOX', name: 'lotVerified', label: 'Lot / batch verified' },
        {
          id: 'w_rcc',
          type: 'DROPDOWN',
          name: 'rootCauseCategory',
          label: 'Root cause category',
          dataSource: opts(['RAW_MATERIAL', 'Raw material'], ['PROCESS', 'Process'], ['MACHINE', 'Machine'], ['HANDLING', 'Handling / transport'], ['CUSTOMER_USE', 'Customer usage'], ['NO_DEFECT', 'Not a defect']),
        },
        { id: 'w_rc', type: 'TEXTAREA', name: 'rootCause', label: 'Root cause (5 whys)' },
        {
          id: 'w_resp',
          type: 'DROPDOWN',
          name: 'responsibility',
          label: 'Responsibility',
          dataSource: opts(['PLANT', 'Plant'], ['LOGISTICS', 'Logistics'], ['SALES', 'Sales'], ['SUPPLIER', 'Supplier'], ['CUSTOMER', 'Customer']),
        },
        {
          id: 'w_disp',
          type: 'DROPDOWN',
          name: 'disposition',
          label: 'Disposition',
          dataSource: opts(['NONE', 'No compensation'], ['REPLACEMENT', 'Replacement'], ['CREDIT', 'Credit note'], ['DISCOUNT', 'Discount']),
        },
        { id: 'w_amt', type: 'NUMBER', name: 'compensationAmount', label: 'Compensation amount (INR)' },
        { id: 'w_ca', type: 'TEXTAREA', name: 'correctiveAction', label: 'Corrective action' },
        { id: 'w_pa', type: 'TEXTAREA', name: 'preventiveAction', label: 'Preventive action' },
        { id: 'w_sum', type: 'TEXTAREA', name: 'resolutionSummary', label: 'Resolution summary (shared with the customer)' },
      ],
    },
    automations: [
      {
        id: 'ack',
        name: 'Acknowledge',
        enabled: true,
        when: 'SUBMITTED',
        actions: [
          {
            id: 'ack_email',
            type: 'EMAIL',
            to: [{ kind: 'FIELD', field: 'email' }],
            subject: 'We received your complaint {{$record.ref}}',
            body: 'Dear {{name}},\n\nThank you for letting us know. Your complaint has been registered as {{$record.ref}}. Our team will contact you shortly.',
          },
        ],
      },
      {
        id: 'critical',
        name: 'Critical complaint alert',
        enabled: true,
        when: 'SUBMITTED',
        if: { field: '$priority', operator: 'equals', value: 'CRITICAL' },
        actions: [{ id: 'alert', type: 'NOTIFY', to: [{ kind: 'ASSIGNEE' }, { kind: 'MANAGER' }], message: 'Critical complaint {{$record.ref}} from {{company}}: {{description}}' }],
      },
      {
        id: 'capa',
        name: 'Corrective action task',
        enabled: true,
        when: 'STATUS_CHANGED',
        toStatus: 'CAPA',
        actions: [{ id: 'task', type: 'NOTIFY', to: [{ kind: 'ASSIGNEE' }], message: 'Corrective action due for {{$record.ref}}: {{$work.rootCause}}' }],
      },
      {
        id: 'closed',
        name: 'Closure email',
        enabled: true,
        when: 'STATUS_CHANGED',
        toStatus: 'CLOSED',
        actions: [
          {
            id: 'close_email',
            type: 'EMAIL',
            to: [{ kind: 'FIELD', field: 'email' }],
            subject: 'Your complaint {{$record.ref}} is closed',
            body: 'Dear {{name}},\n\n{{$work.resolutionSummary}}\n\nThank you for your patience. If the problem comes back, reply to this email within 30 days and we will reopen it.',
          },
        ],
      },
      {
        id: 'rejected',
        name: 'Rejection email',
        enabled: true,
        when: 'STATUS_CHANGED',
        toStatus: 'REJECTED',
        actions: [
          {
            id: 'reject_email',
            type: 'EMAIL',
            to: [{ kind: 'FIELD', field: 'email' }],
            subject: 'About your complaint {{$record.ref}}',
            body: 'Dear {{name}},\n\nWe have reviewed your complaint {{$record.ref}} and are unable to accept it. Our team will get in touch to explain.',
          },
        ],
      },
    ],
  },
};

const lead: FormTemplate = {
  key: 'customer-lead',
  name: 'Customer lead (sales pipeline)',
  description: 'Lead form with a sales pipeline (contacted → qualified → proposal → won / lost), hot-lead priority, fast first-response SLA and discount approval.',
  setup: [
    'Workflow → Process: send new leads to the sales team (e.g. "A team, in turn" = round robin).',
    'Form → Webhooks: subscribe your CRM to record.resolved / status.changed for this form (tick "Include answers and work fields").',
  ],
  definition: {
    access: 'PUBLIC',
    description: 'Tell us what you are looking for and our sales team will get back to you.',
    fields: [
      { id: 'l_name', type: 'TEXT', name: 'name', label: 'Your name', required: true },
      { id: 'l_company', type: 'TEXT', name: 'company', label: 'Company', required: true },
      { id: 'l_email', type: 'EMAIL', name: 'email', label: 'Email', required: true },
      { id: 'l_phone', type: 'PHONE', name: 'phone', label: 'Phone' },
      { id: 'l_region', type: 'DROPDOWN', name: 'region', label: 'Region', required: true, dataSource: opts(['NORTH', 'North'], ['SOUTH', 'South'], ['EAST', 'East'], ['WEST', 'West'], ['EXPORT', 'Export']) },
      { id: 'l_interest', type: 'DROPDOWN', name: 'interest', label: 'Interested in', required: true, dataSource: opts(['DENIM', 'Denim fabric'], ['COTTON', 'Cotton fabric'], ['YARN', 'Yarn']) },
      { id: 'l_qty', type: 'NUMBER', name: 'quantity', label: 'Monthly quantity (m / kg)' },
      { id: 'l_budget', type: 'NUMBER', name: 'budget', label: 'Approx. monthly budget (INR)' },
      { id: 'l_source', type: 'DROPDOWN', name: 'source', label: 'How did you hear about us?', dataSource: opts(['WEBSITE', 'Website'], ['EXHIBITION', 'Exhibition'], ['REFERRAL', 'Referral'], ['OTHER', 'Other']) },
      { id: 'l_msg', type: 'TEXTAREA', name: 'message', label: 'Message' },
    ],
    workflow: {
      enabled: true,
      refPrefix: 'LEAD',
      statuses: [
        { key: 'NEW', label: 'New', category: 'OPEN' },
        { key: 'CONTACTED', label: 'Contacted', category: 'IN_PROGRESS' },
        { key: 'QUALIFIED', label: 'Qualified', category: 'IN_PROGRESS' },
        { key: 'PROPOSAL', label: 'Proposal sent', category: 'IN_PROGRESS' },
        { key: 'WON', label: 'Won', category: 'DONE' },
        { key: 'LOST', label: 'Lost', category: 'DONE' },
      ],
      assignment: { type: 'NONE' },
      priority: { default: 'MEDIUM', rules: [{ if: { field: 'budget', operator: 'greaterThanOrEqual', value: 1000000 }, priority: 'HIGH' }] },
      actions: [
        { key: 'contact', label: 'Log first contact', from: ['NEW'], to: 'CONTACTED', requireComment: true },
        { key: 'qualify', label: 'Qualify', from: ['CONTACTED'], to: 'QUALIFIED', requireFields: ['leadScore', 'decisionMaker'] },
        {
          key: 'propose',
          label: 'Send proposal',
          from: ['QUALIFIED'],
          to: 'PROPOSAL',
          requireFields: ['proposalValue', 'discountPercent'],
          approval: { to: [{ kind: 'MANAGER' }], onReject: 'QUALIFIED', if: { field: '$work.discountPercent', operator: 'greaterThan', value: 10 } },
        },
        { key: 'win', label: 'Mark won', from: ['PROPOSAL'], to: 'WON', requireFields: ['orderValue'] },
        { key: 'lose', label: 'Mark lost', from: ['NEW', 'CONTACTED', 'QUALIFIED', 'PROPOSAL'], to: 'LOST', requireFields: ['lostReason'], requireComment: true },
      ],
      reopen: { to: 'CONTACTED', withinDays: 90 },
      sla: { calendar: 'WORKING', responseHours: 4, byPriority: { HIGH: { responseHours: 1 } } },
      contactEmailField: 'email',
      emailTemplates: [
        {
          key: 'follow_up',
          name: 'Follow-up',
          subject: 'Your enquiry {{$record.ref}}',
          body: 'Dear {{name}},\n\nThank you for your interest in our {{interest}}. When would be a good time for a short call?',
        },
      ],
      workFields: [
        { id: 'w_score', type: 'RADIO', name: 'leadScore', label: 'Lead score', dataSource: opts(['HOT', 'Hot'], ['WARM', 'Warm'], ['COLD', 'Cold']) },
        { id: 'w_dm', type: 'TEXT', name: 'decisionMaker', label: 'Decision maker' },
        { id: 'w_pv', type: 'NUMBER', name: 'proposalValue', label: 'Proposal value (INR)' },
        { id: 'w_disc', type: 'NUMBER', name: 'discountPercent', label: 'Discount (%)' },
        { id: 'w_ov', type: 'NUMBER', name: 'orderValue', label: 'Order value (INR)' },
        {
          id: 'w_lost',
          type: 'DROPDOWN',
          name: 'lostReason',
          label: 'Lost reason',
          dataSource: opts(['PRICE', 'Price'], ['COMPETITOR', 'Went with a competitor'], ['NO_BUDGET', 'No budget'], ['NO_RESPONSE', 'No response'], ['OTHER', 'Other']),
        },
      ],
    },
    automations: [
      {
        id: 'ack',
        name: 'Thank the lead',
        enabled: true,
        when: 'SUBMITTED',
        actions: [
          {
            id: 'ack_email',
            type: 'EMAIL',
            to: [{ kind: 'FIELD', field: 'email' }],
            subject: 'Thank you for your enquiry ({{$record.ref}})',
            body: 'Dear {{name}},\n\nThank you for contacting us about {{interest}}. Our sales team will reach out shortly.',
          },
        ],
      },
      {
        id: 'slow',
        name: 'Lead not contacted in time',
        enabled: true,
        when: 'SLA_BREACHED',
        sla: 'RESPONSE',
        actions: [{ id: 'nudge', type: 'NOTIFY', to: [{ kind: 'ASSIGNEE' }, { kind: 'MANAGER' }], message: 'Lead {{$record.ref}} ({{company}}) has not been contacted yet' }],
      },
      {
        id: 'won',
        name: 'Deal won',
        enabled: true,
        when: 'STATUS_CHANGED',
        toStatus: 'WON',
        actions: [{ id: 'cheer', type: 'NOTIFY', to: [{ kind: 'MANAGER' }], message: 'Won: {{company}} - order {{$work.orderValue}} ({{$record.ref}})' }],
      },
    ],
  },
};

/**
 * A resident reports a problem, maintenance fixes it, a manager watches what is late: the whole process in one
 * step. Who gets each kind of problem and the maintenance team are the organisation's to fill in.
 */
const maintenance: FormTemplate = {
  key: 'maintenance-complaint',
  name: 'Maintenance complaint (full process)',
  description: 'Residents report a problem with a photo; it goes to whoever fixes that kind of problem, with deadlines by urgency, escalation to the manager, a photo of the repair before it is closed, and emails to the resident.',
  setup: [
    'Fill in your properties in "Which property?".',
    'Under Assignment, choose who gets each kind of problem (left empty, it waits in the Maintenance team\'s queue).',
    'Put your maintenance people in the "Maintenance" department (Members), or change the team under "Who works these records".',
  ],
  views: [{ name: 'Overdue maintenance', filters: { overdue: 'true', open: 'true', sort: 'due' } }],
  definition: {
    access: 'PUBLIC',
    description: 'Tell us what needs fixing. We will let you know when someone is on it and when it is done.',
    fields: [
      { id: 'm_name', type: 'TEXT', name: 'name', label: 'Your name', required: true, prefill: { source: 'USER_NAME' } },
      { id: 'm_email', type: 'EMAIL', name: 'email', label: 'Email', required: true, prefill: { source: 'USER_EMAIL' } },
      { id: 'm_phone', type: 'PHONE', name: 'phone', label: 'Phone' },
      { id: 'm_property', type: 'DROPDOWN', name: 'property', label: 'Which property?', required: true, dataSource: opts(['TOWER_A', 'Tower A'], ['TOWER_B', 'Tower B'], ['TOWER_C', 'Tower C']) },
      { id: 'm_unit', type: 'TEXT', name: 'unit', label: 'Flat or unit', required: true },
      {
        id: 'm_kind',
        type: 'DROPDOWN',
        name: 'kind',
        label: 'What kind of problem?',
        required: true,
        dataSource: opts(['LEAK', 'Leak or plumbing'], ['ELECTRICAL', 'Electrical'], ['LIFT', 'Lift'], ['HEATING', 'Heating or cooling'], ['PESTS', 'Pests'], ['OTHER', 'Something else']),
      },
      { id: 'm_urgency', type: 'RADIO', name: 'urgency', label: 'How urgent is it?', required: true, dataSource: opts(['EMERGENCY', 'Emergency: danger or damage now'], ['SOON', 'Today or tomorrow'], ['CAN_WAIT', 'It can wait a few days']) },
      { id: 'm_desc', type: 'TEXTAREA', name: 'description', label: 'What is wrong?', required: true },
      { id: 'm_photo', type: 'FILE', name: 'photo', label: 'A photo, if you can' },
      { id: 'm_visit', type: 'DROPDOWN', name: 'visit', label: 'Best time to come in', dataSource: opts(['ANY', 'Any time'], ['MORNING', 'Mornings'], ['AFTERNOON', 'Afternoons'], ['EVENING', 'Evenings']) },
    ],
    recordAccess: { mode: 'TEAM', userIds: [], departments: ['Maintenance'] },
    workflow: {
      enabled: true,
      refPrefix: 'MNT',
      statuses: [
        { key: 'NEW', label: 'New', category: 'OPEN' },
        { key: 'IN_PROGRESS', label: 'Being fixed', category: 'IN_PROGRESS' },
        { key: 'WAITING_PARTS', label: 'Waiting for parts', category: 'IN_PROGRESS' },
        { key: 'FIXED', label: 'Fixed', category: 'DONE' },
        { key: 'NOT_A_FAULT', label: 'Not a fault', category: 'DONE' },
      ],
      assignment: { type: 'BY_FIELD', field: 'kind', map: {} },
      priority: {
        default: 'MEDIUM',
        rules: [
          { if: { field: 'urgency', operator: 'equals', value: 'EMERGENCY' }, priority: 'CRITICAL' },
          { if: { field: 'urgency', operator: 'equals', value: 'SOON' }, priority: 'HIGH' },
          { if: { field: 'urgency', operator: 'equals', value: 'CAN_WAIT' }, priority: 'LOW' },
        ],
      },
      actions: [
        { key: 'start', label: 'Start work', from: ['NEW', 'WAITING_PARTS'], to: 'IN_PROGRESS' },
        { key: 'parts', label: 'Waiting for parts', from: ['IN_PROGRESS'], to: 'WAITING_PARTS', requireComment: true },
        {
          key: 'fixed',
          label: 'Fixed',
          from: ['IN_PROGRESS'],
          to: 'FIXED',
          requireComment: true,
          // A photo of the repair, where there is something to see.
          requireFiles: { picturesOnly: true, if: { field: 'kind', operator: 'in', value: ['LEAK', 'ELECTRICAL', 'HEATING'] } },
        },
        { key: 'not_a_fault', label: 'Not a fault', from: ['NEW', 'IN_PROGRESS'], to: 'NOT_A_FAULT', requireComment: true },
      ],
      reopen: { to: 'IN_PROGRESS', withinDays: 14 },
      sla: {
        calendar: '24x7',
        responseHours: 24,
        resolutionHours: 120,
        byPriority: { CRITICAL: { responseHours: 1, resolutionHours: 8 }, HIGH: { responseHours: 4, resolutionHours: 48 }, LOW: { resolutionHours: 240 } },
        pauseIn: ['WAITING_PARTS'],
        warnAtPercent: 75,
      },
      escalation: {
        levels: [
          { afterHours: 0, notify: [{ kind: 'MANAGER' }] },
          { afterHours: 24, notify: [{ kind: 'MANAGER' }], raisePriority: true },
        ],
      },
      contactEmailField: 'email',
    },
    automations: [
      {
        id: 'ack',
        name: 'Tell the resident it arrived',
        enabled: true,
        when: 'SUBMITTED',
        actions: [
          {
            id: 'ack_email',
            type: 'EMAIL',
            to: [{ kind: 'FIELD', field: 'email' }],
            subject: 'We have your report {{$record.ref}}',
            body: 'Dear {{name}},\n\nThank you. Your report about {{unit}} is {{$record.ref}}. We will let you know when someone is on it.',
          },
        ],
      },
      {
        id: 'emergency',
        name: 'Emergency alert',
        enabled: true,
        when: 'SUBMITTED',
        if: { field: '$priority', operator: 'equals', value: 'CRITICAL' },
        actions: [{ id: 'alert', type: 'NOTIFY', to: [{ kind: 'ASSIGNEE' }, { kind: 'MANAGER' }], message: 'Emergency {{$record.ref}} at {{unit}}: {{description}}' }],
      },
      {
        id: 'started',
        name: 'Tell the resident someone is on it',
        enabled: true,
        when: 'STATUS_CHANGED',
        toStatus: 'IN_PROGRESS',
        actions: [
          {
            id: 'started_email',
            type: 'EMAIL',
            to: [{ kind: 'FIELD', field: 'email' }],
            subject: 'Someone is working on {{$record.ref}}',
            body: 'Dear {{name}},\n\nSomeone from maintenance is now working on your report {{$record.ref}}.',
          },
        ],
      },
      {
        id: 'fixed',
        name: 'Tell the resident it is fixed',
        enabled: true,
        when: 'STATUS_CHANGED',
        toStatus: 'FIXED',
        actions: [
          {
            id: 'fixed_email',
            type: 'EMAIL',
            to: [{ kind: 'FIELD', field: 'email' }],
            subject: '{{$record.ref}} is fixed',
            body: 'Dear {{name}},\n\nYour report {{$record.ref}} has been fixed. If the problem comes back within 14 days, reply to this email and we will reopen it.',
          },
        ],
      },
    ],
  },
};

export const FORM_TEMPLATES: FormTemplate[] = [maintenance, complaint, lead];

/** A draft from the dialog's basics plus a template's form and process. */
export function applyTemplate(draft: FormDefinition, template: FormTemplate): FormDefinition {
  const t = structuredClone(template.definition);
  return { ...draft, ...t, description: draft.description || t.description, access: draft.access ?? t.access };
}
