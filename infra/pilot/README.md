# Pilot installation: one server on AWS

A single small server running the whole product in Docker, for trying it with a first customer.
Not the production design (see `infra/terraform` and `docs/hosting.md`): one server is one point of failure.

## What exists (account 547878963606, region ap-south-1, all tagged `Project=form-builder-pilot`)

| Thing | Name | For |
|---|---|---|
| Server | `fb-pilot` (`t4g.small`, 2 GB, ARM, Amazon Linux 2023, 40 GB encrypted disk) | Everything: Caddy, API, worker, builder, form app, MongoDB |
| Fixed address | `13.234.208.44` | The three host names below point at it |
| Firewall | `fb-pilot-web` | Ports 80 and 443 only. There is no SSH: use Session Manager |
| Role | `fb-pilot-server` | The server's only access: its bucket, its key, sending mail, pulling its images, reading its settings |
| Bucket | `fb-pilot-547878963606-files` | Uploads and PDFs; `deploy/` (these files); `backups/` (kept 30 days) |
| Key | `alias/fb-pilot` (KMS) | Wraps connector credentials |
| Images | ECR `fb-api`, `fb-studio`, `fb-runtime` | Tagged with the git commit they were built from |
| Customers' images | ECR `fb-ext/<organisation id>`, one per customer, made when they first ask to push | Their own extension images; the last ten versions are kept |
| Push role | IAM `fb-pilot-ext-push` | Customers' push passwords are one-hour sessions of it, each narrowed to that customer's space. Only the server's role can take it |
| Build project | CodeBuild `fb-pilot-ext-build` (role `fb-pilot-ext-build`) | Builds a customer's extension from its linked repository, on a machine of its own per build. Its role can only write its log; the API hands each build what it needs. Charged per build minute, nothing when idle |
| Settings | Parameter store `/fb-pilot/*` | Host names, bucket, key, plan, sender address, and the two generated secrets |

Addresses (temporary names that resolve to the server's address; a real domain replaces them):

- Builder: https://app.13-234-208-44.sslip.io
- Forms: https://forms.13-234-208-44.sslip.io
- API: https://api.13-234-208-44.sslip.io

## Releasing a new version

On a Mac with Apple silicon (the server is ARM, so images built here run there as they are), with everything
committed:

```sh
infra/pilot/release.sh
```

It builds the current commit, pushes the three images (checking each arrived), copies the configuration
files, runs `deploy.sh` on the server and checks the API answers.

The builder and form app have their addresses built in, so a change of host names means building them again.

To go back to the version before: `infra/pilot/rollback.sh` (or `infra/pilot/rollback.sh <tag>`).

## Alerts

`infra/pilot/alerts.sh on <email>` emails that address when the server fails its checks, the API stops answering
or work waits over 10 minutes, a job gives up, or the processor stays above 90% (AWS sends a confirmation link
first). `off` / `resume` stop and restart the emails, `remove` takes it all away, `status` shows it. About
US$1.40 a month while it exists. The server reports its health once a minute (`health-metrics.sh`, by cron).

## Looking at it

`aws ssm start-session --profile formbuilder --region ap-south-1 --target i-08cd40934729c192b`, then
`cd /opt/fb && sudo docker compose ps` / `sudo docker compose logs -f api`.

## Customers

Sign-up is closed on the pilot (`/fb-pilot/SIGNUP=closed`) and new organisations start on the Free plan.
The addresses in `/fb-pilot/OPERATOR_EMAILS` see the **Customers** page, where each customer is added with the
plan bought and its owner invited. See "Who may start an organisation" in `docs/operations.md`.

## Customers' own code

A customer on a plan with extensions deploys its own code from **Extensions → Deploy your own code**
(`docs/extensions.md`). `EXT_REGISTRY` and `EXT_PUSH_ROLE_ARN` in the parameter store switch it on. The API
hands out the push password and writes the request down; `ext-deployer.sh`, the service `fb-ext-deployer` on
the server, is the only thing that starts a container. It keeps each extension's secret and running version
in `/opt/fb/ext/` (root only), and runs each on a network of its own with the API and the worker and no way
out: an extension here cannot call the internet or the customer's systems yet.

With `EXT_BUILD_PROJECT` set, customers can also link a repository and have it built for them: the API starts a
build in CodeBuild, the build asks the API (with a token for that one build) for the repository, the customer's
read-only key and a push sign-in, pushes the image, and reports back; the result is then deployed as above.
A build's full log is in CloudWatch, log group `/aws/codebuild/fb-pilot-ext-build`.

- What it is doing: `journalctl -u fb-ext-deployer -n 50`
- What is running: `docker ps --filter name=fb-ext-`
- A customer's output: `docker logs --tail 50 fb-ext-<first 8 of the organisation id>-main`

## Changing a setting

`aws ssm put-parameter --name /fb-pilot/<NAME> --value ... --overwrite`, then run `deploy.sh` with the current tag.

## Backups

`backup.sh` runs nightly (20:15 UTC) and writes the whole database to `backups/` in the bucket. Uploaded
files are already in the bucket, which keeps earlier versions. To restore: copy an archive to the server and
`docker compose exec -T mongo mongorestore --archive --gzip --drop < file`.

To check a backup really restores, without touching the server: `infra/pilot/restore-drill.sh` (see
docs/operations.md, "Getting it back").

## Taking it all away

Turn off termination protection on the server, terminate it, release the address, empty and delete the
bucket, delete the ECR repositories (the customers' `fb-ext/*` too), the build project and the roles (`fb-pilot-server`, `fb-pilot-ext-push`, `fb-pilot-ext-build`) and instance profile, the firewall group, the parameters, and
schedule the KMS key for deletion. Everything carries the tag `Project=form-builder-pilot`.
