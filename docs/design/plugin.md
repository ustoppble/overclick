# Official OverClick plugin design

Status: approved for OCL-50. This document records the capability matrix explored
in OCL-49 and the owner's final decisions. It replaces the discarded OCL-47 design.

## Package shape

`plugin/` is the single portable package. `plugin/OVERCLICK.md` is the only full
workflow source; the bundled skill points to it instead of maintaining a second copy.
Provider manifests adapt that same package to each native loader.

| Capability | Claude Code | Grok CLI | Kimi Code | Codex | Antigravity (`agy`) |
| --- | --- | --- | --- | --- | --- |
| Manifest | `.claude-plugin/plugin.json` | `plugin.json` | `kimi.plugin.json` (package root) or `.kimi-plugin/plugin.json` (repository root) | `.codex-plugin/plugin.json` | `plugin.json` (shared with Grok) |
| Repository marketplace | `.claude-plugin/marketplace.json` | `.grok-plugin/marketplace.json` | Official registry (`curated` tier) plus native custom install | Installer-created local marketplace | No public registry; installs from a directory or a GitHub subpath |
| Skill | `skills/overclick/SKILL.md` | Same | Same | Same | Same |
| Commands | Auto-discovered `commands/` | Auto-discovered `commands/` | `commands` manifest field | Skill-driven; not declared in the manifest | Auto-discovered `commands/`, converted to namespaced skills |
| MCP | `claude mcp add`, user scope | `grok mcp add`, user scope | `~/.kimi-code/mcp.json` | `[mcp_servers.overclick]` in `config.toml` | `mcp_config.json` in the plugin (`serverUrl` + `headers`) - its only channel |
| Hooks | `hooks/hooks.json` | `hooks/hooks.json` | `hooks` manifest field | Global lifecycle hooks, but no client-side claim guard; deliberately absent from the plugin manifest | `hooks.json` at the plugin root, dispatched through `hooks/antigravity.sh` |
| Memory | `@` import in `~/.claude/CLAUDE.md` | Bundled skill only | Bundled skill only | Bundled skill only | `rules/AGENTS.md` inside the plugin, loaded whenever the plugin is enabled |

The Codex manifest contains only the skill and MCP contributions. Its installer
uses the native marketplace manager, then writes the required user MCP block and
merges global hooks without replacing unrelated rules.

### One MCP registration per CLI, and none in the package (OCL-114)

The package declares **no** MCP server. `plugin/.mcp.json`, `plugin/mcp_config.json`
and `plugin/.codex-plugin/mcp.json` ship an empty `mcpServers`, and
`plugin/kimi.plugin.json` has no `mcpServers` key at all - the same reasoning that
already kept it out of the repository-root `.kimi-plugin/plugin.json`, applied
everywhere.

Two failures came out of the old arrangement, and both were seen on a real machine:

- A `${OVERCLICK_URL}` placeholder is not expanded by any of these CLIs from the
  package itself. Kimi drops the server silently. Claude keeps it and reports
  `${OVERCLICK_URL} (HTTP) - Failed to connect`. Anyone installing straight from a
  marketplace - the documented path for users who only want the plugin - therefore
  got a server that could never connect, and every agent reading it concluded the
  board was down.
- Where install.sh *did* resolve the URL, it wrote the server into the package copy
  **and** into the CLI's own configuration, so each CLI ended up holding two servers
  named `overclick`. A stale package copy could then shadow a working connection.

So: install.sh writes the resolved server where each CLI keeps its own servers, and
never into the package. Antigravity is the exception, because its plugin manifest is
the only channel it reads; that copy stays mode-600. A registry or marketplace install
without install.sh gets the skill, commands and hooks and no server - absent, never
dead.

The installer also refuses an instance URL whose host is in a reserved namespace
(RFC 2606/6761: `.invalid`, `.test`, `.example`), because such a URL is a test
fixture rather than a board and baking it produces exactly the dead server above.

