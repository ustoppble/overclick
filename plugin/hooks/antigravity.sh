#!/bin/sh
# Antigravity (`agy`) speaks a different hook dialect than the other CLIs, so
# this adapter is the only Antigravity-specific piece: it rewrites the incoming
# payload into the shape the shared OverClick hooks already understand, runs
# them unchanged, and rewrites their answer back.
#
# Differences that forced an adapter, all verified hands-on against agy:
#   * tool names are Antigravity step types (run_command, write_to_file,
#     replace_file_content, call_mcp_tool), and every MCP call arrives as
#     call_mcp_tool with the real tool under toolCall.args.ToolName;
#   * PreToolUse must answer with an explicit decision — an empty object is
#     read as a denial, so silence is not an option;
#   * PostToolUse never carries the tool response, only the call and an error
#     string, so anything that needed the response has to read the arguments;
#   * SessionStart does not exist; PreInvocation is the closest event and it
#     fires on every model call, so the snapshot is gated on invocationNum 0;
#   * hooks run with the plugin directory as their working directory, so the
#     repository has to be recovered from the payload.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)

event=${1:-}
payload=$(cat)

# Fail open. A guard that cannot parse its input must not become a wall between
# the agent and the repository; the board still enforces the same rules.
oc_agy_allow() {
  printf '%s\n' '{"decision":"allow"}'
  exit 0
}

oc_agy_normalize() {
  if command -v python3 >/dev/null 2>&1; then
    OC_AGY_WORKSPACE=${OVERCLICK_WORKSPACE:-} python3 -c '
import json, os, sys

try:
    data = json.load(sys.stdin)
except ValueError:
    data = {}

call = data.get("toolCall") or {}
args = call.get("args") or {}
agy_tool = call.get("name") or ""

if agy_tool == "call_mcp_tool":
    tool_name = args.get("ToolName") or ""
    tool_input = args.get("Arguments") or {}
elif agy_tool == "run_command":
    tool_name = "Bash"
    tool_input = {"command": args.get("CommandLine") or ""}
elif agy_tool == "write_to_file":
    tool_name = "Write"
    tool_input = {"file_path": args.get("TargetFile") or ""}
elif agy_tool in ("replace_file_content", "edit_notebook"):
    tool_name = "Edit"
    tool_input = {"file_path": args.get("TargetFile") or ""}
else:
    tool_name = agy_tool
    tool_input = {}

workspaces = data.get("workspacePaths") or []
hint = workspaces[0] if workspaces else ""
if not hint:
    hint = os.environ.get("OC_AGY_WORKSPACE", "")
if not hint:
    target = args.get("TargetFile") or ""
    hint = os.path.dirname(target) if target else ""
if not hint:
    hint = args.get("Cwd") or ""

print(json.dumps({
    "tool_name": tool_name,
    "agy_tool": agy_tool,
    "session_id": data.get("conversationId") or "",
    "cwd": "",
    "tool_input": tool_input,
    "tool_response": {},
    "invocation_num": data.get("invocationNum") or 0,
    "error": data.get("error") or "",
    "termination_reason": data.get("terminationReason") or "",
    "workspace_hint": hint,
}, separators=(",", ":")))
'
    return
  fi

  if command -v node >/dev/null 2>&1; then
    # shellcheck disable=SC2016
    OC_AGY_WORKSPACE=${OVERCLICK_WORKSPACE:-} node -e '
let raw="";process.stdin.on("data",c=>raw+=c).on("end",()=>{
 let d={};try{d=JSON.parse(raw)}catch{}
 const call=d.toolCall??{},args=call.args??{},agy=call.name??"";
 let toolName,toolInput;
 if(agy==="call_mcp_tool"){toolName=args.ToolName??"";toolInput=args.Arguments??{};}
 else if(agy==="run_command"){toolName="Bash";toolInput={command:args.CommandLine??""};}
 else if(agy==="write_to_file"){toolName="Write";toolInput={file_path:args.TargetFile??""};}
 else if(agy==="replace_file_content"||agy==="edit_notebook"){toolName="Edit";toolInput={file_path:args.TargetFile??""};}
 else {toolName=agy;toolInput={};}
 let hint=(d.workspacePaths??[])[0]??"";
 if(!hint) hint=process.env.OC_AGY_WORKSPACE??"";
 if(!hint&&args.TargetFile) hint=require("node:path").dirname(args.TargetFile);
 if(!hint) hint=args.Cwd??"";
 console.log(JSON.stringify({tool_name:toolName,agy_tool:agy,session_id:d.conversationId??"",cwd:"",
  tool_input:toolInput,tool_response:{},invocation_num:d.invocationNum??0,error:d.error??"",
  termination_reason:d.terminationReason??"",workspace_hint:hint}));
});'
    return
  fi

  return 1
}

oc_agy_field() {
  oc_agy_key=$1
  if command -v python3 >/dev/null 2>&1; then
    OC_AGY_KEY=$oc_agy_key python3 -c '
import json, os, sys
try:
    print(json.load(sys.stdin).get(os.environ["OC_AGY_KEY"], ""))
except ValueError:
    print("")
'
    return
  fi
  if command -v node >/dev/null 2>&1; then
    # shellcheck disable=SC2016
    OC_AGY_KEY=$oc_agy_key node -e '
let raw="";process.stdin.on("data",c=>raw+=c).on("end",()=>{
 try{console.log(JSON.parse(raw)[process.env.OC_AGY_KEY]??"")}catch{console.log("")}});'
    return
  fi
  printf '\n'
}

