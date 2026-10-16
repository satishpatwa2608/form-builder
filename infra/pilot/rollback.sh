#!/bin/bash
# Run on the Mac: puts the pilot back on the version released before the one running now (or on the tag given).
# The images are still in the image store, so nothing is built: the server runs deploy.sh with the older tag.
#   infra/pilot/rollback.sh [image tag]
# The database is not rolled back: versions only add to what is stored, so an older version reads it as before.
set -euo pipefail
A=(--profile formbuilder --region ap-south-1)
SERVER=i-08cd40934729c192b
H=$(aws ssm get-parameter "${A[@]}" --name /fb-pilot/APP_HOST --query Parameter.Value --output text); H=${H#app.}

# What runs on the server now, and the commands to run there.
run() {
  local cid st
  cid=$(aws ssm send-command "${A[@]}" --instance-ids $SERVER --document-name AWS-RunShellScript --timeout-seconds 900 --parameters "commands=['$1']" --query Command.CommandId --output text)
  for i in $(seq 1 100); do
    st=$(aws ssm get-command-invocation "${A[@]}" --command-id "$cid" --instance-id $SERVER --query Status --output text 2>/dev/null || true)
    case "$st" in Success|Failed|TimedOut|Cancelled) break;; esac; sleep 3
  done
  aws ssm get-command-invocation "${A[@]}" --command-id "$cid" --instance-id $SERVER --query StandardOutputContent --output text
  [ "$st" = Success ]
}
NOW=$(run "grep ^TAG= /opt/fb/.env | cut -d= -f2" | tr -d '[:space:]')

# The newest tag before it that all three images have.
# Every tag, oldest image first: an image that did not change between two versions carries both their tags.
tags() { aws ecr describe-images "${A[@]}" --repository-name "fb-$1" --query 'sort_by(imageDetails,&imagePushedAt)[].imageTags[]' --output text < /dev/null | tr '\t' '\n' | grep -v None; }
if [ -n "${1:-}" ]; then
  TO=$1
else
  TO=$(tags api | grep -B1000 -x "$NOW" | grep -vx "$NOW" | tail -r 2>/dev/null | while read -r t; do tags studio | grep -qx "$t" && tags runtime | grep -qx "$t" && { echo "$t"; break; }; done)
fi
[ -n "$TO" ] || { echo "no earlier version to go back to (running $NOW)"; exit 1; }
for app in api studio runtime; do tags $app | grep -qx "$TO" || { echo "fb-$app:$TO is not in the image store"; exit 1; }; done

echo "running $NOW; moving to $TO"
run "cd /opt/fb && ./deploy.sh $TO 2>&1 | tail -2" | tail -2
curl -fsS -m 20 -o /dev/null "https://api.$H/health" && echo "now running $TO: https://app.$H"
