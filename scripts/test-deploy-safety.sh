#!/usr/bin/env bash
# deploy.sh and backup.sh must fail closed and keep their order, proven against a
# fake `docker` so no Docker, flock or server is needed:
#
#   1. backup.sh with a docker that fails (exit 42) exits non-zero, still copies
#      deploy/.env, and the deploy built on it aborts before any mutation;
#   2. a database container that exists but is not running is refused, while a
#      host with no database container at all is allowed to skip the dump;
#   3. deploy.sh runs backup -> rollback tag -> mutations, never the other way,
#      and never deletes the legacy data volume.
#
# DEPLOY_DIR overrides the deploy/ directory under test.
set -u

REPO_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
DEPLOY_DIR=${DEPLOY_DIR:-$REPO_ROOT/deploy}
TEST_ROOT=$(mktemp -d)
trap 'rm -rf -- "$TEST_ROOT"' EXIT

BIN="$TEST_ROOT/bin"
mkdir -p "$BIN"

# Fake docker: logs every call to $FAKE_LOG, behaves as the scenario variables say.
#   FAKE_PS_STATUS  exit status of `compose ps` (default 0)
#   FAKE_DB         running | stopped | none   (the database container)
cat >"$BIN/docker" <<'FAKE'
#!/bin/sh
echo "docker $*" >>"$FAKE_LOG"
case "$*" in
  *" ps "*overclick-db*)
    [ "${FAKE_PS_STATUS:-0}" -ne 0 ] && exit "$FAKE_PS_STATUS"
    case "${FAKE_DB:-running}" in
      running) echo db-container-id ;;
      stopped) case "$*" in *--status*) ;; *) echo db-container-id ;; esac ;;
    esac
    exit 0 ;;
  *" ls "*) printf '[{"Name":"overclick","ConfigFiles":"/opt/overclick/deploy/docker-compose.cloud.yml"}]' ;;
  *" ps -q app"*) echo app-container-id ;;
  "inspect --format"*) echo sha256:abc ;;
  *"exec -T overclick-db pg_dump"*) echo PGDMP ;;
  *"pg_restore --list"*) cat >/dev/null ;;
  *"exec -T app node"*) echo 200 ;;
  "container inspect overclick-postgres-1" | "volume inspect overclick_pgdata") exit 0 ;;
