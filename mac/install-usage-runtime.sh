#!/bin/bash
set -euo pipefail
SUPPORT_DIR="$HOME/Library/Application Support/GPTAccountSwitcher"
RUNTIME_DIR="$SUPPORT_DIR/usage-runtime"
if [[ -x "$RUNTIME_DIR/bin/node" ]] && "$RUNTIME_DIR/bin/node" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then exit 0; fi
ARCH="$(uname -m)"
[[ "$ARCH" == arm64 ]] || ARCH=x64
WORK_DIR=$(mktemp -d "$SUPPORT_DIR/node-install.XXXXXX")
trap 'rm -rf "$WORK_DIR"' EXIT
/usr/bin/curl --connect-timeout 15 --max-time 60 -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$WORK_DIR/sums"
ARCHIVE=$(/usr/bin/awk -v suffix="-darwin-$ARCH.tar.gz" 'index($2,suffix) && substr($2,length($2)-length(suffix)+1)==suffix { print $2; exit }' "$WORK_DIR/sums")
[[ "$ARCHIVE" =~ ^node-v22\.[0-9]+\.[0-9]+-darwin-(arm64|x64)\.tar\.gz$ ]] || exit 1
VERSION="${ARCHIVE#node-}"; VERSION="${VERSION%-darwin-*}"
/usr/bin/curl --connect-timeout 15 --max-time 300 --retry 2 -fsSL "https://nodejs.org/dist/$VERSION/$ARCHIVE" -o "$WORK_DIR/$ARCHIVE"
(cd "$WORK_DIR"; /usr/bin/grep " $ARCHIVE\$" sums | /usr/bin/shasum -a 256 -c -)
/usr/bin/tar -xzf "$WORK_DIR/$ARCHIVE" -C "$WORK_DIR"
mkdir -p "$RUNTIME_DIR/bin"
cp "$WORK_DIR/${ARCHIVE%.tar.gz}/bin/node" "$RUNTIME_DIR/bin/node.next"
chmod 700 "$RUNTIME_DIR/bin/node.next"
mv "$RUNTIME_DIR/bin/node.next" "$RUNTIME_DIR/bin/node"
