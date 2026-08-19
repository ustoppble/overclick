# MCP · OverClick

The board exposes its tools over **streamable HTTP**, served by the same app process.

## Connect

Preferred: **pairing code**. The human generates a one-time 6-digit code in the wizard
or in Settings › Tokens and reads it to the agent; the agent exchanges it on the public
pairing endpoint and receives the real token, so the bearer value never travels through
a chat:

```bash
curl -sX POST http://<your-host>/api/pair \
  -H 'Content-Type: application/json' -d '{"code":"<6 digits>"}'
# → {"token":"ocb_...","url":"/mcp",...}   single use, 10 minute TTL
```

Classic: replace the host and paste the token generated in the UI (it is shown in full
only once):

```bash
claude mcp add --transport http overclick http://<your-host>/mcp \
  --header "Authorization: Bearer ocb_••••••••••••"
```

Other HTTP clients (Codex, Gemini CLI, Overclock) use the same URL and the same
`Authorization: Bearer ...` header.

The workspace is resolved from the token. Revoked or missing token → **HTTP 401**.

On initialize the server ships instructions that open with the board identity:
"OverClick is the task board where agents claim and deliver cards (not Overclock the
IDE); registering activities means task_create here." Clients that surface MCP
instructions hand their agents this context before the first tool call. Projects with
context are listed there with a short excerpt and a pointer to `project_get`.

## Tools

