import * as k from './kit';
import type { IndustryTemplate } from './kit';

const ACCOUNT = k.pattern('^[0-9]{9,18}$', 'An account number is 9 to 18 digits');
const CONSUMER = k.pattern('^[0-9]{8,14}$', 'A consumer number is 8 to 14 digits, as on your bill');

// ── Energy: new electricity connection ─────────────────────────────────────
const connection = k.make(
  'energy-new-connection',
  'Energy and utilities',
  'New electricity connection',
  'A home, a shop or a factory asks for power: the premises, the load worked out from the appliances listed, the phase that load needs, and the deposit and charges.',
  ['Rules: set your charges per kilowatt and your security deposit.', 'Replace the divisions with your own.', 'To collect the charges: form settings → Take a payment with each response → Amount to pay: Total to pay.'],
  [
    k.hidden('channel', 'SOURCE_CHANNEL'),
    k.section('supply', 'Supply wanted', [
      k.radio('category', 'The connection is for', [['DOMESTIC', 'A home'], ['COMMERCIAL', 'A shop or office'], ['INDUSTRIAL', 'A factory or workshop'], ['AGRICULTURE', 'A farm pump'], ['TEMPORARY', 'Temporary use (construction, an event)']], k.req),
      k.repeat('appliances', 'Appliance or machine', [
        k.dropdown('appliance', 'What', ['Lights and fans', 'Air conditioner', 'Water heater', 'Refrigerator', 'Motor or pump', 'Welding or heavy machine', 'EV charger', 'Other'], k.req),
        k.stepper('count', 'How many', 1, 200, { defaultValue: 1 }),
        k.num('watts', 'Watts each', { ...k.req, validation: { min: 5, max: 500000 } }),
        k.num('lineWatts', 'Watts in all', { disabled: true }),
      ], { min: 1, max: 30, totals: ['lineWatts'] }),
      k.num('loadKw', 'Load asked for (kW)', { ...k.third, disabled: true }),
      k.text('phase', 'Supply', { ...k.third, disabled: true }),
      k.date('neededBy', 'Needed by', { ...k.third }),
      k.stepper('temporaryDays', 'For how many days', 1, 365, { ...k.half, ...k.showIf(k.is('category', 'TEMPORARY')), requiredWhen: k.is('category', 'TEMPORARY') }),
    ]),
    k.section('premises', 'Premises', [
      k.area('premisesAddress', 'Address where power is needed', k.req),
      k.text('premisesPin', 'PIN code', { ...k.req, ...k.third, ...k.PIN }),
      k.dropdown('division', 'Division', ['City North', 'City South', 'Suburban', 'Rural'], { ...k.req, ...k.third }),
      k.text('nearestConsumer', 'Consumer number of a neighbour', { ...k.third, helpText: 'Helps us find the nearest pole.' }),
      k.radio('occupancy', 'You are the', ['Owner', 'Tenant', 'Builder or developer'], k.req),
      k.num('builtUpSqFt', 'Built-up area (sq ft)', { ...k.half, validation: { min: 0 } }),
      k.yesNo('wiringDone', 'Has a licensed contractor finished the wiring?', k.req),
      k.text('contractor', 'Contractor and licence number', { ...k.half, ...k.showIf(k.is('wiringDone', 'YES')), requiredWhen: k.is('wiringDone', 'YES') }),
    ]),
    k.section('applicant', 'Applicant', [
      ...k.contact('Name the bill should be in'),
      k.text('firmName', 'Name of the business', { ...k.half, ...k.showIf(k.oneOf('category', ['COMMERCIAL', 'INDUSTRIAL'])), requiredWhen: k.oneOf('category', ['COMMERCIAL', 'INDUSTRIAL']) }),
      k.text('gstin', 'GSTIN', { ...k.half, ...k.showIf(k.oneOf('category', ['COMMERCIAL', 'INDUSTRIAL'])) }),
      k.radio('billBy', 'Send the bill by', ['Email', 'SMS', 'Paper'], { defaultValue: 'EMAIL' }),
      k.toggle('prepaid', 'I want a prepaid smart meter'),
    ]),
    k.section('charges', 'Charges', [
      k.num('serviceCharge', 'Service line charges (₹)', { ...k.third, disabled: true }),
      k.num('deposit', 'Security deposit (₹)', { ...k.third, disabled: true }),
      k.num('totalDue', 'Total to pay (₹)', { ...k.third, disabled: true }),
      k.note('highLoad', '<p><strong>A load above 50 kW needs a transformer of your own.</strong> Our engineer will visit to survey the site before a quotation is made.</p>'),
    ]),
    k.section('finish', 'Documents and declaration', [
      k.file('identity', 'Proof of identity', k.req),
      k.file('ownership', 'Proof of ownership, or the rent agreement', k.req),
      k.file('ownerNoc', 'No-objection letter from the owner', k.showIf(k.is('occupancy', 'TENANT'))),
      k.file('wiringCertificate', 'Wiring completion and test report'),
      k.file('licences', 'Trade or factory licence', k.showIf(k.oneOf('category', ['COMMERCIAL', 'INDUSTRIAL']))),
      ...k.declare('I declare that the wiring is as the rules require, that there are no dues on these premises, and that I will pay for the electricity used according to the tariff.'),
    ]),
  ],
  {
    intro: 'Apply for an electricity connection. List what you will run and we work out the load.',
    rules: [
      k.calc('con_line', 'lineWatts', 'count * watts', 'Watts for each line'),
      k.calc('con_load', 'loadKw', 'round(sum(lineWatts) / 1000, 1)', 'Load from the appliances'),
      k.calc('con_phase', 'phase', 'if(loadKw > 50, "High tension", if(loadKw > 7, "Three phase", "Single phase"))', 'Phase the load needs'),
      k.calc('con_service', 'serviceCharge', 'round(if(category == "TEMPORARY", 2000, 1500) + max(0, loadKw - 1) * if(oneOf(category, "COMMERCIAL", "INDUSTRIAL"), 1800, 900))', 'Service line charges'),
      k.calc('con_deposit', 'deposit', 'if(prepaid, 0, round(max(1, loadKw) * if(category == "DOMESTIC", 600, if(category == "AGRICULTURE", 300, 1500))))', 'Deposit, none for prepaid'),
      k.calc('con_total', 'totalDue', 'serviceCharge + deposit', 'Total'),
      { id: 'con_high', name: 'Say when a survey is needed', when: { expr: 'loadKw > 50' }, then: [{ type: 'SHOW', target: 'highLoad' }], else: [{ type: 'HIDE', target: 'highLoad' }] },
      { id: 'con_noc', name: 'The owner\'s letter for a tenant', when: k.is('occupancy', 'TENANT'), then: [{ type: 'REQUIRE', target: 'ownerNoc' }] },
      { id: 'con_wiring', name: 'A test report when wiring is done', when: k.is('wiringDone', 'YES'), then: [{ type: 'REQUIRE', target: 'wiringCertificate' }] },
      k.refuse('con_by', '!isEmpty(neededBy) && neededBy < today()', 'neededBy', 'This date has passed'),
    ],
    workflow: k.flow(
      'NC',
      [k.st('APPLIED', 'Applied', 'OPEN', 8), k.st('SURVEY', 'Site survey', 'IN_PROGRESS', 56), k.st('QUOTATION', 'Quotation sent', 'IN_PROGRESS'), k.st('PAID', 'Charges paid', 'IN_PROGRESS', 40), k.st('METER_FITTED', 'Meter fitted', 'IN_PROGRESS', 8), k.st('ENERGISED', 'Supply released', 'DONE'), k.st('REJECTED', 'Not feasible', 'DONE')],
      [
        k.act('survey', 'Send for survey', ['APPLIED'], 'SURVEY'),
        k.act('quote', 'Send the quotation', ['SURVEY'], 'QUOTATION', { requireFields: ['surveyReport'] }),
        k.act('paid', 'Charges received', ['QUOTATION'], 'PAID'),
        k.act('fit', 'Meter fitted', ['PAID'], 'METER_FITTED', { requireFields: ['meterNumber'] }),
        k.act('release', 'Release supply', ['METER_FITTED'], 'ENERGISED'),
        k.act('refuse', 'Not feasible', ['SURVEY'], 'REJECTED', { requireComment: true }),
      ],
      {
        contactEmailField: 'email',
        priority: { default: 'MEDIUM', rules: [{ if: k.is('category', 'TEMPORARY'), priority: 'HIGH' }, { if: { field: 'loadKw', operator: 'greaterThan', value: 50 }, priority: 'HIGH' }] },
        sla: { calendar: 'WORKING', responseHours: 8, resolutionHours: 120, pauseIn: ['QUOTATION'], warnAtPercent: 80 },
        workFields: [{ id: 'con_w_survey', type: 'TEXTAREA', name: 'surveyReport', label: 'Survey report' }, { id: 'con_w_meter', type: 'TEXT', name: 'meterNumber', label: 'Meter number' }, { id: 'con_w_consumer', type: 'TEXT', name: 'consumerNumber', label: 'Consumer number allotted' }],
      },
    ),
  },
);

