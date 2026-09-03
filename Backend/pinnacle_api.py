"""Pinnacle's own lines and limits, read from the probet42 Lines API.

Why this exists. A ramp that follows Pinnacle has to follow Pinnacle's real
numbers. OddsPapi is a scraped aggregator: one HTTP request per fixture, a
quota shared with the comparison page a person is waiting on, and a `limit`
field that is whatever the scrape happened to see. This is the Pinnacle engine
itself - the same REST service ps3838 runs on, behind a different white-label
host - and two requests return every fixture in a league carrying both the
line and the maximum stake accepted on it.

That difference is not just cleanliness. The sampler used to read eight
fixtures per league per cycle and pick them carefully so the budget was not
spent on one part of the day; here a cycle sees the whole league, so the
lowest limit in it is the actual lowest rather than the lowest of a sample.

What this module does NOT do: place, cancel or price bets. It calls
/v3/sports, /v3/leagues and /v3/fixtures and /v4/odds, and nothing else.
"""

from __future__ import annotations

import base64
import logging
import os
import threading
import time
from datetime import datetime, timezone
from typing import Any, Iterable
from urllib.parse import quote

import requests

logger = logging.getLogger(__name__)

API_BASE = (
    os.getenv("PINNACLE_API_BASE")
    or os.getenv("PS3838_BASE_URL")
    or "https://api.probet42.com"
).rstrip("/")
API_USERNAME = (
    os.getenv("PINNACLE_API_USERNAME") or os.getenv("PS3838_USERNAME") or ""
).strip()
API_PASSWORD = (
    os.getenv("PINNACLE_API_PASSWORD") or os.getenv("PS3838_PASSWORD") or ""
)

# Pinnacle's edge refuses datacenter addresses outright - a 403 and an HTML
# block page, before the account is ever looked at - so a server deployment
# reaches the feed through a proxy on an ordinary address. Accepts either a
# full URL or the host:port:user:password line the proxy vendors hand out,
# because retyping one of those into a URL is how a password ends up wrong.
PROXY_SETTING = (
    os.getenv("PINNACLE_API_PROXY") or os.getenv("PS3838_PROXY") or ""
).strip()


def _proxy_url(setting: str) -> str:
    if not setting or "://" in setting:
        return setting
    parts = setting.split(":")
    if len(parts) == 4:
        host, port, user, password = parts
        return (
            f"http://{quote(user, safe='')}:{quote(password, safe='')}"
            f"@{host}:{port}"
        )
    if len(parts) == 2:
        return f"http://{setting}"
    return setting


API_PROXY = _proxy_url(PROXY_SETTING)

# Pinnacle caches a snapshot for 60s server-side, so asking more often than
# that returns the same bytes. Nothing here needs to be fresher than a minute.
CACHE_SECONDS = float(os.getenv("PINNACLE_API_CACHE_SECONDS", "45") or 45)
MIN_REQUEST_INTERVAL = float(os.getenv("PINNACLE_API_MIN_INTERVAL", "1.0") or 1.0)
# A residential hop adds seconds to every request and drops one now and then,
# so the patience and the retry budget both go up when one is in use.
REQUEST_TIMEOUT = 60.0 if API_PROXY else 25.0
MAX_RETRIES = 4 if API_PROXY else 3


class PinnacleError(RuntimeError):
    """A call to the Pinnacle API failed."""


class PinnacleAuthError(PinnacleError):
    """Wrong credentials, or API access is not enabled on the account."""


class PinnacleBlocked(PinnacleError):
    """Cloudflare refused the request before Pinnacle ever saw it.

    Worth its own class because it arrives as a 403, which reads as "wrong
    password" and sends somebody to rotate credentials that were never wrong.
    The block is on the calling IP, not the account: the same credentials work
    from a laptop and fail from a datacenter.
    """


class PinnacleNotOffered(PinnacleError):
    """The sport or league is not carried on this account right now.

    Separate from a failure on purpose: "Pinnacle is not posting NBA" is a fact
    to report on the page, not a fault to retry.
    """


# ---------------------------------------------------------------------------
# Mapping: our leagues and periods onto Pinnacle's
# ---------------------------------------------------------------------------

# Pinnacle's sport ids are stable across the engine's white-labels. The name is
# carried too so a sport can be resolved by name when the account exposes it,
# which is the safer of the two whenever both are available.
SPORTS = {
    "baseball": {"id": 3, "name": "Baseball"},
    "football": {"id": 15, "name": "Football"},
    "basketball": {"id": 4, "name": "Basketball"},
    "hockey": {"id": 19, "name": "Hockey"},
}

