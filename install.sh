#!/usr/bin/env bash
set -euo pipefail

umask 077

plugin_source="${OVERCLICK_PLUGIN_SOURCE:-ustoppble/overclick}"
install_home="${OVERCLICK_INSTALL_HOME:-$HOME}"
project_dir="${OVERCLICK_PROJECT_DIR:-$PWD}"

if [[ -n "${OVERCLICK_INSTALL_HOME:-}" ]]; then
  config_root="$install_home/.config"
else
  config_root="${XDG_CONFIG_HOME:-$install_home/.config}"
fi
overclick_root="$config_root/overclick"
plugin_target="$overclick_root/plugin"
private_config="$overclick_root/config"

# OCL-114: OVERCLICK_INSTALL_HOME only ever redirected the files this script
# writes itself. The native managers below (`claude plugin marketplace add`,
# `claude mcp add`, `codex plugin add`, ...) resolve their own user scope from
# HOME, so a sandboxed or test run still wrote into the operator's real
# configuration - which is how a marketplace pointing at a temporary directory,
# carrying a fixture instance URL, ended up registered on a working machine.
# Redirect the managers to the same home the files go to - as an override, not a
# default: a CLI that already exports its own config directory (a Claude Code
# session managing more than one account does) would otherwise win and put the
# sandboxed run right back into the real configuration.
if [[ -n "${OVERCLICK_INSTALL_HOME:-}" ]]; then
  export HOME="$install_home"
  export XDG_CONFIG_HOME="$config_root"
  export CLAUDE_CONFIG_DIR="$install_home/.claude"
  export CODEX_HOME="$install_home/.codex"
  export KIMI_CODE_HOME="$install_home/.kimi-code"
  export GEMINI_HOME="$install_home/.gemini"
fi

read_private_setting() {
  local key=$1 line
  [[ -f "$private_config" ]] || return 1
  line=$(grep -E "^${key}=" "$private_config" 2>/dev/null | tail -n 1) || return 1
  printf '%s' "${line#*=}"
}

if [[ -n "${OVERCLICK_INSTANCE_URL:-}" ]]; then
  instance_url=$OVERCLICK_INSTANCE_URL
else
  read -r -p "OverClick instance URL: " instance_url </dev/tty
fi

# The instance is settled before the token, because a pairing code can only be
# exchanged against an instance we already know how to reach.
if [[ -z "$instance_url" ]]; then
  printf '%s\n' "Instance URL is required." >&2
  exit 1
fi
if [[ "$instance_url" == *$'\n'* || "$instance_url" == *$'\r'* ]]; then
  printf '%s\n' "Instance URL must fit on one line." >&2
  exit 1