// ── Energy: rooftop solar ──────────────────────────────────────────────────
const solar = k.make(
  'energy-rooftop-solar',
  'Energy and utilities',
  'Rooftop solar (net metering)',
  'A consumer asks to connect solar panels to the grid: the present connection, the plant and its installer, and whether the size fits the sanctioned load and the roof.',
  ['Rules: set how large a plant may be against the sanctioned load, and your fees.', 'Replace the list of approved installers with your own.'],
  [
    k.section('connection', 'Your connection', [
      k.text('consumerNo', 'Consumer number', { ...k.req, ...k.half, ...CONSUMER }),
      ...k.contact('Name on the bill'),
      k.radio('category', 'Connection', ['Domestic', 'Commercial', 'Industrial', 'Housing society'], k.req),
      k.num('sanctionedKw', 'Sanctioned load (kW)', { ...k.req, ...k.half, validation: { min: 0.5, max: 5000 } }),
      k.num('monthlyUnits', 'Units used in a usual month', { ...k.half, validation: { min: 0 } }),
    ]),
    k.section('plant', 'The solar plant', [
      k.slider('plantKw', 'Size of the plant (kW)', 1, 100, 1, { defaultValue: 3 }),
      k.num('roofSqFt', 'Shadow-free roof area (sq ft)', { ...k.req, ...k.half, validation: { min: 50 } }),
      k.radio('metering', 'Arrangement', [['NET', 'Net metering: export what you do not use'], ['GROSS', 'Gross metering: export everything'], ['CAPTIVE', 'No export']], { ...k.req, defaultValue: 'NET' }),
      k.toggle('battery', 'With battery storage'),
      k.num('batteryKwh', 'Battery size (kWh)', { ...k.half, ...k.showIf(k.is('battery', true)), requiredWhen: k.is('battery', true), validation: { min: 1 } }),
      k.dropdown('installer', 'Installer', ['Approved vendor A', 'Approved vendor B', 'Approved vendor C', 'Another installer'], { ...k.req, ...k.half }),
      k.text('installerName', 'Installer\'s name and registration', { ...k.half, ...k.showIf(k.is('installer', 'ANOTHER_INSTALLER')), requiredWhen: k.is('installer', 'ANOTHER_INSTALLER') }),
      k.num('unitsPerYear', 'Units the plant should make in a year', { ...k.half, disabled: true }),
      k.num('fee', 'Application fee (₹)', { ...k.half, disabled: true }),
      k.yesNo('wantsSubsidy', 'Are you claiming the government subsidy?', k.showIf(k.is('category', 'DOMESTIC'))),
    ]),
    k.section('finish', 'Documents and declaration', [
      k.file('bill', 'Latest electricity bill', k.req),
      k.file('layout', 'Single-line diagram of the plant', k.req),
      k.file('roofProof', 'Proof that the roof is yours to use', k.req),
      k.file('datasheets', 'Datasheets of the panels and inverter'),
      ...k.declare('I declare that the plant will be installed by a qualified installer, with the protection the grid code requires, and that I will not energise it before the utility has fitted the net meter.'),
    ]),
  ],
  {
    intro: 'Ask to connect rooftop solar to the grid.',
    rules: [
      k.calc('sol_units', 'unitsPerYear', 'round(plantKw * 4 * 365 * 0.8)', 'About four units a day for each kW'),
      k.calc('sol_fee', 'fee', 'if(plantKw <= 10, 500, if(plantKw <= 50, 2500, 5000))', 'Fee by size'),
      k.refuse('sol_load', 'plantKw > sanctionedKw', 'plantKw', 'The plant may not be larger than your sanctioned load. Ask for the load to be raised first.'),
      k.refuse('sol_roof', 'plantKw * 100 > roofSqFt', 'roofSqFt', 'A plant needs about 100 sq ft of shadow-free roof for each kW'),
    ],
    workflow: k.flow(
      'SOL',
      [k.st('APPLIED', 'Applied', 'OPEN', 16), k.st('FEASIBILITY', 'Technical feasibility', 'IN_PROGRESS', 80), k.st('APPROVED', 'Approved to install', 'IN_PROGRESS'), k.st('INSPECTION', 'Inspection of the plant', 'IN_PROGRESS', 40), k.st('COMMISSIONED', 'Net meter fitted', 'DONE'), k.st('REJECTED', 'Not feasible', 'DONE')],
      [
        k.act('study', 'Start the study', ['APPLIED'], 'FEASIBILITY'),
        k.act('approve', 'Approve', ['FEASIBILITY'], 'APPROVED'),
        k.act('inspect', 'Plant is ready: inspect', ['APPROVED'], 'INSPECTION'),
        k.act('commission', 'Fit the net meter', ['INSPECTION'], 'COMMISSIONED'),
        k.act('refuse', 'Not feasible', ['FEASIBILITY'], 'REJECTED', { requireComment: true }),
      ],
      { contactEmailField: 'email', sla: { calendar: 'WORKING', resolutionHours: 160, pauseIn: ['APPROVED'] } },
    ),
  },
);