And it will not take the name over: if a CLI already holds an `overclick` server
pointing at a different instance, that registration is left alone with an
instruction, while one pointing at this instance is refreshed as before.

### `--header` is variadic (OCL-114)

`claude mcp add` and `grok mcp add` declare `-H, --header <header...>`. A variadic
option consumes every following argument that is not itself an option, so

```
claude mcp add --transport http --scope user --header "Authorization: Bearer …" overclick <url>
```

hands `overclick` and `<url>` to `--header` and dies on `missing required argument
'name'`. `quiet_try` renders that as "needs manual confirmation in its native plugin
manager", which reads like advice rather than a failure, so the Claude registration
had been failing silently while the package's own `.mcp.json` carried the connection.
The name and the URL go before `--header`.

## Hook policy

Five lifecycle hook capabilities ship as POSIX shell scripts:

1. `SessionStart` fetches the first page of open work and claims owned by the
   current MCP token. It contributes only card IDs, titles, and statuses. Default: on.
2. `PostToolUse` after `task_deliver` requires a full Git commit ID in evidence,
   refreshes remote refs without printing them, and confirms that a remote ref contains
   the commit. Default: on.
3. `Stop` queries claims owned by the current token and blocks while any remain in
   execution. Default: off; set `enforce_stop=1` in private plugin config.
4. `PreToolUse` before `task_create` asks the board for the current harness and
   compares it with the card input. Default: off; set `enforce_harness=1`.
5. The claim guard records `.overclick/claim.json` after `task_claim`, removes it
   after `task_deliver` or `task_release`, and checks it before `Edit`, `Write`, or
   a mutating `Bash` command. A missing marker falls back to `task_list` on the
   board; reads never require a claim. Default: off; set `enforce_claim=1`.

The fifth capability is installed only for Claude, Grok, and Kimi. Codex has no
supported client-side equivalent, so its installer filters both claim-guard
registrations. Codex remains covered by the board's stale-claim timeout and by
the OCL-23 server-side delivery verification. This split is intentional and is
documented in the canonical `OVERCLICK.md` instead of being hidden by a nominal
hook file.

The concrete failure behind the guard occurred on 2026-08-19: a Kimi worker
executed OCL-37 without `task_claim`, leaving the card open and the active work
invisible to the board.

Network and Git diagnostics suppress raw remote errors so neither credentials nor
infrastructure addresses enter agent output. Hook failures never print private config.
The marker contains only the card ID, claim time, and client session ID; it never
contains the board URL or token.

## Installer decisions

The repository root `install.sh` is also served verbatim by `GET /install.sh`.
It uses a hidden token prompt in interactive mode, detects installed CLIs, and calls
their native plugin managers. Antigravity is detected as `agy` on PATH or at
`~/.local/bin/agy`, where its own installer puts it. Because `agy plugin install`
copies the directory it is handed, the installer stages a private copy under
`<config root>/overclick/antigravity/overclick`, writes the credentials and the
resolved `OVERCLICK.md` path into that copy, installs it, and re-checks the
mode-600 permission on the materialized `mcp_config.json`. The repository package
stays a generic template. The stable package copy and a mode-600 config live in
the user's configuration area. Provider MCP config is updated idempotently; Codex gets
an explicit `[mcp_servers.overclick]` block and merged global hooks.

