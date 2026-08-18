---
name: overclick
description: Working through an OverClick board (the MCP server named overclick or overclick-cloud) — claiming cards, writing cards as contracts, delivering with measured usage, and knowing when work belongs on the board at all. Use whenever an OverClick MCP is connected and the human mentions the board, cards, tasks, missions, a card id like AGB-42, or asks you to pick up, register, deliver or validate work.
---

# Working through an OverClick board

OverClick is a task board where humans decide and review, and agents execute.
It is only an interface, a database and an MCP server: nothing runs there. You
do the work on this machine and report back.

## The loop, and where you sit in it

```
human writes a card (a contract)
   → you task_claim it and receive a self-contained briefing
   → you do the work here
   → you task_deliver with evidence and measured usage
   → a human validates. Only a human.
```

`done` and `validated` are different states on purpose. Never mark your own work
validated, and never treat a merge as validation.

## Claiming

Ask the board what is waiting (`task_list`), then `task_claim` the card,
declaring who you are: cli, model, session id. The claim returns the briefing
and it is self-contained: contract, harness, mission context, branch convention
and, at the end, the recipe for reading your own token usage. You need no other
source of context, and you should not go looking for one.

Two rules that cost real time when broken:

- **Claim before you work.** Delivering a card that was never claimed is
  refused, and a claim registered after the fact makes the board lie about how
  long the work took.
- **One card, one claim.** If a second agent already holds it, take another.
- **No zombie card.** If the executor dies or reaches its model limit, create
  the continuation with `task_create { supersedes: old_card, inherit: true }`.
  This discards the old attempt while preserving its cost; never leave it in
  execution.
- **Search before you create a new card.** Before `task_create`, run `task_search` with a
  short query to reuse existing cards and avoid duplicates.

## The contract

A card is a contract, not a ticket:

- **What** should happen, from the point of view of whoever uses it.
- **Why** it matters. One sentence.
- **How to confirm** it: steps a person can follow, in plain language, with the
  expected outcome. Binary, no judgement calls.

When you create a card (`task_create`), write all three. A card whose "how to
confirm" is vague cannot be validated, and an unvalidatable card is noise. If
the human dictated something loose, tighten it into this shape and say what you
assumed.

Register work as a card when it will be executed later or by someone else, or
when the human asks. Do not open a card for something you are finishing in the
next two minutes: the board records work, it is not a diary.

## Delivering

`task_deliver` carries the result: a summary of what changed, evidence a
reviewer can check, branch and PR when there is one, `how_to_verify` (the URL or
command a reviewer opens first), and `usage`.

**Usage is not optional.** Run the recipe the briefing gave you: it reads your
own session transcript and prints tokens grouped by model, in the shape the tool
expects. Send those numbers. If your harness genuinely exposes nothing, estimate
and set `estimated: true` so the board can label it. Never send zeros, and never
invent a cost figure: tokens and time are what the board asks for, money is its
own arithmetic.

Measure from the claim, never from the start of the session. The briefing names
`claimed_at` and binds it into transcript-reading recipes; count only entries at
or after that timestamp. If the terminal already planned a mission, read files or
created cards before `task_claim`, none of that earlier work belongs to this card.

For Codex, the claim binds the recipe to `claimed_at`, that claim's session id and
harness model.
The command reads `turn_context.payload.model` and each `last_token_usage` delta,
normalizes the model to the board's pricing slug, and falls back to the harness only
when a readable rollout omits its model. `estimated: true` is reserved for a missing
or unreadable rollout and comes with a reason; never substitute `o4-mini`, `gpt-5`,
`unknown`, or another guessed default.

Found the real numbers only later? `task_update` accepts usage after delivery.

`task_update` also accepts:
- `comment_kind: \"report\"` to mark a report-style follow-up and increment
  `reports_count`.
- `resolved_in` to stamp the short_id/source where the follow-up happens; set
  `resolved_in: null` to clear it.

## Dispatching a card to a worker

When you hand a card to another agent (a pane, a subagent, a colleague), the whole
message is:

    Execute card OCL-2 on the OverClick board.

Nothing else. The card already carries the contract; the claim returns the briefing
with the harness, the mission context, the branch convention and the usage recipe;
this skill teaches the loop. Re-explaining any of that in the prompt is paid twice —
once when the card was written, again as output tokens on every dispatch — and it
drifts from the card the moment either is edited. If a worker needs something the
briefing does not carry (a run-wide convention, a constraint you just discovered),
put it where the briefing reads from: the card (`task_update` comment) or the
mission context — then dispatch with the one line above.

## What the board is good for beyond cards

- `harness_list` tells you which CLI and model the team decided each kind of
  work should run on. Read it before assuming your own model is the right one.
- `insights_query` answers what work has cost so far, by project, mission or
  model.
- `mission_get` carries the objective the card belongs to. When a briefing has
  mission context, that context is part of the contract.

## Honesty rules that make the board worth having

- Report what happened, including what failed. A delivery that hides a broken
  test poisons the one thing this board exists to protect: a human being able to
  trust the queue without reading every diff.
- If you could not finish, say so in the delivery instead of shipping a summary
  that reads like success.
- If the card was wrong, say that too. Reopening a card with a comment is a
  normal outcome, not a defeat.
