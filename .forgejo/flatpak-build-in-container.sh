#!/bin/bash
# The inside of flatpak-publish.sh: build, export a bundle, upload it to
# $INCOMING/<app>/<arch>/ for quine-global/flatpak-repo to publish.
set -euo pipefail

APP=com.quineglobal.Quple
MANIFEST=desktop/flatpak/$APP.yml

dnf -y -q install flatpak flatpak-builder ostree rclone git >/dev/null
flatpak remote-add --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo

mkdir -p /work
cp -a /src /work/src

# The build directory sits beside the state directory in the cache volume:
# flatpak-builder needs both on the same filesystem.
ARCH=$(flatpak --default-arch)
echo "== building $ARCH"
flatpak-builder --disable-rofiles-fuse --force-clean \
  --state-dir=/cache/state \
  --install-deps-from=flathub \
  --default-branch=stable \
  --repo=/work/build-repo \
  /cache/build "/work/src/$MANIFEST"

flatpak build-bundle /work/build-repo /work/app.flatpak "$APP" stable --arch="$ARCH"
name="$(date -u +%Y%m%dT%H%M%SZ)-${COMMIT:0:12}.flatpak"
echo "== uploading $APP/$ARCH/$name"
rclone copyto /work/app.flatpak "$INCOMING/$APP/$ARCH/$name"
