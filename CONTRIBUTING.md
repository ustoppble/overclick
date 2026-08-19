# Contributing to OverClick

Thanks for wanting to contribute! OverClick is a self-hosted task board where AI agents
execute cards — and it is built through its own board (agents claim cards, humans review).
You can contribute the classic way (fork → branch → PR) or the native way: connect your
coding agent to a board over MCP and let it claim a card. Both are described below.

## Prerequisites

- **Node.js >= 22** (enforced via `engines` in `package.json`)
- **pnpm 9** — the repo pins `pnpm@9.15.9` via the `packageManager` field
  (`corepack enable` gives you the right version automatically)
- **Docker** (optional but easiest for Postgres), or a local **PostgreSQL 16**

## Repository layout

```
apps/web           Next.js app — board UI, auth, and the /mcp HTTP endpoint
packages/mcp-core  Pure TypeScript: contracts, card state machine, harness policy
packages/db        Drizzle ORM schema, migrations, seed
docs/              getting-started.md, mcp.md (the MCP surface),
                   harness-routing.md, rfcs/
```

## Quick smoke test (no local toolchain)

The full stack runs with a single command — useful to see the product before hacking on it:

```bash
docker compose up --build
```

Open http://localhost:3000. Postgres ships in the compose file; nothing phones home.

## Local dev setup

### 1. Install dependencies

```bash
pnpm install
```

### 2. Build `mcp-core`

`@agent-board/mcp-core` is consumed from its compiled `dist/` output, so build it once
after installing (and again whenever you change it):

```bash
pnpm --filter @agent-board/mcp-core build
```

### 3. Start Postgres

Option A — Docker (matches the credentials used everywhere in this repo):

```bash
docker run --name overclick-pg -d -p 5432:5432 \
  -e POSTGRES_USER=agentboard \
  -e POSTGRES_PASSWORD=agentboard \
  -e POSTGRES_DB=agentboard \
  postgres:16-alpine
```

Option B — your own local Postgres: create a database and user, and adjust
`DATABASE_URL` accordingly in the steps below.

> Note: `docker compose up` alone won't work for local dev — the compose file does not
> publish Postgres on the host; it is only reachable from the `app` container.

### 4. Configure environment

Two consumers read the environment in different ways:

- **The Next.js app** reads `.env.local` from `apps/web/`:

  ```bash
  cp .env.example apps/web/.env.local
  ```

  The template already points at the Docker Postgres from step 3. `AUTH_SECRET` must be
  at least 32 characters (any long random string works for local dev).

- **The db scripts** (`db:migrate`, `db:seed`) read `DATABASE_URL` from the shell
  environment — they do not load `.env` files. Pass it inline as shown in step 5.

Never prefix these variables with `NEXT_PUBLIC_` — they are server-only.

### 5. Migrate and seed

```bash
DATABASE_URL=postgres://agentboard:agentboard@localhost:5432/agentboard pnpm db:migrate
DATABASE_URL=postgres://agentboard:agentboard@localhost:5432/agentboard pnpm db:seed
```

The seed is idempotent: it creates an example workspace, project, and card only if the
database is empty, and skips otherwise.

If you change the Drizzle schema in `packages/db/src/schema/`, generate a new migration
with `pnpm db:generate` and commit the files it writes to `packages/db/drizzle/`.

### 6. Run the dev server

```bash
pnpm dev
```

Open http://localhost:3000, create the local admin account (e-mail + password, stored
hashed in your own Postgres), and follow the 3-step onboarding. See
[`docs/getting-started.md`](docs/getting-started.md) for the full walkthrough.

## Running the tests