`OVERCLICK_INSTALL_HOME` redirects the *managers*, not only the files (OCL-114).
The native plugin managers resolve their user scope from `HOME` - and Claude Code
from `CLAUDE_CONFIG_DIR` when that is exported, which a session managing more than
one account does - so a sandboxed or test run used to register a marketplace in the
operator's real configuration, pointing at a temporary directory and carrying
whatever instance that run was given. The installer now overrides `HOME`,
`XDG_CONFIG_HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `KIMI_CODE_HOME` and
`GEMINI_HOME` whenever `OVERCLICK_INSTALL_HOME` is set. They are overrides rather
than defaults for the reason above: an ambient value would otherwise win.

`GET /install.sh?code=NNNNNN` serves the same script with the instance URL and a
one-time pairing code answered ahead of the prompts, which is what makes the
board's offer a single paste-ready command instead of a command plus a token
hunt (OCL-102). The route validates the code as exactly six digits and the host
as a string that cannot end a shell string, injects both as `:-` defaults after
the shebang so an exported `OVERCLICK_TOKEN` still wins and a saved copy is
still executable, and answers `no-store` because a single-use code must not be
held by a proxy. The installer trades the code on `POST /api/pair` for the real
bearer value and never prints either; a wrong or expired code stops the run
rather than writing half a configuration. What the copyable command carries is
therefore a credential worth nothing ten minutes later, which is the property
that lets it sit on a screen someone is sharing. The board surfaces this in
onboarding step three and in Settings → MCP tokens, from one component, with
the hand-written MCP entry folded under it as the advanced path.

When install.sh runs without a local checkout to reuse (the `curl | bash` case),
it clones the plugin package with plain `git` into a persistent
`<config root>/overclick/plugin-src` checkout instead of an ephemeral `gh repo
clone`. Re-running install.sh fetches and hard-resets that checkout to
`origin/HEAD` — **updating the plugin is re-running install.sh**, nothing else.
This checkout, not a `source github` marketplace entry, is what Claude's
native marketplace add points at — but the reason is token injection, not a
broken `source github`. install.sh merges the user's instance URL and token
into the plugin copy's `.mcp.json` before handing it to the native manager,
and only a local directory can carry that private copy; the repository package
ships a generic environment-variable template.

OCL-103 corrected the reason originally recorded here. `source github` was
blamed for "registering without ever materializing a cache" (OCL-76,
2026-08-19). That premise is wrong: on a clean profile,
`claude plugin marketplace add ustoppble/overclick` followed by
`claude plugin install overclick@overclick` clones the repository, materializes
`plugins/cache/overclick/overclick/<version>`, and reports the full component
inventory — verified on CLI 2.1.235 (the exact build in use when the ghost was
reported) and on 2.1.237. The real cause was manifest version drift: Claude
resolves an installed plugin's version from `plugin.json`, not from the
marketplace entry, and keys the cache directory by it. With the marketplace
entry advertising 0.2.1 over a `plugin.json` still pinned to 0.1.12, users
installed 0.1.12 into a directory a previous 0.1.12 install already occupied,
and every `claude plugin update` answered "already at the latest version
(0.1.12)" without ever refreshing the content. OCL-105 pinned every manifest to
`package.json`'s version in `scripts/test-plugin-package.sh`, and OCL-103 put
that suite in CI, where it had never run.

Because "successfully installed" only means the CLI accepted the command,
install.sh also asks `claude plugin list --json` for the enabled overclick
entry's `installPath` and checks that `OVERCLICK.md` actually exists there;
if not, the run exits non-zero after configuring everything else, instead of
reporting completion for a plugin that isn't really there.

Claude receives an `@` import inside `<!-- overclick:start -->` and
`<!-- overclick:end -->`. A CLI without native plugin support receives one AGENTS.md
reference line inside the same markers. Re-running the installer replaces the marked
block, never duplicates it. Supported CLIs use their plugin instead of an AGENTS.md
fallback; `OVERCLICK_AGENTS_FALLBACK=1` enables that reference when an additional,
unrecognized CLI also needs it.

The package keeps generic instance and token inputs. It contains no internal routing
menu, organization names, deployment authority, or private endpoint. Live harness
selection always comes from `harness_recommend` on the connected board.

## Kimi Code, validated hands-on (OCL-106)

OCL-49 recorded the Kimi row from documentation only, because the binary was not on
the subagent's machine. It is now validated against Kimi Code 0.37.2 running locally.
What the CLI actually does, read from its own manifest parser and confirmed by
installing the package:

- The manifest is `kimi.plugin.json` at the plugin root, or `.kimi-plugin/plugin.json`.
  A root `kimi.plugin.json` shadows the directory form. `name` must match
  `^[a-z0-9][a-z0-9_-]{0,63}$`.
- `skills`, `agents` and `commands` are `./`-relative and must resolve inside the
  plugin. `hooks` entries are `{event, matcher?, command, timeout?}` and are validated
  strictly: an unknown key rejects the whole hook. Plugin hooks run with the plugin
  root as working directory and `KIMI_PLUGIN_ROOT` exported, so `node "./hooks/x.mjs"` is correct.
- `mcpServers` uses `transport`, not `type`. A `type` key is silently dropped and the
  transport re-inferred from `url`, so the previous manifest worked by accident; it now
  declares `transport` explicitly.
- `url` is validated as a real URL. A `${OVERCLICK_URL}` placeholder is **not** expanded
  by Kimi: the entry fails validation and the server is dropped with the plugin still
  reporting `state: ok` and `hasErrors: false`. That silent drop is why install.sh
  substitutes the instance URL into the installed copy before registering it.
- `tools`, `apps`, `inject`, `configFile`, `config_file` and `bootstrap` are parsed but
  unsupported, and are reported as informational diagnostics.
- Plugin MCP tools are namespaced `mcp__plugin-<pluginId>_<server>__<tool>`, which the
  existing `mcp__.*__task_claim` hook matchers still cover.

### Installing without a TUI

Kimi Code has no `kimi plugin` subcommand. `/plugins install` is a host slash command,
and `--prompt` hands slash commands to the model instead of the host — `--prompt` also
refuses to combine with `--auto` or `--yolo` at all. The previous
`kimi --auto --prompt "/plugins install ..."` call could therefore never succeed. The
installer now writes Kimi's own registry the way its manager does: copy the package to
`<KIMI_CODE_HOME>/plugins/managed/overclick` and register it in
`<KIMI_CODE_HOME>/plugins/installed.json`, preserving any other installed plugin.

For a user installing by hand, the working command is typed at the Kimi prompt:

```text
/plugins install <absolute path to the package>
```

Non-official sources require an interactive trust confirmation, which is the other
reason the headless path cannot use it.

### Official registry and submission

The registry is real: `https://code.kimi.com/kimi-code/plugins/marketplace.json`,
overridable with `KIMI_CODE_PLUGIN_MARKETPLACE_URL`, browsable in the CLI with
`/plugins marketplace`. Entries carry a `tier` of `official` (Moonshot-hosted zips) or
`curated` (third-party sources). The catalog is served from the public
`MoonshotAI/kimi-code` repository at `plugins/marketplace.json`, so submission is a pull
request against that file; there is no separate application form. Third parties are
already listed this way (`superpowers`, `vercel-plugin`, `modern-web-guidance`,
`cloudbase`).

