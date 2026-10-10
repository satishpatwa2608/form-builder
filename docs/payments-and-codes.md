# Payments and one-time codes

Two things any form can ask for. Both are set up once for the organisation and
then switched on wherever a form needs them; nothing is specific to one form or
one payment company.

## Confirming an email address or phone number

**In the builder:** select an Email or Phone field and switch on **Confirm
with a code**.

**What the person sees:** under the field, *Send me a code*. A 6-digit code
goes to what they typed; they type it in and the field shows as confirmed. If
they change the address, they confirm again. The form cannot be sent until
every such field that is filled in has been confirmed.

**How it is enforced:** the server gives the browser a proof for that exact
value, good for an hour, and refuses a submission without it. A code works for
10 minutes and five tries; at most five codes an hour go to one address.

- **Email codes** go out the way your other emails do (Form Builder, or your
  own mail server if you set one).
- **Text-message codes** need your own SMS service: **Organisation settings →
  Text messages**. Any service called over the web works. You give the address
  it is called at, what to send (with `{{to}}` and `{{message}}` where the
  number and the text go), and the header it asks for. Save, send a test
  message to your own phone, and it is on.

  | Your service wants | Set |
  |---|---|
  | JSON, e.g. `{"to": "...", "text": "..."}` | POST, JSON, body `{"to":"{{to}}","text":"{{message}}"}` |
  | A web form, e.g. `To=...&Body=...` | POST, web form, body `To={{to}}&Body={{message}}` |
  | Everything in the address | GET, address `https://…/send?to={{to}}&msg={{message}}` |

## Taking a payment

**Once, for the organisation:** **Organisation settings → Payments**, choose the
service:

| Service | What you paste |
|---|---|
| Practice payments | Nothing. No money moves; the person sees a practice page with *Pay* and *Let it fail*. For trying forms out |
| Razorpay | Key ID and key secret (Account & Settings → API keys) |
| Stripe | Secret key (Developers → API keys) |

**On a form:** form settings → **Take a payment with each response**. Choose
the number field that holds the amount (usually one a rule works out: a fee, a
premium), the currency, and what the payment is for.

**What the person sees:** they fill in the form and press submit. Their
answers are checked; they are sent to the payment service's own page; when
they have paid they come back to a thank-you page with their reference. If the
amount comes to 0, nothing is asked for and the response is simply accepted.

**How it is enforced:**

- The amount is what the form's rules work out **on the server**, never what
  the browser says.
- The answers are held while the person pays, and become a response only when
  the payment service itself says the money has arrived, for that amount.
- One payment makes one response, however many times the page is reloaded.
- A form that takes a payment refuses a response sent without one. Colleagues
  raising an item from inside are not asked to pay.
- The response keeps which service took the payment, its reference, the amount
  and the time.
- If the money arrives but the response cannot be registered, the person is
  told not to pay again and what to quote, and your log (area *Responses
  coming in*) has an error line with the payment.

## Not there yet

- The payment is not yet shown on the response in the Inbox or on its PDF; it
  is stored with the response.
- Refunds are made in your payment service's own dashboard.
- Other payment services need an adapter; the ones above are built in.
- An unpaid attempt, and the answers held with it, are removed after 48 hours.
