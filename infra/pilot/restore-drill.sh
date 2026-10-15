#!/bin/bash
# The restore drill, run on the Mac from the repository root: the pilot's newest nightly backup (or the one named)
# restored into a clean, throwaway database, the product started on it, and checked. Everything it makes is removed
# at the end. Nothing on the pilot is touched.
#   infra/pilot/restore-drill.sh [form-builder-YYYY-MM-DDTHHMMZ.archive.gz]
#
# It starts the product with throwaway keys, so it proves the data comes back and the product runs on it, not
# that sealed values open: that needs the pilot's own SECRET_KEY and KMS key (docs/operations.md, "Keys"), and is
# done with someone who may handle them, by setting DRILL_SECRET_KEY and DRILL_KMS_KEY_ID before running this.
set -euo pipefail
A=(--profile formbuilder --region ap-south-1)
BUCKET=fb-pilot-547878963606-files
NAME=${1:-$(aws s3 ls "${A[@]}" s3://$BUCKET/backups/ | awk '{print $4}' | sort | tail -1)}
[ -n "$NAME" ] || { echo "no backup found"; exit 1; }
WORK=$(mktemp -d)
DB=fb-restore-drill
API_PID=
cleanup() {
  if [ -n "$API_PID" ]; then kill "$API_PID" 2>/dev/null || true; wait "$API_PID" 2>/dev/null || true; fi
  docker rm -f $DB >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
step() { printf '%-58s' "$1"; }
started=$(date +%s)

step "1. fetch $NAME"
aws s3 cp "${A[@]}" "s3://$BUCKET/backups/$NAME" "$WORK/backup.archive.gz" --only-show-errors
echo "$(du -h "$WORK/backup.archive.gz" | cut -f1)"

step "2. a clean database (mongo:7, throwaway)"
docker rm -f $DB >/dev/null 2>&1 || true
docker run -d --name $DB -p 127.0.0.1::27017 mongo:7 >/dev/null
PORT=$(docker port $DB 27017/tcp | head -1 | cut -d: -f2)
for i in $(seq 1 60); do docker exec $DB mongosh --quiet --eval 'db.runCommand({ping:1}).ok' 2>/dev/null | grep -q 1 && break; sleep 1; done
echo "port $PORT"

step "3. restore into it"
docker exec -i $DB mongorestore --quiet --archive --gzip < "$WORK/backup.archive.gz"
echo ok

step "4. what came back"
COUNTS=$(docker exec $DB mongosh --quiet form-builder --eval '
  const c = (n) => db.getCollection(n).countDocuments();
  print(JSON.stringify({ organisations: c("organizations"), users: c("users"), forms: c("forms"), responses: c("form_submissions"), timeline: c("form_record_events"), jobs: c("jobs") }));')
echo "$COUNTS"
echo "$COUNTS" | grep -q '"organisations":[1-9]' || { echo "no organisations came back"; exit 1; }

step "5. the product started on it"
pnpm --filter @fb/api build >/dev/null
API_PORT=4199
(cd apps/api && env -i PATH="$PATH" HOME="$HOME" NODE_ENV=development PORT=$API_PORT \
  MONGODB_URL="mongodb://127.0.0.1:$PORT/form-builder" JOBS_ROLE=enqueue FORM_WORKFLOW_SWEEP=false \
  JWT_SECRET="$(openssl rand -base64 48)" SECRET_KEY="${DRILL_SECRET_KEY:-$(openssl rand -base64 32)}" ${DRILL_KMS_KEY_ID:+KMS_KEY_ID=$DRILL_KMS_KEY_ID AWS_PROFILE=formbuilder} \
  node dist/main.js > "$WORK/api.log" 2>&1) &
API_PID=$!
for i in $(seq 1 60); do curl -fsS -m 2 "http://127.0.0.1:$API_PORT/health" -o "$WORK/health.json" 2>/dev/null && break; sleep 1; done
grep -q '"database":"ok"' "$WORK/health.json" || { echo "the product did not come up"; tail -20 "$WORK/api.log"; exit 1; }
echo "$(cat "$WORK/health.json" | head -c 160)"

step "6. a published form opens as the public sees it"
FORM=$(docker exec $DB mongosh --quiet form-builder --eval '
  const f = db.forms.findOne({ status: "PUBLISHED", isDeleted: false, "definition.access": "PUBLIC", "definition.opensAt": { $exists: false }, "definition.closesAt": { $exists: false } });
  print(f ? `${f.orgId} ${f.code}` : "");')
set -- $FORM
[ -n "${2:-}" ] || { echo "no published form in the backup"; exit 1; }
STATUS=$(curl -s -o "$WORK/form.json" -w '%{http_code}' "http://127.0.0.1:$API_PORT/public/forms/$2?org=$1")
[ "$STATUS" = 200 ] || { echo "form $2 answered $STATUS"; exit 1; }
echo "$2: $(grep -o '"name":"[^"]*"' "$WORK/form.json" | head -1)"

echo "restore drill passed in $(( $(date +%s) - started ))s: $NAME"
