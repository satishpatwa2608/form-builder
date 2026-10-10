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

## Where to see each feature at work

Open the form named, in the builder, to see how the feature is set up.

| Feature | Where it is used | Look at |
|---|---|---|
| **Steps with a last look before sending** | Every form | Form settings → Layout |
| **Fragments** (a section kept once in the library, used by many forms) | *Address* in 22 forms; *Bank account* in the health claim, farm subsidy, scholarship and joining form | Administration → Fragments; on Bank account opening the same fragment is used twice (`permanent_…`, `mailing_…`) |
| **Calculations** | Loan application (instalment), Car insurance (insured value, premium), Vehicle registration (tax and fees) | Rules |
| **Calculations inside each row, and totals across rows** | New electricity connection (load from appliances), Shipment booking (volumetric weight), Diagnostic test booking (each person's bill), Scholarship (family income) | The repeating section and Rules |
| **A list that depends on another** | Car insurance (model by make), Job application (role by department), Warranty claim (fault by product), Telecom (plan by service) | Rules: "… for …" |
| **Refusing an answer with a message** | Money transfer (limits by route), Visa (passport validity), Driving licence (age by class) | Rules |
| **Showing, requiring and locking fields by rule** | Health proposal, Motor claim, Transfer of vehicle ownership | Rules |
| **A button that fills fields** | Hospital registration ("They live at the patient's address") | Events |
| **Repeating sections** | Health proposal (family), University application (qualifications, tests, jobs, referees), Card dispute (transactions) | The section's settings |
| **Tabs and accordions** | Hospital registration, School admission, Health claim, University application | The container's settings |
| **Signature and consent** | Almost every form | The last step |
| **Values the system fills in** (channel, date, a value from the link) | Car insurance, Job application, Rental application | Hidden fields in the first step |
| **Filled from the signed-in person, and locked** | Employee joining form, Expense claim, System access request | The field → Fill from signed-in user |
| **CAPTCHA** | Not switched on in any: it needs your own site key. The setup notes of Two-wheeler insurance and Citizen complaint say where | Form settings |
| **Confirm with a code** | Switched off by default; the Bank account form says where to switch it on | Email or Phone field → Confirm with a code |
| **Taking a payment** | Named in the setup notes of University application, Trade licence, Vehicle registration, New connection, Visa, Conference, Shipment, Diagnostics | Form settings → Take a payment |
| **Workflow: statuses and buttons** | Every form, each different | Workflow → Process |
| **Fields the team fills in** | Health claim (admissible amount), Loan (credit score), Visa (visa number) | Workflow → Process → Work fields |
| **A button that needs fields or a comment first** | Loan: Sanction needs the score, amount and rate | Workflow → Process → Actions |
| **A manager's approval on a button** | Expense claim (always); Loan sanction, Money transfer and Health claim (above an amount); System access (twice) | Workflow → Process → Actions → Approval |
| **An approval as a step** | Dealer application (head of sales) | Workflow → Automations |
| **Priority from the answers** | Citizen complaint (danger), Loan (amount), Power complaint (fallen wire) | Workflow → Process → Priority |
| **Service times** in working hours or round the clock, by priority, paused while waiting | Health claim, Motor claim, Power complaint, Visa | Workflow → Process → SLA |
| **Escalation** | Power complaint, Workplace incident | Workflow → Process → Escalation |
| **Reopening** | Citizen complaint, Card dispute, Warranty claim | Workflow → Process |
| **Email when something happens** | Loan, Visa, Trade licence, New connection, Job application | Workflow → Automations |
| **Sending a document for signature** | Loan (sanction letter), Rental (lease), Job application (offer) | Workflow → Automations |
| **Alarms before and after a service time is missed** | Loan, Health claim, Citizen complaint, Motor claim, Workplace incident | Workflow → Automations |
| **A step when the team fills in a field** | Loan (the credit score is recorded) | Workflow → Automations |
| **Ready-made emails for the team** | Loan, Health claim, Citizen complaint | Workflow → Process → Email templates |
| **A PDF of each response** | Every form | Form settings |
| **Listed on the requests portal** | Trade licence, Certificates, Citizen complaint | Form settings |
| **Signed-in people only** | Employee joining form, Expense claim, System access request | Form settings → Who can open it |

Not shown, because each needs something of the organisation's own: a **shared
workflow** used by several forms, **connectors** (lists and look-ups from your
systems, and sending responses to them), your **extension's** steps and
checks, **webhooks** and automation tools, **translations**, your **styles**,
and a team that alone sees a form's records. **Tasks** are not available in
Form Builder at all: where a form needs someone to act, it notifies them.

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
