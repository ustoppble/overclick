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
   card over MCP, declares what it runs on (CLI, exact model, effort), receives a
   self-contained briefing (contract + mission context + branch convention), and the card
   slides to *In progress*.
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
export AUTH_SECRET="$(openssl rand -base64 32)"
docker compose up --build
```

The signing key is mandatory and must be unique to each installation. Compose
stops with an explanatory error when `AUTH_SECRET` is missing; keep the generated
value in your deployment's protected environment so restarts use the same key.

Open `http://localhost:3000`, create the local admin account, and follow the 3-step
onboarding: project, executors, connect your agent. There are no passwords: you sign in
with a 6-digit code sent to your e-mail, through [Resend](https://resend.com)
(`RESEND_API_KEY` and `EMAIL_FROM`). Without them, create the first admin and sign in with
a one-time emergency link made on the server:
`docker compose exec app pnpm emergency-login you@example.com` prints the path of a file
inside the container that holds the link. Full walkthrough:
[docs/getting-started.md](docs/getting-started.md).

### Connect an agent

```bash
claude mcp add --transport http overclick http://<your-host>/mcp \
  --header "Authorization: Bearer <your-token>"
```

Then, in your terminal: *"grab the next task from the board."* Watch the example card move.

### Install the plugin (Claude Code)

The MCP server above is enough to claim and deliver cards. The plugin adds the rest of
the workflow — the canonical `OVERCLICK.md`, the `/overclick:*` commands, and the
lifecycle hooks — from this repository's own marketplace:

```bash
claude plugin marketplace add ustoppble/overclick
claude plugin install overclick@overclick
```

Verify it materialized rather than trusting the success message — `claude plugin list`
must report the version and `claude plugin details overclick` must list the components:

```bash
claude plugin list          # overclick@overclick, enabled
claude plugin details overclick
```

`claude plugin update overclick@overclick` picks up later releases. For the other CLIs, or
to have the installer write the MCP server and your token into each CLI's native config in
one pass, use `install.sh` instead — see [docs/design/plugin.md](docs/design/plugin.md).

## One-Click Deploy

[![Deploy on RepoCloud](https://d16t0pc4846x52.cloudfront.net/deploylobe.svg)](https://repocloud.io/details/Overclick/)

## What makes it different

- **Cards are contracts.** *What / Why / How to confirm*, written before the work, so
  review is a script instead of a vibe. `Done != Validated`: merge is the machine's
  opinion, validation is yours.
- **It records what ran, it does not pick it.** A card is born as a contract, with no
  model attached. The agent that claims it declares what it really runs on (CLI, exact
  model, effort) and the delivery adds the measured tokens per model, so the card carries
  what happened instead of a forecast. Which harness runs what is decided where the work is
  launched; the board keeps that record honest.
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

32 tools, including `project_list` · `project_get` · `project_create` · `project_update` · `project_delete` ·
`mission_list` · `mission_get` · `mission_create` · `mission_update` · `mission_delete` ·
`task_list` · `task_get` · `task_create` · `task_search` · `task_claim` · `task_release` ·
`task_heartbeat` · `task_update` · `task_deliver` ·
`task_delete` · `branch_register` · `executors_update` · `insights_query`. Streamable HTTP, bearer tokens, atomic claims, typed errors. The
configuration tools sit behind a per-token manage flag, off by default. See
[`docs/mcp.md`](docs/mcp.md) for the full shipped MCP surface.

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
