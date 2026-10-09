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
| Settings | Parameter store `/fb-pilot/*` | Host names, bucket, key, plan, sender address, and the two generated secrets |

Addresses (temporary names that resolve to the server's address; a real domain replaces them):

- Builder: https://app.13-234-208-44.sslip.io
- Forms: https://forms.13-234-208-44.sslip.io
- API: https://api.13-234-208-44.sslip.io

## Releasing a new version

On a Mac with Apple silicon (the server is ARM, so images built here run there as they are):

```sh
R=547878963606.dkr.ecr.ap-south-1.amazonaws.com; H=13-234-208-44.sslip.io; TAG=$(git rev-parse --short HEAD)
aws ecr get-login-password --profile formbuilder --region ap-south-1 | docker login --username AWS --password-stdin $R
docker build -f infra/docker/api.Dockerfile -t $R/fb-api:$TAG . && docker push $R/fb-api:$TAG
for app in studio runtime; do
  docker build -f infra/docker/web.Dockerfile --build-arg APP=$app --build-arg VITE_API_URL=https://api.$H \
    --build-arg VITE_STUDIO_URL=https://app.$H --build-arg VITE_RUNTIME_URL=https://forms.$H -t $R/fb-$app:$TAG . && docker push $R/fb-$app:$TAG
done
aws ssm send-command --profile formbuilder --region ap-south-1 --instance-ids i-08cd40934729c192b \
  --document-name AWS-RunShellScript --parameters "commands=['/opt/fb/deploy.sh $TAG']"
```

The builder and form app have their addresses built in, so a change of host names means building them again.
Changed `compose.yml`, `Caddyfile` or a script: copy it to `s3://fb-pilot-547878963606-files/deploy/` and run
`aws s3 sync s3://fb-pilot-547878963606-files/deploy/ /opt/fb/` on the server before `deploy.sh`.

## Looking at it

`aws ssm start-session --profile formbuilder --region ap-south-1 --target i-08cd40934729c192b`, then
`cd /opt/fb && sudo docker compose ps` / `sudo docker compose logs -f api`.

## Customers

Sign-up is closed on the pilot (`/fb-pilot/SIGNUP=closed`) and new organisations start on the Free plan.
The addresses in `/fb-pilot/OPERATOR_EMAILS` add each customer from **Account → Add a customer** with the
plan bought. See "Who may start an organisation" in `docs/operations.md`.

## Changing a setting

`aws ssm put-parameter --name /fb-pilot/<NAME> --value ... --overwrite`, then run `deploy.sh` with the current tag.

## Backups

`backup.sh` runs nightly (20:15 UTC) and writes the whole database to `backups/` in the bucket. Uploaded
files are already in the bucket, which keeps earlier versions. To restore: copy an archive to the server and
`docker compose exec -T mongo mongorestore --archive --gzip --drop < file`.

## Taking it all away

Turn off termination protection on the server, terminate it, release the address, empty and delete the
bucket, delete the ECR repositories, the role and instance profile, the firewall group, the parameters, and
schedule the KMS key for deletion. Everything carries the tag `Project=form-builder-pilot`.