fi
if [[ "$instance_url" != http://* && "$instance_url" != https://* ]]; then
  printf '%s\n' "Instance URL must use HTTP or HTTPS." >&2
  exit 1
fi
if [[ "${instance_url#*://}" == *@* ]]; then
  printf '%s\n' "Instance URL must not contain embedded credentials." >&2
  exit 1
fi

# OCL-114: a run pointed at a test fixture baked that fixture into every agent
# config it touched, and each of those agents then reported the board as down.
# The reserved namespaces of RFC 2606/6761 can never resolve, so a URL in one is
# never a board: refuse it here rather than register a server that cannot connect.
instance_host=${instance_url#*://}
instance_host=${instance_host%%/*}
instance_host=${instance_host%%\?*}
instance_host=${instance_host%%:*}
instance_host=$(printf '%s' "$instance_host" | tr '[:upper:]' '[:lower:]')
case "$instance_host" in
  invalid|test|example|localdomain|*.invalid|*.test|*.example|*.localdomain|example.com|example.net|example.org)
    printf '%s\n' "That instance URL is in a reserved namespace that can never resolve (RFC 2606/6761), so it is a test fixture rather than a board. Use the URL of your own OverClick instance." >&2
    exit 1
    ;;
esac

instance_url=${instance_url%/}
if [[ "$instance_url" == */mcp ]]; then
  mcp_url=$instance_url
  instance_base=${instance_url%/mcp}
else
  mcp_url="$instance_url/mcp"
  instance_base=$instance_url
fi

# Reads one string field out of a JSON object. The installer already depends on
# a JSON runtime to merge agent configs safely; the sed arm is only there so a
# machine that has neither still gets a readable failure from the caller rather
# than a silently empty token.
# `command -v` answers "is there a file by that name", which is a different
# question. Windows ships `python3.exe` by default as a Microsoft Store App
# Execution Alias: it satisfies `command -v`, runs, prints "Python was not
# found" and exits 0 with empty stdout. Committing to that runtime made the
# token come back empty on every Windows install, and the sed fallback below --
# written for exactly this machine -- was never reached, because the stub had
# already won the branch. So probe capability, not presence.
runtime_works() {
  case $1 in
    python3) python3 -c pass >/dev/null 2>&1 ;;
    node) node -e "" >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

read_json_string() {
  local field=$1 payload=$2 value
  if command -v python3 >/dev/null 2>&1 && runtime_works python3; then
    OC_JSON_PAYLOAD=$payload OC_JSON_FIELD=$field python3 <<'PY'
import json, os, sys

try:
    data = json.loads(os.environ["OC_JSON_PAYLOAD"])
except Exception:
    sys.exit(1)
value = data.get(os.environ["OC_JSON_FIELD"]) if isinstance(data, dict) else None
if not isinstance(value, str) or not value:
    sys.exit(1)
sys.stdout.write(value)
PY
    return $?
  fi
  if command -v node >/dev/null 2>&1 && runtime_works node; then
    OC_JSON_PAYLOAD=$payload OC_JSON_FIELD=$field node <<'JS'
let data;
try { data = JSON.parse(process.env.OC_JSON_PAYLOAD); } catch { process.exit(1); }
const value = data && typeof data === "object" ? data[process.env.OC_JSON_FIELD] : null;
if (typeof value !== "string" || !value) process.exit(1);
process.stdout.write(value);
JS
    return $?
  fi
  value=$(printf '%s' "$payload" | sed -n 's/.*"'"$field"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
  [[ -n "$value" ]] || return 1
  printf '%s' "$value"
}

# Trades a one-time pairing code for the real bearer token. The code is what
# the board printed in the copyable command, which is why it may be six digits
# on a shared screen and the token may not: it is single use, short lived, and
# worthless once spent. Nothing here echoes either value.
exchange_pairing_code() {
  local code=$1 response
  if ! command -v curl >/dev/null 2>&1; then
    printf '%s\n' "curl is required to exchange an OverClick pairing code." >&2
    return 1
  fi
  # Not `-f`: it collapses "the code was refused", "the instance is broken"
  # and "the network is down" into one exit status, and the caller then blamed
  # all three on an expired code -- sending users to burn a fresh code against
  # a 500 that no code could satisfy. Read the status and say which happened;
  # the server's own JSON error is more specific than anything invented here.
  local body status
  body=$(mktemp) || return 1
  status=$(curl -sS -o "$body" -w '%{http_code}' -X POST "$instance_base/api/pair"     -H 'Content-Type: application/json'     -d "{\"code\":\"$code\"}" 2>/dev/null) || status=000
  response=$(cat "$body" 2>/dev/null)
  rm -f "$body"

  case $status in
    2*) ;;
    000)
      printf '%s
' "Could not reach $instance_base to exchange the pairing code. Check the URL, the network, and that the instance is up." >&2
      return 1 ;;
    5*)
      printf '%s
' "The instance answered HTTP $status while exchanging the pairing code. The code was NOT spent: this is a fault on the board, not a stale code. Check the server logs." >&2
      [ -n "$response" ] && printf '%s
' "  response: $response" >&2
      return 1 ;;
    *)
      local detail
      detail=$(read_json_string error "$response" 2>/dev/null) || detail=""
      printf '%s
' "${detail:-The board refused the pairing code (HTTP $status).}" >&2
      return 1 ;;
  esac

  if ! read_json_string token "$response"; then
    printf '%s
' "The board accepted the pairing code, but the token could not be read out of its reply. The code is now spent -- generate a fresh one. Install python3 or node so the installer can parse JSON." >&2
    return 1
  fi
}

if [[ -n "${OVERCLICK_TOKEN:-}" ]]; then
  token=$OVERCLICK_TOKEN
elif [[ -n "${OVERCLICK_PAIRING_CODE:-}" ]]; then
  pairing_code=$OVERCLICK_PAIRING_CODE
  if [[ ! "$pairing_code" =~ ^[0-9]{6}$ ]]; then
    printf '%s\n' "An OverClick pairing code is exactly six digits." >&2
    exit 1
  fi
  # No blanket message here: exchange_pairing_code already said which failure
  # mode happened, and overwriting it with "the code expired" is precisely what
  # pointed the diagnosis at the one part that was working correctly.
  if ! token=$(exchange_pairing_code "$pairing_code"); then
    exit 1
  fi
  printf '%s\n' "Paired with the OverClick instance. The token was not displayed."
