import * as k from './kit';
import type { IndustryTemplate } from './kit';

const VEHICLE_CLASSES: [string, string][] = [['CAR', 'Car or jeep'], ['MOTORCYCLE', 'Motorcycle'], ['SCOOTER', 'Scooter or moped'], ['THREE_WHEELER', 'Three-wheeler'], ['GOODS', 'Goods vehicle'], ['BUS', 'Bus or passenger vehicle']];
const vehicleIds = () => [
  k.text('make', 'Make', { ...k.req, ...k.third }),
  k.text('model', 'Model', { ...k.req, ...k.third }),
  k.color('bodyColour', 'Colour', k.third),
  k.text('chassisNo', 'Chassis number', { ...k.req, ...k.half, validation: { minLength: 17, maxLength: 17, messages: { minLength: 'A chassis number has 17 characters', maxLength: 'A chassis number has 17 characters' } } }),
  k.text('engineNo', 'Engine or motor number', { ...k.req, ...k.half }),
];
const REG = k.pattern('^[A-Za-z]{2}[0-9]{1,2}[A-Za-z]{0,3}[0-9]{4}$', 'Give it as on the number plate, without spaces: MH12AB1234');

// ── Registration of a new vehicle (car or two-wheeler) ─────────────────────
const registration = k.make(
  'gov-vehicle-registration',
  'Government',
  'Vehicle registration (car or two-wheeler)',
  'Registering a new car, motorcycle or scooter: the owner, the vehicle and its dealer, insurance and loan, a choice of number, and the tax and fees worked out from the price and the kind of vehicle.',
  ['Rules: set your road tax rates and registration fees.', 'Replace the offices with your own.', 'To collect the tax and fees: form settings → Take a payment with each response → Amount to pay: Total to pay.'],
  [
    k.hidden('channel', 'SOURCE_CHANNEL'),
    k.section('vehicle', 'Vehicle', [
      k.radio('vehicleClass', 'Kind of vehicle', VEHICLE_CLASSES, k.req),
      ...vehicleIds(),
      k.radio('fuel', 'Fuel', ['Petrol', 'Diesel', 'CNG', 'Electric', 'Hybrid'], k.req),
      k.num('engineCc', 'Engine capacity (cc)', { ...k.third, validation: { min: 0, max: 20000 }, ...k.showIf(k.isNot('fuel', 'ELECTRIC')) }),
      k.month('madeIn', 'Month and year of manufacture', { ...k.req, ...k.third }),
      k.stepper('seats', 'Seats, with the driver', 1, 60, { ...k.third, defaultValue: 5 }),
      k.num('unladenKg', 'Weight unladen (kg)', { ...k.third, validation: { min: 30, max: 60000 } }),
      k.radio('usage', 'It will be used', [['PRIVATE', 'Privately'], ['COMMERCIAL', 'For hire or business']], k.req),
    ]),
    k.section('purchase', 'Purchase', [
      k.text('dealer', 'Dealer', { ...k.req, ...k.half }),
      k.text('invoiceNo', 'Invoice number', { ...k.req, ...k.half }),
      k.date('invoiceDate', 'Invoice date', { ...k.req, ...k.half }),
      k.num('price', 'Price on the invoice, before tax (₹)', { ...k.req, ...k.half, validation: { min: 10000, max: 500000000 } }),
      k.text('insurer', 'Insurer', { ...k.req, ...k.half }),
      k.text('policyNo', 'Insurance policy number', { ...k.req, ...k.half }),
      k.date('policyUntil', 'Insured until', { ...k.req, ...k.half }),
      k.toggle('financed', 'Bought on a loan'),
      k.text('financier', 'Bank or financier', { ...k.half, ...k.showIf(k.is('financed', true)), requiredWhen: k.is('financed', true) }),
    ]),
    k.section('owner', 'Owner', [
      k.radio('ownerType', 'Registered to', [['PERSON', 'A person'], ['COMPANY', 'A company or firm']], { ...k.req, defaultValue: 'PERSON' }),
      ...k.contact('Name of the owner'),
      k.text('relativeName', 'Son, wife or daughter of', { ...k.half, ...k.showIf(k.is('ownerType', 'PERSON')) }),
      k.date('dob', 'Date of birth', { ...k.half, ...k.showIf(k.is('ownerType', 'PERSON')), requiredWhen: k.is('ownerType', 'PERSON') }),
      k.text('pan', 'PAN', { ...k.half, ...k.PAN }),
      ...k.address('owner', 'Address where the vehicle is kept'),
      k.dropdown('office', 'Registering office', ['Central', 'East', 'West', 'North', 'South'], { ...k.req, ...k.half }),
    ]),
    k.section('number', 'Number and fees', [
      k.radio('numberChoice', 'Registration number', [['NEXT', 'The next number in the series'], ['FANCY', 'A number of my choice (extra fee)']], { ...k.req, defaultValue: 'NEXT' }),
      k.text('wantedNumber', 'Number wanted (last four digits)', { ...k.half, ...k.showIf(k.is('numberChoice', 'FANCY')), requiredWhen: k.is('numberChoice', 'FANCY'), ...k.pattern('^[0-9]{4}$', 'Four digits') }),
      k.toggle('hsrp', 'Fit high-security number plates', { defaultValue: true }),
      k.num('roadTax', 'Road tax (₹)', { ...k.third, disabled: true }),
      k.num('fees', 'Registration and other fees (₹)', { ...k.third, disabled: true }),
      k.num('totalDue', 'Total to pay (₹)', { ...k.third, disabled: true }),
    ]),
    k.section('finish', 'Documents and declaration', [
      k.file('invoice', 'Sale invoice', k.req),
      k.file('form21', 'Sale certificate from the dealer (Form 21)', k.req),
      k.file('roadworthy', 'Roadworthiness certificate from the maker (Form 22)', k.req),
      k.file('insurance', 'Insurance certificate', k.req),
      k.file('identity', 'Proof of identity and address', k.req),
      k.file('form34', 'Loan agreement (Form 34)', k.showIf(k.is('financed', true))),
      ...k.declare('I declare that the vehicle has not been registered anywhere before, that the particulars are true, and that I will pay any difference in tax found on scrutiny.', 'Signature of the owner'),
    ]),
  ],
  {
    intro: 'Register a new vehicle. Your dealer can also fill this in for you.',
    rules: [
      k.calc('reg_tax', 'roadTax', 'round(price * if(vehicleClass == "CAR", if(price > 2000000, 0.13, if(price > 1000000, 0.11, 0.09)), if(oneOf(vehicleClass, "MOTORCYCLE", "SCOOTER"), 0.08, 0.06)) * if(fuel == "ELECTRIC", 0, 1) * if(ownerType == "COMPANY", 1.5, 1))', 'Road tax'),
      k.calc('reg_fees', 'fees', 'if(oneOf(vehicleClass, "MOTORCYCLE", "SCOOTER"), 300, 600) + if(hsrp, if(oneOf(vehicleClass, "MOTORCYCLE", "SCOOTER"), 450, 1100), 0) + if(numberChoice == "FANCY", 5000, 0) + if(financed, 1500, 0)', 'Fees'),
      k.calc('reg_total', 'totalDue', 'roadTax + fees', 'Total'),
      { id: 'reg_loan', name: 'The loan agreement when financed', when: k.is('financed', true), then: [{ type: 'REQUIRE', target: 'form34' }] },
      k.refuse('reg_invoice', 'invoiceDate > today()', 'invoiceDate', 'The invoice date cannot be in the future'),
      k.refuse('reg_late', 'dateDiff(invoiceDate, today(), "days") > 30', 'invoiceDate', 'A vehicle must be registered within 30 days of purchase. Please visit the office for a late registration.'),
      k.refuse('reg_policy', 'policyUntil < today()', 'policyUntil', 'The insurance has expired'),
      k.refuse('reg_adult', 'ownerType == "PERSON" && dateDiff(dob, today(), "years") < 18', 'dob', 'The owner must be 18 or older'),
    ],
    workflow: k.flow(
      'VR',
      [k.st('SUBMITTED', 'Submitted', 'OPEN', 8), k.st('SCRUTINY', 'Scrutiny', 'IN_PROGRESS', 16), k.st('QUERY', 'Waiting for the applicant', 'IN_PROGRESS'), k.st('INSPECTION', 'Vehicle inspection', 'IN_PROGRESS', 24), k.st('NUMBER_ALLOTTED', 'Number allotted', 'IN_PROGRESS', 8), k.st('REGISTERED', 'Certificate issued', 'DONE'), k.st('REJECTED', 'Rejected', 'DONE')],
      [
        k.act('scrutinise', 'Start scrutiny', ['SUBMITTED', 'QUERY'], 'SCRUTINY'),
        k.act('query', 'Ask the applicant', ['SCRUTINY', 'INSPECTION'], 'QUERY', { requireComment: true }),
        k.act('inspect', 'Call for inspection', ['SCRUTINY'], 'INSPECTION'),
        k.act('allot', 'Allot the number', ['SCRUTINY', 'INSPECTION'], 'NUMBER_ALLOTTED', { requireFields: ['registrationNumber'] }),
        k.act('issue', 'Issue the certificate', ['NUMBER_ALLOTTED'], 'REGISTERED'),
        k.act('reject', 'Reject', ['SCRUTINY', 'INSPECTION'], 'REJECTED', { requireComment: true }),
      ],
      {
        contactEmailField: 'email',
        requestInfoStatus: 'QUERY',
        sla: { calendar: 'WORKING', responseHours: 8, resolutionHours: 56, pauseIn: ['QUERY'], warnAtPercent: 80 },
        priority: { default: 'MEDIUM', rules: [{ if: k.is('usage', 'COMMERCIAL'), priority: 'HIGH' }] },
        workFields: [{ id: 'reg_w_no', type: 'TEXT', name: 'registrationNumber', label: 'Registration number allotted' }],
      },
    ),
    automations: [k.confirmation('reg_confirm', 'email', 'Your vehicle registration application', 'Thank you. Your application has been received. Keep your application number to follow it.')],
  },
);

