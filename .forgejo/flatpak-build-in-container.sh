#!/bin/bash
# The inside of flatpak-publish.sh: build, then (holding the repo's lock)
# download the repo, add the build to it, sign and upload it.
set -euo pipefail

APP=com.quineglobal.Quple
COLLECTION=com.quineglobal.Flatpak
MANIFEST=desktop/flatpak/$APP.yml

dnf -y -q install flatpak flatpak-builder ostree rclone gnupg2 git >/dev/null

# The signing key, in a keyring that lives only as long as this container.
export GNUPGHOME
GNUPGHOME=$(mktemp -d)
printf '%s' "$FLATPAK_GPG_KEY_B64" | base64 -d | gpg --batch --quiet --import
KEY=$(gpg --batch --list-secret-keys --with-colons | awk -F: '/^fpr/ { print $10; exit }')
[ -n "$KEY" ] || { echo "FLATPAK_GPG_KEY_B64 holds no secret key" >&2; exit 1; }
echo "signing with $KEY"

flatpak remote-add --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo

mkdir -p /work
cp -a /src /work/src

# Built into a repo of its own first, so the shared repo is locked only for
# the download, add and upload, not the build. The build directory sits
# beside the state directory in the cache volume: flatpak-builder needs
# both on the same filesystem.
echo "== building $(uname -m)"
flatpak-builder --disable-rofiles-fuse --force-clean \
  --state-dir=/cache/state \
  --install-deps-from=flathub \
  --default-branch=stable \
  --repo=/work/build-repo \
  /cache/build "/work/src/$MANIFEST"

# shellcheck source=repo-lock.sh
. /src/.forgejo/repo-lock.sh
take_repo_lock

# The current repo, or a new one. Objects never change, so downloading what
# exists and adding to it is safe while we hold the lock.
if rclone lsf "$REPO_REMOTE/" --include /config | grep -q .; then
  echo "== downloading $REPO_REMOTE"
  rclone copy "$REPO_REMOTE" /work/repo --transfers 16
  # S3 has no empty directories, and ostree needs these even when empty.
  mkdir -p /work/repo/{objects,tmp,extensions,state,refs/{heads,remotes,mirrors}}
else
  echo "== new repo"
  ostree init --repo=/work/repo --mode=archive-z2 --collection-id="$COLLECTION"
fi

for ref in $(ostree --repo=/work/build-repo refs | grep -E "^(app|runtime)/"); do
  flatpak build-commit-from --src-repo=/work/build-repo \
    --gpg-sign="$KEY" --gpg-homedir="$GNUPGHOME" \
    /work/repo "$ref"
done

flatpak build-update-repo \
  --gpg-sign="$KEY" --gpg-homedir="$GNUPGHOME" \
  --title="Quine Linux" \
  --generate-static-deltas \
  --prune --prune-depth=2 \
  /work/repo

# Objects first, then refs and the summary that points at them, then remove
# what --prune dropped: a client never sees a summary naming missing objects.
echo "== uploading to $REPO_REMOTE"
rclone copy /work/repo "$REPO_REMOTE" --transfers 16 --exclude '/summary*' --exclude '/refs/**'
rclone copy /work/repo "$REPO_REMOTE" --transfers 16
rclone sync /work/repo "$REPO_REMOTE" --transfers 16
ostree refs --repo=/work/repo