| Tool | What it does |
|---|---|
| `project_list` | the workspace projects: uuid, name, card prefix, repo url, `has_context`, next card number and card counts by status. The markdown stays out of this summary |
| `project_get` | the complete project, including `context` markdown and `current_version`; read it before changing the project |
| `project_create` | creates a project (`name`, optional `repo_url`, `context`, `current_version`, optional `id_prefix`). Context is limited to 32,000 characters; above that is `INVALID_ARGUMENT`. The prefix is derived from the name when omitted (`Agent Board` → `AB`, `OverClick` → `OC`, `overclick` → `OVE`) and is unique per workspace: a collision comes back as `INVALID_ARGUMENT` naming the project that holds it |
| `project_update` | reconfigures a project (`name`, `repo_url`, `context`, `current_version`, `id_prefix`). `repo_url`, `context` and `current_version` accept `null` to clear them |
| | `id_prefix` is only editable while the project has **no cards**. Every card carries the prefix in its short id (`FUN-1`), and those ids also live in branches, commits and PR titles, so rewriting the prefix would either make the board name cards that never existed or break every external reference. Renumbering is not offered: the error names how many cards block the change and points at moving them instead. A prefix another project already holds comes back as a named `INVALID_ARGUMENT`, never a constraint violation |
| `project_delete` | hard delete, irreversible: `task.project_id` cascades, so the cards go with the project |
| | only an **empty** project by default; one that holds cards is refused with the count that blocks it and the way out (move the cards, or repeat with force). `force: true` destroys the project with every card in it, and their attempts, handoffs and subtasks, with the count stated in the response (`tasks_deleted`, `attempts_deleted`, `handoffs_deleted`) |
| `mission_list` / `mission_get` | missions and the context to inject into the prompt |
| `mission_create` | creates a mission (`title`, objective/context markdown, `status`) and returns its id |
| `mission_update` | partially edits a mission (`title`, objective/context markdown, `status`); omitted fields stay unchanged. Put conventions for one round in mission context and update them here |
| `mission_delete` | removes an empty mission shell. A mission holding cards is refused with its count; `force: true` detaches those cards (`mission_id: null`) and returns `tasks_detached` before deleting the mission |
| `task_list` | the queue (project, `mission_id`, status, priority, `awaiting_review_by`) |
| `task_get` | self-contained md briefing (contract + harness + mission + complete project context + branch), plus the latest attempt's frozen `cost_usd`, `cost_source`, `cost_status` and `cost_unpriced_models` |
| `task_create` | creates the card (`mission` is an existing mission id, `mode` solo\|team, origin); `supersedes` atomically discards an in-execution predecessor, and `inherit: true` reuses its contract without copying comments |
| | `project_id` takes the project uuid **or** its card prefix (`AGB`), so an agent that just called `project_list` never needs the uuid |
| `task_search` | search the queue by text (`q`) and metadata filters |
| `task_claim` | status → `em_execucao`; a second active claim → `ALREADY_CLAIMED`. A claim whose attempt has had no `task_update` or `task_heartbeat` beyond the workspace timeout (60 minutes by default) is reclaimable without `force`: the old attempt becomes `abandoned` with reason `stale`, its usage is preserved, the timeline records the takeover and the response carries `reclaimed_stale: true` |
| | A card claimed again after a delivery was reopened comes back one link down its chain, and the briefing says which try this is. Only reviewed deliveries count: an attempt ended with `force` is a restart, not a verdict, and a harness pinned by hand off the chain is never escalated |
| | when the claiming executor differs from the card harness, the response carries a `harness_divergence` warning and the card timeline automatically records an executor swap entry naming planned vs actual |
| `task_release` | returns a card in execution to open, closes its current attempt as `abandoned` with the supplied `reason`, and preserves every usage counter already stored. The token that owns the claim may release it; a token with `manage` may release any claim in its workspace |
| `task_heartbeat` | renews an open attempt's activity lease for a long run and returns `last_activity_at` plus `expires_at`. The claiming token (or a manage token) may heartbeat it; it adds no timeline prose |
| `task_update` | progress, comment (`comment_kind` supports `report` to increment `reports_count`), `resolved_in` metadata (string or `null`), the `revisado` mark, a new `harness` (validated against executors), or a `usage` block that fills or corrects the latest attempt's telemetry, even after deliver/discard; managed tokens may send `status: descartado` with `superseded_by` |
| | `mission_id`: moves the card between missions after it was created, `null` detaches it. Only missions of the token's workspace qualify; anything else is a `NOT_FOUND`, never a silent detach. Subtasks follow their parent, and the response says how many in `subtasks_moved`. On the board the same move is a select in the card detail, and a bulk bar that assigns a whole selection at once |
| | `project_id`: moves the card to another project of the same workspace. This is how a board gets reorganized without deleting anything, and it is a field on `task_update` rather than a `task_move` tool because a move is one more thing a card can change, like its mission. The card is **restamped** with the destination prefix (`FUN-1` landing in `MKT` becomes `MKT-7`), consuming the destination's `next_number` so the numbering advances without colliding with a card already there. The id it had is kept on the card in `previous_short_ids` and the response returns the whole old-to-new mapping in `project_move {from_prefix, to_prefix, short_ids: [{from, to}]}`, so branches, commits and PR titles that name the old ids can be fixed. Subtasks travel with their parent and are restamped with it (`FUN-1.1` → `MKT-7.1`), counted in `subtasks_moved`; a subtask cannot be moved on its own, because its id is derived from its parent and it would land orphaned in a project its id does not belong to. `mission_id` is untouched: missions are workspace wide and cross projects by design. Naming the project the card is already in changes nothing and returns no `project_move` |
| | `spawn_failure`: a boot-failure note an orchestrator posts when the planned executor never started (CLI missing, crash on boot); it lands as a typed timeline entry with the planned harness attached and both entries render in the card detail under "Execution trace" |
| `task_deliver` | result + usage; status → `feito`; routed to the card's reviewer |
| | `usage` is required by contract: report exact numbers when your harness exposes them, otherwise **estimate** tokens, turns and duration and set `estimated: true` (the card labels the numbers "estimated"). Tokens and time are what the board asks for; `cost_usd` is optional and only used when the board cannot price the run itself. A delivery without usage still lands, but the response carries a warning and the card shows "usage not reported". |
| | `usage.segments` records tokens **per model**: `[{model, input, output, cache_read, cache_write}]`, one entry per model that ran. A conversation that switched model reports both, and the card footer reads `sonnet-5 to opus-5` instead of crediting the whole run to whichever model was recorded at claim time. The flat `tokens_in/out/cache` shape is still accepted and stored as a single segment; when segments arrive the board derives the flat totals from them, so both always agree. |
| | At deliver/update time the board normalizes every model through one alias table (`gpt-5.3-codex-spark` → `gpt-5-3-codex-spark`, `kimi-code/k3` → `k3`, `claude-fable-5` → `fable-5`), multiplies each segment by that model's price, and freezes the total and per-model breakdown on the attempt. `cost_usd` sent by the executor is stored separately and is only a fallback when a model has no price. |
| | optional `how_to_verify`: a URL, command or screenshot reference the reviewer opens first. It is shown on top of the validation panel in the Done detail ("For checking, open"). |
| `task_delete` | hard delete: removes the card plus attempts, handoffs and subtasks (irreversible) |
| `branch_register` | records the branch on the card |
| `harness_recommend` | policy lookup (activity type → CLI · chain · effort) |
| | The answer names the model that will actually run. `chain` is the declared line of succession, best first, and `chain_position` says which link answered: `0` is the first choice, anything higher means the board moved down the line, and `divergence` says why. Two things move it: a model that is not on a configured executor, and `attempt`, which starts the walk lower so a card whose delivery was reopened does not come back on the model that just failed review |
| `harness_list` | the whole policy + configured executors, each line carrying its `chain`, `updated_by` and `updated_at` |
| `harness_set` | writes one policy line (`type`, optional `cli`, `model` and/or `chain`, `effort`), validated against the configured executors and stamped with the token label. **Needs a manage token** (see below); `cli` omitted means no preference |
| | `chain` is the whole line, best first, up to 8 deep; `model` alone still works and reads as a chain of one. The write is refused only when **no** link resolves, so a first choice on an executor you have switched off is a legal thing to declare: that is what a successor is for. The `cli` pin applies to the head only, because past the first choice the point of the fallback is to leave that CLI behind |
| `insights_query` | tokens and time over the workspace, plus the reopened rate per model. Readable with any token |
| | Money is opt-in and off by default: `pricing_enabled: false` comes back with every `cost_usd` null, never a zero standing in for "no cost to report", because on a flat subscription a dollar figure is fiction. Turn the cost layer on in Settings and the board reads the frozen attempt figures, labeled by source. Editing a price affects the next deliver/task_update, not historical snapshots |
| | `group_by=model` reads the segments, so a run that switched model lands in both model groups with the tokens each one actually spent, each priced at its own rate. Those groups carry `shared_attempts`: the runs that touched more than one model. Their duration lands whole in every model the run touched, because nothing records how the wall clock split, so per-model durations overlap instead of adding up to the total |
| | `group_by` project, mission, model or card (omit it for totals and the reopen rate only), `since` and `until` to narrow the period. Same rows and same aggregation the Insights page runs, so a number never disagrees with the screen: only finished attempts count, example cards stay out, `estimated`, `missing`, `zero_usage` and `suspect` come back as honesty counters. Card rows also carry `unpriced_models` and `unpriced_tokens`, so an unknown cost says `no price for X`; absent counters say `not reported`; explicit zero counters say `usage reported as zero`. None becomes a fake `$0`. The period narrows attempts by when they finished; reopens are not narrowed, so a delivery reopened later still counts |
| `executors_update` | adds or removes CLIs and models in the executor config, in the shape the Settings grid saves. **Needs a manage token** |
| | one `cli` per call (the board id, or the binary name an agent sends: `claude` resolves to `claude-code`), plus `add_models`, `remove_models`, `enabled`, `label`, or `remove: true` to drop the CLI entirely. Adding models turns the CLI on unless `enabled: false` says otherwise, because an unchecked model is invisible to the policy selects and to card harnesses. When a change orphans a policy line, the response carries `policy_warnings` naming what `harness_set` has to fix |

