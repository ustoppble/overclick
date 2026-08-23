/**
 * Usage collection recipes: how each CLI can measure the run it just did.
 *
 * An agent can read its own session transcript and total the token counters
 * per model exactly. Nobody ever told it how, which is why field tests ended
 * with ten workers holding board tools and reporting nothing. The board keeps
 * the recipe so the briefing can hand it over at claim time, and so a CLI
 * changing its transcript format is fixed in one place instead of in every
 * agent's head.
 *
 * Every shipped command is a single `node -e "..."` invocation on purpose.
 * The recipes used to be a bash heredoc feeding python3, which is two
 * assumptions a Windows machine breaks at once: PowerShell has no heredoc, and
 * the `python3` on PATH there is the Microsoft Store execution alias, which
 * satisfies `command -v`, runs, prints "Python was not found" and exits 0 with
 * empty stdout. The install script already learned to probe capability instead
 * of presence; the recipe answers the same lesson by running on the runtime
 * that is guaranteed to be there — Claude Code, Codex, Grok and Kimi all ship
 * as Node programs, so node is the interpreter that really runs.
 *
 * The script text inside the quotes therefore contains no double quote, no
 * dollar sign, no backtick, no backslash and no `!` before a word: those are
 * exactly the characters bash, zsh and PowerShell disagree about inside a
 * double-quoted argument. Keep that discipline when editing a script here, or
 * the same command stops surviving the trip through one of the shells.
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

/**
 * Characters a setting keeps as itself on the command line. Everything else is
 * percent-encoded, so a value never needs quoting and never means something to
 * a shell: a space, a quote, a backslash or a dollar sign travels as %20, %22,
 * %5C or %24 and the script decodes it back.
 */
const SETTING_SAFE =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._:/";

/** Percent-encodes one recipe setting value for any shell. */
export function encodeRecipeSetting(value: string): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const char = String.fromCharCode(byte);
    out +=
      SETTING_SAFE.includes(char) && byte < 128
        ? char
        : "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

/**
 * Appends `key=value` settings to a shipped recipe command.
 *
 * The old form was a POSIX environment prefix (`VAR=value command`), which is
 * a bash-only syntax: PowerShell reads it as a stray argument and the recipe
 * measures the wrong window, or nothing at all. Arguments after `node -e` land
 * in process.argv on every platform, and the scripts still read the matching
 * environment variable when a caller sets one.
 */
export function bindRecipeSettings(
  command: string,
  settings: Readonly<Record<string, string | null | undefined>>,
): string {
  const parts = Object.entries(settings)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([key, value]) => `${key}=${encodeRecipeSetting(value)}`);
  return parts.length ? `${command} ${parts.join(" ")}` : command;
}

/**
 * Everything the four transcript readers share: settings, line reading, the
 * claim window filter and the output shape task_deliver takes.
 */