esac
exit 0
FAKE
printf '#!/bin/sh\nexit 0\n' >"$BIN/flock"
cat >"$BIN/git" <<'FAKE'
#!/bin/sh
echo "git $*" >>"$FAKE_LOG"
FAKE
chmod +x "$BIN"/*

failures=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; failures=$((failures + 1)); }

# A scratch checkout: the script under test, a version file and a deploy/.env.
fresh_tree() {
  local t=$1
  mkdir -p "$t/deploy" "$t/apps/web"
  cp "$DEPLOY_DIR/deploy.sh" "$DEPLOY_DIR/backup.sh" "$t/deploy/"
  [ -f "$DEPLOY_DIR/docker-compose.traefik.yml" ] && : >"$t/deploy/docker-compose.traefik.yml"
  printf '{\n  "version": "9.9.9"\n}\n' >"$t/apps/web/package.json"
  printf 'AUTH_SECRET=not-a-real-secret\n' >"$t/deploy/.env"
}

# run_backup <name> <PS_STATUS> <DB> -> sets RC, LOG, TREE
run_backup() {
  TREE="$TEST_ROOT/$1"
  fresh_tree "$TREE"
  LOG="$TREE/log"
  : >"$LOG"
  (cd "$TREE" && PATH="$BIN:$PATH" FAKE_LOG="$LOG" FAKE_PS_STATUS="$2" FAKE_DB="$3" \
    OVERCLICK_BACKUP_DIR="$TREE/backups" ./deploy/backup.sh pre-deploy) >"$TREE/out" 2>&1
  RC=$?
}

# 1. docker fails -> fail closed, .env still copied
run_backup bk-fail 42 running
if [ "$RC" -ne 0 ]; then ok "backup: docker compose ps exit 42 -> exit $RC"; else bad "backup: docker failure was swallowed (exit 0)"; fi
if ls "$TREE"/backups/env-pre-deploy.*.bak >/dev/null 2>&1; then ok "backup: deploy/.env copied even though docker failed"; else bad "backup: deploy/.env was not copied"; fi
if ls "$TREE"/backups/*.dump >/dev/null 2>&1; then bad "backup: a dump exists after a docker failure"; else ok "backup: no dump claimed after a docker failure"; fi

# 2. database container exists but is stopped -> refuse; none at all -> allowed
run_backup bk-stopped 0 stopped
if [ "$RC" -ne 0 ]; then ok "backup: stopped database container refused"; else bad "backup: stopped database container was skipped"; fi
run_backup bk-none 0 none
if [ "$RC" -eq 0 ]; then ok "backup: no database container -> nothing to dump, exit 0"; else bad "backup: fresh host was refused (exit $RC)"; fi
if ls "$TREE"/backups/env-pre-deploy.*.bak >/dev/null 2>&1; then ok "backup: deploy/.env copied on the allowed early exit"; else bad "backup: deploy/.env missing on the early exit"; fi
run_backup bk-ok 0 running
if [ "$RC" -eq 0 ] && ls "$TREE"/backups/pre-deploy.*.dump >/dev/null 2>&1; then ok "backup: running database dumped"; else bad "backup: happy path broke (exit $RC)"; fi

# run_deploy <name> <PS_STATUS> <DB> -> sets RC, LOG
run_deploy() {
  TREE="$TEST_ROOT/$1"
  fresh_tree "$TREE"
  LOG="$TREE/log"
  : >"$LOG"
  (cd "$TREE" && PATH="$BIN:$PATH" FAKE_LOG="$LOG" FAKE_PS_STATUS="$2" FAKE_DB="$3" \
    OVERCLICK_BACKUP_DIR="$TREE/backups" ./deploy/deploy.sh) >"$TREE/out" 2>&1
  RC=$?
}

# line number of the first log line matching an extended regex (0 when absent)
first() { grep -nE "$1" "$LOG" | head -n 1 | cut -d: -f1; }
MUTATIONS='^docker (container rm|volume rm|rmi|builder prune)|^docker compose .* (up|down|rm|stop)|^git pull'

# 3a. the backup fails -> the deploy aborts and mutates nothing
run_deploy dp-fail 42 running
if [ "$RC" -ne 0 ]; then ok "deploy: aborts when the backup fails (exit $RC)"; else bad "deploy: went on after a failed backup"; fi
if [ -z "$(first "$MUTATIONS|^docker tag")" ]; then ok "deploy: no tag and no mutation after a failed backup"; else bad "deploy: mutated after a failed backup"; fi

# 3b. the happy path keeps the order backup -> tag -> mutations
run_deploy dp-ok 0 running
bk=$(first 'pg_dump')
tg=$(first '^docker tag ')
mu=$(first "$MUTATIONS")
if [ "$RC" -eq 0 ] && [ "$bk" -gt 0 ] && [ "$tg" -gt "$bk" ] && [ "$mu" -gt "$tg" ]; then
  ok "deploy: order is backup($bk) -> rollback tag($tg) -> first mutation($mu)"
else
  bad "deploy: wrong order (exit $RC, backup=$bk tag=$tg mutation=$mu)"
fi
if [ -z "$(first '^docker volume rm')" ]; then ok "deploy: legacy data volume is never removed"; else bad "deploy: removed a data volume"; fi
orphan=$(first '^docker container rm')
if [ "$orphan" -gt "$tg" ]; then ok "deploy: legacy orphan container removed only after the tag"; else bad "deploy: orphan removed before the tag (line $orphan)"; fi

if [ "$failures" -ne 0 ]; then
  echo "$failures failure(s)"
  exit 1
fi
