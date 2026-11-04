# Getting started

The complete walkthrough: from zero to an AI agent executing cards on your own board.
Takes about 10 minutes.

## 0. Requirements

- Docker + Docker Compose (that's it: Postgres ships in the compose file).
  No Docker yet? macOS: `brew install --cask docker && open -a Docker` (or OrbStack);
  Linux: your distro's `docker` + `docker-compose-plugin` packages;
  Windows: Docker Desktop with WSL2.
- An MCP-capable coding agent on your machine: Claude Code, Codex CLI, Gemini CLI,
  Antigravity (`agy`), [Overclock](https://overclock.sh), or any MCP client

## 1. Run the board

```bash
git clone https://github.com/ustoppble/overclick && cd overclick
export AUTH_SECRET="$(openssl rand -base64 32)"
docker compose up --build
```

Open **http://localhost:3000**.

> `AUTH_SECRET` is required for every installation and has no built-in default.
> Generate a different value for each installation and keep it in that deployment's
> protected environment; Compose stops before startup if it is absent. Nothing in the
> app ever calls out of your server.

## 2. Create the admin account

First access shows the setup screen: your e-mail, then the 6-digit code sent to it.
There is no password; the code (10 minutes, single use) is how you sign in every time.
No marketing questions: it's just a login.

Codes go out through [Resend](https://resend.com): set `RESEND_API_KEY` and `EMAIL_FROM`
(on a domain verified in Resend). Without them the screen says sign-in is unavailable,
and the way in is an emergency link made on the server, which on an instance with no
accounts also creates the first admin:

```bash
docker compose exec app pnpm emergency-login you@example.com
```

It prints only the path of a file inside the container (mode 600) holding a link that
signs you in once, within 10 minutes. Read it off-screen and delete it after; see
[deploy/README.md](../deploy/README.md#emergency-sign-in-server-owner-only).

## 3. Onboarding: 3 steps

1. **Project**: name it, optionally add the repo URL. The ID prefix (e.g. `AGB`) is
   derived from the name; it drives the whole Git convention: cards become `AGB-1`,
   branches become `agb-1-fix-login`.
2. **Executors**: check the CLIs/models your team actually has. A claim that declares a
   model outside this list is refused, so the record only ever names models you own.
3. **Connect your agent**: two paths, both ending with the agent connected over MCP.

### Pairing code (recommended, the token never touches the chat)

Generate a one-time 6-digit pairing code in the wizard (or later in Settings › Tokens)
and read it to your agent, or hand it the ready-made exchange command. The agent trades
the code for the real token on the public pairing endpoint:

```bash
curl -sX POST http://localhost:3000/api/pair \
  -H 'Content-Type: application/json' -d '{"code":"<6 digits>"}'
```

The response carries the bearer token; the agent stores it and connects to `/mcp` with
`Authorization: Bearer <token>`. The code works once and expires in 10 minutes, so the
secret never appears in a conversation, a livestream, or a chat log. The indicator in
the wizard lights up when the code is exchanged.

Tell your agent something like:

> pair with my OverClick board at localhost:3000 with code 483920, store the token in
> your MCP config, and never print it

### Copy command (classic)

Generate an MCP token (shown once: store it safely) and copy the ready-made command for
your CLI. For Claude Code it looks like:

```bash
claude mcp add --transport http overclick http://localhost:3000/mcp \
  --header "Authorization: Bearer <your-token>"
```

Prefer this path only when you are pasting into your own terminal, not into an agent
conversation that may be logged or streamed.

## 4. The first card

Your board is born with one example card (`AGB-1`: "Ask your agent to grab this task").
In your agent's terminal, say:

> grab the next task from the board

Watch the board: the card slides to **In progress** with the executor's identity, and
when the agent finishes, it lands in **Done · review** with a summary, evidence, and the
real cost (model · minutes · tokens · ~$).

## 5. Validate: the human's move

Open the card in **Done**. Review it against the *How to confirm* script (you wrote it
when creating the card: it's the contract). Then:

- **Validate**: the card moves to *Validated*. Only humans can do this.
- **Reopen with a comment**: the card returns to *Open*, and your comment travels to
  the agent on its next claim.

## 6. Daily flow

- **Morning (board):** create cards. Each card is a contract (*What / Why / How to
  confirm*), with no model attached: the agent that claims it records the CLI, model and
  effort it actually runs on.
- **All day (terminal):** "grab the next task" · "register this as a task for later".
  Agents also file their own discoveries as cards over MCP.
- **End of day (board):** the *Done* column is your review queue. Validate or reopen.

## 7. Settings

- **Executors**: add/remove CLIs and models.
- **MCP tokens**: one per agent/machine, revocable, last-use tracked. The pairing-code
  button lives here too: pair a new agent without the token ever entering a chat.
- **Updates**: off, check only or automatic, plus the update that applies to how this
  instance actually runs: a real one-click update on a source checkout, or the command to run on the
  server for a container. See below.

## 8. Updating

### The three modes

Settings › Updates offers three states, and the conservative one is the default:

| Mode | What it does |
|---|---|
| **Off** (default) | Nothing reaches the network. This instance never learns a newer version exists. |
| **Check only** | One request an hour to `api.github.com` for the latest release tag and notes. It tells you; you decide. |
| **Automatic** | The same check, and when it finds a newer release the instance applies the update itself, under exactly the rules the button follows. |

Automatic is not a second, looser update path: it is the same step runner, so it refuses a
dirty working tree the same way and records the refusal instead of forcing its way through.
It applies only on a source checkout, because a container is replaced rather than pulled
into and this process cannot do that to itself; there, automatic degrades to telling you.
An attempt happens at most once an hour, so a refusal you have not resolved yet does not
run `git` on every page render.

Whatever ran last leaves a line in the panel: what it did, when, and for which release.

### Force update

A **Force update** button sits next to Update in every mode, including Off. It runs the
whole pipeline even when the version already matches, which is what you want when an
instance is broken, half-built, or ahead of the tag it reports. It refuses a dirty tree like
everything else here.

### How this instance runs

The panel first works out how this instance runs, because the advice is not the same in
both cases. It looks for the marks a container leaves (`/.dockerenv`, the podman marker,
the container runtime in the init process's cgroup) and states what it found in the
version line: *running version 0.1.6, in a container* or *from the source checkout*. Set
`AGENT_BOARD_RUNTIME=container` or `AGENT_BOARD_RUNTIME=source` to overrule it when your
setup hides those marks.

### Running from the source checkout

`pnpm dev` or a built node process on the host has no image to pull and no container to
recreate. It does not need one: the process already owns the repository and the rights to
change it, so the Update button runs the update itself, right there, and shows you each
step and its result.

**One click.** Press Update and the board runs, in its own checkout:

1. `git pull --ff-only`, from the repository root, whatever directory the process started in.
2. `pnpm install --frozen-lockfile`, only when the pull touched the lockfile or a
   `package.json`. Otherwise the step says so and is skipped.
3. `pnpm --filter @agent-board/mcp-core build`, only when that package changed. It is the
   one the app imports from `dist` instead of source, so a stale build is a real bug.
4. `pnpm --filter @agent-board/db migrate`, always. The migrator keeps its own journal and
   applies exactly what is pending, which also repairs an instance that missed one earlier.

Each step is reported as done, skipped or failed, with the tail of what it printed. The run
stops at the first failure and nothing after it runs.

**What it refuses to do.** Two cases end the run before anything is touched, and the panel
says which one:

- **A dirty working tree.** Uncommitted changes are somebody's work, and a pull over them is
  worse than a button that declines. Commit or stash, then press Update again.
- **Not a git checkout at all.** Nothing to pull; update it the way you deployed it.

The action is behind the same session as everything else in Settings, and it only runs where
the instance really runs from source. A container has an image and its own path for it.

**The restart, honestly.** What happens to the process afterwards depends on how it was
started, and the panel tells you which one applies:

- Under `pnpm dev`, the dev server picks the new code up by itself. The panel says the update
  is live and there is nothing left to do.
- Under a production node process, the board asks you to restart it. It will not kill a
  server nothing is watching, because that is an instance that never comes back.
- Under a production process with a supervisor (systemd, pm2, a compose restart policy), set
  `AGENT_BOARD_RESTART_ON_UPDATE=1` and the board exits cleanly right after answering the
  page, so the supervisor starts it again on the new code. This is opt-in precisely because
  only you know whether something is there to restart it.

**By hand.** The same update stays on screen as a copyable command for anyone who would
rather type it:

```bash
git pull && pnpm install && pnpm --filter @agent-board/mcp-core build
```

Then restart the process the way you started it, and run `pnpm db:migrate` with
`DATABASE_URL` set if the pull brought new migrations.

### Running in a container

There are two honest paths, and Settings › Updates shows whichever one applies to your
instance.

**On the server, by hand.** Nothing on the board can restart a container, so
Settings › Updates and the new-version banner give you the command and you run it on
the server, from the project folder:

```bash
git pull && docker compose up -d --build --remove-orphans
```

There is no update button for a container install. Earlier versions shipped an optional
`updater` sidecar that mounted `/var/run/docker.sock`, which is root on the host, and
it was removed. If you had turned it on, the command above (note `--remove-orphans`)
also removes its leftover container; your data, in the `pgdata` volume, is untouched.
Nothing about this calls out of your server, except the release check you turn on
yourself.

## Troubleshooting

| Symptom | Check |
|---|---|
| Agent gets 401 | Token revoked or header pasted incomplete: generate a new one in Settings › Tokens |
| "waiting for first connection" never lights | Is the container up? Can the CLI reach the host? Is the `Authorization` header whole? |
| Card stuck in *In progress* | The agent died without a handoff: reopen the card (its attempt stays recorded) |
| `Done` but no telemetry | The executor didn't report usage: generic MCP agents may not; the card is marked "telemetry incomplete" |

## Where things live

Everything is in your Postgres, on your machine. Dump it, back it up, move it: it's
yours. The board never phones home.