const PRELUDE = `const fs = require('fs');
const os = require('os');
const path = require('path');
const NL = String.fromCharCode(10);
const BACKSLASH = String.fromCharCode(92);

// Settings arrive as percent-encoded key=value arguments because PowerShell
// has no VAR=value command prefix; the environment is still read, so a caller
// that exports TRANSCRIPT_PATH or OVERCLICK_CLAIMED_AT keeps working.
const given = {};
for (const item of process.argv.slice(1)) {
  const at = item.indexOf('=');
  if (at > 0) {
    let value = item.slice(at + 1);
    try { value = decodeURIComponent(value); } catch (error) { }
    given[item.slice(0, at).trim().toLowerCase()] = value;
  }
}
function setting(key, variable) {
  return given[key] || process.env[variable] || '';
}
function readLines(file) {
  return fs.readFileSync(file, 'utf8').split(NL);
}
function parse(line) {
  try { return JSON.parse(line); } catch (error) { return null; }
}
function exists(candidate) {
  try { fs.statSync(candidate); return true; } catch (error) { return false; }
}
function newest(candidates) {
  let best = '';
  let stamp = -1;
  for (const candidate of candidates) {
    let at = -1;
    try { at = fs.statSync(candidate).mtimeMs; } catch (error) { continue; }
    if (at > stamp) { stamp = at; best = candidate; }
  }
  return best;
}
// Only entries at or after the claim count: work the session did before this
// card was claimed belongs to no part of it. An entry with no timestamp is
// left out rather than guessed in.
function claimWindow(extraField) {
  const claimedAt = setting('claimed_at', 'OVERCLICK_CLAIMED_AT');
  const claim = claimedAt === '' ? NaN : Date.parse(claimedAt);
  return function (entry) {
    if (claimedAt === '' || Number.isNaN(claim)) return true;
    let value = entry.timestamp;
    if (value === undefined) value = entry.created_at;
    if (value === undefined) value = entry.createdAt;
    if (value === undefined && extraField) value = entry[extraField];
    if (value === undefined || value === null) return false;
    // Grok stamps epoch seconds and Kimi epoch milliseconds; the rest write
    // ISO text.
    const at = typeof value === 'number'
      ? (value > 100000000000 ? value : value * 1000)
      : Date.parse(String(value));
    if (Number.isNaN(at)) return false;
    return at >= claim;
  };
}
function emit(payload) {
  process.stdout.write(JSON.stringify(payload, null, 2) + NL);
}
function unavailable(reason) {
  emit({
    segments: [],
    turns: 0,
    estimated: true,
    reason: reason + ' Estimate usage and send estimated: true.',
  });
  process.exit(0);
}
function bump(seg, model, counts) {
  const key = model || 'unknown';
  if (seg[key] === undefined) {
    seg[key] = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  }
  const row = seg[key];
  row.input += counts.input || 0;
  row.output += counts.output || 0;
  row.cache_read += counts.cache_read || 0;
  row.cache_write += counts.cache_write || 0;
}
function segments(seg) {
  return Object.keys(seg).map(model => Object.assign({ model: model }, seg[model]));
}`;

/** Wraps a script into the one command that runs on bash, zsh and PowerShell. */
function nodeCommand(script: string): string {
  return `node -e "${script}"`;
}

const CLAUDE_COMMAND = nodeCommand(`${PRELUDE}

// TRANSCRIPT_PATH pins one transcript, which is what the card's recompute
// button sets. Without it, Claude Code writes one jsonl per session under
// ~/.claude/projects/<cwd slug>.
let file = setting('transcript', 'TRANSCRIPT_PATH');
const session = setting('session', 'CLAUDE_CODE_SESSION_ID');
let folder = '';
if (file === '') {
  // Claude Code names that folder after the working directory with every path
  // separator turned into a dash. On Windows the cwd carries a drive colon and
  // backslashes, so C:[backslash]Users[backslash]me is stored as C--Users-me:
  // replacing only the forward slash matched no folder at all, and the newest
  // transcript of some other session was the best case.
  const slug = process.cwd()
    .split('')
    .map(ch => (ch === '/' || ch === ':' || ch === BACKSLASH) ? '-' : ch)
    .join('');
  folder = path.join(os.homedir(), '.claude', 'projects', slug);
  if (session === '') {
    let here = [];
    try {
      here = fs.readdirSync(folder)
        .filter(name => name.endsWith('.jsonl'))
        .map(name => path.join(folder, name));
    } catch (error) { here = []; }
    file = newest(here);
  } else {
    file = path.join(folder, session + '.jsonl');
  }
}
if (file === '') {
  unavailable('No Claude Code transcript was found under ' + folder + '.');
}
if (exists(file) === false) {
  unavailable('The Claude Code transcript ' + file + ' is missing or unreadable.');
}

const keep = claimWindow();
const seg = {};
let turns = 0;
for (const line of readLines(file)) {
  const entry = parse(line);
  if (entry === null || keep(entry) === false) continue;
  const message = entry.message || {};
  const usage = message.usage;
  if (usage === undefined || usage === null) continue;
  turns += 1;
  bump(seg, message.model, {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cache_read: usage.cache_read_input_tokens,
    cache_write: usage.cache_creation_input_tokens,
  });
}

if (turns === 0) {
  unavailable('The Claude Code transcript ' + file + ' has no usage entries in the claim window.');
}
emit({ segments: segments(seg), turns: turns, transcript: file, estimated: false });`);