// ── Energy: transfer of a connection ───────────────────────────────────────
const nameChange = k.make(
  'energy-connection-transfer',
  'Energy and utilities',
  'Transfer of an electricity connection',
  'Putting a connection in another name after a sale, a death or a new tenancy, with the dues cleared and the deposit carried over or paid again.',
  ['Rules: set your transfer fee.', 'Workflow → Process: send requests to the billing office of each division.'],
  [
    k.section('connection', 'The connection', [
      k.text('consumerNo', 'Consumer number', { ...k.req, ...k.half, ...CONSUMER }),
      k.text('presentName', 'Name on the bill now', { ...k.req, ...k.half }),
      k.area('premisesAddress', 'Address of the premises', k.req),
      k.radio('reason', 'Why is the name changing', [['SALE', 'The property was sold'], ['DEATH', 'The holder has died'], ['TENANCY', 'A new tenant'], ['FAMILY', 'Within the family'], ['COMPANY', 'The business changed its name']], k.req),
      k.date('effectiveFrom', 'From which date', { ...k.req, ...k.half }),
      k.num('lastReading', 'Meter reading on that date', { ...k.half, validation: { min: 0 } }),
    ]),
    k.section('newHolder', 'New holder', [
      ...k.contact('Name the bill should be in'),
      k.dropdown('relation', 'Relation to the present holder', [...k.RELATIONS, 'Buyer', 'Tenant', 'None'], { ...k.req, ...k.half }),
      k.text('pan', 'PAN', { ...k.half, ...k.PAN }),
      k.radio('depositChoice', 'Security deposit', [['CARRY', 'Carry over the present holder\'s deposit'], ['FRESH', 'I will pay a new deposit']], k.req),
      k.yesNo('duesCleared', 'Are all bills paid up to that date?', k.req),
      k.num('fee', 'Transfer fee (₹)', { ...k.half, disabled: true }),
    ]),
    k.section('finish', 'Documents and declaration', [
      k.file('bill', 'Latest paid bill', k.req),
      k.file('saleDeed', 'Sale deed or index', k.showIf(k.is('reason', 'SALE'))),
      k.file('deathCertificate', 'Death certificate, and consent of the other heirs', k.showIf(k.is('reason', 'DEATH'))),
      k.file('rentAgreement', 'Rent agreement and the owner\'s consent', k.showIf(k.is('reason', 'TENANCY'))),
      k.file('holderConsent', 'Consent of the present holder to carry over the deposit', k.showIf(k.is('depositChoice', 'CARRY'))),
      k.file('identity', 'New holder\'s proof of identity', k.req),
      ...k.declare('I take over the connection with any dues found on it, and agree to the conditions of supply.'),
    ]),
  ],
  {
    intro: 'Change the name on an electricity connection.',
    rules: [
      k.calc('ct_fee', 'fee', 'if(oneOf(reason, "DEATH", "FAMILY"), 100, 500)', 'Fee'),
      { id: 'ct_sale', name: 'The deed after a sale', when: k.is('reason', 'SALE'), then: [{ type: 'REQUIRE', target: 'saleDeed' }] },
      { id: 'ct_death', name: 'Papers after a death', when: k.is('reason', 'DEATH'), then: [{ type: 'REQUIRE', target: 'deathCertificate' }] },
      { id: 'ct_rent', name: 'The agreement for a tenant', when: k.is('reason', 'TENANCY'), then: [{ type: 'REQUIRE', target: 'rentAgreement' }] },
      { id: 'ct_consent', name: 'Consent to carry the deposit', when: { expr: 'depositChoice == "CARRY" && reason != "DEATH"' }, then: [{ type: 'REQUIRE', target: 'holderConsent' }] },
      k.refuse('ct_dues', 'duesCleared == "NO"', 'duesCleared', 'Please pay the outstanding bills first; the name is changed once nothing is due'),
    ],
    workflow: k.flow(
      'CT',
      [k.st('RECEIVED', 'Received', 'OPEN', 8), k.st('DUES_CHECK', 'Checking dues', 'IN_PROGRESS', 16), k.st('APPROVED', 'Approved', 'IN_PROGRESS', 8), k.st('DONE', 'Name changed', 'DONE'), k.st('REJECTED', 'Rejected', 'DONE')],
      [k.act('check', 'Check dues', ['RECEIVED'], 'DUES_CHECK'), k.act('approve', 'Approve', ['DUES_CHECK'], 'APPROVED'), k.act('change', 'Change the name', ['APPROVED'], 'DONE'), k.act('reject', 'Reject', ['DUES_CHECK'], 'REJECTED', { requireComment: true })],
      { contactEmailField: 'email', sla: { calendar: 'WORKING', resolutionHours: 32 } },
    ),
  },
);

// ── Energy: outage or meter complaint ──────────────────────────────────────
const outage = k.make(
  'energy-supply-complaint',
  'Energy and utilities',
  'Power supply or meter complaint',
  'No power, low voltage, a sparking line, a fast meter or a wrong bill, reported in a minute. Danger to life goes to the front of the queue.',
  ['Workflow → Process: send complaints to each division\'s fault desk ("Depends on an answer": Division).', 'Turn on CAPTCHA before sharing the link widely.'],
  [
    k.section('problem', 'What is wrong', [
      k.radio('kind', 'The problem', [['NO_SUPPLY', 'No power'], ['VOLTAGE', 'Low or changing voltage'], ['DANGER', 'A fallen wire, sparking or a shock'], ['METER', 'The meter is faulty or fast'], ['BILL', 'The bill is wrong'], ['STREET_LIGHT', 'A street light is out']], k.req),
      k.radio('extent', 'Who is affected', [['ME', 'Only my premises'], ['STREET', 'My street or building'], ['AREA', 'The whole area']], { ...k.showIf(k.oneOf('kind', ['NO_SUPPLY', 'VOLTAGE'])), requiredWhen: k.oneOf('kind', ['NO_SUPPLY', 'VOLTAGE']) }),
      k.dateTime('since', 'Since when', k.half),
      k.month('billMonth', 'Bill for the month of', { ...k.half, ...k.showIf(k.is('kind', 'BILL')), requiredWhen: k.is('kind', 'BILL') }),
      k.num('billAmount', 'Amount billed (₹)', { ...k.half, ...k.showIf(k.is('kind', 'BILL')), validation: { min: 0 } }),
      k.num('meterReading', 'Meter reading now', { ...k.half, ...k.showIf(k.oneOf('kind', ['METER', 'BILL'])), validation: { min: 0 } }),
      k.area('details', 'Anything that helps us find it', { validation: { maxLength: 1000 } }),
      k.file('photo', 'A photograph', k.showIf(k.oneOf('kind', ['DANGER', 'METER', 'BILL']))),
    ]),
    k.section('where', 'Where', [
      k.text('consumerNo', 'Consumer number', { ...k.half, ...CONSUMER, requiredWhen: k.oneOf('kind', ['METER', 'BILL']) }),
      k.dropdown('division', 'Division', ['City North', 'City South', 'Suburban', 'Rural'], { ...k.req, ...k.half }),
      k.area('location', 'Address or landmark', k.req),
    ]),
    k.section('you', 'How to reach you', [
      k.text('fullName', 'Your name', k.req),
      k.phone('mobile', 'Mobile number', { ...k.req, ...k.half }),
      k.email('email', 'Email', k.half),
      k.check('callBack', 'Call me when the crew is on the way'),
    ]),
  ],
  {
    intro: 'Report a power cut, a dangerous line, or a problem with your meter or bill.',
    saveForLater: false,
    layout: { mode: 'steps', review: false },
    workflow: k.flow(
      'PSC',
      [k.st('LOGGED', 'Logged', 'OPEN', 1), k.st('CREW_SENT', 'Crew on the way', 'IN_PROGRESS', 4), k.st('BILLING_REVIEW', 'With billing', 'IN_PROGRESS', 72), k.st('RESTORED', 'Resolved', 'DONE'), k.st('NO_FAULT', 'No fault found', 'DONE')],
      [
        k.act('dispatch', 'Send a crew', ['LOGGED'], 'CREW_SENT'),
        k.act('billing', 'Send to billing', ['LOGGED'], 'BILLING_REVIEW'),
        k.act('restore', 'Resolved', ['CREW_SENT', 'BILLING_REVIEW'], 'RESTORED', { requireFields: ['cause'] }),
        k.act('nofault', 'No fault found', ['CREW_SENT', 'BILLING_REVIEW'], 'NO_FAULT', { requireComment: true }),
      ],
      {
        reopen: { to: 'LOGGED', withinDays: 3 },
        priority: { default: 'MEDIUM', rules: [{ if: k.is('kind', 'DANGER'), priority: 'CRITICAL' }, { if: k.is('extent', 'AREA'), priority: 'HIGH' }, { if: k.oneOf('kind', ['BILL', 'STREET_LIGHT']), priority: 'LOW' }] },
        sla: { calendar: '24x7', responseHours: 1, resolutionHours: 6, byPriority: { CRITICAL: { responseHours: 0.25, resolutionHours: 2 }, LOW: { resolutionHours: 168 } }, warnAtPercent: 70 },
        escalation: { levels: [{ afterHours: 2, notify: [{ kind: 'ASSIGNEE' }], raisePriority: true }] },
        workFields: [{ id: 'psc_w_cause', type: 'DROPDOWN', name: 'cause', label: 'Cause', dataSource: k.opts('Transformer fault', 'Line fault', 'Fuse blown', 'Planned shutdown', 'Meter replaced', 'Bill corrected', 'Consumer\'s own wiring') }],
      },
    ),
  },
);

