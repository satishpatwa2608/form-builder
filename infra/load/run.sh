#!/bin/bash
# Runs the load test (infra/load/load.mjs) against the API and database in containers held to the pilot server's
# size: a t4g.small has 2 processors and 2 GB, shared by the API, the worker and the database. Here the API (which
# also runs the jobs) gets 1 processor and 900 MB, the database 0.75 and 700 MB. Everything is removed at the end.
#   infra/load/run.sh [seconds of submissions] [clients] [records in the inbox]
set -euo pipefail
SECONDS_=${1:-60}
CLIENTS=${2:-20}
RECORDS=${3:-100000}
NET=fb-load
cleanup() { docker rm -f fb-load-api fb-load-mongo >/dev/null 2>&1 || true; docker network rm $NET >/dev/null 2>&1 || true; }
# KEEP=1 leaves the containers running afterwards, to look into what was found.
[ -n "${KEEP:-}" ] || trap cleanup EXIT
cleanup
# FB_LOAD_BASE=<an earlier API image>: no build (for when images cannot be fetched): this checkout's compiled code
# is put into that image instead. It needs the same dependencies as this checkout.
IMAGE=fb-api:load
MOUNTS=()
if [ -n "${FB_LOAD_BASE:-}" ]; then
  pnpm --filter @fb/engine --filter @fb/connectors --filter @fb/sdk --filter @fb/api build >/dev/null
  IMAGE=$FB_LOAD_BASE
  P=/app/node_modules/.pnpm
  MOUNTS=(-v "$PWD/apps/api/dist:/app/dist:ro" -v "$PWD/packages/engine/dist:$P/@fb+engine@file+packages+engine/node_modules/@fb/engine/dist:ro"
    -v "$PWD/packages/connectors/dist:$P/@fb+connectors@file+packages+connectors_@types+node@20.19.43/node_modules/@fb/connectors/dist:ro"
    -v "$PWD/packages/sdk/dist:$P/@fb+sdk@file+packages+sdk/node_modules/@fb/sdk/dist:ro")
else
  docker build --platform linux/arm64 -f infra/docker/api.Dockerfile -t fb-api:load . >/dev/null
fi
docker network create $NET >/dev/null
docker run -d --name fb-load-mongo --network $NET --cpus 0.75 --memory 700m -p 127.0.0.1:27300:27017 mongo:7 --wiredTigerCacheSizeGB 0.25 >/dev/null
for i in $(seq 1 60); do docker exec fb-load-mongo mongosh --quiet --eval 'db.runCommand({ping:1}).ok' 2>/dev/null | grep -q 1 && break; sleep 1; done
docker run -d --name fb-load-api --network $NET --cpus 1 --memory 900m -p 127.0.0.1:4300:4100 "${MOUNTS[@]}" \
  -e NODE_ENV=development -e MONGODB_URL=mongodb://fb-load-mongo:27017/form-builder -e JOBS_ROLE=all \
  -e JWT_SECRET="$(openssl rand -base64 48)" -e SECRET_KEY="$(openssl rand -base64 32)" \
  -e STORAGE_PROVIDER=local -e LOCAL_STORAGE_DIR=/tmp/files -e MAIL_PROVIDER=console -e FORM_WORKFLOW_SWEEP=false \
  "$IMAGE" >/dev/null
for i in $(seq 1 90); do curl -fsS -m 2 http://127.0.0.1:4300/health >/dev/null 2>&1 && break; sleep 1; done
node infra/load/load.mjs --api http://127.0.0.1:4300 --mongo mongodb://127.0.0.1:27300/form-builder --seconds "$SECONDS_" --clients "$CLIENTS" --records "$RECORDS" --out "${OUT:-/tmp/fb-load-results.json}"
echo "API memory at the end: $(docker stats --no-stream --format '{{.MemUsage}}' fb-load-api)"
