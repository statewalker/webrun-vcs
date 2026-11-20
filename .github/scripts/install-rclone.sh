#!/usr/bin/env bash
# Puts rclone on the PATH for a publish job: bash .github/scripts/install-rclone.sh
#
# apt is the usual way, but during a runner network outage the Ubuntu mirrors do not resolve
# ("Temporary failure resolving 'security.ubuntu.com'") and the publish step failed after the
# whole site had been built and checked. Then a pinned rclone release is downloaded from GitHub
# instead, and installed only if its SHA-256 is the one below (this step holds the publish keys).
set -euo pipefail
VERSION=v1.68.2
SHA256=0e6fa18051e67fc600d803a2dcb10ddedb092247fc6eee61be97f64ec080a13c # rclone-$VERSION-linux-amd64.zip

if command -v rclone >/dev/null 2>&1; then exit 0; fi
if getent hosts archive.ubuntu.com >/dev/null 2>&1 && sudo apt-get install -y -qq rclone >/dev/null; then
  exit 0
fi
echo "::warning::rclone not installed with apt; installing rclone $VERSION from its GitHub release"
dir=$(mktemp -d)
curl -fsSL --retry 3 -o "$dir/rclone.zip" \
  "https://github.com/rclone/rclone/releases/download/$VERSION/rclone-$VERSION-linux-amd64.zip"
echo "$SHA256  $dir/rclone.zip" | sha256sum -c --quiet
unzip -q "$dir/rclone.zip" -d "$dir"
sudo install -m 0755 "$dir/rclone-$VERSION-linux-amd64/rclone" /usr/local/bin/rclone
rclone version | sed -n 1p # reads all of it: no SIGPIPE under pipefail
