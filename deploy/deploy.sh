#!/usr/bin/env bash
# Deploy the EnDesk relay and download page from a git archive on stdin:
#
#   git archive --format=tar HEAD | ssh <server> "sudo /opt/endesk/deploy.sh $(git rev-parse --short HEAD)"
#
# Health-checks the relay and rolls back to the previous release on failure.
set -euo pipefail

NAME=${1:?usage: deploy.sh <release-name>}
BASE=/opt/endesk
PORT=$(sed -n 's/^PORT=//p' /etc/endesk/relay.env)
REL=$BASE/releases/$(date +%Y%m%d%H%M%S)-$NAME

mkdir -p "$REL"
tar -x -C "$REL" -f - server deploy/site-src
(cd "$REL/server" && PATH="$BASE/node/bin:$PATH" npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
chown -R root:root "$REL"
chmod -R a+rX,go-w "$REL"

prev=$(readlink -f "$BASE/current" 2>/dev/null || true)
switch() { ln -sfn "$1" "$BASE/current.new" && mv -T "$BASE/current.new" "$BASE/current"; }

switch "$REL"
systemctl restart endesk-relay

healthy() {
  for _ in $(seq 1 20); do
    curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}

if ! healthy; then
  echo "relay failed its health check" >&2
  journalctl -u endesk-relay -n 20 --no-pager >&2 || true
  if [ -n "$prev" ] && [ -d "$prev" ]; then
    switch "$prev"
    systemctl restart endesk-relay
    echo "rolled back to $prev" >&2
  fi
  exit 1
fi

# Website: build the static pages and copy them over (downloads/ is left alone).
"$BASE/node/bin/node" "$REL/deploy/site-src/build.js" "$REL/site"
cp -r "$REL/site/." /var/www/endesk/
chmod -R a+rX /var/www/endesk

# Keep the five newest releases.
ls -1dt "$BASE"/releases/*/ | tail -n +6 | xargs -r rm -rf

echo "deployed $REL"
curl -fsS "http://127.0.0.1:$PORT/health"
echo
