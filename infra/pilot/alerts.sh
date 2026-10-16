#!/bin/bash
# Email alerts for the pilot, run on the Mac:
#   infra/pilot/alerts.sh on <email>   create them (AWS emails a confirmation link: click it once)
#   infra/pilot/alerts.sh off          stop the emails (the alerts stay, at the same small cost)
#   infra/pilot/alerts.sh resume       start the emails again
#   infra/pilot/alerts.sh remove       take everything away (no further cost)
#   infra/pilot/alerts.sh status       what is set up, and whether each alert is firing
# What it alerts on: the server failing its health checks; the API not answering, or work waiting over 10 minutes,
# for 5 minutes; any job giving up (in an hour); the processor above 90% for 15 minutes.
# Cost (ap-south-1): 4 alarms, 2 custom metrics sent once a minute, about US$1.40 a month. SNS email is free here.
set -euo pipefail
A=(--profile formbuilder --region ap-south-1)
SERVER=i-08cd40934729c192b
ROLE=fb-pilot-server
NS=FormBuilder/Pilot
ALARMS=(fb-pilot-server-down fb-pilot-api-down fb-pilot-jobs-failing fb-pilot-cpu-high)
TAG=(--tags Key=Project,Value=form-builder-pilot)
topic() { aws sns list-topics "${A[@]}" --query "Topics[?ends_with(TopicArn, ':fb-pilot-alerts')].TopicArn" --output text; }
on_server() {
  local cid st
  cid=$(aws ssm send-command "${A[@]}" --instance-ids $SERVER --document-name AWS-RunShellScript --parameters "$(python3 -c 'import json,sys; print(json.dumps({"commands":[sys.argv[1]]}))' "$1")" --query Command.CommandId --output text)
  for i in $(seq 1 40); do st=$(aws ssm get-command-invocation "${A[@]}" --command-id "$cid" --instance-id $SERVER --query Status --output text 2>/dev/null || true); case "$st" in Success|Failed|TimedOut|Cancelled) break;; esac; sleep 3; done
  [ "$st" = Success ] || { echo "on the server: $st"; exit 1; }
}

case "${1:-status}" in
  on)
    EMAIL=${2:?the email address the alerts go to}
    T=$(topic); [ -n "$T" ] || T=$(aws sns create-topic "${A[@]}" --name fb-pilot-alerts "${TAG[@]}" --query TopicArn --output text)
    # Once per address: subscribing again would send another confirmation email.
    aws sns list-subscriptions-by-topic "${A[@]}" --topic-arn "$T" --query 'Subscriptions[].Endpoint' --output text | tr '\t' '\n' | grep -qx "$EMAIL" \
      || aws sns subscribe "${A[@]}" --topic-arn "$T" --protocol email --notification-endpoint "$EMAIL" >/dev/null
    # The server may send these two numbers, and nothing else, to CloudWatch.
    aws iam put-role-policy "${A[@]}" --role-name $ROLE --policy-name fb-pilot-health-metrics --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"cloudwatch:PutMetricData\",\"Resource\":\"*\",\"Condition\":{\"StringEquals\":{\"cloudwatch:namespace\":\"$NS\"}}}]}"
    sleep 15 # a new permission takes a few seconds to reach the server
    aws s3 cp "${A[@]}" infra/pilot/health-metrics.sh s3://fb-pilot-547878963606-files/deploy/health-metrics.sh --only-show-errors
    on_server "aws s3 cp s3://fb-pilot-547878963606-files/deploy/health-metrics.sh /opt/fb/health-metrics.sh --only-show-errors && chmod +x /opt/fb/health-metrics.sh && echo '* * * * * root /opt/fb/health-metrics.sh >/dev/null 2>&1' > /etc/cron.d/fb-health-metrics && /opt/fb/health-metrics.sh"
    common=(--alarm-actions "$T" --ok-actions "$T" "${TAG[@]}")
    aws cloudwatch put-metric-alarm "${A[@]}" --alarm-name fb-pilot-server-down --alarm-description "The pilot server is failing its health checks" --namespace AWS/EC2 --metric-name StatusCheckFailed --dimensions Name=InstanceId,Value=$SERVER --statistic Maximum --period 60 --evaluation-periods 3 --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold "${common[@]}"
    aws cloudwatch put-metric-alarm "${A[@]}" --alarm-name fb-pilot-api-down --alarm-description "The pilot API is not answering, or work has waited over 10 minutes" --namespace $NS --metric-name ApiUp --statistic Minimum --period 60 --evaluation-periods 5 --threshold 1 --comparison-operator LessThanThreshold --treat-missing-data breaching "${common[@]}"
    aws cloudwatch put-metric-alarm "${A[@]}" --alarm-name fb-pilot-jobs-failing --alarm-description "Background work on the pilot is giving up (see Work that failed)" --namespace $NS --metric-name FailedJobsLastHour --statistic Maximum --period 300 --evaluation-periods 1 --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold --treat-missing-data notBreaching "${common[@]}"
    aws cloudwatch put-metric-alarm "${A[@]}" --alarm-name fb-pilot-cpu-high --alarm-description "The pilot server's processor has been above 90% for 15 minutes" --namespace AWS/EC2 --metric-name CPUUtilization --dimensions Name=InstanceId,Value=$SERVER --statistic Average --period 300 --evaluation-periods 3 --threshold 90 --comparison-operator GreaterThanThreshold "${common[@]}"
    echo "Alerts are on. AWS has emailed $EMAIL a confirmation link: click it, or no alert reaches you."
    ;;
  off) aws cloudwatch disable-alarm-actions "${A[@]}" --alarm-names "${ALARMS[@]}"; echo "Alert emails stopped (resume with: alerts.sh resume)." ;;
  resume) aws cloudwatch enable-alarm-actions "${A[@]}" --alarm-names "${ALARMS[@]}"; echo "Alert emails resumed." ;;
  remove)
    aws cloudwatch delete-alarms "${A[@]}" --alarm-names "${ALARMS[@]}"
    on_server "rm -f /etc/cron.d/fb-health-metrics /opt/fb/health-metrics.sh"
    aws iam delete-role-policy "${A[@]}" --role-name $ROLE --policy-name fb-pilot-health-metrics 2>/dev/null || true
    T=$(topic); [ -n "$T" ] && aws sns delete-topic "${A[@]}" --topic-arn "$T"
    echo "Alerts removed: nothing of them is left, and they cost nothing more."
    ;;
  status)
    aws cloudwatch describe-alarms "${A[@]}" --alarm-names "${ALARMS[@]}" --query 'MetricAlarms[].[AlarmName,StateValue,ActionsEnabled]' --output table
    T=$(topic); [ -n "$T" ] && aws sns list-subscriptions-by-topic "${A[@]}" --topic-arn "$T" --query 'Subscriptions[].[Endpoint,SubscriptionArn]' --output table || echo "No alert topic."
    ;;
  *) echo "usage: alerts.sh on <email> | off | resume | remove | status"; exit 2 ;;
esac
