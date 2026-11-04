#!/usr/bin/env bash
# assert_deploy_project_files must accept the hosted project whatever path its
# compose labels carry (/opt/overclick/deploy/... from the host, or
# /workspace/deploy/... if the retired OCL-73 updater sidecar recreated it last),
# and must keep refusing a project that came up from the root quickstart compose.
# remove_updater_sidecar / remove_updater_volume must take away only the retired
# sidecar container and its trigger volume, and never touch the app or database.
#
# The functions are cut out of deploy.sh and run against a fake `docker` so no
# Docker, flock or server is needed. DEPLOY_SH overrides the script under test.
set -u

REPO_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
DEPLOY_SH=${DEPLOY_SH:-$REPO_ROOT/deploy/deploy.sh}
TEST_ROOT=$(mktemp -d)
trap 'rm -rf -- "$TEST_ROOT"' EXIT

awk '/^assert_deploy_project_files\(\) \{/{p=1} p{print} p&&/^\}/{exit}' "$DEPLOY_SH" >"$TEST_ROOT/fn.sh"
[ -s "$TEST_ROOT/fn.sh" ] || { echo "assert_deploy_project_files not found in $DEPLOY_SH" >&2; exit 1; }

# Stands in for `docker compose -p overclick`; prints $FAKE_LS for `ls`.
cat >"$TEST_ROOT/fake-compose" <<'FAKE'
#!/bin/sh
printf '%s' "$FAKE_LS"
FAKE
chmod +x "$TEST_ROOT/fake-compose"

# The sidecar's cwd: /workspace has a deploy/ but the labels never mention it.
mkdir -p "$TEST_ROOT/workspace/deploy"

failures=0
# check <name> <accept|refuse> <ConfigFiles>
check() {
  local name=$1 want=$2 files=$3 got
  if (
    cd "$TEST_ROOT/workspace" &&
      COMPOSE=("$TEST_ROOT/fake-compose") &&
      FAKE_LS="[{\"Name\":\"overclick\",\"Status\":\"running(2)\",\"ConfigFiles\":\"$files\"}]" &&
      export FAKE_LS &&
      . "$TEST_ROOT/fn.sh" &&
      assert_deploy_project_files
  ) >/dev/null 2>&1; then got=accept; else got=refuse; fi
  if [ "$got" = "$want" ]; then
    echo "ok   $name"
  else
    echo "FAIL $name: wanted $want, got $got"
    failures=$((failures + 1))
  fi
}

H=/opt/overclick
check "host: cloud + traefik" accept "$H/deploy/docker-compose.cloud.yml,$H/deploy/docker-compose.traefik.yml"
check "sidecar: labels written by the host, cwd is /workspace" accept "$H/deploy/docker-compose.cloud.yml,$H/deploy/docker-compose.traefik.yml"
check "sidecar: labels written by the sidecar" accept "/workspace/deploy/docker-compose.cloud.yml"
check "relative deploy path" accept "deploy/docker-compose.cloud.yml"
check "legacy: root docker-compose.yml" refuse "$H/docker-compose.yml"
check "legacy: root docker-compose.yml in /workspace" refuse "/workspace/docker-compose.yml"
check "legacy: allowed basename at the repo root" refuse "$H/docker-compose.cloud.yml"
check "odd basename inside deploy/" refuse "$H/deploy/docker-compose.yml"
check "odd basename: override file" refuse "$H/deploy/docker-compose.override.yml"
check "deploy-like dir name" refuse "$H/deploy-old/docker-compose.cloud.yml"
check "dotdot escapes deploy/" refuse "$H/deploy/../docker-compose.cloud.yml"
check "one bad file among good ones" refuse "$H/deploy/docker-compose.cloud.yml,$H/docker-compose.yml"
check "bare basename" refuse "docker-compose.cloud.yml"

# Fail-closed: no project listing, other projects only, empty ConfigFiles.
check "empty ConfigFiles" refuse ""
if (
  cd "$TEST_ROOT/workspace" &&
    COMPOSE=("$TEST_ROOT/fake-compose") &&
    FAKE_LS='[{"Name":"other","ConfigFiles":"/srv/docker-compose.yml"}]' && export FAKE_LS &&
    . "$TEST_ROOT/fn.sh" && assert_deploy_project_files
) >/dev/null 2>&1; then echo "ok   other projects are ignored"; else
  echo "FAIL other projects are ignored"; failures=$((failures + 1)); fi

