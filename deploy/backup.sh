#!/usr/bin/env bash
# Back up the hosted instance: one Postgres dump plus a copy of deploy/.env.
#
#   ./deploy/backup.sh [label]
#
# deploy.sh runs it as `pre-deploy` before every deploy and stops if it fails.
# A systemd timer or cron can run it on its own (see deploy/README.md), with the
# default label `daily`.
#
# Everything lands in OVERCLICK_BACKUP_DIR (default: backups/ in this checkout),
# a directory only its owner can enter, with every file mode 600: the dump holds
# every user's data and the .env copy holds the secrets. Files are named
# <label>.<UTC time>.v<version>.dump / env-<label>.<UTC time>.v<version>.bak and
# only the newest OVERCLICK_BACKUP_KEEP (default 7) of each kind and label are
# kept, so the label is also the retention bucket: a day of deploys cannot push
# the daily dumps out.
set -euo pipefail
umask 077

cd "$(dirname "$0")/.."

LABEL="${1:-daily}"
case "$LABEL" in
  '' | *[!A-Za-z0-9_-]*)
    echo "!! backup label must be letters, digits, - or _ only" >&2
    exit 2
    ;;
esac

BACKUP_DIR="${OVERCLICK_BACKUP_DIR:-$PWD/backups}"
KEEP="${OVERCLICK_BACKUP_KEEP:-7}"
case "$KEEP" in
  '' | *[!0-9]* | 0)
    echo "!! OVERCLICK_BACKUP_KEEP must be a positive number" >&2
    exit 2
    ;;
esac

# Same project and files deploy.sh pins; deploy.sh exports its own (with the
# proxy overlay) and that wins here.
export COMPOSE_PROJECT_NAME=overclick
export COMPOSE_FILE="${COMPOSE_FILE:-deploy/docker-compose.cloud.yml}"
COMPOSE=(docker compose -p "$COMPOSE_PROJECT_NAME")

# The directory may predate this script with looser modes (and hold dumps from
# earlier deploys): close it and every file in it, so one run repairs them all.
mkdir -p "$BACKUP_DIR"
chmod 0700 "$BACKUP_DIR"
find "$BACKUP_DIR" -maxdepth 1 -type f ! -perm 0600 -exec chmod 0600 {} +

VERSION="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' apps/web/package.json | head -n 1)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TAG="${LABEL}.${STAMP}.v${VERSION:-unknown}"

# Retention: newest KEEP of this label, by the time in the name.
prune() {
  local prefix=$1 suffix=$2 file n=0
  # "." cannot be in a label, so `pre.` never matches the files of `pre-deploy`.
  while IFS= read -r file; do
    n=$((n + 1))
    if [ "$n" -gt "$KEEP" ]; then
      rm -f -- "$file"
    fi
  done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name "${prefix}.[0-9]*${suffix}" | sort -r)
}

# The secrets copy comes first: it needs no database, so no early exit below may
# leave a run without it.
if [ -f deploy/.env ]; then
  cp -- deploy/.env "$BACKUP_DIR/env-${TAG}.bak"
  chmod 0600 "$BACKUP_DIR/env-${TAG}.bak"
fi
prune "env-${LABEL}" ".bak"

# Fail closed: only a database container that does not exist at all may skip the
# dump. The docker status is read apart from its output, so a failing docker
# (daemon down, no permission, bad compose file) is never mistaken for "not
# running". Its stderr is not echoed: it can carry host addresses.
running=""
status=0
running="$("${COMPOSE[@]}" ps --status running -q overclick-db 2>/dev/null)" || status=$?
if [ "$status" -ne 0 ]; then
  echo "!! backup: 'docker compose ps' failed (exit ${status}); cannot tell whether the database is running, refusing to go on" >&2
  exit 1
fi
if [ -z "$running" ]; then
  existing=""
  status=0
  existing="$("${COMPOSE[@]}" ps --all -q overclick-db 2>/dev/null)" || status=$?
  if [ "$status" -ne 0 ]; then
    echo "!! backup: 'docker compose ps --all' failed (exit ${status}); refusing to go on" >&2
    exit 1
  fi
  if [ -n "$existing" ]; then
    echo "!! backup: the database container exists but is not running; start it so it can be dumped, then rerun" >&2
    exit 1
  fi
  # A host that never ran this project has no database to dump: nothing to lose.
  echo "==> backup: no database container exists yet; nothing to dump"
  exit 0
fi

DUMP="$BACKUP_DIR/${TAG}.dump"
PART="${DUMP}.partial"
trap 'rm -f -- "$PART"' EXIT

echo "==> backup: dumping the database to ${DUMP#"$PWD"/}"
"${COMPOSE[@]}" exec -T overclick-db pg_dump -U overclick -Fc overclick >"$PART"

# An empty or unreadable archive is worse than none: it looks like a backup.
if [ ! -s "$PART" ] || ! "${COMPOSE[@]}" exec -T overclick-db pg_restore --list <"$PART" >/dev/null; then
  echo "!! backup: the dump is empty or unreadable; refusing to go on" >&2
  exit 1
fi
mv -- "$PART" "$DUMP"
chmod 0600 "$DUMP"

prune "${LABEL}" ".dump"
echo "==> backup: done (newest ${KEEP} of '${LABEL}' kept, mode 600 in a 700 directory)"