// ── Transfer of ownership ──────────────────────────────────────────────────
const transfer = k.make(
  'gov-vehicle-transfer',
  'Government',
  'Transfer of vehicle ownership',
  'When a vehicle is sold, inherited or sold at auction: the vehicle, the present owner, the new owner, any loan on it, and the papers each case needs.',
  ['Rules: set your transfer fees.', 'Workflow → Process: send applications to the office the vehicle is registered with.'],
  [
    k.section('vehicle', 'Vehicle', [
      k.text('regNumber', 'Registration number', { ...k.req, ...k.half, ...REG }),
      k.dropdown('vehicleClass', 'Kind of vehicle', VEHICLE_CLASSES, { ...k.req, ...k.half }),
      ...vehicleIds(),
      k.date('registeredOn', 'First registered on', { ...k.req, ...k.half }),
      k.radio('reason', 'Why is it changing hands', [['SALE', 'It was sold'], ['DEATH', 'The owner has died'], ['AUCTION', 'It was bought at a public auction']], k.req),
      k.yesNo('otherState', 'Is the new owner in another state?', k.req),
    ]),
    k.section('seller', 'Present owner', [
      k.text('sellerName', 'Name, as on the registration certificate', k.req),
      k.phone('sellerMobile', 'Mobile number', { ...k.half, requiredWhen: k.is('reason', 'SALE') }),
      k.date('soldOn', 'Date of sale or delivery', { ...k.half, ...k.showIf(k.is('reason', 'SALE')), requiredWhen: k.is('reason', 'SALE') }),
      k.num('salePrice', 'Sale price (₹)', { ...k.half, validation: { min: 0 }, ...k.showIf(k.isNot('reason', 'DEATH')) }),
      k.date('diedOn', 'Date of death', { ...k.half, ...k.showIf(k.is('reason', 'DEATH')), requiredWhen: k.is('reason', 'DEATH') }),
      k.dropdown('heirRelation', 'The new owner is the late owner\'s', k.RELATIONS, { ...k.half, ...k.showIf(k.is('reason', 'DEATH')), requiredWhen: k.is('reason', 'DEATH') }),
    ]),
    k.section('buyer', 'New owner', [
      ...k.contact('Name of the new owner'),
      k.date('dob', 'Date of birth', { ...k.req, ...k.half }),
      k.text('licenceNo', 'Driving licence number', k.half),
      ...k.address('buyer', 'Address of the new owner'),
    ]),
    k.section('loan', 'Loan and insurance', [
      k.yesNo('hypothecated', 'Is there a loan on the vehicle?', k.req),
      k.text('financier', 'Bank or financier', { ...k.half, ...k.showIf(k.is('hypothecated', 'YES')), requiredWhen: k.is('hypothecated', 'YES') }),
      k.radio('loanAction', 'The loan is', [['CLOSED', 'Paid off: remove it from the certificate'], ['CONTINUES', 'Continuing with the new owner']], { ...k.showIf(k.is('hypothecated', 'YES')), requiredWhen: k.is('hypothecated', 'YES') }),
      k.text('policyNo', 'Insurance policy number', { ...k.req, ...k.half }),
      k.date('policyUntil', 'Insured until', { ...k.req, ...k.half }),
      k.num('transferFee', 'Transfer fee (₹)', { ...k.half, disabled: true }),
    ]),
    k.section('finish', 'Documents and declaration', [
      k.file('rc', 'Registration certificate', k.req),
      k.file('form29', 'Notice of transfer signed by the seller (Form 29)', k.showIf(k.is('reason', 'SALE'))),
      k.file('deathCertificate', 'Death certificate and proof of succession', k.showIf(k.is('reason', 'DEATH'))),
      k.file('auctionOrder', 'Order confirming the auction sale', k.showIf(k.is('reason', 'AUCTION'))),
      k.file('financierNoc', 'No-objection letter from the financier', k.showIf(k.is('hypothecated', 'YES'))),
      k.file('stateNoc', 'No-objection certificate from the present state', k.showIf(k.is('otherState', 'YES'))),
      k.file('insurance', 'Insurance certificate', k.req),
      k.file('pollution', 'Pollution-under-control certificate', k.req),
      k.file('buyerId', 'New owner\'s proof of identity and address', k.req),
      ...k.declare('I declare that I have taken possession of the vehicle, that no tax or challan is unpaid to my knowledge, and that the particulars are true.', 'Signature of the new owner'),
    ]),
  ],
  {
    intro: 'Put a vehicle in the new owner\'s name. Apply within 14 days of the sale.',
    rules: [
      k.calc('tr_fee', 'transferFee', 'if(oneOf(vehicleClass, "MOTORCYCLE", "SCOOTER"), 150, if(vehicleClass == "CAR", 300, 500)) + if(hypothecated == "YES", 500, 0) + if(!isEmpty(soldOn) && dateDiff(soldOn, today(), "days") > 14, 500, 0)', 'Fee, with a late charge after 14 days'),
      { id: 'tr_29', name: 'Form 29 for a sale', when: k.is('reason', 'SALE'), then: [{ type: 'REQUIRE', target: 'form29' }] },
      { id: 'tr_death', name: 'Papers after a death', when: k.is('reason', 'DEATH'), then: [{ type: 'REQUIRE', target: 'deathCertificate' }] },
      { id: 'tr_auction', name: 'The auction order', when: k.is('reason', 'AUCTION'), then: [{ type: 'REQUIRE', target: 'auctionOrder' }] },
      { id: 'tr_fin', name: 'The financier\'s letter', when: k.is('hypothecated', 'YES'), then: [{ type: 'REQUIRE', target: 'financierNoc' }] },
      { id: 'tr_state', name: 'The state\'s no-objection', when: k.is('otherState', 'YES'), then: [{ type: 'REQUIRE', target: 'stateNoc' }] },
      k.refuse('tr_sold', 'soldOn > today()', 'soldOn', 'The date of sale cannot be in the future'),
      k.refuse('tr_policy', 'policyUntil < today()', 'policyUntil', 'The insurance has expired: renew it first'),
      k.refuse('tr_adult', 'dateDiff(dob, today(), "years") < 18', 'dob', 'The new owner must be 18 or older'),
    ],
    workflow: k.flow(
      'TO',
      [k.st('SUBMITTED', 'Submitted', 'OPEN', 8), k.st('VERIFICATION', 'Verification', 'IN_PROGRESS', 24), k.st('QUERY', 'Waiting for the applicant', 'IN_PROGRESS'), k.st('APPROVED', 'Approved', 'IN_PROGRESS', 8), k.st('TRANSFERRED', 'New certificate issued', 'DONE'), k.st('REJECTED', 'Rejected', 'DONE')],
      [
        k.act('verify', 'Start verification', ['SUBMITTED', 'QUERY'], 'VERIFICATION'),
        k.act('query', 'Ask the applicant', ['VERIFICATION'], 'QUERY', { requireComment: true }),
        k.act('approve', 'Approve', ['VERIFICATION'], 'APPROVED'),
        k.act('issue', 'Issue the certificate', ['APPROVED'], 'TRANSFERRED'),
        k.act('reject', 'Reject', ['VERIFICATION'], 'REJECTED', { requireComment: true }),
      ],
      { contactEmailField: 'email', requestInfoStatus: 'QUERY', sla: { calendar: 'WORKING', responseHours: 8, resolutionHours: 40, pauseIn: ['QUERY'] }, priority: { default: 'MEDIUM', rules: [{ if: k.is('reason', 'DEATH'), priority: 'HIGH' }] } },
    ),
  },
);

