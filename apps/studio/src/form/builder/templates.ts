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
  definition: Pick<FormDefinition, 'fields' | 'workflow' | 'automations' | 'access' | 'description'>;
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

export const FORM_TEMPLATES: FormTemplate[] = [complaint, lead];

/** A draft from the dialog's basics plus a template's form and process. */
export function applyTemplate(draft: FormDefinition, template: FormTemplate): FormDefinition {
  const t = structuredClone(template.definition);
  return { ...draft, ...t, description: draft.description || t.description, access: draft.access ?? t.access };
}
