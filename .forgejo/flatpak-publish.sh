#!/bin/bash
# Builds Quple's Flatpak (desktop/flatpak/) from this checkout and adds it to
# Quine Linux's Flatpak repo: a GPG-signed OSTree repo, collection
# com.quineglobal.Flatpak, branch stable, at s3://<bucket>/flatpak/repo/,
# which KeyMaker (quine-global/keymaker) publishes to as well. Quine Linux
# preinstalls Quple from there (quine-linux:
# overlay/etc/flatpak/remotes.d/quine.flatpakrepo and
# preinstall.d/quine-linux.preinstall). The same as KeyMaker's script, but
# for the manifest.
#
# Run by .forgejo/workflows/flatpak.yml, one architecture at a time (the
# repo is downloaded, added to and uploaded whole). On the runner it only
# starts a Fedora container: flatpak-builder needs to run privileged
# (bubblewrap), and the GNOME SDK and build cache live in podman volumes so
# the next run doesn't download them again (the SDK volume is KeyMaker's
# too; the build cache is Quple's own).
#
# Environment: FLATPAK_GPG_KEY_B64 (the armored secret signing key, base64),
# MINIO_ENDPOINT, MINIO_BUCKET, MINIO_ACCESS_KEY, MINIO_SECRET_KEY.
set -euo pipefail

: "${FLATPAK_GPG_KEY_B64:?FLATPAK_GPG_KEY_B64 isn't set: the repo's signing key (quine-global org secret)}"
: "${MINIO_ACCESS_KEY:?}" "${MINIO_SECRET_KEY:?}" "${MINIO_ENDPOINT:?}" "${MINIO_BUCKET:?}"

exec podman run --rm --privileged \
  -v "$PWD":/src:ro \
  -v quine-flatpak-sdk:/var/lib/flatpak \
  -v quple-flatpak-builder:/cache \
  -e FLATPAK_GPG_KEY_B64 \
  -e RCLONE_CONFIG_STORE_TYPE=s3 \
  -e RCLONE_CONFIG_STORE_PROVIDER=Minio \
  -e RCLONE_CONFIG_STORE_ENDPOINT="$MINIO_ENDPOINT" \
  -e RCLONE_CONFIG_STORE_ACCESS_KEY_ID="$MINIO_ACCESS_KEY" \
  -e RCLONE_CONFIG_STORE_SECRET_ACCESS_KEY="$MINIO_SECRET_KEY" \
  -e REPO_REMOTE="store:$MINIO_BUCKET/flatpak/repo" \
  quay.io/fedora/fedora:latest \
  bash /src/.forgejo/flatpak-build-in-container.sh
