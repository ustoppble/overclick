# OverClick

**The open source task board where AI agents do the work.**

OverClick is a self-hosted task board for hybrid human + AI-agent teams. Humans decide and
review; agents execute. The board is just an interface, a database, and an MCP server.
Any MCP-capable coding agent (Claude Code, Codex, Gemini CLI, Overclock, ...) connects to
it, claims cards, does the work on its own machine, and reports back with evidence and
real telemetry: tokens per model, and time.

> Your board. Your server. Your data. Nothing leaves your instance: no analytics, no
> tracking, no e-mail verification, no phone-home. Ever.

![OverClick board with agents executing cards and real telemetry](docs/assets/overclick-demo.gif)

## The loop

1. **You create a card.** A contract, not a ticket: *What* should happen, *Why*, and
   *How to confirm it* (a plain-language test script).
2. **Your agent picks it up.** "Grab the next task from the board." The agent claims the
   card over MCP, receives a self-contained briefing (contract + harness + mission context
   + branch convention), and the card slides to *In progress*.
3. **The agent delivers.** A handoff with summary, evidence, branch/PR links, and real
   telemetry: tokens per model and duration. The briefing tells the agent exactly how to
   read those numbers off its own session transcript, so they are measured, not guessed.
4. **You validate.** Review with the script you wrote in step 1. Only a human stamps
   *Validated*. Reopen with a comment and the agent sees it on the next claim.

Every card shows what it took: `34 min · 1.2M tokens · sonnet-5 to opus-5`. Tokens and
time, because those are facts on every plan. Money is an optional layer, off by default.

## Quickstart

```bash
git clone https://github.com/ustoppble/overclick && cd overclick
docker compose up --build
```

Open `http://localhost:3000`, create the local admin account (e-mail + password, stored in
your own Postgres, used only for login), and follow the 3-step onboarding: project,
executors, connect your agent. Full walkthrough: [docs/getting-started.md](docs/getting-started.md).

### Connect an agent

```bash
claude mcp add --transport http overclick http://<your-host>/mcp \
  --header "Authorization: Bearer <your-token>"
```

Then, in your terminal: *"grab the next task from the board."* Watch the example card move.

## What makes it different

- **Cards are contracts.** *What / Why / How to confirm*, written before the work, so
  review is a script instead of a vibe. `Done != Validated`: merge is the machine's
  opinion, validation is yours.
- **Harness policy, not model roulette.** You declare which CLIs/models your team has and
  map twenty activity types to executors: a dictated tweak and a repo-wide migration are
  both "code" and belong nowhere near each other in a routing table. Every line is a chain,
  not a single name: first choice, escalation, floor. The board claims the first link it can
  actually run, so switching an executor off degrades the policy instead of voiding it.
  Agents read it over MCP (`harness_list`) and every card is born with the right harness
  recommended.
- **Three roles per card.** Who requested it, who executed it, and who it returns to for
  review. The person who delegates isn't always the person who checks.
- **RFCs as cards.** Big decisions become `rfc` cards whose deliverable is a document;
  approving it spawns the execution cards. Design to execution, fully traceable.
- **Tokens and time per card.** Agents report usage in every handoff, split per model, so
  a run that switched models is recorded truthfully. See what a feature actually took, per
  card, per project, per mission. Estimates are labeled as estimates and a run that
  reported nothing says so, instead of showing a confident zero.
- **Money is opt-in.** On a flat subscription a dollar figure is fiction, and a price table
  goes stale and lies with confidence. Cost is off by default; turn it on in Settings if
  you pay per token and the board adds an approximate figure, labeled with where it came
  from, next to the numbers it measured.
- **Git-convention native.** `AGB-123` in the branch, the commit, and the PR title. The
  board tracks which branch belongs to which card. No GitHub API required; works with any
  forge, or none.

## MCP surface

23 tools: `project_list` · `project_create` · `project_update` · `project_delete` ·
`mission_list` · `mission_get` · `mission_create` ·
`task_list` · `task_get` · `task_create` · `task_search` · `task_claim` · `task_release` ·
`task_heartbeat` · `task_update` · `task_deliver` ·
`task_delete` · `branch_register` · `harness_recommend` · `harness_list` · `harness_set` ·
`executors_update` · `insights_query`. Streamable HTTP, bearer tokens, atomic claims, typed errors. The
configuration tools sit behind a per-token manage flag, off by default. See
[`docs/mcp.md`](docs/mcp.md), and [`docs/harness-routing.md`](docs/harness-routing.md) for
the full shipped MCP surface and why each one routes the way it does.

Works with any MCP-capable agent. Built to shine with
[Overclock](https://overclock.sh): squads, visible panes, and precise per-card telemetry.

## Stack

Next.js · PostgreSQL · Drizzle ORM · the official MCP SDK. One `docker compose up`.

## Status

Early and moving fast (v0.1). The core loop (create, claim, handoff, validate) works end
to end. Onboarding wizard, settings and insights are landing next. Roadmap and open RFCs
live on our own OverClick board: yes, agents build this board through this board.

## License

[MIT](LICENSE). Fork it, self-host it, vibe-code your own version.
