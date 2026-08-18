/**
 * Usage collection recipes: how each CLI can measure the run it just did.
 *
 * An agent can read its own session transcript and total the token counters
 * per model exactly. Nobody ever told it how, which is why field tests ended
 * with ten workers holding board tools and reporting nothing. The board keeps
 * the recipe so the briefing can hand it over at claim time, and so a CLI
 * changing its transcript format is fixed in one place instead of in every
 * agent's head.
 */

/** What a recipe can honestly produce. */
export type RecipeYield =
  /** Exact tokens grouped by model, straight from the CLI's own transcript. */
  | "tokens_per_model"
  /** No token counters on disk: the run reports time and turns, tokens estimated. */
  | "no_tokens";

export type UsageRecipe = {
  /** Executor catalog id the recipe belongs to, or GENERIC_RECIPE_CLI. */
  cli: string;
  label: string;
  yields: RecipeYield;
  /** Prose the agent reads before running anything. */
  instructions: string;
  /** The command to run, verbatim. Empty when there is nothing to run. */
  command: string;
};

/** Where a recipe came from: shipped with the board, or edited by a human. */
export type RecipeSource = "seed" | "custom";

export type UsageRecipeRow = UsageRecipe & {
  source: RecipeSource;
  updatedBy: string | null;
  updatedAt: string | null;
};

/** The recipe used when no CLI-specific one matches. */
export const GENERIC_RECIPE_CLI = "generic";

const CLAUDE_COMMAND = `python3 - <<'PY'
import collections, datetime, glob, json, os

# TRANSCRIPT_PATH pins one transcript, which is what the card's recompute
# button sets. Without it, Claude Code writes one jsonl per session under
# ~/.claude/projects/<cwd slug>.
path = os.environ.get("TRANSCRIPT_PATH")
claimed_at = os.environ.get("OVERCLICK_CLAIMED_AT")
if not path:
    folder = os.path.expanduser("~/.claude/projects/" + os.getcwd().replace("/", "-"))
    session = os.environ.get("CLAUDE_CODE_SESSION_ID")
    path = os.path.join(folder, session + ".jsonl") if session else max(
        glob.glob(folder + "/*.jsonl"), key=os.path.getmtime
    )

def at_or_after_claim(entry):
    if not claimed_at:
        return True
    value = entry.get("timestamp") or entry.get("created_at") or entry.get("createdAt")
    if value is None:
        return False
    try:
        at = datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        claim = datetime.datetime.fromisoformat(claimed_at.replace("Z", "+00:00"))
        return at >= claim
    except ValueError:
        return False

seg, turns = collections.defaultdict(collections.Counter), 0
for line in open(path):
    try:
        entry = json.loads(line)
    except ValueError:
        continue
    if not at_or_after_claim(entry):
        continue
    message = entry.get("message") or {}
    usage = message.get("usage")
    if not usage:
        continue
    turns += 1
    counter = seg[message.get("model") or "unknown"]
    counter["input"] += usage.get("input_tokens", 0)
    counter["output"] += usage.get("output_tokens", 0)
    counter["cache_read"] += usage.get("cache_read_input_tokens", 0)
    counter["cache_write"] += usage.get("cache_creation_input_tokens", 0)

print(json.dumps({
    "segments": [dict(model=model, **dict(counter)) for model, counter in seg.items()],
    "turns": turns,
    "transcript": path,
}, indent=2))
PY`;