Every tool that takes `task_id` accepts the card uuid **or** the workspace short id
(`AGB-5`, `OVK-5.4`), and every `project_id` accepts the project uuid **or** its card
prefix (`AGB`). Resolution is case-insensitive and scoped to the token's workspace.

A fresh instance is self-serve: `project_list` shows what exists and `project_create`
starts a project, so an agent can go from an empty board to its first card without ever
reading the database. Reorganizing later is the same surface: `project_update` renames,
`task_update` with `project_id` consolidates two projects into one card by card, and
`project_delete` removes what is left over.

Mission context is the shared place for conventions that apply to one round of work:
edit it in place with `mission_update` instead of repeating it on every card. Empty
mission shells can be removed with `mission_delete`; occupied missions require an
explicit move/detach or `force: true`.

`task_claim` and `task_get` return the briefing. The executor needs no other source of
context. `## Project context` comes immediately after the mission and carries the
project markdown plus `current_version`. The briefing always ends with two things, in this order: how to measure the run,
then what to send.

The same complete markdown is a discoverable MCP resource at
`overclick://project/<PREFIX>/context`. `resources/list` only advertises projects that
have context, and `resources/read` returns it as `text/markdown`.

**The usage collection recipe.** An agent can read its own session transcript and total
the token counters per model exactly; nobody was telling it how. The board keeps one
recipe per CLI (`claude-code`, `codex`, `gemini-cli`, plus a `generic` fallback) and
appends the one matching the executor that claimed the card. The claim response also
carries it structured as `usage_recipe {cli, label, yields, instructions, command}`, so a
caller can run it without parsing markdown. `yields` is `tokens_per_model` when the
command prints real numbers and `no_tokens` when the CLI records none on disk, in which
case the honest move is estimating and saying so. The shipped Claude Code and Codex
recipes print the `segments` shape `task_deliver` takes. The Codex recipe is bound at
claim time to `claimed_at`, the declared session id and harness model. Every shipped
recipe that reads a transcript filters entries to timestamps at or after `claimed_at`;
work that was already in the same session before the claim is not usage for this card.
The Codex recipe reads only that rollout's
`turn_context.payload.model` and `last_token_usage` deltas, normalizes model names such as
`gpt-5.6-sol` to the pricing slug `gpt-5-6-sol`, and uses the harness model only when an
older readable rollout has no model field. It returns `estimated: false` for measured
rollouts; a missing or unreadable rollout returns `estimated: true` plus the reason, never
an invented default such as `o4-mini`, `gpt-5`, or `unknown`. Recipes are editable in
Settings › Usage recipes: a CLI changing its transcript format is fixed there, once,
instead of in every agent's head, and a recipe edited back to the shipped text stops
being stored.