// ── Banking: moving an account to another branch ───────────────────────────
const accountTransfer = k.make(
  'bank-account-transfer',
  'Banking',
  'Account transfer to another branch',
  'A customer moves an account to a branch nearer home or work: the account, where it is going, a new address if they have moved, and what happens to cheque books and standing instructions.',
  ['Replace the branches with your own (or bind the two lists to your branch master through a connector).', 'Workflow → Process: send requests to the home branch.'],
  [
    k.section('account', 'The account', [
      k.text('accountNo', 'Account number', { ...k.req, ...k.half, ...ACCOUNT }),
      k.radio('accountType', 'Type', ['Savings', 'Current', 'Salary', 'Fixed deposit', 'Loan'], { ...k.req, ...k.half }),
      ...k.contact('Name of the account holder'),
      k.dropdown('fromBranch', 'Present branch', ['Mumbai Fort', 'Pune Camp', 'Bengaluru MG Road', 'Delhi Connaught Place', 'Chennai T Nagar'], { ...k.req, ...k.half }),
      k.dropdown('toBranch', 'Move it to', ['Mumbai Fort', 'Pune Camp', 'Bengaluru MG Road', 'Delhi Connaught Place', 'Chennai T Nagar'], { ...k.req, ...k.half }),
      k.checks('alsoMove', 'Also move', ['Linked fixed deposits', 'Locker', 'Loan accounts', 'Demat account']),
      k.dropdown('reason', 'Reason', ['Moved house', 'Changed job', 'Nearer branch', 'Unhappy with the service', 'Other'], k.half),
    ]),
    k.section('address', 'Address', [
      k.yesNo('addressChanged', 'Has your address changed?', k.req),
      k.section('movedTo', 'New address', [...k.address('new', ''), k.file('addressProof', 'Proof of the new address')]),
    ]),
    k.section('instructions', 'What should happen to', [
      k.radio('chequeBook', 'Unused cheques', [['KEEP', 'I will keep using them'], ['REPLACE', 'Cancel them and send a new cheque book']], { ...k.req, defaultValue: 'KEEP' }),
      k.yesNo('standingInstructions', 'Do you have standing instructions or auto-debits on this account?', k.req),
      k.note('siNote', '<p>Standing instructions and auto-debits <strong>continue unchanged</strong>: the account number stays the same. Only the IFSC changes, so tell anyone who pays you by bank transfer.</p>'),
      k.date('effectiveFrom', 'Move it from', k.half),
      ...k.declare('I ask the bank to transfer my account as above. I understand that the IFSC of my account will change.', 'Signature, as on the account'),
    ]),
  ],
  {
    intro: 'Move your account to another branch. Your account number stays the same.',
    rules: [
      { id: 'at_addr', name: 'New address only when it changed', when: k.is('addressChanged', 'YES'), then: [{ type: 'SHOW', target: 'movedTo' }, { type: 'REQUIRE', target: 'addressProof' }], else: [{ type: 'HIDE', target: 'movedTo' }] },
      { id: 'at_si', name: 'Explain standing instructions', when: k.is('standingInstructions', 'YES'), then: [{ type: 'SHOW', target: 'siNote' }], else: [{ type: 'HIDE', target: 'siNote' }] },
      k.refuse('at_same', '!isEmpty(toBranch) && toBranch == fromBranch', 'toBranch', 'Choose a different branch from the present one'),
      k.refuse('at_date', '!isEmpty(effectiveFrom) && effectiveFrom < today()', 'effectiveFrom', 'This date has passed'),
    ],
    workflow: k.flow(
      'AT',
      [k.st('REQUESTED', 'Requested', 'OPEN', 8), k.st('SIGNATURE_CHECK', 'Signature verified', 'IN_PROGRESS', 8), k.st('RELEASED', 'Released by the present branch', 'IN_PROGRESS', 16), k.st('TRANSFERRED', 'Transferred', 'DONE'), k.st('DECLINED', 'Declined', 'DONE')],
      [k.act('verify', 'Signature matches', ['REQUESTED'], 'SIGNATURE_CHECK'), k.act('release', 'Release', ['SIGNATURE_CHECK'], 'RELEASED'), k.act('accept', 'Accept at the new branch', ['RELEASED'], 'TRANSFERRED'), k.act('decline', 'Decline', ['REQUESTED', 'SIGNATURE_CHECK'], 'DECLINED', { requireComment: true })],
      { contactEmailField: 'email', sla: { calendar: 'WORKING', resolutionHours: 24 }, priority: { default: 'MEDIUM', rules: [{ if: k.is('reason', 'UNHAPPY_WITH_THE_SERVICE'), priority: 'HIGH' }] } },
    ),
  },
);