const CODEX_COMMAND = `python3 - <<'PY'
import collections, datetime, glob, json, os, re

# TRANSCRIPT_PATH pins one transcript, which is what the card's recompute
# button sets. Without it, Codex writes one rollout jsonl per session under
# ~/.codex/sessions/<date>/. CODEX_SESSION_ID is bound from task_claim, so a
# busy repo never attributes the newest *other* pane's rollout to this card.
path = os.environ.get("TRANSCRIPT_PATH")
session = os.environ.get("CODEX_SESSION_ID") or os.environ.get("CODEX_THREAD_ID")
fallback_model = os.environ.get("CODEX_HARNESS_MODEL")
claimed_at = os.environ.get("OVERCLICK_CLAIMED_AT")

def model_slug(value):
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-") if value else ""

def unavailable(reason):
    print(json.dumps({
        "segments": [],
        "turns": 0,
        "estimated": True,
        "reason": reason + " Estimate usage and send estimated: true.",
    }, indent=2))

def at_or_after_claim(entry):
    if not claimed_at:
        return True
    value = entry.get("timestamp") or entry.get("created_at") or entry.get("createdAt")
    if value is None:
        return False
    try:
        at = datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        claim = datetime.datetime.fromisoformat(claimed_at.replace("Z", "+00:00"))
        return at >= claim
    except ValueError:
        return False

def belongs_to_session(candidate):
    if session in os.path.basename(candidate):
        return True
    try:
        with open(candidate) as handle:
            first = json.loads(handle.readline())
    except (OSError, ValueError):
        return False
    payload = first.get("payload") or {}
    return payload.get("id") == session or payload.get("session_id") == session

if not path:
    paths = glob.glob(os.path.expanduser("~/.codex/sessions/**/rollout-*.jsonl"), recursive=True)
    if not session:
        unavailable("No transcript path or Codex session id was available from task_claim.")
        raise SystemExit
    matches = [candidate for candidate in paths if belongs_to_session(candidate)]
    if not matches:
        unavailable("No readable Codex rollout matched the session id from task_claim.")
        raise SystemExit
    path = max(matches, key=os.path.getmtime)

if not os.path.isfile(path) or not os.access(path, os.R_OK):
    unavailable("The selected Codex rollout is missing or unreadable.")
    raise SystemExit

seg = collections.defaultdict(collections.Counter)
model, turns = model_slug(fallback_model), 0
with open(path) as handle:
    for line in handle:
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not at_or_after_claim(entry):
            continue
        payload = entry.get("payload") or {}
        if entry.get("type") == "turn_context" and payload.get("model"):
            model = model_slug(payload["model"])
        if payload.get("type") != "token_count":
            continue
        # last_token_usage is this model call's delta; total_token_usage is cumulative.
        usage = (payload.get("info") or {}).get("last_token_usage") or {}
        if not usage:
            continue
        if not model:
            unavailable("The rollout has token counters but neither it nor the card harness names a model.")
            raise SystemExit
        turns += 1
        counter = seg[model]
        cached = usage.get("cached_input_tokens", 0)
        counter["input"] += usage.get("input_tokens", 0) - cached
        counter["cache_read"] += cached
        counter["cache_write"] += usage.get("cache_write_input_tokens", 0)
        counter["output"] += usage.get("output_tokens", 0)

if not turns:
    unavailable("The Codex rollout contains no readable last_token_usage counters.")
    raise SystemExit

print(json.dumps({
    "segments": [dict(model=model, **dict(counter)) for model, counter in seg.items()],
    "turns": turns,
    "transcript": path,
    "estimated": False,
}, indent=2))
PY`;

const GROK_COMMAND = `python3 - <<'PY'
import collections, datetime, glob, json, os, urllib.parse

# TRANSCRIPT_PATH pins one transcript, which is what the card's recompute
# button sets. Without it, Grok writes one updates.jsonl per session under
# ~/.grok/sessions/<cwd percent-encoded>/<session uuid>/.
path = os.environ.get("TRANSCRIPT_PATH")
claimed_at = os.environ.get("OVERCLICK_CLAIMED_AT")
if not path:
    root = os.path.expanduser("~/.grok/sessions")
    folder = os.path.join(root, urllib.parse.quote(os.getcwd(), safe=""))
    session = os.environ.get("GROK_SESSION_ID")
    if session:
        path = os.path.join(folder, session, "updates.jsonl")
    else:
        here = glob.glob(folder + "/*/updates.jsonl")
        path = max(here or glob.glob(root + "/*/*/updates.jsonl"), key=os.path.getmtime)

def at_or_after_claim(entry):
    if not claimed_at:
        return True
    value = entry.get("timestamp") or entry.get("created_at") or entry.get("createdAt")
    if value is None:
        return False
    try:
        at = datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        claim = datetime.datetime.fromisoformat(claimed_at.replace("Z", "+00:00"))
        return at >= claim
    except ValueError:
        return False

seg, turns = collections.defaultdict(collections.Counter), 0
for line in open(path):
    try:
        entry = json.loads(line)
    except ValueError:
        continue
    if not at_or_after_claim(entry):
        continue
    update = (entry.get("params") or {}).get("update") or {}
    if update.get("sessionUpdate") != "turn_completed":
        continue
    usage = update.get("usage") or {}
    # A turn that ended on an error carries no usage. Counting it would put a
    # row of zeros where the honest answer is that nothing was spent.
    if not usage:
        continue
    turns += usage.get("numTurns") or usage.get("modelCalls", 0)
    # modelUsage splits the turn per model, which is what a session that
    # switched model needs; a turn without it is all one model.
    for model, block in (usage.get("modelUsage") or {"unknown": usage}).items():
        counter = seg[model]
        cached = block.get("cachedReadTokens", 0)
        # inputTokens already contains the cached read, so the plain input is
        # what is left after taking it out.
        counter["input"] += block.get("inputTokens", 0) - cached
        counter["cache_read"] += cached
        counter["cache_write"] += block.get("cacheCreationTokens", 0)
        counter["output"] += block.get("outputTokens", 0)

print(json.dumps({
    "segments": [dict(model=model, **dict(counter)) for model, counter in seg.items()],
    "turns": turns,
    "transcript": path,
}, indent=2))
PY`;