**The executor contract**, last, so it is the final thing read: when done, call
`task_deliver` with `summary`, `evidence`, `branch` and `usage`; send usage as
`segments`, one per model that ran, plus `duration_ms` and `turns`; without exact
numbers, estimate and set `estimated: true`.

**The transcript reference.** `task_claim` and `task_deliver` both accept
`transcript {cli, session_id, path, resume}`, and the card detail shows it with three copy
actions: the path, the command that reopens the session in that CLI, and the recipe
command pinned to that transcript with `TRANSCRIPT_PATH`. Send `path` at deliver time,
when the recipe has printed it; fields you omit keep what the claim recorded, and the
`session_id` an executor already sends becomes the reference on its own, so a card claimed
before this existed still points somewhere. The board stores the reference and never the
content: the transcript lives on the agent machine, which is also the only place those two
commands run.

## The manage flag

Reading the board is what a worker token is for. Rewriting the workspace configuration is
not: a token that can move the harness policy can promote itself to a better model between
two claims. So the configuration tools sit behind a per-token **manage** flag, off by
default.

Tick "This token can change the workspace configuration" when generating the token in
Settings › MCP tokens. Tokens that have it show a `manage` badge in the list. Everything
else about the token is unchanged: same URL, same header, same tools for claiming and
delivering.

