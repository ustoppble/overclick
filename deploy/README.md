# Deploying the cloud instance

This directory holds what a hosted OverClick instance needs, kept apart from the
quickstart compose file at the repo root so a server can run this one without
touching anything else already on the machine: its own project name, network,
volume and port.

The root `docker-compose.yml` is a local quickstart only. On a hosted instance,
always use `./deploy/deploy.sh`; it exports the deploy-only `COMPOSE_FILE`, takes
a single-deploy lock, checks the existing project for accidental root compose
files, and removes the known legacy Postgres orphan container once the backup and
rollback tag exist (the legacy data volume is never deleted automatically).

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
RESEND_API_KEY=<your Resend API key>     # needed to sign in, see "Sign-in by email code"
EMAIL_FROM=<Name <sender@your-domain>>   # needed to sign in, see "Sign-in by email code"
OVERCLICK_PUBLIC_URL=<https://board.your-domain>   # optional, see "Public address"
```

Generate both with `openssl rand -hex 32`. The app listens on `127.0.0.1:3100`
by design: nothing reaches it except through the reverse proxy.

## How the app container is locked down

The image runs as a dedicated user (`overclick`, uid 10001, no shell, no home),
never root, and the cloud compose file adds `read_only: true`,
`cap_drop: [ALL]` and `no-new-privileges`. The application code in the image is
owned by root, so the app user cannot rewrite it. What it may write:

| Path | What | Kind |
|------|------|------|
| `/tmp` (also `HOME`) | pnpm and Node scratch | tmpfs, 64 MB |
| `/app/apps/web/.next/cache` | Next's runtime cache | tmpfs, 256 MB |
| `/run/emergency` | `pnpm emergency-login` link files (mode 700) | tmpfs, 1 MB |

Migrations and the seed run at container start as that user and write nothing
outside the database. A `docker exec overclick-app-1 id` should print uid 10001.

## Public address

`OVERCLICK_PUBLIC_URL` is the address people open the board at (scheme and
domain, no path), for example `https://board.your-domain`. It is the **only**
origin a link inside an email is built from. Team invitations are emailed with
it; the request's `Host` and `x-forwarded-*` headers are written by whoever
sent the request, so they are never used for an emailed link.

While it is empty (or is not an `https://` address, or `http://` on a local
one) invitations are still made, but **no email is sent**: Settings says so
and shows the link to copy. Run `./deploy/deploy.sh` after setting it. It is
unrelated to `OVERCLICK_HOST`, which only configures the proxy overlay.

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

Email codes are the only way in: there are no passwords. The person types their
address, receives a 6-digit code valid for 10 minutes, and types it back.
Creating the first admin (`/setup`) and accepting an invitation (`/invite/…`)
work the same way: the account is only created once the code sent to the
address has been typed back, and it is created without a password. On the
invitation page the person types the invited address themselves (the page does
not print it) and any other address gets the same answer and no code.
Accounts created before this kept their old password hash in the database; it
is no longer read.