else
  read -r -s -p "OverClick token: " token </dev/tty
  printf '\n' >/dev/tty
fi

if [[ -z "$token" ]]; then
  printf '%s\n' "A token is required." >&2
  exit 1
fi
if [[ "$token" == *$'\n'* || "$token" == *$'\r'* ]]; then
  printf '%s\n' "The token must fit on one line." >&2
  exit 1
fi

plugin_src="$overclick_root/plugin-src"

# `:-` because the headline install is `curl … | sh`, where the script has no
# source file and `set -u` turns the lookup into a stderr line the reader is
# right to distrust. Empty here just means "no checkout beside me", which is
# what the clone path below already handles.
script_dir=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]:-}")" 2>/dev/null && pwd || true)
if [[ -f "$script_dir/plugin/OVERCLICK.md" ]]; then
  source_root=$script_dir
elif [[ -n "${OVERCLICK_PLUGIN_DIR:-}" && -f "$OVERCLICK_PLUGIN_DIR/OVERCLICK.md" ]]; then
  source_root=$(CDPATH='' cd -- "$OVERCLICK_PLUGIN_DIR/.." && pwd)
else
  # This installer serves a local directory marketplace instead of a
  # `source github` entry because it injects the user's instance URL and token
  # into the package's .mcp.json, and only a private local copy can carry
  # that. (OCL-103: `source github` itself works; the ghost install blamed on
  # it in OCL-76 was manifest version drift. Users who only want the plugin can
  # `claude plugin marketplace add ustoppble/overclick` directly.) The checkout
  # is kept rather than re-cloned so re-running install.sh doubles as the
  # update path: git fetch + reset, not a fresh ephemeral clone every run.
  if ! command -v git >/dev/null 2>&1; then
    printf '%s\n' "git is required to fetch the OverClick plugin package." >&2
    exit 1
  fi
  case "$plugin_source" in
    http://*|https://*|git@*|file://*) clone_url=$plugin_source ;;
    *) clone_url="https://github.com/$plugin_source.git" ;;
  esac
  mkdir -p "$overclick_root"
  if [[ -d "$plugin_src/.git" ]]; then
    if ! git -C "$plugin_src" fetch --depth 1 origin >/dev/null 2>&1 || \
      ! git -C "$plugin_src" reset --hard origin/HEAD >/dev/null 2>&1; then
      printf '%s\n' "Could not update the local OverClick plugin checkout at $plugin_src." >&2
      exit 1
    fi
  else
    rm -rf -- "$plugin_src"
    if ! git clone --depth 1 "$clone_url" "$plugin_src" >/dev/null 2>&1; then
      printf '%s\n' "Could not clone the OverClick plugin package." >&2
      exit 1
    fi
  fi
  source_root="$plugin_src"
fi

if [[ ! -f "$source_root/plugin/.codex-plugin/plugin.json" || ! -f "$source_root/plugin/OVERCLICK.md" ]]; then
  printf '%s\n' "The retrieved package is missing required plugin files." >&2
  exit 1
fi

mkdir -p "$plugin_target"
cp -R "$source_root/plugin/." "$plugin_target/"

enforce_stop=$(read_private_setting enforce_stop 2>/dev/null || printf '0')
enforce_harness=$(read_private_setting enforce_harness 2>/dev/null || printf '0')
enforce_claim=$(read_private_setting enforce_claim 2>/dev/null || printf '0')
cat >"$private_config" <<EOF
url=$mcp_url
token=$token
enforce_stop=$enforce_stop
enforce_harness=$enforce_harness
enforce_claim=$enforce_claim
EOF
chmod 600 "$private_config"

toml_quote() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  printf '"%s"' "$value"
}

replace_marked_block() {
  local file=$1 block=$2 directory temporary
  directory=$(dirname -- "$file")
  mkdir -p "$directory"
  temporary=$(mktemp "$directory/.overclick.XXXXXX")
  if [[ -f "$file" ]]; then
    awk '
      /<!-- overclick:start -->/ { skip=1; next }
      /<!-- overclick:end -->/ { skip=0; next }
      !skip { print }
    ' "$file" >"$temporary"
  fi
  if [[ -s "$temporary" ]]; then printf '\n' >>"$temporary"; fi
  printf '%s\n' "$block" >>"$temporary"
  mv "$temporary" "$file"
}

