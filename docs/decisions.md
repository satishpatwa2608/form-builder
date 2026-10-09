# Decisions taken on 9 October 2026

These were open questions. The owner asked for all of them to be done, so each
was decided as below. Every one can be changed; what changing it would cost is
noted.

## 1. Where the code lives

**Not done: it needs access only the owner has.** This machine has no GitHub
command-line tool and no key that GitHub accepts, so no remote could be
created or pushed to.

What was done instead:

- `main` now holds all the work (the feature branches were stacked in a line
  and are all contained in it).
- A complete copy of the repository is kept outside the project folder, in
  `~/Documents/form-builder-backup/`, as git bundles. Restore one with
  `git clone <file>.bundle`.

To finish: create an empty **private** repository, then
`git remote add origin <url> && git push -u origin main`. CI
(`.github/workflows/ci.yml`) runs on the first push; it has never run.

## 2. AWS account and infrastructure tooling

**Tooling decided: Terraform. Account: not created (only the owner can).**

- The credentials on this machine belong to an IAM user called `s3-user` in an
  existing account. They are not for provisioning and were not used. Nothing
  was created in any AWS account.
- `infra/terraform/` describes the production deployment: a network with one
  fixed outbound address, the API and worker on ECS Fargate behind a load
  balancer, the web apps on S3 and CloudFront, the uploads bucket, a KMS key,
  secrets, and customers' extensions as locked-down services with no route
  out. It mirrors what `infra/stack.mjs` does on Docker, which is tested.
- It passes `terraform validate` and `terraform fmt`. **It has never been
  applied**, so expect to fix things on the first real run.
- Why Terraform and not AWS CDK: it is the more widely known of the two, it is
  not tied to one programming language, and the state it keeps is easy to
  inspect. Changing later means rewriting about 700 lines.

Still the owner's: a separate AWS account for this product (recommended, apart
from Sangam), MongoDB Atlas, domain names, and the certificates.

## 3. PDF engine

**pdfkit, with Noto Sans fonts. No browser on the server.**

- A headless browser would draw any HTML, but costs several hundred megabytes
  and a lot of memory per worker, and turns what people type into something a
  browser interprets. pdfkit draws text as text and nothing else.
- Measured: 1,000 documents in about 50 seconds on a developer machine.
- Limits accepted for now: the layout is the built-in one with a few settings
  per form, not a designed template; scripts covered are Latin and Devanagari.
- Changing engine later affects one file (`apps/api/src/documents/submission-pdf.ts`).

## 4. How fragments behave

- A fragment on a form is an ordinary section whose fields are a **copy** of
  the library's. The copy is refreshed when a draft is opened in the builder
  and when the form is published. A live form is never changed.
- Its fields cannot be edited on the form. An admin changes the fragment from
  any form that uses it and saves it back.
- **Used twice on one form, each copy gets a prefix**, and its answers are
  stored as `prefix_field` (for example `shipping_city`). The second copy is
  given a prefix automatically.
- A fragment in use cannot be deleted. A form sent to another organisation
  keeps the fields as its own.

## 5. How review before publish behaves

- **Advice by default.** An organisation can make it a rule in its settings.
- When it is a rule: a form is published or scheduled only once approved; the
  approver must be someone other than the person who asked and the person who
  last changed it; any change after approval needs a new review.
- Comments can be about the form or one field, and never block publishing.
- **No email is sent** when a review is asked for. The Forms list shows what
  is waiting. Adding email is small once mail is live.

## 6. Custom field types

**Built as recommended: the customer's page in a sandboxed frame.**

- The page gets an origin of its own and no network at all, so it cannot read
  the form, a session or storage, or send what is typed anywhere.
- Its answer is text (up to 10,000 characters). Anything richer is stored as
  JSON text; a check in the extension can judge it.
- The server keeps a copy of each page (up to 200 KB) when it reads the
  extension, so forms do not depend on the customer's container being up.
- Cost of this choice: a custom field cannot load libraries or images from
  the internet; everything must be inside the page.

## 7. Other choices made along the way

- **Plans:** extensions are not included on Free and Team, one on Business,
  unlimited on Enterprise. Placeholder numbers, like every other limit.
- **A PDF of each response** is off by default per form (it is made on first
  request instead), to avoid storing documents nobody asked for.
- **The PDF button downloads** the file. Opening it in a new tab from memory
  is something browsers refuse.