// ── Driving licence ────────────────────────────────────────────────────────
const licence = k.make(
  'gov-driving-licence',
  'Government',
  'Driving licence application',
  'A learner\'s licence, a permanent one, a renewal or a duplicate: the applicant, the classes of vehicle, a health self-declaration, and a slot for the test.',
  ['Replace the offices and the test slots with your own.', 'Rules: set your fees and the ages for each class of vehicle.'],
  [
    k.section('request', 'What you need', [
      k.radio('service', 'I am applying for', [['LEARNER', 'A learner\'s licence'], ['PERMANENT', 'A permanent licence'], ['RENEWAL', 'Renewal of my licence'], ['DUPLICATE', 'A duplicate of a lost or damaged licence']], k.req),
      k.checks('classes', 'For which vehicles', [['MCWOG', 'Motorcycle without gear'], ['MCWG', 'Motorcycle with gear'], ['LMV', 'Car (light motor vehicle)'], ['TRANSPORT', 'Transport vehicle']], k.req),
      k.text('existingNo', 'Present licence or learner\'s licence number', { ...k.half, ...k.showIf(k.isNot('service', 'LEARNER')), requiredWhen: k.isNot('service', 'LEARNER') }),
      k.date('existingUntil', 'It is valid until', { ...k.half, ...k.showIf(k.oneOf('service', ['PERMANENT', 'RENEWAL'])) }),
      k.dropdown('office', 'Licensing office', ['Central', 'East', 'West', 'North', 'South'], { ...k.req, ...k.half }),
    ]),
    k.section('applicant', 'About you', [
      ...k.contact('Full name, as on your identity proof'),
      k.date('dob', 'Date of birth', { ...k.req, ...k.third }),
      k.radio('gender', 'Gender', ['Female', 'Male', 'Other'], { ...k.req, ...k.third }),
      k.dropdown('bloodGroup', 'Blood group', [['A_POS', 'A+'], ['A_NEG', 'A−'], ['B_POS', 'B+'], ['B_NEG', 'B−'], ['O_POS', 'O+'], ['O_NEG', 'O−'], ['AB_POS', 'AB+'], ['AB_NEG', 'AB−']], k.third),
      k.dropdown('education', 'Education', ['Below class 8', 'Class 8', 'Class 10', 'Class 12', 'Graduate or above'], k.half),
      k.text('identityMark', 'A mark of identification', k.half),
      ...k.address('home', 'Present address'),
      k.toggle('organDonor', 'I wish to donate my organs in the event of my death'),
    ]),
    k.section('health', 'Health declaration', [
      k.yesNo('epilepsy', 'Do you suffer from epilepsy, or sudden fainting or giddiness?', k.req),
      k.yesNo('vision', 'Can you read a number plate at 25 metres, with glasses if you wear them?', k.req),
      k.yesNo('limbs', 'Have you lost a hand or foot, or the use of one?', k.req),
      k.yesNo('nightBlind', 'Do you suffer from night blindness?', k.req),
      k.yesNo('hearing', 'Are you so deaf that you cannot hear a horn?', k.req),
      k.file('medical', 'Medical certificate (Form 1A)'),
    ]),
    k.section('test', 'Test and fee', [
      k.dateTime('testSlot', 'Preferred date and time for the test', k.showIf(k.oneOf('service', ['LEARNER', 'PERMANENT']))),
      k.dropdown('testLanguage', 'Language of the test', ['English', 'Hindi', 'Marathi', 'Gujarati', 'Tamil', 'Telugu', 'Kannada'], { ...k.half, ...k.showIf(k.is('service', 'LEARNER')) }),
      k.area('lostHow', 'How the licence was lost or damaged', { ...k.showIf(k.is('service', 'DUPLICATE')), requiredWhen: k.is('service', 'DUPLICATE') }),
      k.num('fee', 'Fee (₹)', { ...k.half, disabled: true }),
    ]),
    k.section('finish', 'Documents and declaration', [
      k.file('photo', 'Passport-size photograph', k.req),
      k.file('ageProof', 'Proof of age', k.req),
      k.file('addressProof', 'Proof of address', k.req),
      k.file('oldLicence', 'Present licence', k.showIf(k.oneOf('service', ['RENEWAL', 'PERMANENT']))),
      ...k.declare('I declare that I am not disqualified from holding a licence, that my answers on health are true, and that I have not held a licence that was cancelled.'),
    ]),
  ],
  {
    intro: 'Apply for a licence, renew one or replace a lost one.',
    rules: [
      k.calc('dl_fee', 'fee', 'if(service == "LEARNER", 150, if(service == "PERMANENT", 700, if(service == "RENEWAL", 400, 400))) + length(classes) * 50', 'Fee by service and classes'),
      { id: 'dl_medical', name: 'A medical certificate when needed', when: { expr: 'contains(classes, "TRANSPORT") || epilepsy == "YES" || limbs == "YES" || nightBlind == "YES" || hearing == "YES" || vision == "NO" || dateDiff(dob, today(), "years") >= 40' }, then: [{ type: 'REQUIRE', target: 'medical' }] },
      k.refuse('dl_age_16', 'dateDiff(dob, today(), "years") < 16', 'dob', 'You must be 16 or older to apply'),
      k.refuse('dl_age_18', 'dateDiff(dob, today(), "years") < 18 && (contains(classes, "LMV") || contains(classes, "MCWG") || contains(classes, "TRANSPORT"))', 'classes', 'Under 18 you may apply only for a motorcycle without gear'),
      k.refuse('dl_age_20', 'dateDiff(dob, today(), "years") < 20 && contains(classes, "TRANSPORT")', 'classes', 'You must be 20 or older to drive a transport vehicle'),
      k.refuse('dl_slot', '!isEmpty(testSlot) && testSlot < now()', 'testSlot', 'Choose a time that is still to come'),
    ],
    workflow: k.flow(
      'DL',
      [k.st('SUBMITTED', 'Submitted', 'OPEN', 8), k.st('VERIFIED', 'Documents verified', 'IN_PROGRESS'), k.st('TEST_BOOKED', 'Test booked', 'IN_PROGRESS'), k.st('PASSED', 'Test passed', 'IN_PROGRESS', 40), k.st('ISSUED', 'Licence issued', 'DONE'), k.st('FAILED', 'Test not passed', 'DONE'), k.st('REJECTED', 'Rejected', 'DONE')],
      [
        k.act('verify', 'Documents are in order', ['SUBMITTED'], 'VERIFIED'),
        k.act('book', 'Book the test', ['VERIFIED'], 'TEST_BOOKED'),
        k.act('pass', 'Passed', ['TEST_BOOKED'], 'PASSED', { requireFields: ['testScore'] }),
        k.act('fail', 'Did not pass', ['TEST_BOOKED'], 'FAILED', { requireFields: ['testScore'] }),
        k.act('issue', 'Issue the licence', ['VERIFIED', 'PASSED'], 'ISSUED'),
        k.act('reject', 'Reject', ['SUBMITTED', 'VERIFIED'], 'REJECTED', { requireComment: true }),
      ],
      { contactEmailField: 'email', reopen: { to: 'TEST_BOOKED', withinDays: 180 }, workFields: [{ id: 'dl_w_score', type: 'NUMBER', name: 'testScore', label: 'Test score' }, { id: 'dl_w_examiner', type: 'TEXT', name: 'examiner', label: 'Examiner' }] },
    ),
  },
);