const CODEX_COMMAND = nodeCommand(`${PRELUDE}

// TRANSCRIPT_PATH pins one transcript, which is what the card's recompute
// button sets. Without it, Codex writes one rollout jsonl per session under
// ~/.codex/sessions/<date>/. The session id is bound from task_claim, so a
// busy repo never attributes the newest *other* pane's rollout to this card.
let file = setting('transcript', 'TRANSCRIPT_PATH');
const session = setting('codex_session', 'CODEX_SESSION_ID')
  || process.env.CODEX_THREAD_ID
  || '';
const fallbackModel = setting('codex_model', 'CODEX_HARNESS_MODEL');
const claimedAt = setting('claimed_at', 'OVERCLICK_CLAIMED_AT');

function modelSlug(value) {
  if (value === '' || value === undefined || value === null) return '';
  let out = String(value).toLowerCase().replace(new RegExp('[^a-z0-9]+', 'g'), '-');
  while (out.startsWith('-')) out = out.slice(1);
  while (out.endsWith('-')) out = out.slice(0, -1);
  return out;
}
function rollouts(dir) {
  let found = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (error) { return found; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found = found.concat(rollouts(full));
    else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) found.push(full);
  }
  return found;
}
function belongsToSession(candidate) {
  if (path.basename(candidate).includes(session)) return true;
  let first = null;
  try { first = parse(readLines(candidate)[0] || ''); } catch (error) { return false; }
  if (first === null) return false;
  const payload = first.payload || {};
  return payload.id === session || payload.session_id === session;
}

if (file === '') {
  if (session === '') {
    unavailable('No transcript path or Codex session id was available from task_claim.');
  }
  const matches = rollouts(path.join(os.homedir(), '.codex', 'sessions'))
    .filter(belongsToSession);
  if (matches.length === 0) {
    unavailable('No readable Codex rollout matched the session id from task_claim.');
  }
  file = newest(matches);
}
if (exists(file) === false) {
  unavailable('The selected Codex rollout is missing or unreadable.');
}

const keep = claimWindow();
const seg = {};
let model = modelSlug(fallbackModel);
let turns = 0;
for (const line of readLines(file)) {
  const entry = parse(line);
  if (entry === null || keep(entry) === false) continue;
  const payload = entry.payload || {};
  if (entry.type === 'turn_context' && payload.model) model = modelSlug(payload.model);
  if (payload.type !== 'token_count') continue;
  // last_token_usage is this model call's delta; total_token_usage is cumulative.
  const usage = (payload.info || {}).last_token_usage;
  if (usage === undefined || usage === null) continue;
  if (model === '') {
    unavailable('The rollout has token counters but neither it nor the card harness names a model.');
  }
  turns += 1;
  const cached = usage.cached_input_tokens || 0;
  bump(seg, model, {
    input: (usage.input_tokens || 0) - cached,
    cache_read: cached,
    cache_write: usage.cache_write_input_tokens,
    output: usage.output_tokens,
  });
}

if (turns === 0) {
  unavailable(claimedAt === ''
    ? 'The Codex rollout contains no readable last_token_usage counters.'
    : 'The Codex rollout contains no readable last_token_usage counters after ' + claimedAt + '.');
}
emit({ segments: segments(seg), turns: turns, transcript: file, estimated: false });`);

