# Ready-made forms by industry

Forty long, multi-step forms that come with the builder: **New form → Show
starting points for → an industry**. Each becomes an ordinary draft; everything
in it can be changed. They exist for two reasons: to give customers a real
starting point, and to exercise the builder with the kind of forms large
organisations run, so that what is missing shows up.

They live in `apps/studio/src/templates/industry/` and are written with a small
vocabulary (`kit.ts`) rather than as raw JSON.

| Industry | Form | Steps | What it shows off |
|---|---|---|---|
| Insurance | Car insurance proposal | 7 | Model narrowed by make; insured value that falls with age; premium estimate; bonus lost after a claim; drivers as rows; six-status underwriting with SLA by priority |
| Insurance | Two-wheeler insurance | 4 | A short proposal; five-year cover only when new; CAPTCHA; a two-hour, round-the-clock SLA |
| Insurance | Health insurance proposal | 5 | Each person as a row with their own body-mass index; medical history in an accordion; reports required only with a history |
| Insurance | Health insurance claim | 5 | Bills as rows, totalled; days in hospital; late claims refused; documents in tabs; work fields the assessor fills; reopen |
| Healthcare | Hospital registration and admission | 6 | Age from date of birth; guardian for a child; clinic narrowed by department; a button that copies an address; emergency in 15 minutes |
| Education | School admission | 5 | Age on 1 June against the class; each parent in a tab; brothers and sisters as rows; eight statuses with a waiting list |
| Education | University application | 6 | Programme narrowed by school; qualifications, tests, jobs and referees as rows; fee by level, residency and category |
| Banking | Bank account opening (KYC) | 7 | Joint holders as rows; tax residency abroad; services with defaults; risk rating required to open |
| Banking | Loan application | 5 | The real monthly instalment; present loans totalled; share of income with a warning; 80% of property value enforced |
| Government | Trade licence application | 5 | Fee from area, trade and years; late fee on renewal; fire certificate required by rule; listed on the requests portal |
| Human resources | Employee joining form | 5 | Signed-in only, filled from the person's account; education and jobs as rows; three policies to accept |

## The second batch

Twenty-nine more, written the same way, to cover the industries where forms carry
real processes:

| Industry | Forms |
|---|---|
| Government | Vehicle registration (car or two-wheeler) · Transfer of vehicle ownership · Driving licence · Birth, death or marriage certificate · Citizen complaint |
| Agriculture | Farm subsidy application |
| Energy and utilities | New electricity connection · Rooftop solar (net metering) · Transfer of an electricity connection · Power supply or meter complaint |
| Banking | Account transfer to another branch · Money transfer (NEFT, RTGS, abroad) · Credit card application · Disputed card transaction |
| Insurance | Motor insurance claim |
| Hiring and HR | Job application · Expense claim |
| Information technology | System access request |
| Manufacturing and safety | Workplace incident report |
| Real estate | Rental application |
| Telecom | New mobile or broadband connection (with number porting) |
| Travel and immigration | Visa application |
| Events and hospitality | Conference registration |
| Retail and consumer goods | Warranty claim · Dealer or distributor application |
| Logistics | Shipment booking |
| Healthcare | Diagnostic test booking |
| Education | Scholarship application |
| Non-profit | Volunteer registration |

What these added to the picture: calculations inside each row and totals across
rows carry a great deal (the electrical load from a list of appliances, the
volumetric weight of each parcel, each patient's bill, a family's income for
each person), and every one of them worked without a change to the engine.

Between them they use every kind of field except the one drawn by an
extension. No two have the same workflow or service times: some count working
hours, some run round the clock, some pause while waiting for the applicant,
and three have no overall SLA at all.

## How they are checked

- Each is created, published and served through the API as a customer would
  (`apps/api/test/industry-templates.e2e-spec.ts`).
- Their calculations and refusals are checked with real answers
  (`apps/studio/src/templates/industry/industry.test.ts`): the car's insured
  value and premium, the claim total, the loan instalment against a known
  figure, the licence fee, ages and so on.

## What writing them showed

Added because a form needed it:

- **`pow(value, n)`** in calculations. Without it a loan instalment could only
  be approximated.

- **Taking a payment** with a response (see [payments-and-codes.md](payments-and-codes.md)).
  A form names a number field as the amount; the organisation chooses its
  payment service once.
- **Confirming a mobile number or email with a one-time code**, a switch on
  any email or phone field.

Missing, and worth deciding on:

- **Choosing an appointment from free slots.** The hospital form can only ask
  for a preferred time.
- **Lists that depend on another list, set up in one place.** It works, but
  takes one rule for each choice (six rules for the car's make and model).
- **A number of rows that depends on an answer.** A postgraduate applicant
  should give two referees and an undergraduate none; the minimum is fixed.
- **Looking something up as the person types** (a vehicle from its number, a
  bank from its IFSC). The builder can call a connector on a button, but these
  forms do not, so that they work in an organisation with no connectors.
