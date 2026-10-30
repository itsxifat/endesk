#!/usr/bin/env bash
# One-time, idempotent setup of the EnDesk relay + download page on an Ubuntu
# server that already runs nginx and certbot. Run as root from a checkout:
#
#   sudo DOMAIN=endesk.example.com bash deploy/server-setup.sh
#
# It only adds EnDesk's own pieces: a system user, a private Node runtime in
# /opt/endesk/node, the endesk-relay systemd unit, /etc/endesk/relay.env,
# /var/www/endesk and one nginx site file. If a local coturn uses
# static-auth-secret, the relay reuses that secret to mint TURN credentials;
# coturn itself is not changed.
set -euo pipefail

DOMAIN=${DOMAIN:?set DOMAIN}
PORT=${PORT:-4740}
NODE_VERSION=${NODE_VERSION:-v22.23.3}
COTURN_CONF=${COTURN_CONF:-/etc/turnserver.conf}
HERE=$(cd "$(dirname "$0")" && pwd)
BASE=/opt/endesk
WWW=/var/www/endesk

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

# 1. Service user.
id endesk >/dev/null 2>&1 ||
  useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin endesk

# 2. Private Node runtime, independent of whatever node the system has.
install -d -m 0755 "$BASE" "$BASE/releases"
if [ "$("$BASE/node/bin/node" -v 2>/dev/null)" != "$NODE_VERSION" ]; then
  tmp=$(mktemp -d)
  tarball="node-$NODE_VERSION-linux-x64.tar.xz"
  curl -fsSL -o "$tmp/$tarball" "https://nodejs.org/dist/$NODE_VERSION/$tarball"
  curl -fsSL -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
  (cd "$tmp" && grep " $tarball\$" SHASUMS256.txt | sha256sum -c -)
  rm -rf "$BASE/node.new" && mkdir "$BASE/node.new"
  tar -xJf "$tmp/$tarball" -C "$BASE/node.new" --strip-components=1
  rm -rf "$BASE/node" && mv "$BASE/node.new" "$BASE/node"
  rm -rf "$tmp"
fi

# 3. Settings, kept if present. Only root and the service can read them.
install -d -m 0755 /etc/endesk
if [ ! -f /etc/endesk/relay.env ]; then
  secret=$(sed -n 's/^[[:space:]]*static-auth-secret[[:space:]]*=[[:space:]]*//p' "$COTURN_CONF" 2>/dev/null | head -1)
  {
    echo "HOST=127.0.0.1"
    echo "PORT=$PORT"
    echo "OWNERS_FILE=/var/lib/endesk/owners.json"
    if [ -n "$secret" ]; then
      echo "TURN_URLS=turn:$DOMAIN:3478?transport=udp,turn:$DOMAIN:3478?transport=tcp"
      echo "TURN_SECRET=$secret"
    fi
  } > /etc/endesk/relay.env.new
  chown root:endesk /etc/endesk/relay.env.new
  chmod 0640 /etc/endesk/relay.env.new
  mv /etc/endesk/relay.env.new /etc/endesk/relay.env
fi
PORT=$(sed -n 's/^PORT=//p' /etc/endesk/relay.env)

# 4. Server-side scripts.
install -m 0755 "$HERE/deploy.sh" "$BASE/deploy.sh"
install -m 0755 "$HERE/publish-downloads.sh" "$BASE/publish-downloads.sh"

# 5. systemd unit (the first deploy starts it).
install -m 0644 "$HERE/endesk-relay.service" /etc/systemd/system/endesk-relay.service
systemctl daemon-reload
systemctl enable endesk-relay >/dev/null

# 6. Web root (deploy.sh installs the page itself).
install -d -m 0755 "$WWW" "$WWW/downloads"

# 7. nginx site, installed once: certbot edits it afterwards.
site=/etc/nginx/sites-available/endesk.conf
if [ ! -f "$site" ]; then
  sed -e "s/__DOMAIN__/$DOMAIN/g" -e "s/__PORT__/$PORT/g" "$HERE/nginx-endesk.conf" > "$site"
  ln -sfn "$site" /etc/nginx/sites-enabled/endesk.conf
  if nginx -t; then
    systemctl reload nginx
  else
    rm -f /etc/nginx/sites-enabled/endesk.conf
    echo "nginx -t failed; endesk site left disabled" >&2
    exit 1
  fi
fi

echo "Setup done. Next: deploy a release, then enable TLS with"
echo "  certbot --nginx -d $DOMAIN --redirect"
