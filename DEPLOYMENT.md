# Production deployment

Deploy this application as one long-running container with a managed MySQL
database. Do not run multiple application replicas: each replica starts a
schedule worker, which could apply the same due limit more than once.

## Required secrets

Configure these in the hosting provider's secret manager, never in Git:

- `LIMITBOT_ENCRYPTION_KEY`: a persistent Fernet key
- `MYSQL_HOST`
- `MYSQL_PORT`
- `MYSQL_DATABASE`
- `MYSQL_USER`
- `MYSQL_PASSWORD`

Generate the encryption key once and retain it for the lifetime of the
database:

```sh
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

Losing or changing this key invalidates encrypted Aces High sessions already
stored in the database. It also prevents the schedule worker from decrypting
the Aces High credentials used solely to renew expired automation tokens.

## Running more than one site

betwar.ag runs the identical platform at the identical version, so the same
image manages either. The one difference found so far is that betwar.ag has
no guest player login, which the Pinnacle comparison and Trading Monitor
pages rely on - see `PLAYER_USERNAME` below. Deploy one container per site, each with its own
database:

```sh
docker run -d --name betwar-app --restart unless-stopped -p 8001:8000 \
  -e PARTNER_HOST=betwar.ag -e PARTNER_NAME="BetWar" \
  -e MYSQL_DATABASE=betwardb ... aceshigh-app:<sha>
```

Never point two sites at one database. Agent ids are assigned per site, and
`users.accesshigh_agent_id` is unique, so two different agents sharing an id
would collide on the same row. Separate databases also mean a problem on one
site cannot reach the other's schedules or limits.

## Runtime settings

- `APP_ENV=production`
- `HOST=0.0.0.0`
- `PORT`: supplied by the hosting provider
- `TRUST_PROXY_HEADERS=true` only when traffic reaches the container through
  the hosting provider's trusted HTTPS proxy
- `LOG_LEVEL=INFO`
- `HIERARCHY_WORKERS`: how many AccessHigh hierarchy nodes are expanded at
  once when the agent tree is built. Defaults to `4`, clamped to 1-32.
  AccessHigh rate limits this endpoint, and the tree is cached afterwards, so
  a modest walk is worth more than a fast one that gets throttled.
- `HIERARCHY_RETRIES`: how many times a rate-limited hierarchy request is
  retried. Defaults to `8`, clamped to 1-20. A 429 from any worker pauses the
  whole walk, honouring `Retry-After` where AccessHigh sends one, so the walk
  settles to a rate AccessHigh accepts rather than failing.
- `AGENT_TREE_TTL_SECONDS`: how long a stored agent tree is served before it
  is rebuilt. Defaults to `900`. A tree past its TTL is still returned
  immediately and refreshed in the background, so only an account's very first
  login ever waits for the walk. Set it lower where agents are added often.

- `PARTNER_HOST`: which site to manage, e.g. `aceshigh.ag` or `betwar.ag`.
  Defaults to `aceshigh.ag`.
- `PARTNER_NAME`: what to call that site in the interface. Defaults to
  "Aces High" for aceshigh.ag, otherwise the host. Both variables also drive
  the Pinnacle comparison and Trading Monitor pages, which read limits from
  `PARTNER_HOST` and title themselves "Pinnacle vs <PARTNER_NAME>".
- `PLAYER_USERNAME` / `PLAYER_PASSWORD`: a read-only player account on
  `PARTNER_HOST`, used only to read the fixture schedule for the Pinnacle
  comparison and Trading Monitor pages. Those fixtures come from the player
  site, not the partner site, and a partner token is rejected there. Leave
  both unset for aceshigh.ag, which serves an anonymous token from
  `identity/GuestToken`. **betwar.ag does not serve that route and its player
  site has no guest mode, so on betwar these two pages stay unavailable, with
  a message saying so, until a player account is configured here.** No other
  page depends on this; limits, schedules and the agent tree all use the
  partner token and work without it.
- `WRITE_ALLOWED_ACCOUNTS`: a comma-separated list of AccessHigh account ids
  that limits may be written on. Empty means no restriction, which is normal
  operation. A populated list is a hard stop enforced inside
  `save_single_limit`, so it applies to every write regardless of origin - a
  person on the dashboard, a scheduled limit, or a live tracker - and is
  checked before any request is made upstream. Creating a schedule, a ramp or
  a tracker on an account outside the list is refused outright rather than
  failing later at run time. Use it while testing so automation cannot reach a
  live downline.
- `LIMIT_TRACKER`: set `off` to stop the live tracker thread. `TRACKER_INTERVAL_MINUTES`
  (default 10) is how often tracked limits are compared with Pinnacle,
  `TRACKER_WINDOW_HOURS` (default 12) how close to kick-off a fixture must be
  to count, and `TRACKER_MIN_CHANGE_PERCENT` (default 8) how far Pinnacle must
  move before a rewrite is worth making. Tracked limits are the one place
  `SKIP_BLUE` does not apply: every write marks a limit blue, so a tracker
  honouring it would move a limit once and never again.
- `PINNACLE_SAMPLING`: set `off` on the second site. The readings describe
  Pinnacle, not a partner, so both sites recording them stores the same
  numbers twice. `PINNACLE_SAMPLE_MINUTES` (default 60) and
  `PINNACLE_SAMPLE_DAYS` (default 60) control the cadence and retention.
- `SKIP_BLUE`: refuse to overwrite any blue limit. Defaults to `on`; set
  `off` to write every limit regardless. Blue means the account holds its own
  value rather than inheriting one. Note that writing a limit on a
  sub-account creates that state, so a limit this bot changes becomes blue
  and is skipped on every later run, recurring schedules included.
- `LOG_FILE`: path to write logs to as well as stdout, e.g.
  `/app/logs/limitbot.log`. Container logs are destroyed with the container,
  so without this a redeploy erases the record of why a scheduled limit
  failed. Point it at a mounted volume. `LOG_FILE_MAX_BYTES` (default 16MB)
  and `LOG_FILE_BACKUPS` (default 5) bound the rotation.

The agent tree is stored in the `agent_tree_cache` table, which the
application creates on startup. No migration step is required. Use
`GET /api/agents?refresh=1` to force a rebuild for a hierarchy that changed
and has to be picked up immediately.

The container health check uses `/api/health`. A healthy response confirms the
application can connect to MySQL.

## Release checklist

1. Provision MySQL and enable automated backups.
2. Add the required secrets through the provider's secret manager.
3. Deploy exactly one application replica from the repository `Dockerfile`.
4. Require HTTPS and verify the login cookie has the `Secure`, `HttpOnly`, and
   `SameSite=Strict` attributes.
5. Test login, agent search, limit loading, a manual change, recurring schedule
   creation, cancellation, and restart recovery on a staging deployment.
6. Promote the same tested image to production.

Never upload local `.env`, `.limitbot.key`, CSV exports, logs, or database
files. The repository and Docker ignore rules exclude them.