// ── Banking: money transfer ────────────────────────────────────────────────
const fundTransfer = k.make(
  'bank-fund-transfer',
  'Banking',
  'Money transfer request (NEFT, RTGS, abroad)',
  'A transfer too large or unusual for internet banking: who pays, who is paid, how it travels, the charges, and for money going abroad the purpose and the yearly limit.',
  ['Rules: set your charges and limits.', 'Workflow → Process: choose the operations team, and who authorises large transfers.'],
  [
    k.section('from', 'Pay from', [
      k.text('accountNo', 'Your account number', { ...k.req, ...k.half, ...ACCOUNT }),
      ...k.contact('Name of the account holder'),
      k.radio('mode', 'Send by', [['NEFT', 'NEFT (within India, any amount)'], ['RTGS', 'RTGS (within India, ₹2 lakh and above, within the hour)'], ['IMPS', 'IMPS (within India, at once, up to ₹5 lakh)'], ['SWIFT', 'Wire transfer abroad']], k.req),
      k.num('amount', 'Amount', { ...k.req, ...k.half, validation: { min: 1 } }),
      k.dropdown('currency', 'Currency', [['INR', 'Indian rupee'], ['USD', 'US dollar'], ['EUR', 'Euro'], ['GBP', 'British pound'], ['AED', 'UAE dirham'], ['CAD', 'Canadian dollar']], { ...k.req, ...k.half, defaultValue: 'INR' }),
      k.date('valueDate', 'Send on', { ...k.req, ...k.half }),
    ]),
    k.section('to', 'Pay to', [
      k.text('payeeName', 'Name of the person or company', k.req),
      k.text('payeeAccount', 'Their account number or IBAN', { ...k.req, ...k.half }),
      k.text('payeeAccountAgain', 'Their account number again', { ...k.req, ...k.half }),
      k.text('payeeIfsc', 'IFSC of their branch', { ...k.half, ...k.IFSC, ...k.showIf(k.isNot('mode', 'SWIFT')), requiredWhen: k.isNot('mode', 'SWIFT') }),
      k.text('swiftCode', 'SWIFT code of their bank', { ...k.half, ...k.pattern('^[A-Za-z]{6}[A-Za-z0-9]{2}([A-Za-z0-9]{3})?$', 'A SWIFT code is 8 or 11 characters'), ...k.showIf(k.is('mode', 'SWIFT')), requiredWhen: k.is('mode', 'SWIFT') }),
      k.text('payeeBank', 'Their bank and branch', { ...k.req, ...k.half }),
      k.text('payeeCountry', 'Country', { ...k.half, ...k.showIf(k.is('mode', 'SWIFT')), requiredWhen: k.is('mode', 'SWIFT') }),
      k.area('payeeAddress', 'Their address', k.showIf(k.is('mode', 'SWIFT'))),
      k.text('remarks', 'Message to the payee', { validation: { maxLength: 140 } }),
    ]),
    k.section('abroad', 'Sending money abroad', [
      k.dropdown('purpose', 'Purpose', ['Education', 'Medical treatment', 'Travel', 'Maintenance of a relative', 'Gift', 'Investment', 'Import of goods or services'], k.req),
      k.num('sentThisYear', 'Already sent abroad this financial year, in US dollars', { ...k.half, validation: { min: 0 }, defaultValue: 0 }),
      k.radio('chargesBy', 'Bank charges abroad are paid by', [['OUR', 'Me'], ['BEN', 'The payee'], ['SHA', 'Shared']], { defaultValue: 'SHA' }),
      k.text('pan', 'Your PAN', { ...k.req, ...k.half, ...k.PAN }),
      k.file('purposeProof', 'Invoice, admission letter or other proof of the purpose', k.req),
    ], k.showIf(k.is('mode', 'SWIFT'))),
    k.section('finish', 'Charges and authority', [
      k.num('charges', 'Our charges (₹), before tax', { ...k.half, disabled: true }),
      ...k.declare('I authorise the bank to debit my account with the amount and charges. I confirm that the payee\'s details are right; the bank is not liable for a transfer made as instructed.', 'Signature, as on the account'),
    ]),
  ],
  {
    intro: 'Ask the branch to send money for you.',
    rules: [
      k.calc('ft_charges', 'charges', 'if(mode == "SWIFT", 1000, if(mode == "RTGS", if(amount > 500000, 50, 25), if(mode == "IMPS", 10, if(amount > 200000, 25, if(amount > 100000, 15, if(amount > 10000, 5, 2.5))))))', 'Charges by route and amount'),
      { id: 'ft_inr', name: 'Rupees within India', when: k.isNot('mode', 'SWIFT'), then: [{ type: 'SET_VALUE', target: 'currency', value: '"INR"' }, { type: 'DISABLE', target: 'currency' }] },
      k.refuse('ft_match', '!isEmpty(payeeAccountAgain) && payeeAccount != payeeAccountAgain', 'payeeAccountAgain', 'The two account numbers are not the same'),
      k.refuse('ft_rtgs', 'mode == "RTGS" && amount < 200000', 'amount', 'RTGS is for ₹2,00,000 and above. Choose NEFT for a smaller amount.'),
      k.refuse('ft_imps', 'mode == "IMPS" && amount > 500000', 'amount', 'IMPS carries up to ₹5,00,000. Choose NEFT or RTGS.'),
      k.refuse('ft_lrs', 'mode == "SWIFT" && currency == "USD" && sentThisYear + amount > 250000', 'amount', 'This would take you past the limit of US$250,000 a year for money sent abroad'),
      k.refuse('ft_date', 'valueDate < today()', 'valueDate', 'This date has passed'),
      k.refuse('ft_self', '!isEmpty(payeeAccount) && payeeAccount == accountNo', 'payeeAccount', 'This is your own account'),
    ],
    workflow: k.flow(
      'FT',
      [k.st('RECEIVED', 'Received', 'OPEN', 1), k.st('VERIFIED', 'Signature and balance checked', 'IN_PROGRESS', 1), k.st('AUTHORISATION', 'Waiting for authorisation', 'IN_PROGRESS', 2), k.st('SENT', 'Sent', 'DONE'), k.st('RETURNED', 'Returned by the payee\'s bank', 'DONE'), k.st('REFUSED', 'Refused', 'DONE')],
      [
        k.act('verify', 'Signature and balance are in order', ['RECEIVED'], 'VERIFIED'),
        k.act('refer', 'Send for authorisation', ['VERIFIED'], 'AUTHORISATION'),
        k.act('send', 'Send', ['VERIFIED', 'AUTHORISATION'], 'SENT', { requireFields: ['utr'] }),
        k.act('returned', 'It came back', ['SENT'], 'RETURNED', { requireComment: true }),
        k.act('refuse', 'Refuse', ['RECEIVED', 'VERIFIED', 'AUTHORISATION'], 'REFUSED', { requireComment: true }),
      ],
      {
        contactEmailField: 'email',
        priority: { default: 'MEDIUM', rules: [{ if: k.is('mode', 'RTGS'), priority: 'HIGH' }, { if: { field: 'amount', operator: 'greaterThanOrEqual', value: 5000000 }, priority: 'CRITICAL' }] },
        sla: { calendar: 'WORKING', responseHours: 1, resolutionHours: 4, byPriority: { HIGH: { resolutionHours: 1 }, CRITICAL: { resolutionHours: 2 } }, warnAtPercent: 60 },
        workFields: [{ id: 'ft_w_utr', type: 'TEXT', name: 'utr', label: 'Transaction reference (UTR)' }],
      },
    ),
  },
);

