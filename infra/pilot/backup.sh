#!/bin/bash
# Runs on the server each night: the whole database, compressed, into the bucket under backups/.
# The bucket keeps old versions; a rule on it removes backups after 30 days.
set -euo pipefail
cd /opt/fb
# Two values from the settings file (it is not a shell script: other values hold spaces and brackets).
UPLOADS_BUCKET=$(grep '^UPLOADS_BUCKET=' .env | cut -d= -f2-)
AWS_REGION=$(grep '^AWS_REGION=' .env | cut -d= -f2-)
docker compose exec -T mongo mongodump --quiet --archive --gzip --db form-builder | aws s3 cp - "s3://$UPLOADS_BUCKET/backups/form-builder-$(date -u +%Y-%m-%dT%H%MZ).archive.gz" --region "$AWS_REGION" --only-show-errors
echo "backup done $(date -u +%FT%TZ)"
