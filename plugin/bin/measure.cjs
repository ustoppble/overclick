// Generated from packages/db/src/domain/usage-recipe.ts — do not edit.
// Regenerate: WRITE_PLUGIN_MEASURE=1 pnpm --filter @agent-board/db test usage-recipe-plugin
//
// Measures this run from the CLI's own transcript and prints the usage
// task_deliver takes. Run it through the line a claim gives you:
// node -e "...measure.cjs..." cli=<cli> claimed_at=<claim time>
const recipes = {
  "claude-code": function () {
const fs = require('fs');
const os = require('os');
const path = require('path');
const NL = String.fromCharCode(10);

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
}

// TRANSCRIPT_PATH pins one transcript, which is what the card's recompute
// button sets. Without it, Claude Code writes one jsonl per session under
// ~/.claude/projects/<cwd slug>.
let file = setting('transcript', 'TRANSCRIPT_PATH');
const session = setting('session', 'CLAUDE_CODE_SESSION_ID');
let folder = '';
if (file === '') {
  // Claude Code names that folder after the working directory with every
  // character that is not a letter or a digit turned into a dash. Replacing
  // only the forward slash matched no folder at all whenever the path carried
  // a dot (/repo/.worktrees/x) and matched nothing on Windows, where the cwd
  // carries a drive colon and backslashes: C:[backslash]Users[backslash]me is
  // stored as C--Users-me. A miss then fell through to the newest transcript
  // of some other session, which put someone else's tokens on the card.
  const slug = process.cwd().replace(new RegExp('[^a-zA-Z0-9]', 'g'), '-');
  // CLAUDE_CONFIG_DIR moves the whole config tree, which is how Overclock
  // gives each account its own; without it the recipe reads a ~/.claude that
  // holds no session of this run.
  const configDir = setting('claude_config_dir', 'CLAUDE_CONFIG_DIR')
    || path.join(os.homedir(), '.claude');
  folder = path.join(configDir, 'projects', slug);
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
emit({ segments: segments(seg), turns: turns, transcript: file, estimated: false });
  },
  "codex": function () {
const fs = require('fs');
const os = require('os');
const path = require('path');
const NL = String.fromCharCode(10);

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
}

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
emit({ segments: segments(seg), turns: turns, transcript: file, estimated: false });
  },
  "grok": function () {
const fs = require('fs');
const os = require('os');
const path = require('path');
const NL = String.fromCharCode(10);

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
}

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

emit({ segments: segments(seg), turns: turns, transcript: file, estimated: false });
  },
  "kimi": function () {
const fs = require('fs');
const os = require('os');
const path = require('path');
const NL = String.fromCharCode(10);

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
}

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

emit({ segments: segments(seg), turns: turns, transcript: dir, estimated: false });
  },
};
let cli = '';
for (const item of process.argv.slice(1)) {
  if (item.startsWith('cli=')) cli = decodeURIComponent(item.slice(4));
}
const run = recipes[cli];
if (run === undefined) {
  process.stdout.write(JSON.stringify({
    segments: [],
    turns: 0,
    estimated: true,
    reason: 'This plugin has no usage recipe for ' + (cli || 'an unnamed CLI') + '. Estimate usage and send estimated: true.',
  }, null, 2) + String.fromCharCode(10));
} else {
  run();
}
