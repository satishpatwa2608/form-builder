#!/bin/bash
# Runs on the server. Brings the installation to the version given: reads its settings and secrets from the
# parameter store, pulls that version's images, and starts what changed.
#   deploy.sh <image tag>
set -euo pipefail
TAG="${1:?the image tag to run}"
cd /opt/fb
REGION=$(curl -s -H "X-aws-ec2-metadata-token: $(curl -s -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')" http://169.254.169.254/latest/meta-data/placement/region)
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGISTRY="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"

# Every setting under /fb-pilot/, secrets included, into a file only root can read.
umask 077
{
  aws ssm get-parameters-by-path --region "$REGION" --path /fb-pilot/ --with-decryption --query 'Parameters[].[Name,Value]' --output text | while IFS=$'\t' read -r name value; do echo "${name##*/}=$value"; done
  echo "AWS_REGION=$REGION"
  echo "REGISTRY=$REGISTRY"
  echo "TAG=$TAG"
} > .env

aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
docker compose pull --quiet
docker compose up -d --remove-orphans
# Old images take the disk a small server does not have.
docker image prune -af --filter "until=24h" >/dev/null || true
for i in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' fb-api-1 2>/dev/null)" = healthy ] && break
  [ "$i" = 60 ] && { echo "the API did not become healthy:"; docker compose logs --tail 40 api; exit 1; }
  sleep 3
done

# Customers' own code (ext-deployer.sh). A release makes new API and worker containers: put them back on each
# extension's network, and keep the service that runs what customers ask for.
chmod +x ext-deployer.sh
./ext-deployer.sh attach
cat > /etc/systemd/system/fb-ext-deployer.service <<'UNIT'
[Unit]
Description=Form Builder: runs the extensions customers deploy
After=docker.service
Requires=docker.service
[Service]
ExecStart=/opt/fb/ext-deployer.sh
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --quiet fb-ext-deployer
systemctl restart fb-ext-deployer
echo "running $TAG"; exit 0