All tests use [Vitest](https://vitest.dev). From the repo root:

```bash
pnpm test
```

That runs the suites in `packages/mcp-core`, `packages/db`, and `apps/web`. To run a
single package:

```bash
pnpm --filter @agent-board/mcp-core test
pnpm --filter @agent-board/web test
```

The `apps/web` integration tests (MCP end-to-end, auth, policy) run against an in-memory
Postgres via `@electric-sql/pglite` — no running database required. Remember that
`apps/web` tests import `@agent-board/mcp-core` from `dist/`, so re-run the `mcp-core`
build (step 2) after touching that package.

## The one-line check on the top bar

The top bar holds one rule: no label in it ever breaks across two lines. A control that
runs out of room shrinks, truncates with an ellipsis while the whole value stays reachable
on its title or in the panel it opens, or moves behind the menu button. It never wraps.

`scripts/topbar-one-line.mjs` checks that rule at several widths in headless Chrome. It
drives the browser over the DevTools protocol with no extra dependency, and it measures
the text the browser actually painted: for every control on the bar it counts the line
boxes under it, and it fails if any control paints two. It also fails when the bar's
content is wider than the bar, since a control pushed past the edge is a control nobody
can reach.

It needs a board running and a session, so it is not part of `pnpm test`. Run it by hand
against a dev server:

```bash
BOARD_COOKIE=<value of the ab_session cookie> pnpm check:topbar
```

Useful switches: `--url` for another page that uses the same bar (`/insights`,
`/settings`), `--widths 1440,1024,390` to narrow the sweep, `--shots ./out` to write one
screenshot per width, and `VERBOSE=1` to print the width every control ended up with.
The default sweep is 1440, 1280, 1024, 768, 390 and 320, on purpose: the regression that
this check was written for was visible at 1440 and invisible on a phone.

## The sheet check on the card detail

Below the mobile breakpoint the card detail is not a window floating over the board: it
is a sheet. It takes the whole viewport with no strip of the list left at the edges, it is
opaque from the very first frame of its entrance, the way out stays on screen without
scrolling, the board behind it never moves, and closing it puts the list back exactly
where it was. Above the breakpoint the detail stays the centred panel it has always been.

`scripts/detail-sheet.mjs` checks that rule. A screenshot of the settled panel cannot see
what this guards against, because the overlap it was written for lasted a fifth of a
second, so the guard freezes the entrance instead of racing it: it pauses every animation
before the card opens, seeks them to seven points of their own duration, and at each point
captures the frame twice, once with the board list rendered and once with it hidden.
Identical frames are the proof that at that instant the sheet was the only thing painted;
a single pixel of difference fails the run. It then scrolls the sheet to its end to check
the way out is still on screen, pushes the page behind it to check it does not move, and
closes it to check the list came back at the offset it was left on. Last it opens the same
card at 1440 and fails if the detail stopped being centred with the board around it.

Like the top bar check it needs a board running and a session, so it is not part of
`pnpm test`:

```bash
BOARD_COOKIE=<value of the ab_session cookie> pnpm check:sheet
```

Useful switches: `--widths 390` to narrow the phone sweep, `--url` for another page that
opens the same detail, and `--shots ./out` to write every captured frame, which is the
fastest way to see what a failing frame actually looked like.

## Branch and commit convention

Every change maps to a card on the board, and the card ID drives the Git convention:

- **Branch:** lowercase card ID + short slug — e.g. `agb-2-add-contributing-md`
- **Commit:** prefix the message with the card ID in brackets — e.g.
  `[AGB-2] docs: add CONTRIBUTING.md with dev setup`
- **PR title:** include the same `[AGB-2]` prefix

When an agent claims a card over MCP, the briefing includes the exact branch name and
commit prefix to use. The board tracks which branch belongs to which card — no GitHub
API involved, so this works with any forge (or none).

## Contributing through the board itself

This is the dogfooding path: the roadmap and open cards live on an OverClick board, and
MCP-capable agents (Claude Code, Codex CLI, Gemini CLI, [Overclock](https://overclock.sh),
or any MCP client) execute them.

1. Run your own board (see above) or get a token for an existing one. Tokens are created
   in **Settings › MCP tokens** and shown once.
2. Connect your agent — for Claude Code:

   ```bash
   claude mcp add --transport http overclick http://localhost:3000/mcp \
     --header "Authorization: Bearer <your-token>"
   ```

3. In your agent's terminal: *"grab the next task from the board."* The agent calls
   `task_claim`, receives a self-contained briefing (contract + harness + branch
   convention), does the work, and reports back with `task_deliver` — summary,
   evidence, and real usage telemetry (tokens, duration, cost).
4. A human reviews the card against its *How to confirm* script and validates or reopens
   it. `Done ≠ Validated` — only humans stamp *Validated*.

The full MCP surface is documented in [`docs/mcp.md`](docs/mcp.md).

## Pull request checklist

- [ ] `pnpm test` passes from the repo root
- [ ] Touched the top bar or its labels? `pnpm check:topbar` is green at every width
- [ ] Touched the card detail or its overlay? `pnpm check:sheet` is green at every width
- [ ] Branch and commits follow the card-ID convention above
- [ ] New schema changes ship with generated migrations (`pnpm db:generate`)
- [ ] No telemetry, analytics, or phone-home of any kind — this is a hard project rule

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