// ── Certificates (birth, death, marriage) ──────────────────────────────────
const certificate = k.make(
  'gov-certificate',
  'Government',
  'Birth, death or marriage certificate',
  'One form for the three certificates people ask for most: what happened, where and when, who is asking, how many copies, and delivery.',
  ['Rules: set your fee per copy and the delivery charge.', 'Working time: set the office calendar the service time is counted in.'],
  [
    k.section('event', 'The certificate', [
      k.radio('kind', 'Certificate of', ['Birth', 'Death', 'Marriage'], k.req),
      k.radio('purpose', 'You need', [['NEW', 'A first registration'], ['COPY', 'A copy of one already registered'], ['CORRECTION', 'A correction']], k.req),
      k.text('registrationNo', 'Registration number, if known', { ...k.half, ...k.showIf(k.isNot('purpose', 'NEW')) }),
      k.date('eventDate', 'Date it happened', { ...k.req, ...k.half }),
      k.time('eventTime', 'Time', { ...k.half, ...k.showIf(k.is('kind', 'BIRTH')) }),
      k.text('place', 'Place (hospital, home or venue)', { ...k.req, ...k.half }),
      k.dropdown('ward', 'Ward or zone', ['Ward A', 'Ward B', 'Ward C', 'Ward D', 'Ward E'], { ...k.req, ...k.half }),
      k.area('correction', 'What is wrong, and what it should say', { ...k.showIf(k.is('purpose', 'CORRECTION')), requiredWhen: k.is('purpose', 'CORRECTION') }),
    ]),
    k.section('people', 'The people', [
      k.section('birth', 'The child', [
        k.text('childName', 'Name of the child (leave empty if not yet named)', k.half),
        k.radio('childGender', 'Gender', ['Girl', 'Boy', 'Other'], k.half),
        k.text('motherName', 'Mother\'s name', k.half),
        k.text('fatherName', 'Father\'s name', k.half),
        k.radio('deliveredAt', 'Born', ['In a hospital', 'At home', 'Elsewhere']),
      ], k.showIf(k.is('kind', 'BIRTH'))),
      k.section('death', 'The person who died', [
        k.text('deceasedName', 'Name', k.half),
        k.num('deceasedAge', 'Age', { ...k.half, validation: { min: 0, max: 130 } }),
        k.radio('deceasedGender', 'Gender', ['Female', 'Male', 'Other'], k.half),
        k.text('causeOfDeath', 'Cause of death, as certified', k.half),
      ], k.showIf(k.is('kind', 'DEATH'))),
      k.section('marriage', 'The couple', [
        k.columns('couple', [[k.text('spouse1', 'First spouse'), k.date('spouse1Dob', 'Date of birth')], [k.text('spouse2', 'Second spouse'), k.date('spouse2Dob', 'Date of birth')]]),
        k.repeat('witnesses', 'Witness', [k.text('witnessName', 'Name', k.req), k.text('witnessAddress', 'Address', k.req)], { max: 3 }),
      ], k.showIf(k.is('kind', 'MARRIAGE'))),
    ]),
    k.section('applicant', 'Who is asking', [
      ...k.contact(),
      k.dropdown('relation', 'You are the', ['Person named', 'Parent', 'Spouse', 'Son or daughter', 'Other relative', 'Hospital', 'Authorised person'], { ...k.req, ...k.half }),
      k.stepper('copies', 'Copies wanted', 1, 10, { ...k.half, defaultValue: 1 }),
      k.radio('delivery', 'How you want it', [['DIGITAL', 'By email, digitally signed'], ['COLLECT', 'Collected at the office'], ['POST', 'By post']], { ...k.req, defaultValue: 'DIGITAL' }),
      k.area('postalAddress', 'Address to post it to', { ...k.showIf(k.is('delivery', 'POST')), requiredWhen: k.is('delivery', 'POST') }),
      k.num('fee', 'Fee (₹)', { ...k.half, disabled: true }),
    ]),
    k.section('finish', 'Documents and declaration', [
      k.file('proofOfEvent', 'Hospital record, cremation or burial receipt, or invitation and photographs', k.req),
      k.file('applicantId', 'Your photo identity', k.req),
      k.file('affidavit', 'Affidavit, for a registration after one year or a correction'),
      ...k.declare('I declare that the particulars are true to my knowledge and that I am entitled to ask for this certificate.'),
    ]),
  ],
  {
    intro: 'Register a birth, a death or a marriage, or ask for a copy of a certificate.',
    timeZone: 'Asia/Kolkata',
    listOnPortal: true,
    rules: [
      k.calc('cert_fee', 'fee', 'copies * 50 + if(delivery == "POST", 100, 0) + if(purpose == "NEW" && !isEmpty(eventDate) && dateDiff(eventDate, today(), "days") > 21, 200, 0)', 'Fee, with a late charge after 21 days'),
      { id: 'cert_birth', name: 'What a birth needs', when: k.is('kind', 'BIRTH'), then: [{ type: 'REQUIRE', target: 'motherName' }, { type: 'REQUIRE', target: 'childGender' }] },
      { id: 'cert_death', name: 'What a death needs', when: k.is('kind', 'DEATH'), then: [{ type: 'REQUIRE', target: 'deceasedName' }, { type: 'REQUIRE', target: 'deceasedAge' }] },
      { id: 'cert_marriage', name: 'What a marriage needs', when: k.is('kind', 'MARRIAGE'), then: [{ type: 'REQUIRE', target: 'spouse1' }, { type: 'REQUIRE', target: 'spouse2' }] },
      { id: 'cert_affidavit', name: 'An affidavit when late or corrected', when: { expr: 'purpose == "CORRECTION" || (purpose == "NEW" && dateDiff(eventDate, today(), "days") > 365)' }, then: [{ type: 'REQUIRE', target: 'affidavit' }] },
      k.refuse('cert_date', 'eventDate > today()', 'eventDate', 'This date cannot be in the future'),
    ],
    workflow: k.flow(
      'CRT',
      [k.st('RECEIVED', 'Received', 'OPEN', 8), k.st('VERIFICATION', 'Verification of records', 'IN_PROGRESS', 24), k.st('QUERY', 'Waiting for the applicant', 'IN_PROGRESS'), k.st('ISSUED', 'Certificate issued', 'DONE'), k.st('REJECTED', 'Rejected', 'DONE')],
      [k.act('verify', 'Verify', ['RECEIVED', 'QUERY'], 'VERIFICATION'), k.act('query', 'Ask the applicant', ['VERIFICATION'], 'QUERY', { requireComment: true }), k.act('issue', 'Issue', ['VERIFICATION'], 'ISSUED'), k.act('reject', 'Reject', ['VERIFICATION'], 'REJECTED', { requireComment: true })],
      { contactEmailField: 'email', requestInfoStatus: 'QUERY', sla: { calendar: 'WORKING', resolutionHours: 56, pauseIn: ['QUERY'] }, priority: { default: 'MEDIUM', rules: [{ if: k.is('kind', 'DEATH'), priority: 'HIGH' }] } },
    ),
  },
);

