#!/bin/bash
# Runs on the server every minute (cron, put there by alerts.sh): asks the API's /health through the public
# address, as a visitor would, and reports two numbers to CloudWatch for the alerts:
#   ApiUp               1 when it answers ok and no due job has waited over 10 minutes, else 0
#   FailedJobsLastHour  jobs that gave up in the last hour
set -u
cd /opt/fb
HOST=$(grep '^APP_HOST=' .env | cut -d= -f2-); HOST=${HOST#app.}
REGION=$(grep '^AWS_REGION=' .env | cut -d= -f2-)
BODY=$(curl -fsS -m 15 "https://api.$HOST/health" 2>/dev/null || true)
UP=0; FAILED=0
if echo "$BODY" | grep -q '"status":"ok"'; then
  WAIT=$(echo "$BODY" | grep -o '"oldestWaitingJobSeconds":[0-9]*' | cut -d: -f2)
  [ "${WAIT:-0}" -le 600 ] && UP=1
  FAILED=$(echo "$BODY" | grep -o '"failedJobsLastHour":[0-9]*' | cut -d: -f2)
fi
aws cloudwatch put-metric-data --region "$REGION" --namespace FormBuilder/Pilot \
  --metric-data "MetricName=ApiUp,Value=$UP,Unit=Count" "MetricName=FailedJobsLastHour,Value=${FAILED:-0},Unit=Count"
