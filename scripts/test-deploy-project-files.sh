#!/usr/bin/env bash
# assert_deploy_project_files must accept the hosted project from both places
# deploy.sh runs: the host (compose labels say /opt/overclick/deploy/...) and the
# OCL-73 updater sidecar (same checkout mounted at /workspace), and must keep
# refusing a project that came up from the root quickstart compose.
#
# The function is cut out of deploy.sh and run against a fake `docker compose ls`
# so no Docker, flock or server is needed. DEPLOY_SH overrides the script under test.
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

if [ "$failures" -ne 0 ]; then echo "$failures failure(s)"; exit 1; fi
echo "all deploy project-file checks passed"
