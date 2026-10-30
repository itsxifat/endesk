#!/usr/bin/env bash
# Publish installers built by CI on the download page:
#
#   sudo /opt/endesk/publish-downloads.sh <dir-with-installers> <version>
#
# Files are copied to /var/www/endesk/downloads/<version>/ and the stable names
# the page links to (EnDesk-Setup.exe, EnDesk-mac.dmg, ...) are pointed at them.
# Platforms missing from <dir> keep their previous version.
set -euo pipefail

SRC=${1:?usage: publish-downloads.sh <dir> <version>}
VER=${2:?usage: publish-downloads.sh <dir> <version>}
case "$VER" in '' | *[!0-9A-Za-z.-]*) echo "bad version: $VER" >&2; exit 1 ;; esac
DL=/var/www/endesk/downloads

declare -A STABLE=(
  [EnDesk-Setup.exe]="EnDesk-Setup-$VER.exe"
  [EnDesk-Portable.exe]="EnDesk-Portable-$VER.exe"
  [EnDesk-mac.dmg]="EnDesk-$VER-mac-universal.dmg"
  [EnDesk-mac.zip]="EnDesk-$VER-mac-universal.zip"
)

published=0
install -d -m 0755 "$DL/$VER"
for name in "${!STABLE[@]}"; do
  file=${STABLE[$name]}
  if [ ! -f "$SRC/$file" ]; then
    echo "skip $name: $file not found in $SRC" >&2
    continue
  fi
  install -m 0644 "$SRC/$file" "$DL/$VER/$file"
  ln -sfn "$VER/$file" "$DL/$name"
  published=$((published + 1))
done
[ "$published" -gt 0 ] || { echo "nothing to publish" >&2; exit 1; }

# Windows self-update feed (electron-updater reads downloads/latest.yml). Its
# file names point into the version folder; publish it last, once the
# installer and its blockmap are in place.
if [ -f "$SRC/latest.yml" ] && [ -f "$DL/$VER/EnDesk-Setup-$VER.exe" ]; then
  grep -qx "version: $VER" "$SRC/latest.yml" || { echo "latest.yml is not for $VER" >&2; exit 1; }
  [ -f "$SRC/EnDesk-Setup-$VER.exe.blockmap" ] && install -m 0644 "$SRC/EnDesk-Setup-$VER.exe.blockmap" "$DL/$VER/"
  sed -E "s#^([[:space:]]*-?[[:space:]]*url: )(EnDesk-)#\1$VER/\2#; s#^(path: )(EnDesk-)#\1$VER/\2#" "$SRC/latest.yml" > "$DL/latest.yml.new"
  chmod 0644 "$DL/latest.yml.new"
  mv "$DL/latest.yml.new" "$DL/latest.yml"
fi

# latest.json describes whatever every stable name points at now.
json="{\"version\":\"$VER\",\"files\":{"
sep=
for name in EnDesk-Setup.exe EnDesk-Portable.exe EnDesk-mac.dmg EnDesk-mac.zip; do
  [ -L "$DL/$name" ] || continue
  target=$(readlink "$DL/$name")
  size=$(stat -L -c %s "$DL/$name")
  sum=$(sha256sum "$DL/$name" | cut -d' ' -f1)
  json+="$sep\"$name\":{\"file\":\"$target\",\"size\":$size,\"sha256\":\"$sum\"}"
  sep=,
done
printf '%s}}\n' "$json" > "$DL/latest.json.new"
chmod 0644 "$DL/latest.json.new"
mv "$DL/latest.json.new" "$DL/latest.json"
cat "$DL/latest.json"