const GROK_COMMAND = nodeCommand(`${PRELUDE}

// TRANSCRIPT_PATH pins one transcript, which is what the card's recompute
// button sets. Without it, Grok writes one updates.jsonl per session under
// ~/.grok/sessions/<cwd percent-encoded>/<session uuid>/.
let file = setting('transcript', 'TRANSCRIPT_PATH');
const session = setting('grok_session', 'GROK_SESSION_ID');

// Grok encodes the whole working directory, separators included, the way
// Python's quote(safe='') does: everything outside the unreserved set becomes
// a percent escape of its utf-8 bytes.
function encodePath(value) {
  const safe = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
  let out = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const char = String.fromCharCode(byte);
    out += (byte < 128 && safe.includes(char))
      ? char
      : '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}
function children(dir) {
  try { return fs.readdirSync(dir).map(name => path.join(dir, name)); } catch (error) { return []; }
}
function updateLogs(dir) {
  return children(dir)
    .map(child => path.join(child, 'updates.jsonl'))
    .filter(exists);
}

let folder = '';
if (file === '') {
  const root = path.join(os.homedir(), '.grok', 'sessions');
  folder = path.join(root, encodePath(process.cwd()));
  if (session === '') {
    const here = updateLogs(folder);
    const anywhere = children(root).map(updateLogs).reduce((all, some) => all.concat(some), []);
    file = newest(here.length > 0 ? here : anywhere);
  } else {
    file = path.join(folder, session, 'updates.jsonl');
  }
}
if (file === '') {
  unavailable('No Grok updates.jsonl was found under ' + folder + '.');
}
if (exists(file) === false) {
  unavailable('The Grok transcript ' + file + ' is missing or unreadable.');
}

const keep = claimWindow();
const seg = {};
let turns = 0;
for (const line of readLines(file)) {
  const entry = parse(line);
  if (entry === null || keep(entry) === false) continue;
  const update = (entry.params || {}).update || {};
  if (update.sessionUpdate !== 'turn_completed') continue;
  const usage = update.usage;
  // A turn that ended on an error carries no usage. Counting it would put a
  // row of zeros where the honest answer is that nothing was spent.
  if (usage === undefined || usage === null) continue;
  turns += usage.numTurns || usage.modelCalls || 0;
  // modelUsage splits the turn per model, which is what a session that
  // switched model needs; a turn without it is all one model.
  const perModel = usage.modelUsage || { unknown: usage };
  for (const model of Object.keys(perModel)) {
    const block = perModel[model] || {};
    const cached = block.cachedReadTokens || 0;
    // inputTokens already contains the cached read, so the plain input is
    // what is left after taking it out.
    bump(seg, model, {
      input: (block.inputTokens || 0) - cached,
      cache_read: cached,
      cache_write: block.cacheCreationTokens,
      output: block.outputTokens,
    });
  }
}

emit({ segments: segments(seg), turns: turns, transcript: file, estimated: false });`);

const KIMI_COMMAND = nodeCommand(`${PRELUDE}

// TRANSCRIPT_PATH pins one session directory, which is what the card's
// recompute button sets. Without it, the index Kimi keeps in its home maps
// every session to the directory it ran in, including sessions stored outside
// that home, so it beats globbing for them.
const home = setting('kimi_home', 'KIMI_HOME') || path.join(os.homedir(), '.kimi-code');
let dir = setting('transcript', 'TRANSCRIPT_PATH');
const session = setting('kimi_session', 'KIMI_SESSION_ID');

function realpath(value) {
  try { return fs.realpathSync(value); } catch (error) { return ''; }
}
function isDirectory(candidate) {
  try { return fs.statSync(candidate).isDirectory(); } catch (error) { return false; }
}

if (dir === '') {
  const here = realpath(process.cwd());
  const rows = [];
  let lines = [];
  try { lines = readLines(path.join(home, 'session_index.jsonl')); } catch (error) { lines = []; }
  for (const line of lines) {
    const row = parse(line);
    if (row === null) continue;
    const sessionDir = row.sessionDir || '';
    if (isDirectory(sessionDir) === false) continue;
    if (session !== '' && row.sessionId !== session) continue;
    if (session === '' && realpath(row.workDir || '') !== here) continue;
    rows.push(sessionDir);
  }
  dir = newest(rows);
}
if (dir === '') {
  unavailable('No Kimi session in ' + home + ' matched this repo or the session id.');
}

// One wire log per agent: main plus every subagent it spawned, so the tokens a
// subagent spent land on the card that spawned it instead of nowhere.
let agents = [];
try { agents = fs.readdirSync(path.join(dir, 'agents')).sort(); } catch (error) { agents = []; }
const logs = agents
  .map(agent => path.join(dir, 'agents', agent, 'wire.jsonl'))
  .filter(exists);
if (logs.length === 0) {
  unavailable('The Kimi session ' + dir + ' has no readable agent wire log.');
}

// Kimi's wire.jsonl stamps every record with a time field, not the timestamp or
// created_at the other CLIs write.
const keep = claimWindow('time');
const seg = {};
let turns = 0;
for (const log of logs) {
  for (const line of readLines(log)) {
    const entry = parse(line);
    if (entry === null || keep(entry) === false) continue;
    // Kimi writes one record per model call with usageScope of turn, and a
    // cumulative session record at the end. Summing both counts the
    // session twice.
    if (entry.type !== 'usage.record' || entry.usageScope !== 'turn') continue;
    const usage = entry.usage || {};
    turns += 1;
    bump(seg, entry.model, {
      input: usage.inputOther,
      cache_read: usage.inputCacheRead,
      cache_write: usage.inputCacheCreation,
      output: usage.output,
    });
  }
}

emit({ segments: segments(seg), turns: turns, transcript: dir, estimated: false });`);