write_codex_mcp() {
  local file="$install_home/.codex/config.toml" directory temporary quoted_url quoted_header
  directory=$(dirname -- "$file")
  mkdir -p "$directory"
  temporary=$(mktemp "$directory/.config.XXXXXX")
  if [[ -f "$file" ]]; then
    awk '
      /^# overclick:start$/ { skip=1; next }
      /^# overclick:end$/ { skip=0; next }
      !skip { print }
    ' "$file" >"$temporary"
  fi
  quoted_url=$(toml_quote "$mcp_url")
  quoted_header=$(toml_quote "Bearer $token")
  if [[ -s "$temporary" ]]; then printf '\n' >>"$temporary"; fi
  {
    printf '%s\n' '# overclick:start'
    printf '%s\n' '[mcp_servers.overclick]'
    printf 'url = %s\n' "$quoted_url"
    printf 'http_headers = { Authorization = %s }\n' "$quoted_header"
    printf '%s\n' '# overclick:end'
  } >>"$temporary"
  mv "$temporary" "$file"
  chmod 600 "$file"
}

merge_json_config() {
  local mode=$1 file=$2 source_hooks=${3:-}
  mkdir -p "$(dirname -- "$file")"
  if command -v python3 >/dev/null 2>&1 && runtime_works python3; then
    OC_JSON_MODE=$mode OC_JSON_FILE=$file OC_MCP_URL=$mcp_url OC_MCP_TOKEN=$token \
      OC_HOOK_SOURCE=$source_hooks OC_PLUGIN_TARGET=$plugin_target python3 <<'PY'
import json, os, pathlib, tempfile

path = pathlib.Path(os.environ["OC_JSON_FILE"])
if path.exists():
    try:
        data = json.loads(path.read_text())
    except Exception as exc:
        raise SystemExit(f"Refusing to replace invalid JSON config: {exc}")
else:
    data = {}

mode = os.environ["OC_JSON_MODE"]
if mode == "mcp-kimi":
    # Kimi discriminates the transport on `transport`; a `type` key is dropped
    # and the transport re-inferred from the url.
    data.setdefault("mcpServers", {})["overclick"] = {
        "transport": "http",
        "url": os.environ["OC_MCP_URL"],
        "headers": {"Authorization": "Bearer " + os.environ["OC_MCP_TOKEN"]},
    }
elif mode == "mcp-antigravity":
    # Antigravity names the remote transport `serverUrl` and has no `type`
    # field; `agy mcp add --header ... <url>` writes exactly this shape.
    data.setdefault("mcpServers", {})["overclick"] = {
        "serverUrl": os.environ["OC_MCP_URL"],
        "headers": {"Authorization": "Bearer " + os.environ["OC_MCP_TOKEN"]},
        "disabled": False,
    }
elif mode in ("hooks", "hooks-no-claim-guard"):
    source = json.loads(pathlib.Path(os.environ["OC_HOOK_SOURCE"]).read_text())
    target = os.environ["OC_PLUGIN_TARGET"]
    hooks = data.setdefault("hooks", {})
    for event, rules in source.get("hooks", {}).items():
        kept = []
        for rule in hooks.get(event, []):
            commands = [h.get("command", "") for h in rule.get("hooks", [])]
            if not any("overclick" in command.lower() for command in commands):
                kept.append(rule)
        for rule in rules:
            if mode == "hooks-no-claim-guard" and any("claim-guard.mjs" in hook.get("command", "") for hook in rule.get("hooks", [])):
                continue
            serialized = json.dumps(rule).replace("${CLAUDE_PLUGIN_ROOT}", target)
            kept.append(json.loads(serialized))
        hooks[event] = kept

path.parent.mkdir(parents=True, exist_ok=True)
fd, temp_name = tempfile.mkstemp(prefix=".overclick-", dir=path.parent)
with os.fdopen(fd, "w") as handle:
    json.dump(data, handle, indent=2)
    handle.write("\n")
os.replace(temp_name, path)
os.chmod(path, 0o600)
PY
    return
  fi

  if command -v node >/dev/null 2>&1 && runtime_works node; then
    OC_JSON_MODE=$mode OC_JSON_FILE=$file OC_MCP_URL=$mcp_url OC_MCP_TOKEN=$token \
      OC_HOOK_SOURCE=$source_hooks OC_PLUGIN_TARGET=$plugin_target node <<'JS'
const fs = require("node:fs");
const path = require("node:path");
const file = process.env.OC_JSON_FILE;
let data = {};
if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, "utf8"));
if (process.env.OC_JSON_MODE === "mcp-kimi") {
  data.mcpServers ??= {};
  data.mcpServers.overclick = {
    transport: "http",
    url: process.env.OC_MCP_URL,
    headers: { Authorization: "Bearer " + process.env.OC_MCP_TOKEN },
  };
} else if (process.env.OC_JSON_MODE === "mcp-antigravity") {
  data.mcpServers ??= {};
  data.mcpServers.overclick = {
    serverUrl: process.env.OC_MCP_URL,
    headers: { Authorization: "Bearer " + process.env.OC_MCP_TOKEN },
    disabled: false,
  };
} else {
  const source = JSON.parse(fs.readFileSync(process.env.OC_HOOK_SOURCE, "utf8"));
  data.hooks ??= {};
  for (const [event, rules] of Object.entries(source.hooks ?? {})) {
    const kept = (data.hooks[event] ?? []).filter(rule =>
      !(rule.hooks ?? []).some(h => (h.command ?? "").toLowerCase().includes("overclick"))
    );
    const selected = process.env.OC_JSON_MODE === "hooks-no-claim-guard"
      ? rules.filter(rule => !(rule.hooks ?? []).some(hook => (hook.command ?? "").includes("claim-guard.mjs")))
      : rules;
    const serialized = JSON.stringify(selected).split("${CLAUDE_PLUGIN_ROOT}").join(process.env.OC_PLUGIN_TARGET);
    data.hooks[event] = [...kept, ...JSON.parse(serialized)];
  }
}
fs.mkdirSync(path.dirname(file), { recursive: true });
const temp = file + ".overclick-" + process.pid;
fs.writeFileSync(temp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
fs.renameSync(temp, file);
fs.chmodSync(file, 0o600);
JS
    return
  fi

  printf '%s\n' "A JSON runtime is required to merge existing agent configuration safely." >&2
  return 1
}

