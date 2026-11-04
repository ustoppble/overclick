#!/usr/bin/env bash
# Deploy the cloud instance: pull, rebuild, restart, prove it came back.
#
# This script is the only supported hosted deploy entrypoint. Keep the compose
# file selection here explicit: a root quickstart compose file must never be
# inherited by the hosted project.
set -euo pipefail

cd "$(dirname "$0")/.."

LOCK_FILE=/tmp/overclick-deploy.lock
if ! command -v flock >/dev/null 2>&1; then
  echo "!! flock is required to prevent concurrent deploys" >&2
  exit 1
fi

# Fail cleanly instead of allowing two pulls/builds/restarts to interleave.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "!! another deploy is already running; lock is held at $LOCK_FILE" >&2
  exit 75
fi

# Pin both the compose project and its files. COMPOSE_FILE is exported so that
# every compose call below (including calls made by Compose itself) keeps the
# hosted project on the deploy files, even when the checkout also has a root
# quickstart compose file.
export COMPOSE_PROJECT_NAME=overclick
export COMPOSE_FILE=deploy/docker-compose.cloud.yml

# The proxy overlay is part of the deployment whenever this instance is fronted by
# an existing Traefik: leaving it out recreates the container without its route,
# which takes the site down while the container looks perfectly healthy.
COMPOSE=(docker compose -p "$COMPOSE_PROJECT_NAME")
OVERLAY=0
if [ -f deploy/docker-compose.traefik.yml ] && grep -qE '^OVERCLICK_HOST=.+' deploy/.env 2>/dev/null; then
  export COMPOSE_FILE="$COMPOSE_FILE:deploy/docker-compose.traefik.yml"
  OVERLAY=1
  echo "==> proxy overlay on (OVERCLICK_HOST set)"
fi

# A previous accidental root-compose deploy used this exact container name.
# Remove only that known orphan, and remove its old quickstart volume only when
# Docker confirms that no remaining container references it. Never use `down`
# here: the legacy and hosted projects shared a project name during the
# incident, so a project-wide down could take the healthy app with it.
remove_legacy_orphans() {
  local referencing_containers

  if docker container inspect overclick-postgres-1 >/dev/null 2>&1; then
    echo "==> removing legacy orphan container overclick-postgres-1"
    docker container rm -f overclick-postgres-1 >/dev/null
  fi

  if docker volume inspect overclick_pgdata >/dev/null 2>&1; then
    if ! referencing_containers="$(docker ps -a --filter volume=overclick_pgdata --format '{{.ID}}')"; then
      echo "==> retaining overclick_pgdata because its references could not be inspected"
    elif [ -n "$referencing_containers" ]; then
      echo "==> retaining overclick_pgdata because a container still references it"
    else
      echo "==> removing legacy orphan volume overclick_pgdata"
      docker volume rm overclick_pgdata >/dev/null
    fi
  fi
}

# Compose records the files that created a project. Refuse to proceed if the
# existing `overclick` project still has a compose file outside a deploy/
# directory. The check is intentionally fail-closed: a malformed listing is safer than
# guessing and touching the wrong project.
assert_deploy_project_files() {
  local projects
  if ! projects="$("${COMPOSE[@]}" ls --all --format json 2>/dev/null)"; then
    echo "!! unable to inspect existing compose projects; refusing deploy" >&2
    return 1
  fi

  if ! command -v python3 >/dev/null 2>&1; then
    echo "!! python3 is required to verify compose project files; refusing deploy" >&2
    return 1
  fi

  if ! printf '%s' "$projects" | python3 -c '
import json
import os
import sys

try:
    rows = json.load(sys.stdin)
except (TypeError, ValueError):
    raise SystemExit(1)

if isinstance(rows, dict):
    rows = [rows]
if not isinstance(rows, list):
    raise SystemExit(1)

for row in rows:
    if not isinstance(row, dict):
        raise SystemExit(1)
    name = row.get("Name") or row.get("name")
    if name != "overclick":
        continue
    files = row.get("ConfigFiles")
    if files is None:
        files = row.get("config_files") or row.get("configFiles")
    if isinstance(files, str):
        files = [item.strip() for item in files.split(",") if item.strip()]
    if not isinstance(files, list) or not files:
        raise SystemExit(1)
    allowed = {
        "docker-compose.cloud.yml",
        "docker-compose.traefik.yml",
    }
    # Compare lexically, not through realpath: the label holds the path the
    # project was created from. The host records /opt/overclick/deploy/...,
    # while the OCL-73 sidecar sees the same checkout as /workspace/deploy/...,
    # so "under this checkouts deploy/" is the wrong test there. What tells the
    # hosted project from the legacy root-compose one is the file itself: an
    # allowed basename inside a directory named deploy.
    for item in files:
        if not isinstance(item, str) or not item.strip():
            raise SystemExit(1)
        path = os.path.normpath(item.strip())
        if os.path.basename(path) not in allowed:
            raise SystemExit(1)
        if os.path.basename(os.path.dirname(path)) != "deploy":
            raise SystemExit(1)
'; then
    echo "!! compose project overclick has config files outside deploy/; refusing deploy" >&2
    echo "   remove the legacy root-compose project manually, then rerun ./deploy/deploy.sh" >&2
    return 1
  fi
}

