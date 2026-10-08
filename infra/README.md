# Infrastructure

AWS `ap-south-1` (Mumbai). Planned (docs/plan.md, section 2):

- ECS Fargate services: api, worker, studio (static), runtime (static behind CloudFront)
- MongoDB Atlas (Mumbai), S3 (uploads), SQS (jobs), SES (mail), CloudWatch (logs/metrics)
- KMS: envelope encryption of connector credentials; Secrets Manager for platform secrets
- NAT gateway with one fixed outbound IP that customers allow-list
- Separate AWS accounts for stage and prod

Nothing is provisioned yet (by design: no AWS resources are created without the account decision below).

## Email (SES) - to do once the AWS account is chosen

1. Verify the sending domain in SES (ap-south-1) with Easy DKIM; publish the DKIM CNAMEs and an SPF/DMARC record.
2. Request production access (SES starts in the sandbox: only verified recipients).
3. Give the api task role `ses:SendEmail` limited to that identity; no access keys.
4. Set `MAIL_PROVIDER=ses` and `MAIL_FROM="Form Builder <no-reply@your-domain>"`.

## Decisions needed before provisioning

- Which AWS account/organisation hosts the product (a new one, separate from Sangam, is recommended).
- Domain names for studio, runtime (public forms) and API.
- Terraform or AWS CDK (Terraform is not installed on the dev machine yet).
- How customer custom domains get TLS: CloudFront + ACM certificate per host (automated), or an edge proxy with on-demand TLS (e.g. Caddy) that checks `GET /public/domains/:host`. See docs/operations.md.
- One API instance at first, or sticky routing for gateway WebSockets; background jobs move to `apps/worker` + SQS before running several instances.
- Billing provider (Razorpay for India, Stripe for international) and the plan prices/limits.