// ── Public grievance ───────────────────────────────────────────────────────
const DEPARTMENT_ISSUES: Record<string, string[]> = {
  ROADS: ['POTHOLE', 'BROKEN_FOOTPATH', 'STREET_LIGHT', 'TRAFFIC_SIGNAL'],
  WATER: ['NO_WATER', 'LEAK', 'DIRTY_WATER', 'BLOCKED_DRAIN'],
  SANITATION: ['GARBAGE_NOT_COLLECTED', 'PUBLIC_TOILET', 'DEAD_ANIMAL', 'MOSQUITOES'],
  BUILDINGS: ['ILLEGAL_CONSTRUCTION', 'DANGEROUS_BUILDING', 'ENCROACHMENT'],
  OTHER: ['STRAY_ANIMALS', 'NOISE', 'SOMETHING_ELSE'],
};
const issueOptions = Object.values(DEPARTMENT_ISSUES).flat().map((v): [string, string] => [v, v[0] + v.slice(1).toLowerCase().replace(/_/g, ' ')]);

const grievance = k.make(
  'gov-grievance',
  'Government',
  'Citizen complaint',
  'A complaint to a city or department: what is wrong and where, photographs, how serious it is, and whether the person wants to stay anonymous. Routed by department, with escalation.',
  ['Replace the departments and problems with your own.', 'Workflow → Process: send complaints to the officer of each department ("Depends on an answer": Department).', 'Turn on CAPTCHA before sharing the link widely.'],
  [
    k.hidden('channel', 'SOURCE_CHANNEL'),
    k.section('problem', 'The problem', [
      k.dropdown('department', 'It is about', [['ROADS', 'Roads and lights'], ['WATER', 'Water and drainage'], ['SANITATION', 'Garbage and sanitation'], ['BUILDINGS', 'Buildings and encroachment'], ['OTHER', 'Something else']], { ...k.req, ...k.half }),
      k.dropdown('issue', 'Problem', issueOptions, { ...k.req, ...k.half, dependency: { dependsOn: ['department'], resetOnChange: true } }),
      k.area('details', 'What is wrong', { ...k.req, validation: { minLength: 15, maxLength: 2000 } }),
      k.radio('severity', 'How serious is it', [['DANGER', 'Someone could be hurt'], ['MAJOR', 'Many people are affected'], ['MINOR', 'A nuisance']], k.req),
      k.date('since', 'Since when', k.half),
      k.yesNo('reportedBefore', 'Have you reported this before?', k.half),
      k.text('earlierRef', 'Earlier complaint number', { ...k.half, ...k.showIf(k.is('reportedBefore', 'YES')) }),
    ]),
    k.section('where', 'Where', [
      k.dropdown('ward', 'Ward', ['Ward A', 'Ward B', 'Ward C', 'Ward D', 'Ward E'], { ...k.req, ...k.half }),
      k.text('landmark', 'Nearest landmark', { ...k.req, ...k.half }),
      k.area('location', 'Address or directions', k.req),
      k.url('mapLink', 'A map link to the spot', k.half),
      k.file('photos', 'Photographs'),
    ]),
    k.section('you', 'About you', [
      k.toggle('anonymous', 'Keep my name from the department'),
      k.text('fullName', 'Your name', k.req),
      k.phone('mobile', 'Mobile number', { ...k.req, ...k.half }),
      k.email('email', 'Email', k.half),
      k.radio('updates', 'Tell me about progress by', ['SMS', 'Email', 'Do not send updates'], { defaultValue: 'SMS' }),
      k.consent('declaration', 'Declaration', 'What I have reported is true to my knowledge.'),
    ]),
  ],
  {
    intro: 'Tell us about a problem in your area.',
    saveForLater: false,
    listOnPortal: true,
    rules: [
      ...k.narrow('grv_issues', 'department', 'issue', DEPARTMENT_ISSUES),
      { id: 'grv_email', name: 'An email when updates go by email', when: k.is('updates', 'EMAIL'), then: [{ type: 'REQUIRE', target: 'email' }] },
      k.refuse('grv_since', 'since > today()', 'since', 'This date cannot be in the future'),
    ],
    workflow: k.flow(
      'GRV',
      [k.st('NEW', 'New', 'OPEN', 4), k.st('ASSIGNED', 'With the field team', 'IN_PROGRESS', 48), k.st('NEEDS_INFO', 'Waiting for the citizen', 'IN_PROGRESS'), k.st('RESOLVED', 'Resolved', 'DONE'), k.st('NOT_OURS', 'Sent to another authority', 'DONE'), k.st('DUPLICATE', 'Already reported', 'DONE')],
      [
        k.act('assign', 'Send to the field team', ['NEW', 'NEEDS_INFO'], 'ASSIGNED'),
        k.act('ask', 'Ask the citizen', ['NEW', 'ASSIGNED'], 'NEEDS_INFO', { requireComment: true }),
        k.act('resolve', 'Resolved', ['ASSIGNED'], 'RESOLVED', { requireFields: ['actionTaken'] }),
        k.act('forward', 'Not ours: forward', ['NEW', 'ASSIGNED'], 'NOT_OURS', { requireComment: true }),
        k.act('duplicate', 'Already reported', ['NEW'], 'DUPLICATE', { requireComment: true }),
      ],
      {
        requestInfoStatus: 'NEEDS_INFO',
        reopen: { to: 'ASSIGNED', withinDays: 15 },
        priority: { default: 'MEDIUM', rules: [{ if: k.is('severity', 'DANGER'), priority: 'CRITICAL' }, { if: k.is('severity', 'MAJOR'), priority: 'HIGH' }, { if: k.is('severity', 'MINOR'), priority: 'LOW' }] },
        sla: { calendar: '24x7', responseHours: 4, resolutionHours: 72, byPriority: { CRITICAL: { responseHours: 1, resolutionHours: 12 }, HIGH: { resolutionHours: 48 }, LOW: { resolutionHours: 168 } }, pauseIn: ['NEEDS_INFO'], warnAtPercent: 75 },
        workFields: [{ id: 'grv_w_action', type: 'TEXTAREA', name: 'actionTaken', label: 'What was done' }],
      },
    ),
  },
);