# OCL-114: the package used to declare its own `overclick` MCP server on top of
# the one registered in each CLI's own configuration below. Every install
# therefore produced two servers of the same name per CLI - and, because the
# repository template carries an unexpanded ${OVERCLICK_URL}, the plugin-level
# one is dead for anyone who installs straight from a marketplace instead of
# through this script. Each CLI now gets exactly one registration, written where
# that CLI keeps its own servers, and the package ships none. Antigravity is the
# exception below: its plugin manifest is the only channel it reads.

native_marketplace="$overclick_root/native-marketplace"
mkdir -p "$native_marketplace/.claude-plugin" "$native_marketplace/.grok-plugin" "$native_marketplace/plugin"
cp "$source_root/.claude-plugin/marketplace.json" "$native_marketplace/.claude-plugin/marketplace.json"
cp "$source_root/.grok-plugin/marketplace.json" "$native_marketplace/.grok-plugin/marketplace.json"
cp -R "$plugin_target/." "$native_marketplace/plugin/"

if [[ -n "${OVERCLICK_CLIS:-}" ]]; then
  detected_clis=",${OVERCLICK_CLIS// /},"
else
  detected_clis=","
  # Antigravity ships its CLI as `agy`, and its own installer puts it in
  # ~/.local/bin, which is not always on PATH for a non-login shell.
  if command -v agy >/dev/null 2>&1 || [[ -x "$install_home/.local/bin/agy" ]]; then
    detected_clis+="agy,"
  fi
  for candidate in claude codex grok kimi; do
    if command -v "$candidate" >/dev/null 2>&1; then
      detected_clis+="$candidate,"
    fi
  done
fi

has_cli() {
  [[ "$detected_clis" == *",$1,"* ]]
}

# A server already named `overclick` in a CLI is somebody's board. Answering
# "yes" here only for one that points somewhere else keeps a re-run against the
# same instance a plain credential refresh, while a run pointed at a different
# instance stops instead of silently taking the name over (OCL-114). The listing
# carries an Authorization header, so it is matched and discarded, never printed.
foreign_mcp_registration() {
  local existing
  existing=$("$@" 2>/dev/null) || return 1
  [[ -n "$existing" ]] || return 1
  printf '%s' "$existing" | grep -Fq "$mcp_url" && return 1
  return 0
}

quiet_try() {
  local label=$1
  shift
  if "$@" >/dev/null 2>&1; then
    printf '%s\n' "$label configured."
  else
    printf '%s\n' "$label needs manual confirmation in its native plugin manager." >&2
  fi
}