const KIMI_COMMAND = `python3 - <<'PY'
import collections, datetime, glob, json, os

# TRANSCRIPT_PATH pins one session directory, which is what the card's
# recompute button sets. Without it, the index Kimi keeps in its home maps
# every session to the directory it ran in, including sessions stored outside
# that home, so it beats globbing for them.
home = os.environ.get("KIMI_HOME") or os.path.expanduser("~/.kimi-code")
path = os.environ.get("TRANSCRIPT_PATH")
claimed_at = os.environ.get("OVERCLICK_CLAIMED_AT")
if not path:
    here, session = os.path.realpath(os.getcwd()), os.environ.get("KIMI_SESSION_ID")
    rows = []
    for line in open(os.path.join(home, "session_index.jsonl")):
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if not os.path.isdir(row.get("sessionDir", "")):
            continue
        if session and row.get("sessionId") != session:
            continue
        if not session and os.path.realpath(row.get("workDir", "")) != here:
            continue
        rows.append(row["sessionDir"])
    path = max(rows, key=os.path.getmtime)

# One wire log per agent: main plus every subagent it spawned, so the tokens a
# subagent spent land on the card that spawned it instead of nowhere.
logs = sorted(glob.glob(os.path.join(path, "agents", "*", "wire.jsonl")))
def at_or_after_claim(entry):
    if not claimed_at:
        return True
    value = entry.get("timestamp") or entry.get("created_at") or entry.get("createdAt")
    if value is None:
        return False
    try:
        at = datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        claim = datetime.datetime.fromisoformat(claimed_at.replace("Z", "+00:00"))
        return at >= claim
    except ValueError:
        return False

seg, turns = collections.defaultdict(collections.Counter), 0
for log in logs:
    for line in open(log):
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not at_or_after_claim(entry):
            continue
        # Kimi writes one record per model call with usageScope "turn", and a
        # cumulative "session" record at the end. Summing both counts the
        # session twice.
        if entry.get("type") != "usage.record" or entry.get("usageScope") != "turn":
            continue
        usage = entry.get("usage") or {}
        turns += 1
        counter = seg[entry.get("model") or "unknown"]
        counter["input"] += usage.get("inputOther", 0)
        counter["cache_read"] += usage.get("inputCacheRead", 0)
        counter["cache_write"] += usage.get("inputCacheCreation", 0)
        counter["output"] += usage.get("output", 0)

print(json.dumps({
    "segments": [dict(model=model, **dict(counter)) for model, counter in seg.items()],
    "turns": turns,
    "transcript": path,
}, indent=2))
PY`;

