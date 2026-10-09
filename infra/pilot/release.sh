#!/bin/bash
# Run on the Mac, from the repository root: builds the current commit, pushes it, and runs it on the pilot server.
#   infra/pilot/release.sh
set -euo pipefail
A=(--profile formbuilder --region ap-south-1)
R=547878963606.dkr.ecr.ap-south-1.amazonaws.com
SERVER=i-08cd40934729c192b
H=$(aws ssm get-parameter "${A[@]}" --name /fb-pilot/APP_HOST --query Parameter.Value --output text); H=${H#app.}
TAG=$(git rev-parse --short HEAD)
[ -z "$(git status --porcelain)" ] || { echo "There are uncommitted changes: a release is of a commit."; exit 1; }

aws ecr get-login-password "${A[@]}" | docker login --username AWS --password-stdin $R >/dev/null
docker build --platform linux/arm64 -f infra/docker/api.Dockerfile -t $R/fb-api:$TAG . >/dev/null
for app in studio runtime; do
  docker build --platform linux/arm64 -f infra/docker/web.Dockerfile --build-arg APP=$app --build-arg VITE_API_URL=https://api.$H \
    --build-arg VITE_STUDIO_URL=https://app.$H --build-arg VITE_RUNTIME_URL=https://forms.$H -t $R/fb-$app:$TAG . >/dev/null
done
# A push can fail quietly through Docker Desktop's proxy: each is checked, and tried again.
for i in api studio runtime; do
  for try in 1 2 3; do
    docker push $R/fb-$i:$TAG >/dev/null 2>&1 || true
    aws ecr describe-images "${A[@]}" --repository-name fb-$i --query 'imageDetails[].imageTags[]' --output text | tr '\t' '\n' | grep -qx "$TAG" && break
    [ $try = 3 ] && { echo "fb-$i:$TAG did not reach the image store"; exit 1; }
  done
done

for f in compose.yml Caddyfile deploy.sh backup.sh; do aws s3 cp "${A[@]}" infra/pilot/$f s3://fb-pilot-547878963606-files/deploy/$f --only-show-errors; done
CID=$(aws ssm send-command "${A[@]}" --instance-ids $SERVER --document-name AWS-RunShellScript --timeout-seconds 900 \
  --parameters "commands=['cd /opt/fb && aws s3 sync s3://fb-pilot-547878963606-files/deploy/ /opt/fb/ --only-show-errors && chmod +x deploy.sh backup.sh && ./deploy.sh $TAG 2>&1 | tail -3']" --query Command.CommandId --output text)
for i in $(seq 1 100); do
  ST=$(aws ssm get-command-invocation "${A[@]}" --command-id "$CID" --instance-id $SERVER --query Status --output text 2>/dev/null || true)
  case "$ST" in Success|Failed|TimedOut|Cancelled) break;; esac; sleep 3
done
aws ssm get-command-invocation "${A[@]}" --command-id "$CID" --instance-id $SERVER --query StandardOutputContent --output text | tail -2
[ "$ST" = Success ] || { echo "the release did not finish: $ST"; exit 1; }
curl -fsS -m 20 -o /dev/null "https://api.$H/health" && echo "released $TAG: https://app.$H"