# One entry per league the limit rows use. `names` are matched exactly against
# Pinnacle's league list (case-insensitively); `container` disambiguates the
# ones that repeat across countries - "NCAA" exists under both Football and
# Basketball, and only the sport tells them apart.
LEAGUE_SOURCES: dict[str, dict[str, Any]] = {
    "mlb": {
        "sport": "baseball", "names": ("MLB",), "container": "USA",
        "label": "MLB",
    },
    "nfl": {
        "sport": "football", "names": ("NFL",), "container": "USA",
        "label": "NFL",
    },
    "ncaa-football": {
        "sport": "football", "names": ("NCAA", "NCAA Football"),
        "container": "USA", "label": "NCAA Football",
    },
    "nba": {
        "sport": "basketball", "names": ("NBA",), "container": "USA",
        "label": "NBA",
    },
    "wnba": {
        "sport": "basketball", "names": ("WNBA",), "container": "USA",
        "label": "WNBA",
    },
    "ncaa-basketball": {
        "sport": "basketball", "names": ("NCAA", "NCAA Basketball"),
        "container": "USA", "label": "NCAA Basketball",
    },
    "nhl": {
        "sport": "hockey", "names": ("NHL",), "container": "USA",
        "label": "NHL",
    },
}

# Which Pinnacle period number carries each of our period labels, per sport.
#
# The baseball row is the one worth reading twice. Pinnacle has no "2nd half"
# in baseball and no period called "1st 5 innings" either: its period 1 IS the
# first five innings, described as "1st Half". A mapping that took the words at
# face value would look up a period that does not exist and the tracker would
# quietly never write - which is exactly the failure the label translation in
# main.py was added to prevent on the other side.
PERIOD_NUMBERS: dict[str, dict[str, int]] = {
    "baseball": {"Full Game": 0, "1st 5 Innings": 1},
    "football": {"Full Game": 0, "1st Half": 1, "2nd Half": 2},
    "basketball": {"Full Game": 0, "1st Half": 1, "2nd Half": 2},
    "hockey": {"Full Game": 0},
}

# Our limit field -> the period-level maximum that governs its main line.
#
# Alternate lines carry their own `max`; the main line does not, because the
# period maximum is its limit. So the number a limit row should follow is
# always the period-level one, never an alt line's.
FIELD_MAX_KEYS = {
    "moneyLine": "maxMoneyline",
    "spread": "maxSpread",
    "total": "maxTotal",
    "teamTotal": "maxTeamTotal",
}

FIELD_LABELS = {
    "moneyLine": "Money line",
    "spread": "Spread",
    "total": "Total",
    "teamTotal": "Team total",
}


def configured() -> bool:
    """Whether credentials exist. Callers report this instead of failing."""
    return bool(API_USERNAME and API_PASSWORD)


def available_sports() -> set[str] | None:
    """Which of our sports this Pinnacle account can see, or None if unknown.

    None is not "none": it means Pinnacle could not be asked. The caller shows
    everything in that case, because hiding a league on the strength of a
    failed request would quietly shrink the page whenever the feed hiccups.
    """
    try:
        payload = _get("/v3/sports")
    except PinnacleError:
        return None
    listed = {
        str(entry.get("name", "")).strip().casefold()
        for entry in (payload.get("sports") or [])
    }
    if not listed:
        return None
    return {
        key for key, sport in SPORTS.items()
        if sport["name"].casefold() in listed
    }


def supported_leagues() -> set[str] | None:
    """The league slugs that can be tracked right now, or None if unknown.

    A slug qualifies when this account carries its sport. Leagues inside an
    enabled sport are not checked one at a time on purpose: that is a request
    per sport through a proxy, on a page somebody is waiting for, to rule out
    a case the creation path already reports clearly.
    """
    sports = available_sports()
    if sports is None:
        return None
    return {
        slug for slug, source in LEAGUE_SOURCES.items()
        if source["sport"] in sports
    }


def period_number(league_slug: str, period_label: str) -> int | None:
    """Pinnacle's period number for one of our period labels, or None."""
    source = LEAGUE_SOURCES.get(league_slug)
    if not source:
        return None
    return PERIOD_NUMBERS.get(source["sport"], {}).get(str(period_label))


def supported_periods(league_slug: str) -> list[str]:
    source = LEAGUE_SOURCES.get(league_slug)
    if not source:
        return []
    return list(PERIOD_NUMBERS.get(source["sport"], {}))


# ---------------------------------------------------------------------------
# Transport
# ---------------------------------------------------------------------------

_session: requests.Session | None = None
_session_lock = threading.Lock()
_throttle_lock = threading.Lock()
_next_allowed = 0.0