# "Successfully installed" only means the CLI accepted the command. The OCL-76
# ghost install exited 0 while the plugin the user ended up with was a stale
# cache directory from an earlier version. Ask the CLI what it actually has on
# disk instead of trusting exit codes.
verify_claude_plugin() {
  local listing
  listing=$(claude plugin list --json 2>/dev/null) || return 1
  if command -v python3 >/dev/null 2>&1 && runtime_works python3; then
    printf '%s' "$listing" | python3 -c '
import json, sys
try:
    plugins = json.load(sys.stdin)
except Exception:
    sys.exit(1)
for entry in plugins:
    if str(entry.get("id", "")).startswith("overclick@") and entry.get("enabled"):
        print(entry.get("installPath", ""))
        sys.exit(0)
sys.exit(1)
'
    return $?
  fi
  if command -v node >/dev/null 2>&1 && runtime_works node; then
    printf '%s' "$listing" | node -e '
let data = "";
process.stdin.on("data", chunk => { data += chunk; });
process.stdin.on("end", () => {
  let plugins;
  try { plugins = JSON.parse(data); } catch { process.exit(1); }
  const found = plugins.find(p => String(p.id || "").startsWith("overclick@") && p.enabled);
  if (!found) process.exit(1);
  process.stdout.write(String(found.installPath || ""));
});
'
    return $?
  fi
  return 1
}

# Same reasoning as verify_claude_plugin: `codex plugin add` prints a success
# line even when the marketplace layout is wrong, so ask Codex what it holds.
verify_codex_plugin() {
  local listing
  listing=$(codex plugin list --json 2>/dev/null) || return 1
  if command -v python3 >/dev/null 2>&1 && runtime_works python3; then
    printf '%s' "$listing" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(1)
for entry in data.get("installed", []):
    if entry.get("name") == "overclick" and entry.get("installed") and entry.get("enabled"):
        print((entry.get("source") or {}).get("path", ""))
        sys.exit(0)
sys.exit(1)
'
    return $?
  fi
  return 1
}

validation_failed=0

if has_cli claude; then
  if claude plugin marketplace add "$native_marketplace" --scope user >/dev/null 2>&1 || \
    claude plugin marketplace update overclick >/dev/null 2>&1; then
    printf '%s\n' "Claude marketplace configured."
  else
    printf '%s\n' "Claude marketplace needs manual confirmation in its native plugin manager." >&2
  fi
  if claude plugin install overclick@overclick --scope user >/dev/null 2>&1 || \
    claude plugin update overclick@overclick --scope user >/dev/null 2>&1; then
    printf '%s\n' "Claude plugin configured."
  else
    printf '%s\n' "Claude plugin needs manual confirmation in its native plugin manager." >&2
  fi
  if foreign_mcp_registration claude mcp get overclick; then
    printf '%s\n' "Claude already has an MCP server named overclick pointing at a different instance; it was left untouched. Remove it with 'claude mcp remove overclick' and re-run this installer to move to this board." >&2
  else
    claude mcp remove overclick --scope user >/dev/null 2>&1 || true
    # `--header` is variadic (`-H, --header <header...>`), so it eats every
    # argument that follows it - including the name and the URL, which is why
    # this call used to die on "missing required argument 'name'" while
    # quiet_try reported it as something to confirm by hand. The positionals
    # have to come first (OCL-114).
    quiet_try "Claude MCP" claude mcp add --transport http --scope user \
      overclick "$mcp_url" --header "Authorization: Bearer $token"
  fi
  claude_block=$(printf '%s\n' '<!-- overclick:start -->' "@$plugin_target/OVERCLICK.md" '<!-- overclick:end -->')
  replace_marked_block "$install_home/.claude/CLAUDE.md" "$claude_block"

  claude_install_path=$(verify_claude_plugin) || claude_install_path=""
  if [[ -n "$claude_install_path" && -f "$claude_install_path/OVERCLICK.md" ]]; then
    printf '%s\n' "Claude plugin verified: enabled and materialized at $claude_install_path."
  else
    printf '%s\n' "Claude plugin did not materialize: 'claude plugin list --json' shows no enabled overclick entry with OVERCLICK.md on disk. Do not trust the earlier \"configured\" messages; retry or install manually." >&2
    validation_failed=1
  fi
fi

