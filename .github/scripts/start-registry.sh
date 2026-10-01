#!/usr/bin/env bash
# Starts the registry with `wrangler dev` in the background, using the test configuration (user
# "hello", password "world"), and waits until it answers.
#
#   start-registry.sh PORT STATE_DIR
set -euo pipefail
port=$1
state=$2
mkdir -p "$state"

WRANGLER_SEND_METRICS=false nohup pnpm exec wrangler dev --config test/wrangler.test.jsonc --env dev \
  --ip 127.0.0.1 --port "$port" --inspector-port 0 --persist-to "$state/r2" >"$state/wrangler.log" 2>&1 &
echo $! >"$state/wrangler.pid"

for _ in $(seq 1 120); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/v2/")" = "401" ]; then
    echo "registry is up on port $port"
    exit 0
  fi
  sleep 1
done

echo "registry did not start" >&2
cat "$state/wrangler.log" >&2
exit 1