_cache: dict[tuple, tuple[float, Any]] = {}
_cache_lock = threading.Lock()


def _http() -> requests.Session:
    global _session
    with _session_lock:
        if _session is None:
            token = base64.b64encode(
                f"{API_USERNAME}:{API_PASSWORD}".encode()
            ).decode()
            session = requests.Session()
            session.headers.update({
                "Authorization": f"Basic {token}",
                "Accept": "application/json",
                "User-Agent": "limitbot-pinnacle/1.0",
            })
            if API_PROXY:
                session.proxies.update({"http": API_PROXY, "https": API_PROXY})
            _session = session
        return _session


def _throttle() -> None:
    """One request at a time, spaced.

    The feed is governed by a fair-use policy rather than a published quota,
    and two workers (the tracker and the sampler) share this module, so the
    spacing is enforced here rather than trusted to each caller.
    """
    global _next_allowed
    with _throttle_lock:
        now = time.monotonic()
        wait = _next_allowed - now
        if wait > 0:
            time.sleep(wait)
            now = time.monotonic()
        _next_allowed = now + MIN_REQUEST_INTERVAL


def _get(path: str, **params: Any) -> Any:
    if not configured():
        raise PinnacleError(
            "Pinnacle API credentials are not set. Add PINNACLE_API_USERNAME "
            "and PINNACLE_API_PASSWORD to the environment."
        )

    query = {}
    for key, value in params.items():
        if value is None:
            continue
        if isinstance(value, bool):
            query[key] = 1 if value else 0
        elif isinstance(value, (list, tuple, set)):
            items = [str(item) for item in value]
            if items:
                query[key] = ",".join(items)
        else:
            query[key] = value

    cache_key = (path, tuple(sorted(query.items())))
    now = time.time()
    with _cache_lock:
        cached = _cache.get(cache_key)
        if cached and now - cached[0] < CACHE_SECONDS:
            return cached[1]

    url = f"{API_BASE}{path}"
    last_error: Exception | None = None
    for attempt in range(MAX_RETRIES + 1):
        _throttle()
        try:
            response = _http().get(url, params=query, timeout=REQUEST_TIMEOUT)
        except requests.RequestException as error:
            last_error = error
        else:
            if response.status_code in (401, 403):
                body = response.text[:2000]
                if "Cloudflare" in body or "Attention Required" in body:
                    ray = response.headers.get("CF-RAY", "")
                    raise PinnacleBlocked(
                        "Pinnacle's edge blocked the calling IP address, so "
                        "the request never reached the account. "
                        + (
                            "The proxy's exit address is being refused too; "
                            "try another one."
                            if API_PROXY
                            else "Set PINNACLE_API_PROXY, or ask the provider "
                            "to allow this server's outbound IP."
                        )
                        + (f" (Cloudflare ray {ray})" if ray else "")
                    )
                raise PinnacleAuthError(
                    f"Pinnacle refused the credentials ({response.status_code}). "
                    "Check the username and password, and that API access is "
                    "enabled on the account."
                )
            if response.status_code == 400:
                raise PinnacleError(
                    f"Pinnacle rejected {path} {query}: {response.text[:200]}"
                )
            if response.ok:
                body = response.text.strip()
                payload: Any = {}
                if body:
                    try:
                        payload = response.json()
                    except ValueError as error:
                        raise PinnacleError(
                            f"Pinnacle returned non-JSON from {path}"
                        ) from error
                with _cache_lock:
                    _cache[cache_key] = (time.time(), payload)
                return payload
            last_error = PinnacleError(
                f"Pinnacle returned {response.status_code} on {path}"
            )

        if attempt < MAX_RETRIES:
            time.sleep(min(8.0, 2 ** attempt))

    raise PinnacleError(f"{path} failed after {MAX_RETRIES + 1} attempts") from last_error


# ---------------------------------------------------------------------------
# Resolving a league
# ---------------------------------------------------------------------------

def _sport_id(sport_key: str) -> int:
    sport = SPORTS[sport_key]
    payload = _get("/v3/sports")
    listed = payload.get("sports") or []
    if listed:
        wanted = sport["name"].casefold()
        for entry in listed:
            if str(entry.get("name", "")).strip().casefold() == wanted:
                return int(entry["id"])
        # The account carries only the sports it is enabled for, so a sport
        # missing from this list is not a lookup failure - it is Pinnacle
        # telling us this account cannot see it. Say that, rather than firing
        # a request that returns an empty league list and looks like a quiet
        # day.
        raise PinnacleNotOffered(
            f"{sport['name']} is not enabled on this Pinnacle account "
            f"(it carries {', '.join(sorted(str(e.get('name')) for e in listed))})"
        )
    return int(sport["id"])