// ── Banking: credit card ───────────────────────────────────────────────────
const creditCard = k.make(
  'bank-credit-card',
  'Banking',
  'Credit card application',
  'Choosing a card, the applicant\'s work and income, cards they already hold, add-on cards for the family, and an indicative limit from their income.',
  ['Replace the cards with your own, and the income each one needs (the rules).', 'Workflow → Process: choose the card operations team.'],
  [
    k.hidden('campaign', 'URL_PARAMETER', 'utm_campaign'),
    k.section('card', 'The card', [
      k.radio('cardChoice', 'Card', [['CLASSIC', 'Classic: no yearly fee'], ['REWARDS', 'Rewards: points on everything'], ['TRAVEL', 'Travel: lounges and miles'], ['PREMIUM', 'Premium: by invitation']], k.req),
      k.yesNo('existingCustomer', 'Do you bank with us already?', k.req),
      k.text('accountNo', 'Your account number', { ...k.half, ...ACCOUNT, ...k.showIf(k.is('existingCustomer', 'YES')) }),
      k.text('nameOnCard', 'Name on the card', { ...k.req, ...k.half, validation: { maxLength: 19, messages: { maxLength: 'Up to 19 characters fit on a card' } } }),
    ]),
    k.section('applicant', 'About you', [
      ...k.contact('Full name, as on your PAN card'),
      k.date('dob', 'Date of birth', { ...k.req, ...k.third }),
      k.text('pan', 'PAN', { ...k.req, ...k.third, ...k.PAN }),
      k.dropdown('education', 'Education', ['School', 'Graduate', 'Postgraduate', 'Professional'], k.third),
      ...k.address('home', 'Home address'),
      k.radio('residence', 'You live there as', ['Owner', 'Tenant', 'With family', 'Company provided'], k.half),
      k.stepper('yearsThere', 'Years there', 0, 80, k.half),
    ]),
    k.section('work', 'Work and income', [
      k.radio('employment', 'You are', ['Salaried', 'Self-employed', 'Retired', 'Student'], k.req),
      k.text('employer', 'Employer or business', { ...k.half, requiredWhen: k.oneOf('employment', ['SALARIED', 'SELF_EMPLOYED']) }),
      k.num('yearlyIncome', 'Income a year (₹)', { ...k.req, ...k.half, validation: { min: 0 } }),
      k.repeat('otherCards', 'Card you hold now', [k.text('issuer', 'Bank', k.req), k.num('limit', 'Its limit (₹)', { ...k.req, validation: { min: 0 } }), k.num('heldYears', 'Held for (years)', { validation: { min: 0, max: 60 } })], { max: 6, totals: ['limit'] }),
      k.num('indicativeLimit', 'Limit you may be offered (₹)', { ...k.half, disabled: true, helpText: 'An indication. The limit is set after we check your credit history.' }),
    ]),
    k.section('extras', 'Add-on cards and services', [
      k.repeat('addOns', 'Add-on card', [k.text('addOnName', 'Name', k.req), k.dropdown('addOnRelation', 'Relation to you', k.RELATIONS, k.req), k.date('addOnDob', 'Date of birth', k.req)], { max: 3 }),
      k.checks('services', 'Switch on', [['INTERNATIONAL', 'Use abroad'], ['CONTACTLESS', 'Tap to pay'], ['ONLINE', 'Use online'], ['AUTOPAY', 'Pay the bill from my account each month']], { defaultValue: ['CONTACTLESS', 'ONLINE'] }),
      k.radio('statement', 'Statement by', ['Email', 'Post'], { defaultValue: 'EMAIL' }),
      k.file('incomeProof', 'Salary slip or income tax return', k.req),
      k.file('identity', 'PAN card and address proof', k.req),
      k.consent('bureau', 'Credit check', 'I allow the bank to obtain my credit report from credit bureaus.'),
      ...k.declare('I have read the most important terms and conditions and the schedule of charges, and agree to them.'),
    ]),
  ],
  {
    intro: 'Apply for a credit card.',
    rules: [
      k.calc('cc_limit', 'indicativeLimit', 'round(min(yearlyIncome * 0.25, 1500000) / 10000) * 10000', 'About a quarter of yearly income'),
      { id: 'cc_autopay', name: 'Auto-pay needs an account with us', when: k.is('existingCustomer', 'NO'), then: [{ type: 'SET_OPTIONS', target: 'services', values: ['INTERNATIONAL', 'CONTACTLESS', 'ONLINE'] }] },
      { id: 'cc_account', name: 'The account when a customer', when: k.is('existingCustomer', 'YES'), then: [{ type: 'REQUIRE', target: 'accountNo' }] },
      k.refuse('cc_age', 'dateDiff(dob, today(), "years") < 21', 'dob', 'You must be 21 or older to hold a card of your own'),
      k.refuse('cc_travel', 'cardChoice == "TRAVEL" && yearlyIncome < 1200000', 'cardChoice', 'The Travel card needs an income of ₹12 lakh a year. The Rewards card may suit you.'),
      k.refuse('cc_premium', 'cardChoice == "PREMIUM" && yearlyIncome < 3000000', 'cardChoice', 'The Premium card needs an income of ₹30 lakh a year'),
      k.refuse('cc_student', 'employment == "STUDENT" && cardChoice != "CLASSIC"', 'cardChoice', 'Students may apply for the Classic card'),
    ],
    workflow: k.flow(
      'CC',
      [k.st('APPLIED', 'Applied', 'OPEN', 4), k.st('BUREAU_CHECK', 'Credit check', 'IN_PROGRESS', 8), k.st('VERIFICATION', 'Address and income verification', 'IN_PROGRESS', 48), k.st('APPROVED', 'Approved', 'IN_PROGRESS', 24), k.st('DISPATCHED', 'Card dispatched', 'DONE'), k.st('DECLINED', 'Declined', 'DONE')],
      [
        k.act('bureau', 'Run the credit check', ['APPLIED'], 'BUREAU_CHECK'),
        k.act('verify', 'Send for verification', ['BUREAU_CHECK'], 'VERIFICATION', { requireFields: ['creditScore'] }),
        k.act('approve', 'Approve', ['BUREAU_CHECK', 'VERIFICATION'], 'APPROVED', { requireFields: ['creditScore', 'limitGiven'] }),
        k.act('dispatch', 'Dispatch the card', ['APPROVED'], 'DISPATCHED'),
        k.act('decline', 'Decline', ['BUREAU_CHECK', 'VERIFICATION'], 'DECLINED', { requireComment: true }),
      ],
      { contactEmailField: 'email', sla: { calendar: 'WORKING', responseHours: 4, resolutionHours: 56 }, priority: { default: 'MEDIUM', rules: [{ if: k.is('cardChoice', 'PREMIUM'), priority: 'HIGH' }] }, workFields: [{ id: 'cc_w_score', type: 'NUMBER', name: 'creditScore', label: 'Credit score' }, { id: 'cc_w_limit', type: 'NUMBER', name: 'limitGiven', label: 'Limit given (₹)' }] },
    ),
  },
);