const SEED: UsageRecipe[] = [
  {
    cli: "claude-code",
    label: "Claude Code",
    yields: "tokens_per_model",
    instructions:
      "Run this from the repo you worked in. It reads your own session transcript from the claim boundary and prints tokens grouped by model, ready to paste into task_deliver as usage.segments. Numbers from the transcript are measured, not guessed, so deliver them without estimated. It also prints the transcript path: send it as transcript.path and the card links back to this run.",
    command: CLAUDE_COMMAND,
  },
  {
    cli: "codex",
    label: "Codex",
    yields: "tokens_per_model",
    instructions:
      "At task_claim, declare the exact model from this session's --model flag (for example gpt-5.6-sol), never the generic family label gpt-5. Run this from the repo you worked in. The board binds claimed_at, the session id and harness model declared at task_claim: the command reads that exact Codex rollout only from the claim boundary, attributes each model call to turn_context.payload.model, normalizes the model slug for pricing, and falls back to the harness model only when the rollout omits it. A readable rollout returns estimated: false. Only a missing or unreadable rollout returns estimated: true with a reason. Send the printed transcript path as transcript.path so the card links back to this run.",
    command: CODEX_COMMAND,
  },
  {
    cli: "gemini-cli",
    label: "Gemini CLI",
    yields: "no_tokens",
    instructions:
      "Gemini CLI keeps a chat transcript under ~/.gemini/tmp/<project>/chats but records no token counters in it, so there is nothing on disk to total. Report the duration and the turns you can count, estimate the tokens, and set estimated: true so the card labels them as an estimate instead of showing nothing. If your version starts writing usage into that transcript, fix this recipe once in Settings and every agent gets it.",
    command: "",
  },
  {
    cli: "grok",
    label: "Grok",
    yields: "tokens_per_model",
    instructions:
      "Run this from the repo you worked in. Grok closes every turn with a turn_completed line carrying usage.modelUsage, tokens already split per model, and this totals only entries from the claim boundary into usage.segments. inputTokens there includes the cached read, so the command subtracts it and reports input and cache_read apart, the way the board counts them. A turn that ended on an error carries no usage and is skipped, so an aborted session reports nothing instead of a row of zeros. It also prints the transcript path: send it as transcript.path and the card links back to this run.",
    command: GROK_COMMAND,
  },
  {
    cli: "kimi",
    label: "Kimi",
    yields: "tokens_per_model",
    instructions:
      "Run this from the repo you worked in. Kimi writes one usage.record per model call into the wire log of every agent in the session, main and subagents, and this totals only entries from the claim boundary per model for usage.segments. It reads only the records scoped to a turn: the cumulative session record at the end would count the whole run twice. The session is found through the index Kimi keeps in its home, which maps each session to the directory it ran in. It also prints the session path: send it as transcript.path and the card links back to this run.",
    command: KIMI_COMMAND,
  },
  {
    cli: GENERIC_RECIPE_CLI,
    label: "Any other CLI",
    yields: "no_tokens",
    instructions:
      "Look for your CLI's session transcript, usually a jsonl under a dot directory in your home, and total only entries at or after claimed_at, grouped by model. Work already present in the session is not part of this card. If nothing on disk records them, estimate the tokens, turns and duration and set estimated: true: an estimate the card labels beats silence. Found the format? Write the command into Settings so the next agent on this CLI gets it in the briefing.",
    command: "",
  },
];

/** The recipes the board ships with, before any workspace edit. */
export function factoryUsageRecipes(): UsageRecipeRow[] {
  return SEED.map((recipe) => ({
    ...recipe,
    source: "seed" as const,
    updatedBy: null,
    updatedAt: null,
  }));
}

/** One CLI in the coverage list: its own recipe, or the generic fallback. */
export type RecipeCoverage = {
  cli: string;
  label: string;
  /** False when nothing names this CLI and the generic recipe answers for it. */
  covered: boolean;
};

/**
 * Which of the CLIs a workspace actually runs have a recipe of their own.
 *
 * A CLI with no recipe still gets an answer, the generic one, which asks the
 * agent to go looking and estimate. That is silent: the card comes back with an
 * estimate and nothing says the exact numbers were sitting in a transcript
 * nobody read. Listing the fallbacks makes the cost of a missing recipe visible
 * at the one place somebody can fix it.
 */
export function recipeCoverage(
  recipes: readonly UsageRecipe[],
  executors: readonly { id: string; label: string }[],
): RecipeCoverage[] {
  const own = new Set(
    recipes
      .map((recipe) => recipe.cli.trim().toLowerCase())
      .filter((cli) => cli !== GENERIC_RECIPE_CLI),
  );
  const seen = new Set<string>();
  const rows: RecipeCoverage[] = [];
  for (const executor of executors) {
    const cli = executor.id.trim().toLowerCase();
    if (!cli || seen.has(cli)) continue;
    seen.add(cli);
    rows.push({ cli, label: executor.label, covered: own.has(cli) });
  }
  return rows;
}

/**
 * The recipe for a CLI, falling back to the generic one. `cli` is expected to
 * be a catalog id already: the caller resolves the name an agent sends
 * ("claude") to the id the board stores ("claude-code").
 */
export function findUsageRecipe<T extends UsageRecipe>(
  recipes: readonly T[],
  cli: string | null | undefined,
): T | null {
  const key = (cli ?? "").trim().toLowerCase();
  const exact = key
    ? recipes.find((recipe) => recipe.cli.toLowerCase() === key)
    : undefined;
  return (
    exact ?? recipes.find((recipe) => recipe.cli === GENERIC_RECIPE_CLI) ?? null
  );
}