def _league_ids(slug: str) -> tuple[int, list[int]]:
    """(sportId, [leagueId]) for one of our league slugs.

    Resolved by name every time rather than hard-coded, because a league id is
    Pinnacle's to change and a stale one returns an empty board that looks
    exactly like a league with no games on it.
    """
    source = LEAGUE_SOURCES.get(slug)
    if not source:
        raise PinnacleNotOffered(f"{slug} is not a league Pinnacle is read for")

    sport_id = _sport_id(source["sport"])
    payload = _get("/v3/leagues", sportId=sport_id)
    wanted = {str(name).strip().casefold() for name in source["names"]}
    container = str(source.get("container") or "").strip().casefold()

    matches = []
    for league in payload.get("leagues") or []:
        name = str(league.get("name", "")).strip().casefold()
        if name not in wanted:
            continue
        if container and str(league.get("container", "")).strip().casefold() != container:
            continue
        matches.append(league)

    if not matches:
        raise PinnacleNotOffered(
            f"Pinnacle is not carrying {source['label']} right now"
        )
    # Prefer the leagues that actually have games up; keep the rest so a league
    # between seasons still resolves rather than raising.
    offered = [league for league in matches if league.get("hasOfferings")]
    chosen = offered or matches
    return sport_id, [int(league["id"]) for league in chosen]


# ---------------------------------------------------------------------------
# Reading lines and limits
# ---------------------------------------------------------------------------

def _parse_start(value: object) -> float | None:
    text_value = str(value or "").strip()
    if not text_value:
        return None
    try:
        return datetime.fromisoformat(
            text_value.replace("Z", "+00:00")
        ).replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        return None


def _main_entry(entries: Iterable[dict[str, Any]] | None) -> dict[str, Any] | None:
    """The main line among a period's spreads or totals.

    Pinnacle marks alternates with an `altLineId` and gives each its own `max`;
    the main line has neither, and takes the period's maximum. So "no altLineId"
    is the whole test.
    """
    if not entries:
        return None
    for entry in entries:
        if isinstance(entry, dict) and "altLineId" not in entry:
            return entry
    return None


def _team_total_main(period: dict[str, Any]) -> dict[str, Any] | None:
    team_totals = period.get("teamTotal") or {}
    if isinstance(team_totals, dict):
        for team in ("home", "away"):
            entries = team_totals.get(team)
            if isinstance(entries, dict):
                entries = [entries]
            main = _main_entry(entries)
            if main:
                return main
    return None


def _field_reading(
    period: dict[str, Any], field: str, sport_key: str
) -> tuple[float, float | None] | None:
    """(limit, line) for one market on one period, or None if not posted."""
    limit = period.get(FIELD_MAX_KEYS[field])

    if field == "moneyLine":
        line = None
        if not limit:
            # Baseball's first five innings has no money line of its own:
            # Pinnacle prices it as a pick'em run line, so the 0.0 spread IS
            # the money line and maxSpread is its limit. Without this the
            # tracker would report "Pinnacle is not posting a money line" on a
            # market Pinnacle very much is posting.
            main = _main_entry(period.get("spreads"))
            if (
                sport_key == "baseball"
                and main is not None
                and float(main.get("hdp") or 0) == 0.0
            ):
                limit = period.get("maxSpread")
    elif field == "spread":
        main = _main_entry(period.get("spreads"))
        line = None if main is None else main.get("hdp")
    elif field == "total":
        main = _main_entry(period.get("totals"))
        line = None if main is None else main.get("points")
    elif field == "teamTotal":
        main = _team_total_main(period)
        line = None if main is None else main.get("points")
    else:
        return None

    if not isinstance(limit, (int, float)) or limit <= 0:
        return None
    return float(limit), (None if line is None else float(line))