# The claim marker belongs next to the code, not next to the plugin. Antigravity
# leaves workspacePaths empty in print mode, so the repository is recovered from
# whatever path the call itself mentioned.
oc_agy_repo_root() {
  oc_agy_hint=$1
  [ -n "$oc_agy_hint" ] || return 1
  [ -d "$oc_agy_hint" ] || oc_agy_hint=$(dirname -- "$oc_agy_hint")
  [ -d "$oc_agy_hint" ] || return 1
  git -C "$oc_agy_hint" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$oc_agy_hint"
}

oc_agy_reason() {
  oc_agy_text=$1
  printf '%s' "$oc_agy_text" | tr '\n' ' ' | sed -e 's/.*"reason"[[:space:]]*:[[:space:]]*"//' -e 's/".*//'
}

oc_agy_escape() {
  printf '%s' "$1" | tr '\n' ' ' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

normalized=$(printf '%s' "$payload" | oc_agy_normalize 2>/dev/null || true)
if [ -z "$normalized" ]; then
  case "$event" in
    pre-tool) oc_agy_allow ;;
    *) printf '%s\n' '{}'; exit 0 ;;
  esac
fi

workspace_hint=$(printf '%s' "$normalized" | oc_agy_field workspace_hint 2>/dev/null || true)
repo_root=$(oc_agy_repo_root "$workspace_hint" 2>/dev/null || true)
if [ -n "$repo_root" ] && command -v python3 >/dev/null 2>&1; then
  normalized=$(printf '%s' "$normalized" | OC_AGY_ROOT=$repo_root python3 -c '
import json, os, sys
data = json.load(sys.stdin)
data["cwd"] = os.environ["OC_AGY_ROOT"]
print(json.dumps(data, separators=(",", ":")))
')
elif [ -n "$repo_root" ] && command -v node >/dev/null 2>&1; then
  # shellcheck disable=SC2016
  normalized=$(printf '%s' "$normalized" | OC_AGY_ROOT=$repo_root node -e '
let raw="";process.stdin.on("data",c=>raw+=c).on("end",()=>{
 const d=JSON.parse(raw);d.cwd=process.env.OC_AGY_ROOT;console.log(JSON.stringify(d));});')
fi

tool_name=$(printf '%s' "$normalized" | oc_agy_field tool_name 2>/dev/null || true)
tool_error=$(printf '%s' "$normalized" | oc_agy_field error 2>/dev/null || true)

case "$event" in
  pre-invocation)
    invocation=$(printf '%s' "$normalized" | oc_agy_field invocation_num 2>/dev/null || printf '1')
    [ "$invocation" = "0" ] || { printf '%s\n' '{}'; exit 0; }
    snapshot=$(node "$SCRIPT_DIR/session-start.mjs" </dev/null 2>/dev/null || true)
    [ -n "$snapshot" ] || { printf '%s\n' '{}'; exit 0; }
    printf '{"injectSteps":[{"ephemeralMessage":"%s"}]}\n' "$(oc_agy_escape "$snapshot")"
    ;;

  pre-tool)
    case "$tool_name" in
      task_create|mcp__*__task_create)
        verdict=$(printf '%s' "$normalized" | node "$SCRIPT_DIR/pre-create.mjs" 2>/dev/null || true)
        case "$verdict" in
          *'"decision":"block"'*)
            printf '{"decision":"deny","reason":"%s"}\n' "$(oc_agy_escape "$(oc_agy_reason "$verdict")")"
            ;;
          *) oc_agy_allow ;;
        esac
        ;;
      task_deliver|mcp__*__task_deliver)
        # Antigravity's PostToolUse has no channel back to the model, so the
        # push check moves ahead of the call. It asks instead of denying: the
        # blocking guards stay opt-in, and the human keeps the last word.
        # post-deliver.mjs inspects the repository through its own working
        # directory, and Antigravity starts hooks in the plugin directory.
        if complaint=$(cd "${repo_root:-.}" && printf '%s' "$normalized" | node "$SCRIPT_DIR/post-deliver.mjs" 2>&1 >/dev/null); then
          oc_agy_allow
        else
          [ -n "$complaint" ] || complaint="OverClick could not verify the delivered commit."
          printf '{"decision":"ask","reason":"%s"}\n' "$(oc_agy_escape "$complaint")"
        fi
        ;;
      Bash|Edit|Write)
        verdict=$(printf '%s' "$normalized" | node "$SCRIPT_DIR/claim-guard.mjs" 2>/dev/null || true)
        case "$verdict" in
          *'"decision":"block"'*)
            printf '{"decision":"deny","reason":"%s"}\n' "$(oc_agy_escape "$(oc_agy_reason "$verdict")")"
            ;;
          *) oc_agy_allow ;;
        esac
        ;;
      *) oc_agy_allow ;;
    esac
    ;;

  post-tool)
    if [ -z "$tool_error" ]; then
      case "$tool_name" in
        task_claim|mcp__*__task_claim|task_deliver|mcp__*__task_deliver|task_release|mcp__*__task_release)
          printf '%s' "$normalized" | node "$SCRIPT_DIR/claim-guard.mjs" >/dev/null 2>&1 || true
          ;;
      esac
    fi
    printf '%s\n' '{}'
    ;;

  stop)
    verdict=$(printf '%s' "$normalized" | node "$SCRIPT_DIR/stop-guard.mjs" 2>/dev/null || true)
    case "$verdict" in
      *'"decision":"block"'*)
        printf '{"decision":"continue","reason":"%s"}\n' "$(oc_agy_escape "$(oc_agy_reason "$verdict")")"
        ;;
      *) printf '%s\n' '{}' ;;
    esac
    ;;

  *)
    printf '%s\n' '{}'
    ;;
esac
