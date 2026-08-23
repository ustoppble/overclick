# overclick

Claim, execute, and deliver [OverClick](https://github.com/ustoppble/overclick) cards from
your CLI. OverClick is an MIT-licensed, self-hosted task board for hybrid human + AI-agent
teams: humans write the contract and validate, agents claim the card, do the work, and
report back with evidence and per-model telemetry.

This plugin carries the *discipline* of that board — the workflow rules, the slash
commands, the guards — so an agent that installs it already knows how to behave on a card.

## Install

### Grok

```bash
grok plugin marketplace add ustoppble/overclick
grok plugin install overclick
```

Or install straight from the repo, without registering the marketplace — the plugin lives
in the `plugin/` subdirectory:

```bash
grok plugin install 'ustoppble/overclick#plugin'
```

Then point it at your own board:

```bash
grok mcp add --transport http --scope user \
  --header "Authorization: Bearer <your-token>" \
  overclick https://<your-instance>/mcp
```

Verify with `grok plugin details overclick` and `grok inspect` — the latter lists the
`overclick` skill, the five slash commands, the hooks, and the MCP server.

### Every CLI at once

The board's instance serves an installer that detects which CLIs you have and drives each
one's *native* plugin manager (Claude Code, Codex, Grok, Kimi). See the repository
[README](https://github.com/ustoppble/overclick).

## What it ships

| Component | What it does |
|---|---|
| `skills/overclick` | The workflow: how to read a card contract, claim it, deliver it with measured usage |
| `commands/` | `/board`, `/card`, `/claim`, `/deliver`, `/release` |
| `hooks/hooks.json` | Board snapshot at session start; claim-marker bookkeeping; a delivery commit check; opt-in guards |
| `.mcp.json` | Empty on purpose: the package declares no MCP server. The installer writes the `overclick` server into each CLI's own configuration, with your instance URL resolved, so a marketplace install can never leave you a server that cannot connect |
| `OVERCLICK.md` | The canonical rules the skill and commands both defer to |

## Network endpoints and credentials

The plugin talks to **exactly one endpoint: your own OverClick instance**, whose URL you
supply. There is no vendor endpoint, no analytics, no telemetry, and no phone-home — the
plugin ships no hostname of ours at all.

- **Credential:** a bearer token for your instance. The installer writes it to
  `${XDG_CONFIG_HOME:-~/.config}/overclick/config` with mode `600`, or you pass it to your
  CLI's own MCP config. It is never committed, never printed, and never leaves your machine
  except as the `Authorization` header on requests to your instance.
- **Hook traffic:** `session-start.mjs` reads your current cards, and the enforcement guards
  ask the board whether you hold a claim. Both hit the same instance URL.

## Hooks and least privilege

Two hooks are on by default and are read-only with respect to your repo: the session-start
board snapshot, and the `PostToolUse` bookkeeping that records or clears the local claim
marker after `task_claim` / `task_deliver` / `task_release`.

The **enforcement** guards are opt-in and ship disabled (`enforce_claim=0`,
`enforce_stop=0`, `enforce_harness=0` in the config file). `claim-guard.mjs` is the one
matched on `Edit|Write|Bash`: with `enforce_claim=0` it exits silently without inspecting
anything, and only when you deliberately turn it on does it block a write that has no
claimed card behind it. Turning it on is a choice you make about your own workflow.

No hook downloads or executes remote content. They are plain Node scripts, readable in
`hooks/`, run as `node "<plugin root>/hooks/x.mjs"`, and they depend on nothing but Node
itself — no `jq`, no `python3`, no `curl`, no shell. That is also what makes them work on
Windows without Git Bash, where the previous POSIX-shell hooks could not even be parsed by
PowerShell.

## License

[MIT](https://github.com/ustoppble/overclick/blob/main/LICENSE).