// ── Banking: disputed card transaction ─────────────────────────────────────
const dispute = k.make(
  'bank-card-dispute',
  'Banking',
  'Disputed card transaction',
  'A cardholder disputes one or several transactions: each on its own line, why it is disputed, what they have already done about it, and whether the card should be blocked.',
  ['Workflow → Process: choose the disputes team.', 'Set the service times to match the card network\'s time limits.'],
  [
    k.section('card', 'Card', [
      ...k.contact('Name on the card'),
      k.text('cardLast4', 'Last four digits of the card', { ...k.req, ...k.half, ...k.pattern('^[0-9]{4}$', 'Four digits') }),
      k.radio('cardType', 'Card', ['Credit card', 'Debit card', 'Prepaid card'], { ...k.req, ...k.half }),
      k.yesNo('haveCard', 'Is the card with you?', k.req),
      k.dateTime('lostAt', 'When did you last have it', { ...k.half, ...k.showIf(k.is('haveCard', 'NO')), requiredWhen: k.is('haveCard', 'NO') }),
      k.toggle('blockCard', 'Block this card and send a new one', { defaultValue: true }),
    ]),
    k.section('transactions', 'What you dispute', [
      k.repeat('items', 'Transaction', [
        k.date('txnDate', 'Date', k.req),
        k.text('merchant', 'Merchant, as on the statement', k.req),
        k.num('txnAmount', 'Amount (₹)', { ...k.req, validation: { min: 1 } }),
        k.dropdown('txnChannel', 'Made', ['Online', 'At a shop', 'At an ATM', 'Do not know']),
      ], { min: 1, max: 20, totals: ['txnAmount'] }),
      k.num('disputedTotal', 'Total disputed (₹)', { ...k.half, disabled: true }),
      k.radio('reason', 'Why', [['FRAUD', 'I did not make it'], ['DUPLICATE', 'I was charged twice'], ['NOT_RECEIVED', 'I did not get the goods or service'], ['WRONG_AMOUNT', 'The amount is wrong'], ['CANCELLED', 'I cancelled, and was still charged'], ['ATM', 'The ATM did not give the cash']], k.req),
      k.area('story', 'What happened', { ...k.req, validation: { minLength: 20, maxLength: 3000 } }),
    ]),
    k.section('steps', 'What you have done', [
      k.yesNo('contactedMerchant', 'Have you asked the merchant to put it right?', { ...k.showIf(k.isNot('reason', 'FRAUD')) }),
      k.area('merchantReply', 'What they said', k.showIf(k.is('contactedMerchant', 'YES'))),
      k.yesNo('sharedDetails', 'Did you share the card number, PIN or a one-time password with anyone?', { ...k.showIf(k.is('reason', 'FRAUD')), requiredWhen: k.is('reason', 'FRAUD') }),
      k.yesNo('policeReport', 'Have you reported it to the police or the cyber-crime helpline?', k.showIf(k.is('reason', 'FRAUD'))),
      k.file('evidence', 'Receipts, messages, the cancellation or a police report'),
      ...k.declare('I declare that this is true, and that I have not made or allowed the transactions I dispute. I will help the bank with its enquiry.'),
    ]),
  ],
  {
    intro: 'Tell us about a card transaction you do not agree with.',
    rules: [
      k.calc('dsp_total', 'disputedTotal', 'sum(txnAmount)', 'Total disputed'),
      { id: 'dsp_block', name: 'A card used without you is blocked', when: { any: [k.is('reason', 'FRAUD'), k.is('haveCard', 'NO')] }, then: [{ type: 'SET_VALUE', target: 'blockCard', value: 'true' }, { type: 'DISABLE', target: 'blockCard' }] },
      { id: 'dsp_evidence', name: 'Proof for a dispute with a merchant', when: k.oneOf('reason', ['NOT_RECEIVED', 'CANCELLED', 'WRONG_AMOUNT']), then: [{ type: 'REQUIRE', target: 'evidence' }, { type: 'REQUIRE', target: 'contactedMerchant' }] },
    ],
    workflow: k.flow(
      'DSP',
      [k.st('RAISED', 'Raised', 'OPEN', 4), k.st('TEMP_CREDIT', 'Provisional credit given', 'IN_PROGRESS', 240), k.st('WITH_NETWORK', 'With the card network', 'IN_PROGRESS', 720), k.st('WON', 'Resolved for the customer', 'DONE'), k.st('LOST', 'Resolved for the merchant', 'DONE'), k.st('WITHDRAWN', 'Withdrawn by the customer', 'DONE')],
      [
        k.act('credit', 'Give provisional credit', ['RAISED'], 'TEMP_CREDIT'),
        k.act('chargeback', 'Raise a chargeback', ['RAISED', 'TEMP_CREDIT'], 'WITH_NETWORK', { requireFields: ['chargebackRef'] }),
        k.act('won', 'Customer is right', ['TEMP_CREDIT', 'WITH_NETWORK'], 'WON'),
        k.act('lost', 'Merchant is right', ['TEMP_CREDIT', 'WITH_NETWORK'], 'LOST', { requireComment: true }),
        k.act('withdraw', 'Customer withdrew', ['RAISED', 'TEMP_CREDIT', 'WITH_NETWORK'], 'WITHDRAWN'),
      ],
      {
        contactEmailField: 'email',
        reopen: { to: 'RAISED', withinDays: 30 },
        priority: { default: 'MEDIUM', rules: [{ if: k.is('reason', 'FRAUD'), priority: 'CRITICAL' }, { if: { field: 'disputedTotal', operator: 'greaterThan', value: 100000 }, priority: 'HIGH' }] },
        sla: { calendar: '24x7', responseHours: 4, resolutionHours: 2160, byPriority: { CRITICAL: { responseHours: 1 } }, warnAtPercent: 80 },
        workFields: [{ id: 'dsp_w_ref', type: 'TEXT', name: 'chargebackRef', label: 'Chargeback reference' }, { id: 'dsp_w_liability', type: 'RADIO', name: 'liability', label: 'Liability', dataSource: k.opts('Bank', 'Merchant', 'Customer') }],
      },
    ),
  },
);