remove_legacy_orphans
assert_deploy_project_files

# Always probe by exec'ing into the app container over the docker socket,
# never the host's published loopback port. The overlay case already needed
# this (the port is dropped on purpose there); OCL-73's sidecar runs this same
# script from inside its own container, where 127.0.0.1 is the sidecar, not
# the app, so the host-loopback probe would time out on every sidecar-driven
# update even though the deploy itself succeeded.
WHERE="inside the container"

probe() {
  "${COMPOSE[@]}" exec -T app node -e \
    'fetch("http://127.0.0.1:3000/setup").then(r=>console.log(r.status)).catch(()=>console.log("000"))' \
    2>/dev/null || echo "000"
}

# The image compose builds for the app service. Everything below that tags or
# removes images only ever names this repository.
APP_IMAGE="${COMPOSE_PROJECT_NAME}-app"
ROLLBACK_PREFIX="rollback-"

# Keep the image that is serving right now under a rollback tag before the build
# replaces `latest`. Rolling back is then `docker tag` + `up -d --no-build`,
# with no rebuild (README, "Rolling back").
tag_rollback() {
  local container image_id version tag
  container="$("${COMPOSE[@]}" ps -q app 2>/dev/null | head -n 1)"
  if [ -z "$container" ]; then
    echo "==> no running app container; nothing to keep for rollback"
    return 0
  fi
  image_id="$(docker inspect --format '{{.Image}}' "$container")"
  version="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' apps/web/package.json | head -n 1)"
  tag="${APP_IMAGE}:${ROLLBACK_PREFIX}v${version:-unknown}-$(date -u +%Y%m%dT%H%M%SZ)"
  docker tag "$image_id" "$tag"
  echo "==> rollback image: ${tag}"
}

# Disk: every deploy leaves its build cache (about 4 GB) and the previous image
# behind. Once the new app is healthy, drop build cache older than
# OVERCLICK_BUILD_CACHE_MAX_AGE (default 24h; the cache is shared by every build
# on the host, so this is an age filter and never a full prune) and keep, of the
# rollback images, only the most recently tagged one. The running image is
# `latest`; nothing is removed while a container still uses it.
cleanup_disk() {
  local max_age="${OVERCLICK_BUILD_CACHE_MAX_AGE:-24h}" newest="" newest_time="" ref tagged
  echo "==> pruning build cache older than ${max_age}"
  docker builder prune --force --filter "until=${max_age}" || echo "==> build cache prune failed; continuing"

  while IFS= read -r ref; do
    tagged="$(docker image inspect --format '{{.Metadata.LastTagTime}}' "$ref" 2>/dev/null || true)"
    if [ -z "$newest" ] || [[ "$tagged" > "$newest_time" ]]; then
      newest="$ref"
      newest_time="$tagged"
    fi
  done < <(docker image ls "$APP_IMAGE" --format '{{.Repository}}:{{.Tag}}' | grep -F ":${ROLLBACK_PREFIX}" || true)

  [ -n "$newest" ] || return 0
  echo "==> keeping rollback image ${newest}"
  while IFS= read -r ref; do
    [ "$ref" = "$newest" ] && continue
    echo "==> removing old rollback image ${ref}"
    docker rmi "$ref" >/dev/null || echo "==> could not remove ${ref}; continuing"
  done < <(docker image ls "$APP_IMAGE" --format '{{.Repository}}:{{.Tag}}' | grep -F ":${ROLLBACK_PREFIX}" || true)
}

# Before anything changes: a restorable copy of the database and of deploy/.env
# (mode 600, in a 700 directory, newest 7 kept; see deploy/backup.sh). A failed
# backup stops the deploy, since the whole point is being able to go back.
echo "==> backing up"
"$(dirname "$0")/backup.sh" pre-deploy
tag_rollback

echo "==> pulling"
git pull --ff-only

echo "==> building and restarting"
"${COMPOSE[@]}" up -d --build --remove-orphans

echo "==> waiting for the app (${WHERE})"
for _ in $(seq 1 60); do
  code="$(probe | tr -dc '0-9')"
  # /setup answers 200 on a fresh board and redirects once the owner exists.
  # Both prove the app is serving, which is all this check is asking.
  case "$code" in
    200 | 30?)
      echo "==> up (HTTP ${code}) on ${WHERE}"
      "${COMPOSE[@]}" ps --format '{{.Service}} {{.Status}}'
      # Only after the app is proven healthy: a failed deploy keeps the old
      # images and cache it may need to be rolled back.
      cleanup_disk
      exit 0
      ;;
  esac
  sleep 2
done

echo "!! the app did not answer in time (${WHERE}), last 40 log lines:" >&2
"${COMPOSE[@]}" logs --tail 40 app >&2
exit 1