const SEED: UsageRecipe[] = [
  {
    cli: "claude-code",
    label: "Claude Code",
    yields: "tokens_per_model",
    instructions:
      "Run this from the repo you worked in. It is one node command, no heredoc and no python3, so the same line runs on macOS, Linux and Windows PowerShell. It reads your own session transcript from the claim boundary and prints tokens grouped by model, ready to paste into task_deliver as usage.segments. Numbers from the transcript are measured, not guessed, so deliver them without estimated. It also prints the transcript path: send it as transcript.path and the card links back to this run. If it comes back with estimated: true, the reason says exactly what was missing.",
    command: CLAUDE_COMMAND,
  },
  {
    cli: "codex",
    label: "Codex",
    yields: "tokens_per_model",
    instructions:
      "At task_claim, declare the exact model from this session's --model flag (for example gpt-5.6-sol), never the generic family label gpt-5. Run this from the repo you worked in: it is one node command, no heredoc and no python3, so it runs on macOS, Linux and Windows PowerShell alike. The board binds claimed_at, the session id and harness model declared at task_claim: the command reads that exact Codex rollout only from the claim boundary, attributes each model call to turn_context.payload.model, normalizes the model slug for pricing, and falls back to the harness model only when the rollout omits it. A readable rollout returns estimated: false. Only a missing or unreadable rollout returns estimated: true with a reason. Send the printed transcript path as transcript.path so the card links back to this run.",
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
      "Run this from the repo you worked in: one node command, no heredoc and no python3, so macOS, Linux and Windows PowerShell all run it. Grok closes every turn with a turn_completed line carrying usage.modelUsage, tokens already split per model, and this totals only entries from the claim boundary into usage.segments. inputTokens there includes the cached read, so the command subtracts it and reports input and cache_read apart, the way the board counts them. A turn that ended on an error carries no usage and is skipped, so an aborted session reports nothing instead of a row of zeros. It also prints the transcript path: send it as transcript.path and the card links back to this run.",
    command: GROK_COMMAND,
  },
  {
    cli: "kimi",
    label: "Kimi",
    yields: "tokens_per_model",
    instructions:
      "Run this from the repo you worked in: one node command, no heredoc and no python3, so macOS, Linux and Windows PowerShell all run it. Kimi writes one usage.record per model call into the wire log of every agent in the session, main and subagents, and this totals only entries from the claim boundary per model for usage.segments. It reads only the records scoped to a turn: the cumulative session record at the end would count the whole run twice. The session is found through the index Kimi keeps in its home, which maps each session to the directory it ran in. It also prints the session path: send it as transcript.path and the card links back to this run.",
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