A curated entry points at a GitHub repository, and Kimi resolves the plugin root by
looking for a manifest in the extracted archive root or in a single child directory —
it does not search deeper. `plugin/kimi.plugin.json` alone is therefore not reachable
from a repository install, which is why the repository root also carries
`.kimi-plugin/plugin.json` pointing into `./plugin/`. That root manifest deliberately
omits `mcpServers`: a registry install cannot know the user's instance URL, and a
placeholder would be dropped silently. Registry users get the skill, commands and hooks,
then run install.sh (or add the server to `~/.kimi-code/mcp.json`) to connect their board.

The entry to submit, once the owner decides to publish:

```json
{
  "id": "overclick",
  "tier": "curated",
  "displayName": "OverClick",
  "description": "Claim, execute, and deliver OverClick cards from Kimi Code.",
  "homepage": "https://github.com/ustoppble/overclick",
  "keywords": ["overclick", "task-board", "mcp", "workflow"],
  "source": "https://github.com/ustoppble/overclick"
}
```

## Antigravity, validated hands-on (OCL-107)

OCL-49 never covered Antigravity. It is validated here against `agy` on the
owner's machine (binary at `~/.local/bin/agy`, customization docs bundled as
the built-in `agy-customizations` skill). Antigravity has a first-class plugin system —
`agy plugin install|uninstall|list|enable|disable|validate` — and all five
components the board needs load from a single directory, so it gets the native
path, not the AGENTS.md fallback.