// ── Farm subsidy ───────────────────────────────────────────────────────────
const subsidy = k.make(
  'gov-farm-subsidy',
  'Agriculture',
  'Farm subsidy application',
  'A farmer applies for help with equipment, irrigation or seed: the farmer, each plot of land with its area, the crop, what is being bought, and the subsidy worked out from the cost and the farmer\'s category.',
  ['Rules: set the share of cost each scheme pays and its ceiling.', 'Replace the districts and schemes with your own.'],
  [
    k.section('farmer', 'Farmer', [
      ...k.contact('Name of the farmer'),
      k.date('dob', 'Date of birth', { ...k.req, ...k.third }),
      k.radio('gender', 'Gender', ['Female', 'Male', 'Other'], { ...k.req, ...k.third }),
      k.dropdown('category', 'Category', ['General', 'OBC', 'SC', 'ST'], { ...k.req, ...k.third }),
      k.text('farmerId', 'Farmer registration number', k.half),
      k.dropdown('district', 'District', ['Pune', 'Nashik', 'Nagpur', 'Kolhapur', 'Aurangabad'], { ...k.req, ...k.half }),
      k.text('village', 'Village and taluka', { ...k.req, ...k.half }),
    ]),
    k.section('land', 'Land and crop', [
      k.repeat('plots', 'Plot', [
        k.text('surveyNo', 'Survey number', k.req),
        k.num('areaAcres', 'Area (acres)', { ...k.req, validation: { min: 0.1, max: 500 } }),
        k.dropdown('holding', 'Held as', ['Owner', 'Tenant', 'Sharecropper'], k.req),
        k.toggle('irrigated', 'Irrigated'),
      ], { min: 1, max: 15, totals: ['areaAcres'] }),
      k.num('totalAcres', 'Total land (acres)', { ...k.half, disabled: true }),
      k.text('farmerClass', 'Size of holding', { ...k.half, disabled: true }),
      k.multi('crops', 'Crops grown', ['Rice', 'Wheat', 'Sugarcane', 'Cotton', 'Pulses', 'Soybean', 'Vegetables', 'Fruit']),
      k.dropdown('season', 'For the season', ['Kharif', 'Rabi', 'Summer'], { ...k.req, ...k.half }),
    ]),
    k.section('help', 'What the subsidy is for', [
      k.radio('scheme', 'Scheme', [['MACHINERY', 'Farm machinery'], ['DRIP', 'Drip or sprinkler irrigation'], ['PUMP', 'Solar pump'], ['SEED', 'Seed and fertiliser']], k.req),
      k.text('item', 'What you are buying', { ...k.req, ...k.half }),
      k.text('supplier', 'Supplier', k.half),
      k.num('cost', 'Its cost (₹)', { ...k.req, ...k.half, validation: { min: 100, max: 5000000 } }),
      k.num('subsidy', 'Subsidy you may get (₹)', { ...k.half, disabled: true }),
      k.yesNo('hadBefore', 'Have you had a subsidy for this in the last three years?', k.req),
    ]),
    k.section('bank', 'Bank account and documents', [
      ...k.bank('payout', 'Bank account for the subsidy'),
      k.file('landRecord', 'Land record (7/12 extract)', k.req),
      k.file('quotation', 'Quotation from the supplier', k.req),
      k.file('passbook', 'First page of the bank passbook', k.req),
      k.file('casteCertificate', 'Caste certificate', k.showIf(k.oneOf('category', ['SC', 'ST', 'OBC']))),
      ...k.declare('I declare that the land is cultivated by me, that I have not taken a subsidy for the same item elsewhere, and that I will use what I buy on my own farm.', 'Signature or thumb impression of the farmer'),
    ]),
  ],
  {
    intro: 'Apply for a subsidy. The amount is paid into your bank account after verification.',
    rules: [
      k.calc('sub_acres', 'totalAcres', 'sum(areaAcres)', 'Total land'),
      k.calc('sub_class', 'farmerClass', 'if(totalAcres <= 2.5, "Marginal", if(totalAcres <= 5, "Small", "Other"))', 'Marginal, small or other'),
      k.calc('sub_amount', 'subsidy', 'min(round(cost * if(oneOf(category, "SC", "ST") || totalAcres <= 5, 0.5, 0.4)), if(scheme == "MACHINERY", 125000, if(scheme == "PUMP", 200000, if(scheme == "DRIP", 60000, 10000))))', 'Half the cost for small farmers, up to the scheme\'s ceiling'),
      k.refuse('sub_before', 'hadBefore == "YES" && scheme != "SEED"', 'hadBefore', 'A subsidy for this is given once in three years'),
      k.refuse('sub_adult', 'dateDiff(dob, today(), "years") < 18', 'dob', 'The farmer must be 18 or older'),
    ],
    workflow: k.flow(
      'FS',
      [k.st('APPLIED', 'Applied', 'OPEN'), k.st('FIELD_CHECK', 'Field verification', 'IN_PROGRESS', 120), k.st('SANCTIONED', 'Sanctioned', 'IN_PROGRESS'), k.st('PURCHASE', 'Waiting for the purchase bill', 'IN_PROGRESS'), k.st('PAID', 'Subsidy paid', 'DONE'), k.st('REJECTED', 'Rejected', 'DONE')],
      [
        k.act('check', 'Send for field verification', ['APPLIED'], 'FIELD_CHECK'),
        k.act('sanction', 'Sanction', ['FIELD_CHECK'], 'SANCTIONED', { requireFields: ['sanctionedAmount'] }),
        k.act('await', 'Ask for the purchase bill', ['SANCTIONED'], 'PURCHASE'),
        k.act('pay', 'Pay the subsidy', ['PURCHASE'], 'PAID'),
        k.act('reject', 'Reject', ['APPLIED', 'FIELD_CHECK'], 'REJECTED', { requireComment: true }),
      ],
      { contactEmailField: 'email', priority: { default: 'MEDIUM', rules: [{ if: k.oneOf('category', ['SC', 'ST']), priority: 'HIGH' }] }, workFields: [{ id: 'sub_w_amount', type: 'NUMBER', name: 'sanctionedAmount', label: 'Amount sanctioned (₹)' }, { id: 'sub_w_report', type: 'TEXTAREA', name: 'fieldReport', label: 'Field officer\'s report' }] },
    ),
  },
);

export const GOVERNMENT: IndustryTemplate[] = [registration, transfer, licence, certificate, grievance, subsidy];
