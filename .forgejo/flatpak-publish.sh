#!/bin/bash
# Builds Quple's Flatpak (desktop/flatpak/) from this checkout and uploads
# it as a bundle to s3://<bucket>/flatpak/incoming/, where
# quine-global/flatpak-repo's publish workflow picks it up, signs it into
# Quine Linux's Flatpak repo (flatpak.quineglobal.com) and uploads that.
# Quine Linux preinstalls Quple from there.
#
# Run by .forgejo/workflows/flatpak.yml, once per architecture. On the
# runner it only starts a Fedora container: flatpak-builder needs to run
# privileged (bubblewrap), and the GNOME SDK and build cache live in podman
# volumes so the next run doesn't download them again (the SDK volume is
# shared with other apps' builds; the build cache is Quple's own).
#
# Environment: MINIO_ENDPOINT, MINIO_BUCKET, MINIO_ACCESS_KEY,
# MINIO_SECRET_KEY; GITHUB_SHA (the commit, for the bundle's name).
set -euo pipefail

: "${MINIO_ACCESS_KEY:?}" "${MINIO_SECRET_KEY:?}" "${MINIO_ENDPOINT:?}" "${MINIO_BUCKET:?}"

exec podman run --rm --privileged \
  -v "$PWD":/src:ro \
  -v quine-flatpak-sdk:/var/lib/flatpak \
  -v quple-flatpak-builder:/cache \
  -e COMMIT="${GITHUB_SHA:-unknown}" \
  -e RCLONE_CONFIG_STORE_TYPE=s3 \
  -e RCLONE_CONFIG_STORE_PROVIDER=Minio \
  -e RCLONE_CONFIG_STORE_ENDPOINT="$MINIO_ENDPOINT" \
  -e RCLONE_CONFIG_STORE_ACCESS_KEY_ID="$MINIO_ACCESS_KEY" \
  -e RCLONE_CONFIG_STORE_SECRET_ACCESS_KEY="$MINIO_SECRET_KEY" \
  -e INCOMING="store:$MINIO_BUCKET/flatpak/incoming" \
  quay.io/fedora/fedora:latest \
  bash /src/.forgejo/flatpak-build-in-container.sh
