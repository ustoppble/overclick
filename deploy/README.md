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
```

Generate both with `openssl rand -hex 32`. The app listens on `127.0.0.1:3100`
by design: nothing reaches it except through the reverse proxy.

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

## Updating a hosted instance

Settings does not offer a one-click Update button here (OCL-157). The `app`
service is built from the checkout (`build: context: ..`) with no `image:`,
so `docker compose pull app` is a no-op: the click would report success and
leave the instance on the old version. The path is the same command this
directory already documents:

```bash
./deploy/deploy.sh
```

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