The configuration tools behind it are `harness_set` and `executors_update`. The flag also
lets an owner release or heartbeat another token's stuck claim; the claiming token can
always manage its own lease. Without the flag, configuration writes answer
with a typed `PERMISSION_DENIED` and change nothing. The harness policy also keeps a
trail: every line records who wrote it last (an email from Settings, the token label from
`harness_set`) and when, shown in the Settings policy table and returned by
`harness_list`.

## Errors

Every error is typed and speaks tool language: a short `code` plus a message that
tells the agent what to call next. Internals (SQL, driver output, state machine event
names) never reach the client; unexpected failures come back as a generic `INTERNAL`
error and the details stay in the server logs.

| Code | Meaning and next step |
|---|---|
| `NOT_FOUND` | the id does not exist in the token's workspace; the message points to `task_list`, `project_list`, `mission_list` or `harness_list` |
| `INVALID_TRANSITION` | the call does not fit the card status; for example, delivering an open card returns "Card is open, call task_claim before task_deliver." |
| `ALREADY_CLAIMED` | another executor holds the card; retry with `force: true` to take over |
| `INVALID_ARGUMENT` | the input failed validation; the message names the field |
| `PERMISSION_DENIED` | the token is valid but has no manage flag, so it cannot change the workspace configuration; nothing was written |
| `INTERNAL` | unexpected server error, nothing leaked; check ids and retry |

## Telemetry

The unit is tokens and time. Both are facts on any plan, which is why the card footer
and the Insights page lead with them and show no dollar figure unless somebody switches
the cost layer on.

Telemetry does not depend on agent goodwill. The server measures the duration itself,
from claim to deliver, and stores it on the attempt. The card footer always shows
something real, in this order: full usage; estimated usage labeled "estimated";
server-measured duration with "usage not reported". Estimates beat silence: agents
that cannot read exact numbers are instructed to estimate and mark `estimated: true`,
and real numbers found later can overwrite the attempt through `task_update`. Whatever
the source, it travels with the number: measured, estimated, or not reported at all.

Cost is derived once, when `task_deliver` or `task_update {usage}` processes the
attempt. The board keeps the executor's optional `cost_usd` as
`reported_cost_usd`, normalizes the segment model, loads the workspace price row,
and stores `cost_usd`, `cost_source`, `cost_status`, `cost_unpriced_models` and a
per-model breakdown. Board and Insights read that snapshot; they do not silently
reprice old work when Settings changes. Migration `0024_ambitious_doctor_strange`
backfills finished attempts with the same rules and is idempotent, so rerunning its
cost update produces the same result.

`cost_status` is the reason a card can show instead of zero: `computed`,
`reported`, `estimated`, `unpriced`, `not_reported`, `zero_usage` or `suspect`.
A priced free tier is different: it has tokens, a real price row whose rates are
zero, and therefore a legitimate computed `$0`.

The server also checks the report against the claim window. A usage total that could not
fit between claim and delivery, or a session id that already delivered a different card,
does not block the delivery: the attempt is stored with `usage_suspect: true`, the card
shows "usage above the possible claim window, probably a whole-session total", and
`task_get` returns the flag and reason. Insights keeps suspect tokens, duration and cost
outside the trusted totals and reports them in `suspect_*` fields instead of silently
inflating the project, mission or model.

Two clocks run on a card and they are not the same number. The `duration_ms` an agent
reports in its usage is execution time: the board shows it as the time the run took.
The server measurement is claim to deliver, and it keeps counting while an orphaned
claim sits open, so the card shows it as "open for 41h" instead of printing "41h03"
next to the model as if somebody had worked that long. The detail panel shows both,
each next to the source that measured it. `insights_query` follows the same rule:
`duration_ms` aggregates execution time only, and the elapsed time of attempts that
reported none comes back apart, in `elapsed_ms` with its `elapsed_only` count. No
attempt lands in both, so the two never double count one run.
