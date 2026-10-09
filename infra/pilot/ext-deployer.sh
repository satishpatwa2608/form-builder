#!/bin/bash
# Runs on the server, as the service fb-ext-deployer (deploy.sh installs it). Customers ask in the builder for a
# version of their own code to run; this is the one thing that runs it. The API only writes the request down and
# never touches Docker; this script takes each request through the API's `extension` command, runs the image
# locked down on a network of its own, and reports how it went.
#   ext-deployer.sh           the service: waits for requests
#   ext-deployer.sh attach    puts the API and the worker back on every extension's network (after a release)
set -uo pipefail
cd /opt/fb
STATE=/opt/fb/ext
mkdir -p "$STATE" && chmod 700 "$STATE"
API=fb-api-1
WORKER=fb-worker-1
REGISTRY=$(sed -n 's/^REGISTRY=//p' .env)
REGION=$(sed -n 's/^AWS_REGION=//p' .env)
# What a customer's code may not do, whatever its image says: write to its disk, gain privileges, run as root,
# or take more than its share of a small server.
LOCKED=(--read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges --user 1000:1000)
LIMITS=(--memory 256m --cpus 0.5 --pids-limit 128 --log-opt max-size=5m --log-opt max-file=2)

op() { docker exec -i "$API" node dist/cli/extension.js "$@"; }
attach() {
  for c in "$API" "$WORKER"; do
    docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$c" 2>/dev/null | tr ' ' '\n' | grep -qx "$1" || docker network connect "$1" "$c" 2>/dev/null || true
  done
}
detach() {
  for c in "$API" "$WORKER"; do docker network disconnect -f "$1" "$c" >/dev/null 2>&1 || true; done
  docker network rm "$1" >/dev/null 2>&1 || true
}
if [ "${1:-}" = attach ]; then
  for f in "$STATE"/*.state; do [ -f "$f" ] && attach "$(basename "$f" .state)"; done
  exit 0
fi

# Requests waiting, and any left half done when this service last stopped (the command closes those).
waiting() {
  docker exec fb-mongo-1 mongosh --quiet form-builder --eval 'print(db.extension_deploys.countDocuments({$or:[{status:"PENDING"},{status:"RUNNING",updatedAt:{$lt:new Date(Date.now()-600000)}}]}))' 2>/dev/null | tail -1
}

job() (
  ID=$1 KIND=$2 ORG=$3 IMAGE=$4
  done_() { printf '%s' "${3:-}" | op deploy-done "$ID" "$1" "$2" >/dev/null 2>&1; exit 0; }
  [[ "$ORG" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || done_ FAILED "The request was not one this installation can run."
  # One name for the container, its network and its files: the address the API was told to call it at.
  C="fb-ext-${ORG:0:8}-main"
  ENVF="$STATE/$C.env" ST="$STATE/$C.state"
  run() {
    docker rm -f "$C" >/dev/null 2>&1
    docker run -d --name "$C" --restart unless-stopped --network "$C" --env-file "$ENVF" -e PORT=8080 "${LOCKED[@]}" "${LIMITS[@]}" "$1" >/dev/null 2>&1
  }
  healthy() {
    for _ in $(seq 1 60); do
      # Asked from the API's side: it is the API that must be able to reach it.
      docker exec "$API" node -e "fetch('http://$C:8080/fb/health',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null && return 0
      sleep 0.5
    done
    return 1
  }

  if [ "$KIND" = REMOVE ]; then
    [ -f "$ST" ] || done_ FAILED "There is no extension of yours running here."
    REF=$(sed -n 's/^REF=//p' "$ST")
    op remove "$ORG" "$REF" >/dev/null 2>&1 </dev/null
    docker rm -f "$C" >/dev/null 2>&1
    detach "$C"
    rm -f "$ENVF" "$ST"
    done_ REMOVED "The extension was removed. Forms that used it must be changed before they can be published again."
  fi

  TAG_RE='[A-Za-z0-9][A-Za-z0-9._-]{0,99}'
  [[ "$IMAGE" =~ ^${REGISTRY//./\\.}/fb-ext/$ORG:$TAG_RE$ ]] || done_ FAILED "The request was not one this installation can run."
  VERSION=${IMAGE##*:}
  aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null 2>&1
  timeout 600 docker pull -q "$IMAGE" >/dev/null 2>&1 || done_ FAILED "Version $VERSION could not be fetched from your image space. Push it again and ask once more."
  BUILT=$(docker image inspect -f '{{.Os}}/{{.Architecture}}' "$IMAGE")
  [ "$BUILT" = linux/arm64 ] || done_ FAILED "Version $VERSION was built for $BUILT, and this server is linux/arm64. Build it with: docker build --platform linux/arm64"
  [ "$(docker image inspect -f '{{.Size}}' "$IMAGE")" -lt 1073741824 ] || done_ FAILED "Version $VERSION is larger than 1 GB. Leave out what the running code does not need."

  # First time: a network only this container, the API and the worker are on, with no way out, and the secret they share.
  docker network inspect "$C" >/dev/null 2>&1 || docker network create --internal "$C" >/dev/null
  attach "$C"
  if [ ! -f "$ST" ]; then
    OUT=$(op install "$ORG" "http://$C:8080" 2>&1 </dev/null)
    REF=$(sed -n 's/^Installed as \([a-z0-9]\{8\}\)\..*/\1/p' <<<"$OUT")
    SECRET=$(sed -n 's/^ *FB_EXTENSION_SECRET=//p' <<<"$OUT")
    if [ -z "$REF" ] || [ -z "$SECRET" ]; then
      detach "$C"
      done_ FAILED "$(tail -1 <<<"$OUT")"
    fi
    (umask 077; printf 'FB_EXTENSION_SECRET=%s\nFB_ORG_ID=%s\n' "$SECRET" "$ORG" > "$ENVF"; printf 'REF=%s\nIMAGE=\n' "$REF" > "$ST")
  fi
  REF=$(sed -n 's/^REF=//p' "$ST")
  BEFORE=$(sed -n 's/^IMAGE=//p' "$ST")
  back() {
    if [ -n "$BEFORE" ]; then run "$BEFORE"; healthy && op sync "$ORG" "$REF" >/dev/null 2>&1 </dev/null; else docker rm -f "$C" >/dev/null 2>&1; fi
  }

  # Replace the running version; go back to it if the new one does not answer or cannot say what it offers.
  run "$IMAGE"
  if ! healthy; then
    LOGS=$(docker logs --tail 40 "$C" 2>&1)
    back
    done_ FAILED "Version $VERSION did not start${BEFORE:+; the previous one is running again}." "$LOGS"
  fi
  if ! OFFERS=$(op sync "$ORG" "$REF" 2>&1 </dev/null); then
    LOGS=$(docker logs --tail 40 "$C" 2>&1)
    back
    done_ FAILED "Version $VERSION started but what it offers could not be read${BEFORE:+; the previous one is running again}: $(tail -1 <<<"$OFFERS")" "$LOGS"
  fi
  (umask 077; printf 'REF=%s\nIMAGE=%s\n' "$REF" "$IMAGE" > "$ST")
  done_ LIVE "Version $VERSION is running. $(tail -1 <<<"$OFFERS")"
)

echo "waiting for deployments"
while true; do
  if [ "$(waiting)" != 0 ] && [ -n "$(waiting)" ]; then
    NEXT=$(op deploy-next 2>/dev/null </dev/null)
    if [ -n "$NEXT" ]; then
      ID=$(sed -n 's/^ID=//p' <<<"$NEXT") KIND=$(sed -n 's/^KIND=//p' <<<"$NEXT") ORG=$(sed -n 's/^ORG=//p' <<<"$NEXT") IMAGE=$(sed -n 's/^IMAGE=//p' <<<"$NEXT")
      echo "$(date -u +%FT%TZ) $KIND $ORG ${IMAGE##*:}"
      job "$ID" "$KIND" "$ORG" "$IMAGE"
    fi
  fi
  sleep 5
done