if has_cli codex; then
  codex_marketplace="$overclick_root/codex-marketplace"
  # Codex resolves each plugin `source.path` against the MARKETPLACE ROOT, not
  # against the directory holding marketplace.json. The manifest below says
  # "./plugins/overclick", so the payload has to live at <root>/plugins/overclick;
  # copying it next to the manifest makes `codex plugin add` fail with
  # "plugin source path is not a directory".
  codex_plugin="$codex_marketplace/plugins/overclick"
  mkdir -p "$codex_plugin" "$codex_marketplace/.agents/plugins"
  cp -R "$plugin_target/." "$codex_plugin/"
  cat >"$codex_marketplace/.agents/plugins/marketplace.json" <<'JSON'
{
  "name": "overclick",
  "interface": { "displayName": "OverClick" },
  "plugins": [
    {
      "name": "overclick",
      "source": { "source": "local", "path": "./plugins/overclick" },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
      "category": "Productivity"
    }
  ]
}
JSON
  # `codex` refuses to load its configuration when CODEX_HOME does not exist,
  # so every plugin call below would fail on a machine where codex is installed
  # but has never been run.
  mkdir -p "$install_home/.codex"
  quiet_try "Codex marketplace" codex plugin marketplace add "$codex_marketplace"
  quiet_try "Codex plugin" codex plugin add overclick@overclick
  write_codex_mcp

  codex_install_path=$(verify_codex_plugin) || codex_install_path=""
  if [[ -n "$codex_install_path" && -f "$codex_install_path/OVERCLICK.md" ]]; then
    printf '%s\n' "Codex plugin verified: enabled and materialized at $codex_install_path."
  else
    printf '%s\n' "Codex plugin did not materialize: 'codex plugin list --json' shows no enabled overclick entry with OVERCLICK.md on disk. Do not trust the earlier \"configured\" messages; retry or install manually." >&2
    validation_failed=1
  fi
  # Codex has no supported client-side claim guard. Keep the existing lifecycle
  # integrations, while claim enforcement remains on the board for this CLI.
  merge_json_config hooks-no-claim-guard "$install_home/.codex/hooks.json" "$plugin_target/hooks/hooks.json"
fi

if has_cli grok; then
  if grok plugin marketplace add "$native_marketplace" >/dev/null 2>&1 || \
    grok plugin marketplace update overclick >/dev/null 2>&1; then
    printf '%s\n' "Grok marketplace configured."
  else
    printf '%s\n' "Grok marketplace needs manual confirmation in its native plugin manager." >&2
  fi
  if grok plugin install "$plugin_target" --trust >/dev/null 2>&1 || \
    grok plugin update overclick >/dev/null 2>&1; then
    printf '%s\n' "Grok plugin configured."
  else
    printf '%s\n' "Grok plugin needs manual confirmation in its native plugin manager." >&2
  fi
  if foreign_mcp_registration grok mcp get overclick; then
    printf '%s\n' "Grok already has an MCP server named overclick pointing at a different instance; it was left untouched. Remove it with 'grok mcp remove overclick' and re-run this installer to move to this board." >&2
  else
    grok mcp remove --scope user >/dev/null 2>&1 || true
    # Same variadic `--header` as Claude: name and URL before it.
    quiet_try "Grok MCP" grok mcp add --transport http --scope user \
      overclick "$mcp_url" --header "Authorization: Bearer $token"
  fi
fi

# Kimi Code has no non-interactive plugin subcommand: `/plugins install` is a TUI
# slash command, and `--prompt` hands slash commands to the model instead of the
# host (and refuses to combine with --auto/--yolo at all). So we write Kimi's own
# plugin registry directly, the same way its manager does: copy the payload to
# plugins/managed/<id> and register it in plugins/installed.json, preserving any
# other installed plugin.
kimi_register_plugin() {
  local kimi_home=${KIMI_CODE_HOME:-$install_home/.kimi-code}
  local managed="$kimi_home/plugins/managed/overclick"

  mkdir -p "$kimi_home/plugins/managed" || return 1
  rm -rf "$managed" || return 1
  cp -R "$plugin_target" "$managed" || return 1

  OC_KIMI_INSTALLED="$kimi_home/plugins/installed.json" OC_KIMI_ROOT="$managed" \
    OC_PLUGIN_TARGET="$plugin_target" python3 <<'KIMIPY'
import json, os, pathlib, tempfile
from datetime import datetime, timezone

path = pathlib.Path(os.environ["OC_KIMI_INSTALLED"])
data = {"version": 1, "plugins": []}
if path.exists():
    try:
        loaded = json.loads(path.read_text())
    except Exception as exc:
        raise SystemExit(f"Refusing to replace invalid Kimi plugin registry: {exc}")
    if isinstance(loaded, dict) and isinstance(loaded.get("plugins"), list):
        data = loaded

now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
previous = next((p for p in data["plugins"] if p.get("id") == "overclick"), {})
plugins = [p for p in data["plugins"] if p.get("id") != "overclick"]
plugins.append({
    "id": "overclick",
    "root": os.environ["OC_KIMI_ROOT"],
    "source": "local-path",
    "enabled": previous.get("enabled", True),
    "installedAt": previous.get("installedAt", now),
    "updatedAt": now,
    "originalSource": os.environ["OC_PLUGIN_TARGET"],
})
data["plugins"] = plugins

path.parent.mkdir(parents=True, exist_ok=True)
fd, temp_name = tempfile.mkstemp(prefix=".overclick-", dir=path.parent)
with os.fdopen(fd, "w") as handle:
    json.dump(data, handle, indent=2)
    handle.write("\n")
os.replace(temp_name, path)
os.chmod(path, 0o600)
KIMIPY
}

