# Deploying the cloud instance

This directory holds what a hosted OverClick instance needs, kept apart from the
quickstart compose file at the repo root so a server can run this one without
touching anything else already on the machine: its own project name, network,
volume and port.

The root `docker-compose.yml` is a local quickstart only. On a hosted instance,
always use `./deploy/deploy.sh`; it exports the deploy-only `COMPOSE_FILE`, takes
a single-deploy lock, checks the existing project for accidental root compose
files, and removes the known legacy Postgres orphan when it is safe to do so.

## First deploy

```bash
git clone https://github.com/ustoppble/overclick && cd overclick
cp deploy/.env.example deploy/.env       # then fill it in, see below
./deploy/deploy.sh
```

`deploy/.env` needs two values and nothing else:

```
POSTGRES_PASSWORD=<a long random string>
AUTH_SECRET=<32+ random characters>
OVERCLICK_PORT=3100                      # optional, the loopback port the proxy talks to
GITHUB_WEBHOOK_SECRET=<random string>    # optional, see "GitHub release webhook"
RESEND_API_KEY=<your Resend API key>     # optional, see "Sign-in by email code"
EMAIL_FROM=<Name <sender@your-domain>>   # optional, see "Sign-in by email code"
```

Generate both with `openssl rand -hex 32`. The app listens on `127.0.0.1:3100`
by design: nothing reaches it except through the reverse proxy.

## GitHub release webhook

A project whose context follows a releases repo can be updated the moment a
release is published, through `POST /api/github/release`. That route only
accepts deliveries signed with `GITHUB_WEBHOOK_SECRET` (GitHub's
`X-Hub-Signature-256`) and refuses every call while the variable is empty, so
it stays closed until you set it up:

1. Generate a secret with `openssl rand -hex 32` and put it in `deploy/.env`
   as `GITHUB_WEBHOOK_SECRET=`, then run `./deploy/deploy.sh` so the app
   container picks it up.
2. In the releases repo on GitHub: Settings → Webhooks → Add webhook. Payload
   URL `https://<your board>/api/github/release`, content type
   `application/json`, Secret = the same value, events = "Let me select
   individual events" → Releases only.
3. Repeat step 2 for every releases repo a project follows; they all share the
   one secret. After a redeploy, GitHub's "Recent Deliveries" tab shows the
   ping answered 200.

## Sign-in by email code

The login screen offers "Sign in with an email code" next to the password: the
person types their address, receives a 6-digit code valid for 10 minutes, and
types it back. It sets the same session as the password sign-in, and the
password keeps working as before.

Mail goes out through [Resend](https://resend.com), from two variables in
`deploy/.env`:

```
RESEND_API_KEY=<your Resend API key>
EMAIL_FROM=OverClick <login@your-domain>
```

`EMAIL_FROM` has to be on a domain verified in your Resend account. Run
`./deploy/deploy.sh` after setting them so the app container picks them up.
While either is empty, asking for a code answers that the option is not
available on this instance and logs one line saying which variables are
missing; nothing else changes.

Codes are stored only as a keyed hash, work once, and die after 5 wrong
attempts. An address can ask for 1 code a minute and 5 an hour (and one origin
for 20 an hour, behind the trusted proxy), and the answer never says whether
the address has an account.

## Reverse proxy

Caddy, the shortest path to HTTPS:

```
cloud.overclock.sh {
    reverse_proxy 127.0.0.1:3100
}
```

Nginx, if the host already runs one:

```nginx
server {
    server_name cloud.overclock.sh;
    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;          # MCP streams over HTTP, do not cut it short
    }
}
```

The long read timeout matters: agents hold streaming HTTP calls to `/mcp` while
they work.

## Deploying again

```bash
./deploy/deploy.sh
```

That is `git pull`, rebuild, restart, and a health check, in one command. The
data volume is never touched, so cards, tokens and settings survive every deploy.
If another deploy is already running, the second invocation exits with a clear
lock message and does not touch the compose project.

After a deploy, `docker compose ls --all` should show the `overclick` project
using only `deploy/docker-compose.cloud.yml` and, when the proxy overlay is
enabled, `deploy/docker-compose.traefik.yml`. If the listing contains a root
compose file, stop and remove that legacy project before retrying; the deploy
script refuses to guess which project is safe to change.

## One-click update from the UI

Off by default; a signed-in owner turns it on from Settings → Updates, or a
human runs it directly:

```bash
docker compose -p overclick -f deploy/docker-compose.cloud.yml --profile updater up -d
```

It watches for the Update button in the board, then runs `./deploy/deploy.sh`
itself, from inside the sidecar container, over the checkout and the docker
socket. It takes the same `/tmp/overclick-deploy.lock` flock a human running
`./deploy/deploy.sh` on the host takes, so the two can never interleave: one
waits its turn. Progress and any failure detail land in the board's Settings
page. It needs the docker socket, which is root on the host — that is the
whole reason it stays behind the `updater` profile instead of running always.

## Releasing a new version

A release is a tag and a version bump in the *same commit* — `scripts/verify-
release-version.sh` fails the `release-image` workflow if a pushed `v*` tag
does not match every `package.json` in the repo. This is what OCL-73 fixed:
a tag pushed without the matching bump left the deployed instance's own
`APP_VERSION` reading older than the release it already ran, so the update
banner offered an update to an instance that was already current. Bump
`package.json`, `apps/web/package.json`, `packages/db/package.json` and
`packages/mcp-core/package.json` to the same version, commit, tag `vX.Y.Z` on
that commit, and push the tag.

## Backups

The whole instance is one Postgres volume:

```bash
docker compose -p overclick -f deploy/docker-compose.cloud.yml exec -T overclick-db \
  pg_dump -U overclick overclick | gzip > overclick-$(date +%F).sql.gz
```

Put that in a cron and the instance is disposable, which is the point.