`agy plugin install <dir>` copies the directory into
`~/.gemini/config/plugins/<name>/` and ingests `skills/`, `commands/`,
`mcp_config.json`, `hooks.json`, and `rules/`. A GitHub subpath works too:
`agy plugin install https://github.com/ustoppble/overclick/tree/main/plugin`
clones and installs the same package. `agy plugin validate <dir>` reports what
each component contributed and is the cheapest pre-flight check.

Four dialect differences are absorbed by `plugin/hooks/antigravity.sh` rather
than by forking the shared hooks, all confirmed by probing a live `agy` session:

1. Tool names are Antigravity step types — `run_command`, `write_to_file`,
   `replace_file_content`, `view_file`, `call_mcp_tool` — and every MCP call
   arrives as `call_mcp_tool` with the real tool under
   `toolCall.args.ToolName` and its input under `toolCall.args.Arguments`. A
   matcher alone cannot single out `task_claim`; the adapter reads the payload.
2. `PreToolUse` must answer with an explicit decision. An empty object is read
   as a denial — a hook that stays quiet blocks the agent — so the adapter
   always emits `allow`, `deny`, or `ask`, and fails open when it cannot parse
   its input.
3. `PostToolUse` carries the call and an `error` string but never the tool
   response. The claim marker is therefore written from the call arguments, and
   the post-delivery remote check moves ahead of `task_deliver` as an `ask`,
   since after the fact there is no channel back to the model.
4. Hooks start in the plugin directory and `workspacePaths` is empty in print
   mode, so the repository is recovered from the path the call mentions
   (`TargetFile`, `Cwd`) and resolved with `git rev-parse --show-toplevel`.
   `OVERCLICK_WORKSPACE` overrides it.

There is no `SessionStart`. `PreInvocation` is the closest event and fires on
every model call, so the snapshot is gated on `invocationNum == 0` and returned
as `{"injectSteps": [{"ephemeralMessage": ...}]}`.

MCP uses `serverUrl` plus `headers`, which the bundled `mcp_servers.md` does not
document but `agy mcp add --header "Authorization: Bearer …" <name> <url>`
writes verbatim; install.sh emits that same shape into the staged copy.

### Official registry and submission

There is nothing to submit to, and that is a finding rather than a blocker.
`agy plugin link` and the `plugin@marketplace` form resolve names against a
Google-hosted, server-side customization catalog
(`SearchMarketplaceCustomizations`); every name tried was rejected as
`unknown marketplace`, and neither the CLI nor the bundled docs expose a
submission endpoint. Distribution is therefore the directory install that
install.sh performs, or the GitHub subpath form for a manual install.

## Verification contract

- Validate all JSON manifests and both provider validators.
- Validate the Codex plugin and the OverClick skill with their official local tools.
- Run `agy plugin validate plugin/`; skills, commands, mcpServers, and hooks must all
  report as processed.
- Run the installer twice against an isolated home with stub native managers; markers,
  MCP entries, and hook rules must remain singular and private input must not appear in
  output.
- Exercise all four hooks with fixture MCP responses and a local Git remote.
- Fetch `/install.sh` and compare its response byte-for-byte with the root installer.
- Fetch `/install.sh?code=NNNNNN` and confirm the shebang is still first, the rest of
  the script is untouched, the response is uncacheable, and a code that is not six
  digits or a host that could break out of the shell string is ignored entirely.
- Run the installer with a pairing code against a stub `/api/pair`: the token reaches
  the mode-600 config, reaches no output, and a refused exchange exits non-zero
  without writing a configuration.
- Run the MCP schema, integration, lint, type, and production build checks.