def league_readings(
    slug: str,
    *,
    window_hours: float = 12.0,
    max_fixtures: int = 0,
) -> list[dict[str, Any]]:
    """Every current line-and-limit for one league, one row per market.

    Two rules decide which fixtures count, and both carry over unchanged from
    the OddsPapi sampler because they are about betting, not about the feed.

    Only fixtures that have not started. Pinnacle's in-play limits behave
    nothing like its pre-game ones, and a limit covering games that have not
    started should not be set from games that have.

    Only fixtures inside the window. A game three days out carries a tiny limit
    and would hold the whole league down all day, which is the opposite of
    following the market.
    """
    sport_id, league_ids = _league_ids(slug)
    source = LEAGUE_SOURCES[slug]
    sport_key = source["sport"]
    periods_wanted = {
        number: label for label, number in PERIOD_NUMBERS[sport_key].items()
    }

    fixtures_payload = _get(
        "/v3/fixtures", sportId=sport_id, leagueIds=league_ids
    )
    now = time.time()
    fixtures: dict[int, dict[str, Any]] = {}
    for league in fixtures_payload.get("league") or []:
        for event in league.get("events") or []:
            starts = _parse_start(event.get("starts"))
            if starts is None:
                continue
            hours = (starts - now) / 3600.0
            if hours <= 0 or hours > window_hours:
                continue
            if str(event.get("status", "O")).upper() != "O":
                continue
            # Pinnacle carries three things that look like games and are not.
            # "Daily Total" is the league-wide aggregate - MLB's "Home Runs
            # (9 Games)" board, whose 1,000 total limit is the lowest number
            # on the whole page and would have set every MLB total for us.
            # An event with a parentId is the in-play relay of a game already
            # counted. Both have to go before "lowest" means anything.
            if str(event.get("resultingUnit") or "Regular") != "Regular":
                continue
            if event.get("parentId"):
                continue
            fixtures[int(event["id"])] = {
                "hours": hours,
                "home": str(event.get("home") or ""),
                "away": str(event.get("away") or ""),
                "starts": event.get("starts"),
            }
    if not fixtures:
        return []

    if max_fixtures and len(fixtures) > max_fixtures:
        nearest = sorted(fixtures.items(), key=lambda item: item[1]["hours"])
        fixtures = dict(nearest[:max_fixtures])

    odds_payload = _get(
        "/v4/odds",
        sportId=sport_id,
        leagueIds=league_ids,
        oddsFormat="American",
    )

    rows: list[dict[str, Any]] = []
    for league in odds_payload.get("leagues") or []:
        for event in league.get("events") or []:
            fixture = fixtures.get(int(event.get("id", 0)))
            if fixture is None:
                continue
            for period in event.get("periods") or []:
                label = periods_wanted.get(period.get("number"))
                if label is None:
                    continue
                # status 2 is offline: the market is listed but not accepting
                # bets, and its stale maximum should not set anybody's limit.
                if period.get("status") != 1:
                    continue
                for field in FIELD_MAX_KEYS:
                    reading = _field_reading(period, field, sport_key)
                    if reading is None:
                        continue
                    limit, line = reading
                    rows.append({
                        "league": slug,
                        "leagueName": source["label"],
                        "period": label,
                        "periodNumber": period.get("number"),
                        "field": field,
                        "fixtureId": str(event.get("id")),
                        "event": f"{fixture['home']} v {fixture['away']}".strip(" v"),
                        "startsAt": fixture["starts"],
                        "hoursToStart": round(fixture["hours"], 2),
                        "limit": limit,
                        "line": line,
                    })
    return rows


def league_levels(
    slug: str,
    *,
    window_hours: float = 12.0,
    basis: str = "lowest",
) -> dict[tuple[str, str], dict[str, Any]]:
    """One number per period and market for a whole league.

    A limit row on the partner site covers every fixture in the league, so the
    exposure is set by the game Pinnacle trusts least - which is why the
    default basis is the lowest reading rather than the typical one. The median
    is kept available for comparison, but it leaves you above Pinnacle on
    exactly the game they are most careful about.

    The line comes back alongside the limit, taken from the same fixture that
    supplied the limit, so what is written can always be traced to one board.
    """
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for row in league_readings(slug, window_hours=window_hours):
        grouped.setdefault((row["period"], row["field"]), []).append(row)

    levels: dict[tuple[str, str], dict[str, Any]] = {}
    for key, rows in grouped.items():
        rows.sort(key=lambda row: row["limit"])
        values = [row["limit"] for row in rows]
        middle = len(values) // 2
        median = (
            values[middle] if len(values) % 2
            else (values[middle - 1] + values[middle]) / 2
        )
        chosen = rows[middle] if basis == "median" else rows[0]
        levels[key] = {
            "limit": median if basis == "median" else values[0],
            "line": chosen["line"],
            "event": chosen["event"],
            "hoursToStart": chosen["hoursToStart"],
            "fixtures": len(values),
            "lowest": values[0],
            "median": median,
            "highest": values[-1],
        }
    return levels


def describe_line(field: str, line: float | None) -> str:
    """How a line reads next to its limit, e.g. "-3.5" or "o 44.5"."""
    if line is None:
        return ""
    if field == "spread":
        return "PK" if line == 0 else f"{line:+g}"
    if field in ("total", "teamTotal"):
        return f"o {line:g}"
    return f"{line:g}"