Mail goes out through [Resend](https://resend.com), from two variables in
`deploy/.env`:

```
RESEND_API_KEY=<your Resend API key>
EMAIL_FROM=OverClick <login@your-domain>
```

`EMAIL_FROM` has to be on a domain verified in your Resend account. Run
`./deploy/deploy.sh` after setting them so the app container picks them up.
**While either is empty nobody can sign in, set up or accept an invitation by
the web**: the login, setup and invitation screens say "Sign-in unavailable:
email is not configured." and the actions refuse with the same words, logging
one line that says which variables are missing. The way in then is the
emergency link below.

Codes are stored only as a keyed hash (an HKDF subkey of `AUTH_SECRET`, so
the session key itself is never used for it), work once, and die after 5 wrong
attempts. An address can ask for 1 code a minute and 5 an hour (and one origin
for 20 an hour, behind the trusted proxy), and the answer never says whether
the address has an account. A live code under a minute old is never replaced
by a new ask. The failed-attempt budget is 8 failures in 15 minutes per
address typed and, behind the trusted proxy, per origin. The origin is
charged before the code is checked, in one step, so a burst of parallel
guesses cannot slip past it together; the charge is given back when the
sign-in works, so people who sign in correctly are never counted against it.
Switching a member off deletes the codes they were sent.

**The lock on an account.** Ten wrong codes in 24 hours, however many codes
they were spread over, shut code sign-in for that account for **1 hour** from
the tenth. While the day is still running, each further wrong guess after the
hour shuts it for another hour (guesses made during a lock do not count), so a
guesser gets about 33 tries a day at most. The account gets one email per
lock ("Seu login no overclick foi travado por 1 hora"), with no code in it.
Anyone who knows an address can still keep its owner out of code sign-in an
hour at a time; the emergency link ignores the lock.

The whole instance also sends at most 60 code emails an hour, whoever asks;
set `LOGIN_CODE_MAX_SENDS_PER_HOUR` in `deploy/.env` to change it. Past the cap
nobody gets an email, the answer stays the same neutral one, and the log gets
one line (`hourly send cap reached`, no address in it) per hour. The cap is
checked before an address's own minute and hour allowance is charged, so asks
turned away for it cost their owners nothing. The cap is a
kill switch, not a defence: someone asking for codes can use it up and keep
real people from getting theirs until the hour turns.

**Next step, not done:** put a bot check (Cloudflare Turnstile or a captcha) in
front of "send me a code". It needs a Cloudflare site key and secret, so it is
the owner's call; until then the limits above are all there is.

### Emergency sign-in (server owner only)

When nobody can get in by email — no `RESEND_API_KEY`/`EMAIL_FROM`, Resend is
down, or the admin is locked out — whoever has shell on the server makes a
single-use link from inside the app container:

```
docker exec overclick-app-1 pnpm emergency-login <admin email>
```

(`overclick-app-1` is the app container of the `overclick` compose project; `docker ps` shows the name if yours differs.) It prints **only the path** of a file inside the container (mode 600), never the link or
the token. The container's root filesystem is read-only, so the file is written
to `/run/emergency` (`OVERCLICK_EMERGENCY_DIR`, set by the compose file): a
memory-backed directory only the app user can enter, which is emptied by every
restart. The file holds the link: `https://<this board's address>/login/emergency#<token>`.
Open it in a browser within **10 minutes**; it works **once**. The token sits
after the `#`, so it never reaches the proxy, Cloudflare or any access log, and
the database keeps only its hash. Making a new link kills the previous one for
that admin.

Read the file without putting it on a screen that is being shared, for
example copy it to a file on your own machine and open it there, then delete
it in the container (use the path the command printed):

```
docker exec overclick-app-1 sh -c 'cat <path>' > ~/overclick-emergency.txt && chmod 600 ~/overclick-emergency.txt
docker exec overclick-app-1 rm <path>
```

Only an **active admin** gets a link; a member, a switched-off account or an
unknown address is refused and nothing is written. The one exception: on an
instance nobody has set up yet (no accounts at all), the script creates the
first admin with that address, with no password, since without mail there is
no other way to set it up.

### Behind a proxy: which address counts as the origin

The per-origin limits (code requests, and the failed-attempt budget by origin,
which sign-ins that work give back) and the pairing endpoint only look at the
caller's address when `OVERCLICK_TRUSTED_PROXY=1`. The cloud compose file sets
it to `1` unless `deploy/.env` says otherwise. Then:

- By default the origin is the **last** hop of `X-Forwarded-For`. That is right
  for one proxy that **appends** the address it saw (Caddy, Traefik, nginx
  with `$proxy_add_x_forwarded_for`).
- With Cloudflare (or another proxy) in front of yours, the last hop is
  Cloudflare's edge, not the visitor: everyone coming through the same edge
  shares one bucket and real people can be refused. Set
  `OVERCLICK_CLIENT_IP_HEADER=cf-connecting-ip` in `deploy/.env` and run
  `./deploy/deploy.sh`: the origin is then the address Cloudflare writes in
  that header, so two visitors behind the same edge get buckets of their own.
  A request without the header falls back to the last hop.
- Without `X-Forwarded-For` the app falls back to `X-Real-IP`, which a client
  can send itself unless your proxy overwrites or strips it. Make it do one or
  the other.

**`OVERCLICK_CLIENT_IP_HEADER` is only trustworthy if the server takes
traffic from Cloudflare alone.** Anyone who can reach the server directly can
send `CF-Connecting-IP` with any value and get a fresh budget per request.
Before setting it, check, without pasting addresses anywhere public:

1. The app port is bound to loopback (`127.0.0.1:${OVERCLICK_PORT}` in the
   compose file), so only the reverse proxy reaches it.
2. Ports 80/443 on the server accept connections **only from Cloudflare's
   published ranges** (https://www.cloudflare.com/ips/): either a host
   firewall (ufw/nftables/iptables, or the provider's firewall) that allows
   80/443 from those ranges and drops the rest, or Traefik limited to them
   (an `ipAllowList` middleware, `ipWhiteList` on Traefik v2, with Cloudflare's ranges on the router, plus
   `forwardedHeaders.trustedIPs` with the same ranges on the entrypoint).
3. From a machine outside Cloudflare, a request straight to the server's own
   address on 443 (not through the domain) times out or is refused. If it
   gets the board, the header is not safe yet.
4. Cloudflare's ranges change now and then; recheck the list when you update
   the rule.

If any of this does not hold, leave `OVERCLICK_CLIENT_IP_HEADER` empty: the
shared edge bucket refuses real people sooner, but it cannot be bypassed.

### Behind a proxy: the Origin check on forms

Sign-in (like every form in the app) is a Next.js Server Action. Next accepts
one only when the request's `Origin` header matches `Host` (or
`X-Forwarded-Host`), and aborts it otherwise; that check is what keeps another
site from signing a visitor in or sending them code emails. The app sets no
`serverActions.allowedOrigins`, so the proxy must pass the original `Host`
(Caddy and Traefik do by default; nginx needs `proxy_set_header Host $host`).
After a deploy, confirm it holds: a `POST` to the login page with a foreign
`Origin` header must be refused, and the login form on your own domain must
still work. Do not "fix" a failing check by widening `allowedOrigins` to
`*`.

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

That is a backup, `git pull`, rebuild, restart, and a health check, in one
command. The data volume is never touched, so cards, tokens and settings
survive every deploy. If another deploy is already running, the second
invocation exits with a clear lock message and does not touch the compose
project. In order, `deploy.sh`:

1. runs `deploy/backup.sh pre-deploy` (below) and **stops if it fails**: it
   copies `deploy/.env` first, then dumps the database, and any docker error
   (or a database container that exists but is stopped) aborts instead of
   being read as "nothing to back up";
2. tags the image that is serving as `overclick-app:rollback-v<version>-<time>`;
3. only then mutates: removes the known legacy orphan container
   `overclick-postgres-1` (its volume `overclick_pgdata` is kept and the script
   prints the `docker volume rm` to run by hand), pulls, builds and restarts,
   then waits for the app to answer;
4. only once the app is healthy, frees disk: `docker builder prune` for cache
   older than 24 hours (`OVERCLICK_BUILD_CACHE_MAX_AGE`, any `docker` duration;
   the cache is shared with every other build on the host, hence the age
   filter) and removes every `overclick-app:rollback-*` image except the newest.
   A failed deploy prunes nothing.

After a deploy, `docker compose ls --all` should show the `overclick` project
using only `deploy/docker-compose.cloud.yml` and, when the proxy overlay is
enabled, `deploy/docker-compose.traefik.yml`. If the listing contains a root
compose file, stop and remove that legacy project before retrying; the deploy
script refuses to guess which project is safe to change.

## There is no update button

The board never updates itself. The one-click updater sidecar was removed: it
mounted the docker socket (root on the host), a writable checkout and the
host's `/tmp`, so whoever compromised it owned the machine. Settings → System
→ Updates and the new-version banner only say which version this instance runs
and, when a newer release exists, the command to run, in every runtime. Updating is always
done on the server, with `./deploy/deploy.sh` (see "Deploying again").

If you ran the sidecar before (`--profile updater`), do this once, on the
host, not from the Update button:

```bash
cd /opt/overclick && ./deploy/deploy.sh
```

`deploy.sh` removes the old `updater` container itself (looked up by its
compose labels, so the app and the database are never touched) and then, after
the app is recreated without it (and after the pre-deploy backup and rollback tag), the `overclick_update-trigger` volume it left
behind, when no container uses it any more. The app container is recreated on
that deploy, as on every deploy; the data volume is not touched. Running the
first deploy from the old button instead would remove the very container
running it, halfway through, so use the host.

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

The whole instance is one Postgres volume plus `deploy/.env`.
`deploy/backup.sh [label]` backs up both, and `deploy.sh` runs it as
`pre-deploy` before every deploy:

```bash
./deploy/backup.sh            # label "daily"
./deploy/backup.sh pre-deploy
```

- The directory is `backups/` in the checkout (`OVERCLICK_BACKUP_DIR` to move
  it), created mode **700**; every file in it is **600**. The script repairs the
  modes of files that were already there, so one run closes an older directory.
- `<label>.<UTC time>.v<version>.dump` is `pg_dump -Fc`, checked with
  `pg_restore --list` before it is kept; an empty or unreadable dump is an error.
  `env-<label>.<UTC time>.v<version>.bak` is the copy of `deploy/.env`.
- Retention: the newest 7 of each label (`OVERCLICK_BACKUP_KEEP`). Labels are
  separate buckets, so a day of deploys does not push out the daily dumps.
- Nothing is dumped, and the script says so, when the database container is not
  running yet (the first deploy of a host).

### Schedule a daily backup

`deploy.sh` only backs up when you deploy. A daily copy is a systemd timer (or a
cron line) you install yourself; nothing here installs it. systemd:

```ini
# /etc/systemd/system/overclick-backup.service
[Unit]
Description=OverClick backup
[Service]
Type=oneshot
WorkingDirectory=/opt/overclick
ExecStart=/opt/overclick/deploy/backup.sh daily
```

```ini
# /etc/systemd/system/overclick-backup.timer
[Unit]
Description=OverClick daily backup
[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true
[Install]
WantedBy=timers.target
```

```bash
systemctl daemon-reload && systemctl enable --now overclick-backup.timer
```

or, in root's crontab: `30 3 * * * cd /opt/overclick && ./deploy/backup.sh daily >>/var/log/overclick-backup.log 2>&1`.
Copy `backups/` off the machine too; a backup on the same disk does not survive
the disk.

### Restoring

```bash
docker compose -p overclick -f deploy/docker-compose.cloud.yml exec -T overclick-db \
  pg_restore -U overclick -d overclick --clean --if-exists --no-owner < backups/<file>.dump
```

Stop the app first (`docker compose -p overclick -f deploy/docker-compose.cloud.yml stop app`)
so nothing writes while it runs, and start it again afterwards.

### Rolling back a deploy

The image that was serving before the last deploy is still on the host as
`overclick-app:rollback-v<version>-<time>` (`docker image ls overclick-app`).
To go back to it without rebuilding:

```bash
docker tag overclick-app:rollback-v<version>-<time> overclick-app:latest
docker compose -p overclick -f deploy/docker-compose.cloud.yml up -d --no-build app
```

(add `-f deploy/docker-compose.traefik.yml` when the proxy overlay is on). If
the deploy ran a migration the old code cannot read, restore the
`pre-deploy` dump from the same moment too.