if has_cli kimi; then
  merge_json_config mcp-kimi "$install_home/.kimi-code/mcp.json"
  if command -v python3 >/dev/null 2>&1 && runtime_works python3 && kimi_register_plugin; then
    printf '%s\n' "Kimi plugin configured."
  else
    printf '%s\n' "Kimi plugin needs manual confirmation: run /plugins install $plugin_target inside Kimi Code." >&2
  fi
fi

if has_cli agy; then
  if command -v agy >/dev/null 2>&1; then
    agy_bin=agy
  else
    agy_bin="$install_home/.local/bin/agy"
  fi
  # `agy plugin install` copies the directory it is given into
  # ~/.gemini/config/plugins/<name>, so the staged copy is what carries the
  # credentials and the resolved rule path, and the repository package stays a
  # generic template.
  agy_stage="$overclick_root/antigravity/overclick"
  agy_installed="$install_home/.gemini/config/plugins/overclick"
  rm -rf -- "$agy_stage"
  mkdir -p "$agy_stage"
  cp -R "$plugin_target/." "$agy_stage/"
  merge_json_config mcp-antigravity "$agy_stage/mcp_config.json"
  chmod 600 "$agy_stage/mcp_config.json"
  agy_rule_block=$(printf '%s\n' '<!-- overclick:start -->' \
    "Read and follow $agy_installed/OVERCLICK.md for all OverClick board work." \
    '<!-- overclick:end -->')
  replace_marked_block "$agy_stage/rules/AGENTS.md" "$agy_rule_block"
  quiet_try "Antigravity plugin" "$agy_bin" plugin install "$agy_stage"
  "$agy_bin" plugin enable overclick >/dev/null 2>&1 || true
  # The manager copies the staged directory, so the credentials land in a second
  # place and need the same mode-600 the staged copy already has.
  if [[ -f "$agy_installed/mcp_config.json" ]]; then
    chmod 600 "$agy_installed/mcp_config.json"
  fi

  if "$agy_bin" plugin list 2>/dev/null | grep -q '"overclick"' && \
    [[ -f "$agy_installed/OVERCLICK.md" ]]; then
    printf '%s\n' "Antigravity plugin verified: imported and materialized at $agy_installed."
  else
    printf '%s\n' "Antigravity plugin did not materialize: 'agy plugin list' shows no overclick entry with OVERCLICK.md on disk. Retry or install manually." >&2
    validation_failed=1
  fi
fi

if [[ "${OVERCLICK_AGENTS_FALLBACK:-0}" = "1" ]] || \
  { ! has_cli claude && ! has_cli codex && ! has_cli grok && ! has_cli kimi && ! has_cli agy; }; then
  agents_block=$(printf '%s\n' '<!-- overclick:start -->' "Read and follow $plugin_target/OVERCLICK.md for all OverClick board work." '<!-- overclick:end -->')
  replace_marked_block "$project_dir/AGENTS.md" "$agents_block"
  printf '%s\n' "No plugin-capable CLI was detected; the AGENTS.md fallback was installed."
fi

if [[ "$validation_failed" = "1" ]]; then
  printf '%s\n' "OverClick plugin installation finished with unverified components; see warnings above. Credentials were stored privately and were not displayed." >&2
  exit 1
fi

printf '%s\n' "OverClick plugin installation complete. Credentials were stored privately and were not displayed."
