# The repo's lock, in the bucket beside it: KeyMaker's and Quple's publishes
# each download the whole repo, add their app and sync it back, so two at
# once would undo each other's update. (Each workflow's concurrency group
# only covers its own repository.) S3 has no atomic create, so: wait while
# someone else's lock is there, write ours, and check a moment later that
# it's still ours. A lock older than an hour is from a run that was killed
# before it could remove it.
LOCK="${REPO_REMOTE}.lock"
LOCK_ID="${LOCK_OWNER:-$(hostname)}-$$-$(date +%s%N)"
take_repo_lock() {
  local held age
  while :; do
    held=$(rclone cat "$LOCK" 2>/dev/null || true)
    if [ -n "$held" ]; then
      age=$(( $(date +%s) - ${held##* } ))
      if [ "$age" -lt 3600 ]; then
        echo "== repo locked by ${held% *} (${age}s); waiting"
        sleep 30
        continue
      fi
      echo "== stale repo lock (${held% *}, ${age}s); taking it"
    fi
    echo "$LOCK_ID $(date +%s)" | rclone rcat "$LOCK"
    sleep 10
    held=$(rclone cat "$LOCK" 2>/dev/null || true)
    if [ "${held% *}" = "$LOCK_ID" ]; then
      echo "== repo lock taken ($LOCK_ID)"
      trap release_repo_lock EXIT
      return
    fi
    echo "== lost the repo lock to ${held% *}; waiting"
  done
}
release_repo_lock() {
  local held
  held=$(rclone cat "$LOCK" 2>/dev/null || true)
  if [ "${held% *}" = "$LOCK_ID" ]; then
    rclone deletefile "$LOCK" && echo "== repo lock released"
  fi
}