// ── Insurance: motor claim ─────────────────────────────────────────────────
const motorClaim = k.make(
  'ins-motor-claim',
  'Insurance',
  'Motor insurance claim',
  'After an accident or a theft: the policy, what happened and where, the driver, other people and vehicles involved, the damage, and the garage. A theft or an injury is treated differently from a dent.',
  ['Replace the list of network garages with your own.', 'Workflow → Process: choose the claims team and the surveyors.'],
  [
    k.section('policy', 'Policy and vehicle', [
      k.text('policyNo', 'Policy number', { ...k.req, ...k.half }),
      k.text('regNumber', 'Registration number', { ...k.req, ...k.half }),
      ...k.contact('Name of the insured'),
      k.radio('claimFor', 'You are claiming for', [['DAMAGE', 'Damage to my vehicle'], ['THEFT', 'Theft of my vehicle'], ['THIRD_PARTY', 'Injury or damage to someone else'], ['PARTS', 'Theft of parts or accessories']], k.req),
    ]),
    k.section('incident', 'What happened', [
      k.dateTime('happenedAt', 'Date and time', { ...k.req, ...k.half }),
      k.text('happenedWhere', 'Place', { ...k.req, ...k.half }),
      k.area('account', 'In your own words', { ...k.req, validation: { minLength: 30, maxLength: 3000 } }),
      k.dropdown('cause', 'Cause', ['Collision with a vehicle', 'Collision with something else', 'Overturned', 'Fire', 'Flood or storm', 'Riot or vandalism', 'Animal', 'Other'], { ...k.half, ...k.showIf(k.oneOf('claimFor', ['DAMAGE', 'THIRD_PARTY'])) }),
      k.yesNo('policeInformed', 'Was it reported to the police?', k.req),
      k.text('firNo', 'Police station and report number', { ...k.half, ...k.showIf(k.is('policeInformed', 'YES')), requiredWhen: k.is('policeInformed', 'YES') }),
      k.yesNo('anyoneHurt', 'Was anyone hurt?', k.req),
      k.num('odometer', 'Kilometres on the clock', { ...k.half, validation: { min: 0 } }),
    ]),
    k.section('driver', 'Driver and others', [
      k.radio('drivenBy', 'Who was driving', [['INSURED', 'I was'], ['FAMILY', 'A family member'], ['PAID_DRIVER', 'A paid driver'], ['OTHER', 'Someone else'], ['PARKED', 'It was parked']], k.req),
      k.columns('driverCols', [[k.text('driverName', 'Driver\'s name', k.req), k.text('licenceNo', 'Licence number', k.req)], [k.date('licenceUntil', 'Licence valid until', k.req), k.yesNo('driverSober', 'Was the driver free of alcohol and drugs?')]]),
      k.repeat('others', 'Other vehicle or person involved', [
        k.text('otherName', 'Name', k.req),
        k.text('otherVehicle', 'Their vehicle number'),
        k.text('otherInsurer', 'Their insurer'),
        k.dropdown('otherLoss', 'What they suffered', ['Damage to a vehicle', 'Damage to property', 'Injury', 'Death'], k.req),
      ], { max: 8 }),
      k.repeat('witnessList', 'Witness', [k.text('witnessName', 'Name', k.req), k.phone('witnessPhone', 'Phone')], { max: 4 }),
    ]),
    k.section('damage', 'Damage and repair', [
      k.checks('damagedParts', 'What is damaged', ['Front', 'Rear', 'Left side', 'Right side', 'Roof', 'Glass', 'Engine', 'Interior', 'Underbody']),
      k.yesNo('drivable', 'Can the vehicle be driven?', k.req),
      k.radio('garageChoice', 'Repair at', [['NETWORK', 'A garage on our list: we pay the garage'], ['OWN', 'A garage of my choice: I pay and claim back']], k.req),
      k.dropdown('networkGarage', 'Garage', ['City Motors', 'Highway Auto Care', 'Prime Service Centre', 'Metro Body Shop'], { ...k.half, ...k.showIf(k.is('garageChoice', 'NETWORK')), requiredWhen: k.is('garageChoice', 'NETWORK') }),
      k.text('ownGarage', 'Garage and its phone number', { ...k.half, ...k.showIf(k.is('garageChoice', 'OWN')), requiredWhen: k.is('garageChoice', 'OWN') }),
      k.num('estimate', 'Estimate of repair (₹)', { ...k.half, validation: { min: 0 } }),
      k.toggle('needsTow', 'The vehicle needs to be towed'),
    ]),
    k.section('finish', 'Documents and declaration', [
      k.file('photos', 'Photographs of the damage and the place', k.req),
      k.file('rc', 'Registration certificate', k.req),
      k.file('licence', 'Driver\'s licence'),
      k.file('fir', 'Police report'),
      k.file('repairEstimate', 'Garage estimate'),
      k.file('keys', 'Photograph of both sets of keys', k.showIf(k.is('claimFor', 'THEFT'))),
      ...k.declare('I declare that this account is true, that the driver held a valid licence, and that I have not admitted liability to anyone. I allow the insurer to inspect the vehicle and to deal with other parties.', 'Signature of the insured'),
    ]),
  ],
  {
    intro: 'Tell us about an accident, damage or a theft.',
    rules: [
      { id: 'mc_driver', name: 'No driver for a parked or stolen vehicle', when: { any: [k.is('drivenBy', 'PARKED'), k.is('claimFor', 'THEFT')] }, then: [{ type: 'HIDE', target: 'driverCols' }], else: [{ type: 'SHOW', target: 'driverCols' }, { type: 'REQUIRE', target: 'licence' }] },
      { id: 'mc_theft', name: 'A theft has no repair', when: k.is('claimFor', 'THEFT'), then: [{ type: 'HIDE', target: 'damage' }, { type: 'REQUIRE', target: 'keys' }] },
      { id: 'mc_fir', name: 'A police report when one is needed', when: { any: [k.is('claimFor', 'THEFT'), k.is('claimFor', 'THIRD_PARTY'), k.is('anyoneHurt', 'YES')] }, then: [{ type: 'REQUIRE', target: 'fir' }] },
      { id: 'mc_estimate', name: 'An estimate for your own garage', when: k.is('garageChoice', 'OWN'), then: [{ type: 'REQUIRE', target: 'repairEstimate' }, { type: 'REQUIRE', target: 'estimate' }] },
      k.refuse('mc_when', 'happenedAt > now()', 'happenedAt', 'This cannot be in the future'),
      k.refuse('mc_police', 'policeInformed == "NO" && (claimFor == "THEFT" || anyoneHurt == "YES")', 'policeInformed', 'A theft or an injury must be reported to the police before a claim'),
      k.refuse('mc_licence', '!isEmpty(licenceUntil) && licenceUntil < happenedAt', 'licenceUntil', 'The licence had expired on the day of the accident'),
    ],
    workflow: k.flow(
      'MC',
      [k.st('INTIMATED', 'Intimated', 'OPEN', 2), k.st('SURVEY', 'Survey', 'IN_PROGRESS', 48), k.st('DOCUMENTS', 'Waiting for documents', 'IN_PROGRESS'), k.st('REPAIR', 'Under repair', 'IN_PROGRESS'), k.st('INVESTIGATION', 'Investigation', 'IN_PROGRESS', 720), k.st('SETTLED', 'Settled', 'DONE'), k.st('REPUDIATED', 'Not payable', 'DONE')],
      [
        k.act('survey', 'Appoint a surveyor', ['INTIMATED', 'DOCUMENTS'], 'SURVEY'),
        k.act('ask', 'Ask for documents', ['INTIMATED', 'SURVEY'], 'DOCUMENTS', { requireComment: true }),
        k.act('repair', 'Approve the repair', ['SURVEY'], 'REPAIR', { requireFields: ['assessedLoss'] }),
        k.act('investigate', 'Investigate', ['INTIMATED', 'SURVEY'], 'INVESTIGATION'),
        k.act('settle', 'Settle', ['SURVEY', 'REPAIR', 'INVESTIGATION'], 'SETTLED', { requireFields: ['assessedLoss'] }),
        k.act('repudiate', 'Not payable', ['SURVEY', 'INVESTIGATION'], 'REPUDIATED', { requireComment: true }),
      ],
      {
        contactEmailField: 'email',
        requestInfoStatus: 'DOCUMENTS',
        reopen: { to: 'SURVEY', withinDays: 60 },
        priority: { default: 'MEDIUM', rules: [{ if: { any: [k.is('anyoneHurt', 'YES'), k.is('claimFor', 'THEFT')] }, priority: 'CRITICAL' }, { if: k.is('drivable', 'NO'), priority: 'HIGH' }] },
        sla: { calendar: '24x7', responseHours: 2, resolutionHours: 168, byPriority: { CRITICAL: { responseHours: 1, resolutionHours: 720 } }, pauseIn: ['DOCUMENTS', 'REPAIR'], warnAtPercent: 75 },
        workFields: [{ id: 'mc_w_loss', type: 'NUMBER', name: 'assessedLoss', label: 'Loss assessed (₹)' }, { id: 'mc_w_surveyor', type: 'TEXT', name: 'surveyor', label: 'Surveyor' }],
      },
    ),
    automations: [k.confirmation('mc_confirm', 'email', 'We have your motor claim', 'Thank you. Do not start repairs until our surveyor has seen the vehicle, unless it is an emergency.')],
  },
);

export const ENERGY_BANKING: IndustryTemplate[] = [connection, solar, nameChange, outage, accountTransfer, fundTransfer, creditCard, dispute, motorClaim];