# --- the retired updater sidecar -------------------------------------------
for fn in remove_updater_sidecar remove_updater_volume; do
  awk -v f="$fn" '$0 ~ "^"f"\\(\\) \\{"{p=1} p{print} p&&/^\}/{exit}' "$DEPLOY_SH" >"$TEST_ROOT/$fn.sh"
  [ -s "$TEST_ROOT/$fn.sh" ] || { echo "$fn not found in $DEPLOY_SH" >&2; exit 1; }
done

# Fake `docker`: logs every call to $DOCKER_LOG. `ps` answers $FAKE_PS_IDS,
# `volume inspect` succeeds only when $FAKE_VOLUME=1, and $FAKE_PS_FAIL=1 makes
# `ps` fail.
mkdir -p "$TEST_ROOT/bin"
cat >"$TEST_ROOT/bin/docker" <<'FAKE'
#!/bin/sh
echo "$*" >>"$DOCKER_LOG"
case "$1 $2" in
  "ps -a") [ "${FAKE_PS_FAIL:-0}" = 1 ] && exit 1; printf '%s' "${FAKE_PS_IDS:-}" ;;
  "volume inspect") [ "${FAKE_VOLUME:-0}" = 1 ] || exit 1 ;;
esac
exit 0
FAKE
chmod +x "$TEST_ROOT/bin/docker"

# run_fn <fn> <env assignments...>: runs the function with the fake docker and
# leaves what it called in $TEST_ROOT/docker.log.
run_fn() {
  local fn=$1; shift
  : >"$TEST_ROOT/docker.log"
  env "$@" PATH="$TEST_ROOT/bin:$PATH" DOCKER_LOG="$TEST_ROOT/docker.log" \
    COMPOSE_PROJECT_NAME=overclick bash -c ". '$TEST_ROOT/$fn.sh'; $fn" >/dev/null 2>&1
}
# expect <name> <pattern-that-must-match> [<pattern-that-must-not>]
expect() {
  local name=$1 want=$2 never=${3:-}
  if grep -q -- "$want" "$TEST_ROOT/docker.log" &&
    { [ -z "$never" ] || ! grep -q -- "$never" "$TEST_ROOT/docker.log"; }; then
    echo "ok   $name"
  else
    echo "FAIL $name"; sed 's/^/     /' "$TEST_ROOT/docker.log"; failures=$((failures + 1))
  fi
}
expect_no() {
  local name=$1 pattern=$2
  if ! grep -q -- "$pattern" "$TEST_ROOT/docker.log"; then echo "ok   $name"; else
    echo "FAIL $name"; sed 's/^/     /' "$TEST_ROOT/docker.log"; failures=$((failures + 1)); fi
}

run_fn remove_updater_sidecar FAKE_PS_IDS="abc123"
expect "sidecar: looked up by project and service labels, not by name" \
  "label=com.docker.compose.service=updater" "label=com.docker.compose.service=app"
expect "sidecar: the container found is removed" "^rm -f abc123"
run_fn remove_updater_sidecar FAKE_PS_IDS=""
expect_no "sidecar: nothing is removed when it is not there" "^rm "
run_fn remove_updater_sidecar FAKE_PS_FAIL=1
expect_no "sidecar: nothing is removed when the lookup fails" "^rm "

run_fn remove_updater_volume FAKE_VOLUME=1 FAKE_PS_IDS=""
expect "volume: an unreferenced trigger volume is removed" "^volume rm overclick_update-trigger"
run_fn remove_updater_volume FAKE_VOLUME=1 FAKE_PS_IDS="def456"
expect_no "volume: kept while a container still references it" "^volume rm"
run_fn remove_updater_volume FAKE_VOLUME=0
expect_no "volume: nothing to do when there is no trigger volume" "^volume rm"
run_fn remove_updater_volume FAKE_VOLUME=1 FAKE_PS_FAIL=1
expect_no "volume: kept when its references cannot be inspected" "^volume rm"

if [ "$failures" -ne 0 ]; then echo "$failures failure(s)"; exit 1; fi
echo "all deploy project-file checks passed"
