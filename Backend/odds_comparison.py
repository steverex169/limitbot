"""Read-only league comparisons between the partner site and Pinnacle/OddsPapi."""

from __future__ import annotations

from datetime import datetime, time as datetime_time, timezone
import os
import re
import threading
import time
from typing import Any
from zoneinfo import ZoneInfo

import requests


# The same value main.py uses, read independently so this module has no import
# back into it. A BetWar deployment must compare Pinnacle against BetWar, and
# querying aceshigh.ag with a BetWar token would simply be rejected.
PARTNER_HOST = os.getenv("PARTNER_HOST", "aceshigh.ag").strip().lower()
PARTNER_NAME = os.getenv("PARTNER_NAME", "").strip() or (
    "Aces High" if PARTNER_HOST == "aceshigh.ag" else PARTNER_HOST
)
PARTNER_BASE = f"https://{PARTNER_HOST}"
PLAYER_API = f"{PARTNER_BASE}/player-api"

# The fixture schedule comes from the player site, not the partner site, and a
# partner token is rejected there (verified: HTTP 401 on both hosts). aceshigh.ag
# hands out an anonymous token from identity/GuestToken; betwar.ag does not serve
# that route at all (HTTP 404) and its player bundle has no guest mode. So a site
# without guest browsing needs a read-only player account configured here.
PLAYER_USERNAME = os.getenv("PLAYER_USERNAME", "").strip()
PLAYER_PASSWORD = os.getenv("PLAYER_PASSWORD", "")
ODDSPAPI_BASE = "https://v5.oddspapi.io/en"
BOOKMAKER = "pinnacle"
CACHE_SECONDS = 45
FIXTURE_MATCH_TOLERANCE_SECONDS = 90 * 60

PUBLIC_HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json;charset=UTF-8",
    "Origin": PARTNER_BASE,
    "Referer": f"{PARTNER_BASE}/v2/",
    "User-Agent": "limitbot-comparison/1.0",
}

MARKET_LIMIT_KEYS = {
    "moneyline": "MoneyLine",
    "spread": "Spread",
    "total": "Total",
    "teamtotal": "TeamTotal",
}

LEAGUE_CONFIGS: dict[str, dict[str, Any]] = {
    "mlb": {
        "name": "MLB", "sportId": 13, "limitRow": "Baseball -- Full Game",
        "tournaments": ("MLB", "MLB Spring Training"), "aliases": ("mlb",),
    },
    "nba": {
        "name": "NBA", "sportId": 11, "limitRow": "Pro Basketball -- Full Game",
        "tournaments": ("NBA", "NBA Preseason", "NBA Summer League"),
        "aliases": ("nba",),
    },
    "wnba": {
        "name": "WNBA", "sportId": 11, "limitRow": "WNBA -- Full Game",
        "tournaments": ("WNBA", "WNBA Preseason"), "aliases": ("wnba",),
    },
    "nfl": {
        "name": "NFL", "sportId": 14, "limitRow": "Pro Football -- Full Game",
        "tournaments": ("NFL", "NFL Preseason"), "aliases": ("nfl",),
    },
    "ncaa-football": {
        "name": "NCAA Football", "sportId": 14,
        "limitRow": "College Football -- Full Game",
        "tournamentPrefixes": ("NCAA",),
        "aliases": ("ncaa football", "college football"),
    },
    "ncaa-basketball": {
        "name": "NCAA Basketball", "sportId": 11,
        "limitRow": "College Basketball -- Full Game",
        "tournamentPrefixes": ("NCAA",),
        "aliases": ("ncaa basketball", "college basketball", "march madness"),
    },
    "nhl": {
        "name": "NHL", "sportId": 15, "limitRow": "Hockey -- Full Game",
        "tournaments": ("NHL", "NHL Preseason"), "aliases": ("nhl",),
    },
}

_cache_lock = threading.Lock()
_monitor_cache_lock = threading.Lock()
_comparison_cache: dict[tuple[int, str], tuple[float, dict[str, Any]]] = {}
_monitor_cache: dict[tuple[int, str], tuple[float, dict[str, Any]]] = {}


class ComparisonError(RuntimeError):
    """A read-only comparison source could not be loaded."""


def _json(response: requests.Response, label: str) -> Any:
    if not response.ok:
        raise ComparisonError(f"{label} returned HTTP {response.status_code}")
    try:
        return response.json()
    except ValueError:
        raise ComparisonError(f"{label} returned invalid JSON") from None


def _partner_get(
    session: requests.Session,
    headers: dict[str, str],
    url: str,
    label: str,
) -> Any:
    try:
        response = session.get(url, headers=headers, timeout=30)
    except requests.RequestException as error:
        raise ComparisonError(f"{label} failed: {type(error).__name__}") from None
    data = _json(response, label)
    if isinstance(data, dict) and data.get("Errors"):
        raise ComparisonError("; ".join(map(str, data["Errors"])))
    return data


def _nested_limit(row: dict[str, Any], key: str) -> float | int | None:
    value = row.get(key)
    if not isinstance(value, dict):
        return None
    amount = value.get("AmountMax")
    if amount in (None, ""):
        amount = value.get("Amount")
    return amount if isinstance(amount, (int, float)) else None


def _limit_values(row: dict[str, Any]) -> dict[str, float | int | None]:
    return {
        market: _nested_limit(row, source_key)
        for market, source_key in MARKET_LIMIT_KEYS.items()
    }


def _load_aceshigh_limits(
    session: requests.Session,
    headers: dict[str, str],
    account_id: int,
    league: str,
) -> tuple[dict[str, dict[str, float | int | None]], dict[str, dict[str, int]]]:
    config = LEAGUE_CONFIGS[league]
    data = _partner_get(
        session,
        headers,
        f"{PARTNER_BASE}/partner-api/partner/Backbone/"
        f"GetOrganizationAll/{account_id}/false/S",
        f"{PARTNER_NAME} limit lookup",
    )
    limit_row: dict[str, Any] | None = None

    def walk(value: Any) -> None:
        nonlocal limit_row
        if isinstance(value, dict):
            label = (
                value.get("LeagueDescription")
                or value.get("Description")
                or value.get("Name")
                or value.get("OrganizationLabelParent")
                or value.get("OrganizationLabel")
                or ""
            )
            if label == config["limitRow"]:
                limit_row = value
            for child in value.values():
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)

    walk((data or {}).get("Payload") if isinstance(data, dict) else None)
    if limit_row is None:
        raise ComparisonError(
            f"{PARTNER_NAME} {config['name']} limits are unavailable for this agent"
        )

    result = {"Full Game": _limit_values(limit_row)}
    organization_id = limit_row.get("IdOrganization") or limit_row.get("Id")
    league_id = limit_row.get("IdLeague")
    sport_type_id = limit_row.get("IdSportType") or 0
    # Where a limit for this period is written. Derived exactly as the
    # dashboard derives it (IdOrganization falling back to Id), so a write
    # from this page lands on the same row the dashboard would edit.
    targets: dict[str, dict[str, int]] = {
        "Full Game": {
            "idOrganization": organization_id,
            "idLeague": league_id,
            "idSportType": sport_type_id,
            "periodNumber": 0,
        }
    }
    if isinstance(organization_id, int):
        periods = _partner_get(
            session,
            headers,
            f"{PARTNER_BASE}/partner-api/partner/Backbone/"
            f"GetOrganizationPeriods/{account_id}/{organization_id}/S",
            f"{PARTNER_NAME} period limit lookup",
        )
        for period in (periods or {}).get("Payload") or []:
            if not isinstance(period, dict):
                continue
            description = str(period.get("PeriodDescription") or "").strip()
            if description:
                result[description] = _limit_values(period)
                # A period row carries IdLeague 0, so the league comes from
                # its parent - the same way load_period_rows does it.
                targets[description] = {
                    "idOrganization": period.get("Id") or organization_id,
                    "idLeague": league_id,
                    "idSportType": period.get("IdSportType") or 0,
                    "periodNumber": period.get("PeriodNumber") or 0,
                }
    return result, targets


def _league_from_text(group_name: object, subtype: object = "") -> str | None:
    text = f"{group_name or ''} {subtype or ''}".lower()
    # Check NCAA before NBA so a broader token can never capture it.
    for slug in ("ncaa-football", "ncaa-basketball", "wnba", "mlb", "nfl", "nba", "nhl"):
        if any(alias in text for alias in LEAGUE_CONFIGS[slug]["aliases"]):
            return slug
    return None


def _schedule_requests(menu: dict[str, Any], league: str) -> list[dict[str, int]]:
    requests_by_key: dict[tuple[int, int], dict[str, int]] = {}
    groups = menu.get("Items") or {}
    for group_name, group in groups.items() if isinstance(groups, dict) else []:
        if not isinstance(group, dict):
            continue
        for item in group.get("items") or []:
            if not isinstance(item, dict):
                continue
            subtype = str(item.get("SportSubType") or "")
            if _league_from_text(group_name, subtype) != league:
                continue
            if re.search(r"future|season|playoff|division|award|heisman", subtype, re.I):
                continue
            for combined in item.get("CombinedItems") or []:
                sport_id = combined.get("IdSportType")
                period = combined.get("PeriodNumber")
                if isinstance(sport_id, int) and isinstance(period, int):
                    requests_by_key[(sport_id, period)] = {
                        "IdSport": sport_id,
                        "Period": period,
                    }
    return list(requests_by_key.values())


def _player_token(session: requests.Session) -> str:
    """A token for the player API, which is where the fixture schedule lives.

    Prefers a configured player account, since a site may not offer guest
    browsing at all. Falls back to the anonymous token where it exists.
    """
    if PLAYER_USERNAME:
        label = f"{PARTNER_NAME} player login"
        try:
            response = session.post(
                f"{PLAYER_API}/identity/customerLogin/",
                headers=PUBLIC_HEADERS,
                json={
                    "userName": PLAYER_USERNAME,
                    "password": PLAYER_PASSWORD,
                    # Their own login screen sends the site's domain here.
                    "website": PARTNER_HOST,
                    "version": "2.2.20",
                },
                timeout=30,
            )
        except requests.RequestException as error:
            raise ComparisonError(f"{label} failed: {type(error).__name__}") from None
        data = _json(response, label)
        errors = data.get("Errors") if isinstance(data, dict) else None
        if errors:
            raise ComparisonError(f"{label} was rejected: {', '.join(errors)}")
        payload = data.get("Payload") if isinstance(data, dict) else None
        token = None
        for source in (payload, data):
            if isinstance(source, dict) and source.get("AccessToken"):
                token = source["AccessToken"]
                break
        if not token:
            raise ComparisonError(f"{label} did not return a token")
        return token

    label = f"{PARTNER_NAME} guest login"
    try:
        response = session.post(
            f"{PLAYER_API}/identity/GuestToken",
            headers=PUBLIC_HEADERS,
            data="null",
            timeout=30,
        )
    except requests.RequestException as error:
        raise ComparisonError(f"{label} failed: {type(error).__name__}") from None
    if response.status_code == 404:
        # Not a fault to debug: this site simply has no anonymous browsing.
        raise ComparisonError(
            f"{PARTNER_NAME} does not offer guest browsing, so fixtures cannot "
            "be read anonymously. Set PLAYER_USERNAME and PLAYER_PASSWORD to a "
            f"read-only {PARTNER_NAME} player account to enable this page."
        )
    token_data = _json(response, label)
    token = token_data.get("AccessToken") if isinstance(token_data, dict) else None
    if not token:
        raise ComparisonError(f"{label} did not return a token")
    return token


def _guest_schedule(league: str) -> list[dict[str, Any]]:
    session = requests.Session()
    try:
        token = _player_token(session)
        headers = {**PUBLIC_HEADERS, "Authorization": f"Bearer {token}"}
        try:
            menu_response = session.get(
                f"{PLAYER_API}/api/wager/public/"
                "sportsavailablebyplayeronleague/false",
                headers=headers,
                timeout=30,
            )
            menu = _json(menu_response, f"{PARTNER_NAME} sports lookup")
            request_body = _schedule_requests(menu, league)
            if not request_body:
                return []
            response = session.post(
                f"{PLAYER_API}/api/wager/public/schedules/S/0",
                headers=headers,
                json=request_body,
                timeout=30,
            )
        except requests.RequestException as error:
            raise ComparisonError(
                f"{PARTNER_NAME} schedule failed: {type(error).__name__}"
            ) from None
        data = _json(response, f"{PARTNER_NAME} schedule")
        return data if isinstance(data, list) else []
    finally:
        session.close()


def _normalize_team(name: object) -> str:
    text = re.sub(r"\([^)]*\)", "", str(name or "")).lower()
    return "".join(re.findall(r"[a-z0-9]+", text))


def _same_team(left: str, right: str) -> bool:
    if left == right:
        return True
    shorter, longer = sorted((left, right), key=len)
    return len(shorter) >= 4 and longer.startswith(shorter)


def _main_aces_line(lines: Any, game_number: object) -> dict[str, Any] | None:
    if not isinstance(lines, list) or not lines:
        return None
    target = str(game_number)
    for line in lines:
        if not isinstance(line, dict):
            continue
        parts = str(line.get("i") or "").split("_")
        if len(parts) > 1 and parts[1] == target:
            return line
    return lines[0] if isinstance(lines[0], dict) else None


def _add_aces_entry(
    entries: list[dict[str, Any]],
    market: str,
    selection: str,
    line: dict[str, Any] | None,
    configured_limit: float | int | None,
) -> None:
    if line is None:
        return
    entries.append(
        {
            "marketKey": market,
            "selection": selection,
            "selectionKey": _normalize_team(selection),
            "line": None if market == "moneyline" else line.get("p"),
            "oddsAmerican": line.get("o"),
            "limit": configured_limit,
        }
    )


def _odds_period(description: object, period_number: object) -> str | None:
    text = str(description or "").strip().lower()
    if period_number == 0 or text in {"", "game", "full game"}:
        return "result"
    if "1st 5" in text and "inning" in text:
        return "p1+p2+p3+p4+p5"
    number_match = re.search(r"(?:^|\s)(\d+)(?:st|nd|rd|th)?", text)
    if number_match and any(
        word in text for word in ("half", "quarter", "period", "inning")
    ):
        return f"p{int(number_match.group(1))}"
    for word, number in {
        "first": 1, "second": 2, "third": 3, "fourth": 4,
    }.items():
        if word in text:
            return f"p{number}"
    return None


def _aces_start_time(day_value: object, time_value: object, timezone_code: object) -> int | None:
    """Convert the AcesHigh schedule's separate local date/time into Unix UTC."""
    try:
        day = datetime.fromisoformat(str(day_value).replace("Z", "+00:00")).date()
        clock = datetime_time.fromisoformat(str(time_value))
    except (TypeError, ValueError):
        return None
    zone_name = {
        "PT": "America/Los_Angeles",
        "ET": "America/New_York",
        "CT": "America/Chicago",
        "MT": "America/Denver",
        "UTC": "UTC",
    }.get(str(timezone_code or "").upper())
    if not zone_name:
        return None
    local_start = datetime.combine(day, clock, ZoneInfo(zone_name))
    return int(local_start.timestamp())


def _period_limits(
    limits: dict[str, dict[str, float | int | None]],
    description: str,
) -> dict[str, float | int | None]:
    if description in limits:
        return limits[description]
    lowered = description.lower()
    for name, values in limits.items():
        if name.lower() == lowered:
            return values
    category = next(
        (word for word in ("inning", "half", "quarter", "period") if word in lowered),
        None,
    )
    if category:
        for name, values in limits.items():
            if category in name.lower():
                return values
    return {}


def _parse_aces_games(
    schedule: list[dict[str, Any]],
    limits: dict[str, dict[str, float | int | None]],
    league: str,
    targets: dict[str, dict[str, int]] | None = None,
) -> list[dict[str, Any]]:
    games: list[dict[str, Any]] = []
    for envelope in schedule:
        sc = envelope.get("sc") if isinstance(envelope, dict) else None
        if not isinstance(sc, dict):
            continue
        if _league_from_text(sc.get("l"), sc.get("sb")) != league:
            continue
        period_number = sc.get("p")
        period = "Full Game" if period_number == 0 else str(sc.get("pd") or "")
        odds_period = _odds_period(period, period_number)
        if odds_period is None:
            continue
        period_limits = _period_limits(limits, period)
        period_target = _period_limits(targets or {}, period) or None
        for day in sc.get("schl") or []:
            for game in day.get("g") or []:
                teams = game.get("ts") if isinstance(game, dict) else None
                if not isinstance(teams, list) or len(teams) < 2:
                    continue
                names = [str(team.get("n") or "") for team in teams[:2]]
                if not all(names):
                    continue
                entries: list[dict[str, Any]] = []
                game_number = game.get("gn")
                for index, team in enumerate(teams[:2]):
                    team_lines = team.get("ls") or {}
                    team_name = names[index]
                    _add_aces_entry(
                        entries,
                        "moneyline",
                        team_name,
                        _main_aces_line(team_lines.get("m"), game_number),
                        period_limits.get("moneyline"),
                    )
                    _add_aces_entry(
                        entries,
                        "spread",
                        team_name,
                        _main_aces_line(team_lines.get("s"), game_number),
                        period_limits.get("spread"),
                    )
                    for side, key in (("over", "to"), ("under", "tu")):
                        _add_aces_entry(
                            entries,
                            f"teamtotal-{side}",
                            team_name,
                            _main_aces_line(team_lines.get(key), game_number),
                            period_limits.get("teamtotal"),
                        )
                _add_aces_entry(
                    entries,
                    "total-over",
                    "Over",
                    _main_aces_line((teams[0].get("ls") or {}).get("t"), game_number),
                    period_limits.get("total"),
                )
                _add_aces_entry(
                    entries,
                    "total-under",
                    "Under",
                    _main_aces_line((teams[1].get("ls") or {}).get("t"), game_number),
                    period_limits.get("total"),
                )
                games.append(
                    {
                        "gameNumber": game_number,
                        "startTime": _aces_start_time(
                            day.get("d"), game.get("t"), sc.get("tz")
                        ),
                        "period": period,
                        "oddsPeriod": odds_period,
                        "teamKeys": {_normalize_team(name) for name in names},
                        "writeTarget": period_target,
                        "entries": entries,
                    }
                )
    return games


def _odds_get(
    session: requests.Session,
    api_key: str,
    path: str,
    **params: object,
) -> Any:
    try:
        response = session.get(
            f"{ODDSPAPI_BASE}{path}",
            params={"apiKey": api_key, **params},
            timeout=30,
        )
    except requests.RequestException as error:
        raise ComparisonError(
            f"OddsPapi {path} failed: {type(error).__name__}"
        ) from None
    if not response.ok:
        try:
            body = response.json()
            detail = body.get("message") or body.get("code") or "request rejected"
        except (ValueError, AttributeError):
            detail = "request rejected"
        raise ComparisonError(
            f"OddsPapi {path} returned HTTP {response.status_code}: {detail}"
        )
    try:
        return response.json()
    except ValueError:
        raise ComparisonError(f"OddsPapi {path} returned invalid JSON") from None


def _pinnacle_currency(session: requests.Session, api_key: str) -> str | None:
    data = _odds_get(session, api_key, "/bookmakers", bookmakers=BOOKMAKER)
    for bookmaker in data if isinstance(data, list) else []:
        if bookmaker.get("slug") == BOOKMAKER:
            value = bookmaker.get("limitCurrency")
            return value if isinstance(value, str) else None
    return None


def _is_league_tournament(config: dict[str, Any], tournament_name: object) -> bool:
    name = str(tournament_name or "").strip().casefold()
    exact = {str(value).casefold() for value in config.get("tournaments", ())}
    prefixes = tuple(
        str(value).casefold() for value in config.get("tournamentPrefixes", ())
    )
    return name in exact or any(name.startswith(prefix) for prefix in prefixes)


def _league_fixtures(
    session: requests.Session,
    api_key: str,
    league: str,
) -> list[dict[str, Any]]:
    config = LEAGUE_CONFIGS[league]
    fixtures: list[dict[str, Any]] = []
    seen: set[str] = set()
    now = int(time.time())
    lookups = (
        ("/fixtures/live", {}),
        ("/fixtures", {
            "startTimeFrom": now - 6 * 60 * 60,
            "startTimeTo": now + 60 * 24 * 60 * 60,
        }),
    )
    for path, time_params in lookups:
        data = _odds_get(
            session,
            api_key,
            path,
            bookmakers=BOOKMAKER,
            sportId=config["sportId"],
            **time_params,
        )
        for fixture in data if isinstance(data, list) else []:
            fixture_id = fixture.get("fixtureId")
            tournament = fixture.get("tournament") or {}
            if (
                isinstance(fixture_id, str)
                and fixture_id not in seen
                and _is_league_tournament(config, tournament.get("tournamentName"))
            ):
                seen.add(fixture_id)
                fixtures.append(fixture)
    return sorted(fixtures, key=lambda fixture: fixture.get("startTime") or 0)


def _matching_aces_games(
    fixture: dict[str, Any],
    games: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    participants = fixture.get("participants") or {}
    keys = [
        _normalize_team(participants.get("participant1Name")),
        _normalize_team(participants.get("participant2Name")),
    ]
    if "" in keys or keys[0] == keys[1]:
        return []

    fixture_start = fixture.get("startTime")
    if not isinstance(fixture_start, (int, float)):
        return []

    matches = []
    for game in games:
        game_keys = list(game["teamKeys"])
        if len(game_keys) != 2:
            continue
        teams_match = (
            _same_team(keys[0], game_keys[0]) and _same_team(keys[1], game_keys[1])
        ) or (
            _same_team(keys[0], game_keys[1]) and _same_team(keys[1], game_keys[0])
        )
        game_start = game.get("startTime")
        if (
            teams_match
            and isinstance(game_start, (int, float))
            and abs(fixture_start - game_start) <= FIXTURE_MATCH_TOLERANCE_SECONDS
        ):
            matches.append({
                **game,
                "startTimeDifferenceMinutes": round(
                    abs(fixture_start - game_start) / 60, 1
                ),
            })
    return sorted(matches, key=lambda game: game["oddsPeriod"] != "result")


def _market_map(
    session: requests.Session,
    api_key: str,
    quotes: list[dict[str, Any]],
) -> dict[int, dict[str, Any]]:
    outcome_ids = sorted(
        {
            quote.get("outcomeId")
            for quote in quotes
            if isinstance(quote.get("outcomeId"), int)
        }
    )
    if not outcome_ids:
        return {}
    data = _odds_get(
        session,
        api_key,
        "/markets",
        outcomeIds=",".join(map(str, outcome_ids)),
    )
    result: dict[int, dict[str, Any]] = {}
    for market in data if isinstance(data, list) else []:
        for outcome in market.get("outcomes") or []:
            outcome_id = outcome.get("outcomeId")
            if isinstance(outcome_id, int):
                result[outcome_id] = {
                    **market,
                    "outcomeName": outcome.get("outcomeName"),
                }
    return result


def _pinnacle_entries(
    fixture: dict[str, Any],
    quotes: list[dict[str, Any]],
    markets: dict[int, dict[str, Any]],
    desired_period: str,
) -> list[dict[str, Any]]:
    participants = fixture.get("participants") or {}
    participant1 = str(participants.get("participant1Name") or "Participant 1")
    participant2 = str(participants.get("participant2Name") or "Participant 2")
    sport_name = str((fixture.get("sport") or {}).get("sportName") or "")
    entries: list[dict[str, Any]] = []
    for quote in quotes:
        market = markets.get(quote.get("outcomeId"))
        if not market or market.get("period") != desired_period:
            continue
        market_type = market.get("marketType")
        outcome = str(market.get("outcomeName") or "")
        handicap = market.get("handicap")
        comparison_market: str | None = None
        selection = outcome
        line: float | int | None = None
        if market_type == "moneyline" and outcome in {"1", "2"}:
            comparison_market = "moneyline"
            selection = participant1 if outcome == "1" else participant2
        elif market_type == "spreads" and outcome in {"1", "2"}:
            selection = participant1 if outcome == "1" else participant2
            if sport_name == "Baseball" and desired_period != "result" and handicap == 0:
                comparison_market = "moneyline"
            else:
                comparison_market = "spread"
                if isinstance(handicap, (int, float)):
                    line = handicap if outcome == "1" else -handicap
        elif market_type == "totals" and outcome in {"Over", "Under"}:
            comparison_market = f"total-{outcome.lower()}"
            line = handicap
        elif market_type in {"teamtotals-team1", "teamtotals-team2"}:
            selection = participant1 if market_type.endswith("team1") else participant2
            comparison_market = f"teamtotal-{outcome.lower()}"
            line = handicap
        if comparison_market is None:
            continue
        entries.append(
            {
                "marketKey": comparison_market,
                "selection": selection,
                "selectionKey": _normalize_team(selection),
                "line": line,
                "oddsAmerican": quote.get("priceAmerican"),
                "limit": quote.get("limit"),
            }
        )
    return entries


def _entry_key(entry: dict[str, Any]) -> tuple[str, str]:
    return str(entry.get("marketKey")), str(entry.get("selectionKey"))


def _limit_field(market_key: object) -> str | None:
    """The limit a market row writes to. Over and Under share one limit."""
    base = str(market_key or "").split("-", 1)[0]
    return {
        "moneyline": "moneyLine",
        "spread": "spread",
        "total": "total",
        "teamtotal": "teamTotal",
    }.get(base)


def _market_label(key: str) -> str:
    return {
        "moneyline": "Moneyline",
        "spread": "Spread",
        "total-over": "Total Over",
        "total-under": "Total Under",
        "teamtotal-over": "Team Total Over",
        "teamtotal-under": "Team Total Under",
    }.get(key, key)


# The curve is read across these distances from kick-off, so a cycle always
# sees both the quiet early market and the busy one near the start.
TIME_BUCKETS = ((0.0, 3.0), (3.0, 8.0), (8.0, 24.0), (24.0, 1e9))


class RateLimited(ComparisonError):
    """OddsPapi refused because we asked too often."""


def sample_pinnacle_limits(
    api_key: str,
    league: str,
    max_fixtures: int = 8,
) -> list[dict[str, Any]]:
    """Pinnacle's current limits for one league, with time to kick-off.

    Recorded over days this becomes the intraday curve: how a limit grows as a
    game absorbs two-way money. The shape is what transfers to a smaller book -
    the level never does - so this reads only Pinnacle and needs no partner
    login.
    """
    config = LEAGUE_CONFIGS[league]
    session = requests.Session()
    session.headers.update(
        {"Accept": "application/json", "User-Agent": "limitbot-comparison/1.0"}
    )
    samples: list[dict[str, Any]] = []
    now = time.time()
    try:
        # OddsPapi's quota is shared with the comparison page, which a person
        # is waiting on, so only a handful of fixtures are read per cycle.
        # Which handful matters: taking the nearest ones meant every MLB
        # reading came from games under three hours out, and the early end of
        # the curve - the part a morning limit is set from - was never seen.
        # Spread the budget across the distance instead.
        upcoming = []
        for fixture in _league_fixtures(session, api_key, league):
            try:
                hours = (float(fixture.get("startTime")) - now) / 3600.0
            except (TypeError, ValueError):
                continue
            if hours < -3:
                continue
            upcoming.append((hours, fixture))
        upcoming.sort(key=lambda item: item[0])

        chosen: list[tuple[float, dict[str, Any]]] = []
        seen_ids: set[str] = set()
        for low, high in TIME_BUCKETS:
            for hours, fixture in upcoming:
                if len(chosen) >= max_fixtures:
                    break
                if not low <= hours < high:
                    continue
                fixture_id = str(fixture.get("fixtureId"))
                if fixture_id in seen_ids:
                    continue
                seen_ids.add(fixture_id)
                chosen.append((hours, fixture))
                # Two per bucket is enough to see the level without spending
                # the whole budget on one part of the curve.
                if sum(1 for h, _ in chosen if low <= h < high) >= 2:
                    break
        # Whatever budget the buckets left over goes to the nearest games,
        # which are the ones still moving.
        for hours, fixture in upcoming:
            if len(chosen) >= max_fixtures:
                break
            fixture_id = str(fixture.get("fixtureId"))
            if fixture_id in seen_ids:
                continue
            seen_ids.add(fixture_id)
            chosen.append((hours, fixture))

        for hours_to_start, fixture in chosen:
            try:
                payload = _odds_get(
                    session,
                    api_key,
                    "/fixtures/odds",
                    fixtureId=fixture["fixtureId"],
                    bookmakers=BOOKMAKER,
                    mainLine=True,
                )
            except ComparisonError as error:
                if "429" in str(error):
                    # Stop the whole cycle rather than keep pushing against a
                    # limiter the page also depends on.
                    raise RateLimited(str(error)) from None
                raise
            quote_map = ((payload.get("odds") or {}).get(BOOKMAKER) or {})
            quotes = [
                quote
                for quote in quote_map.values()
                if isinstance(quote, dict)
                and quote.get("active") is True
                and quote.get("marketActive") is not False
                and quote.get("limit") is not None
            ]
            if not quotes:
                continue
            markets = _market_map(session, api_key, quotes)
            for period_label, odds_period in (
                ("Full Game", "result"),
                ("1st Half", "p1"),
                ("2nd Half", "p2"),
                ("1st 5 Innings", "p1+p2+p3+p4+p5"),
            ):
                for entry in _pinnacle_entries(
                    payload, quotes, markets, odds_period
                ):
                    field = _limit_field(entry.get("marketKey"))
                    limit = entry.get("limit")
                    if not field or not isinstance(limit, (int, float)):
                        continue
                    samples.append({
                        "league": league,
                        "leagueName": config["name"],
                        "period": period_label,
                        "field": field,
                        "fixtureId": str(fixture.get("fixtureId")),
                        "hoursToStart": round(hours_to_start, 2),
                        "limit": float(limit),
                    })
            # Slower than the page's own throttle: a background reading is
            # never urgent, and the quota belongs to whoever is waiting.
            time.sleep(0.5)
    finally:
        session.close()
    return samples


def _comparison_section(
    fixture: dict[str, Any],
    aces_game: dict[str, Any],
    pinnacle_entries: list[dict[str, Any]],
) -> dict[str, Any]:
    rows = []
    for aces in aces_game["entries"]:
        aces_market, aces_selection = _entry_key(aces)
        pinnacle = next(
            (
                entry
                for entry in pinnacle_entries
                if str(entry.get("marketKey")) == aces_market
                and _same_team(str(entry.get("selectionKey")), aces_selection)
            ),
            None,
        )
        if pinnacle is None:
            continue
        rows.append(
            {
                "market": _market_label(aces["marketKey"]),
                "field": _limit_field(aces["marketKey"]),
                "selection": aces["selection"],
                "acesHigh": {
                    "line": aces["line"],
                    "oddsAmerican": aces["oddsAmerican"],
                    "limit": aces["limit"],
                },
                "pinnacle": {
                    "line": pinnacle["line"],
                    "oddsAmerican": pinnacle["oddsAmerican"],
                    "limit": pinnacle["limit"],
                },
            }
        )
    participants = fixture.get("participants") or {}
    start_time = fixture.get("startTime")
    return {
        "fixtureId": fixture.get("fixtureId"),
        "acesHighGameNumber": aces_game.get("gameNumber"),
        "fixture": (
            f"{participants.get('participant1Name')} vs "
            f"{participants.get('participant2Name')}"
        ),
        "period": aces_game["period"],
        "writeTarget": aces_game.get("writeTarget"),
        "startTimeUtc": (
            datetime.fromtimestamp(start_time, timezone.utc).isoformat()
            if isinstance(start_time, (int, float))
            else None
        ),
        "rows": rows,
    }


def _build_uncached(
    api_key: str,
    partner_session: requests.Session,
    partner_headers: dict[str, str],
    account_id: int,
    league: str,
) -> dict[str, Any]:
    config = LEAGUE_CONFIGS[league]
    limits, targets = _load_aceshigh_limits(
        partner_session,
        partner_headers,
        account_id,
        league,
    )
    aces_games = _parse_aces_games(
        _guest_schedule(league), limits, league, targets
    )
    odds_session = requests.Session()
    odds_session.headers.update(
        {"Accept": "application/json", "User-Agent": "limitbot-comparison/1.0"}
    )
    try:
        currency = _pinnacle_currency(odds_session, api_key)
        fixtures = _league_fixtures(odds_session, api_key, league)
        comparisons: list[dict[str, Any]] = []
        matched_fixture_ids: set[str] = set()
        for fixture in fixtures:
            matches = _matching_aces_games(fixture, aces_games)
            if not matches:
                continue
            payload = _odds_get(
                odds_session,
                api_key,
                "/fixtures/odds",
                fixtureId=fixture["fixtureId"],
                bookmakers=BOOKMAKER,
                mainLine=True,
            )
            quote_map = ((payload.get("odds") or {}).get(BOOKMAKER) or {})
            quotes = [
                quote
                for quote in quote_map.values()
                if isinstance(quote, dict)
                and quote.get("active") is True
                and quote.get("marketActive") is not False
                and quote.get("limit") is not None
            ]
            markets = _market_map(odds_session, api_key, quotes)
            for aces_game in matches:
                pinnacle = _pinnacle_entries(
                    payload,
                    quotes,
                    markets,
                    aces_game["oddsPeriod"],
                )
                section = _comparison_section(payload, aces_game, pinnacle)
                if section["rows"]:
                    comparisons.append(section)
                    matched_fixture_ids.add(str(fixture["fixtureId"]))
            time.sleep(0.11)
    finally:
        odds_session.close()

    return {
        "league": config["name"],
        "leagueSlug": league,
        "accountId": account_id,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "pinnacleLimitCurrency": currency,
        "configuredLimits": limits,
        "matchedFixtureCount": len(matched_fixture_ids),
        "sectionCount": len(comparisons),
        "comparisons": comparisons,
        "sources": {
            "acesHighLines": "Public sportsbook feed",
            "acesHighLimits": "Selected agent's partner league configuration",
            "pinnacle": "OddsPapi",
        },
    }


def build_league_comparison(
    api_key: str,
    partner_session: requests.Session,
    partner_headers: dict[str, str],
    account_id: int,
    league: str = "mlb",
    force: bool = False,
) -> dict[str, Any]:
    """Return one current league comparison, cached briefly per agent."""
    league = str(league or "mlb").strip().lower()
    if league not in LEAGUE_CONFIGS:
        raise ValueError("Unsupported comparison league")
    now = time.monotonic()
    cache_key = (account_id, league)
    with _cache_lock:
        cached = _comparison_cache.get(cache_key)
        if not force and cached and now - cached[0] < CACHE_SECONDS:
            return cached[1]
        result = _build_uncached(
            api_key,
            partner_session,
            partner_headers,
            account_id,
            league,
        )
        _comparison_cache[cache_key] = (time.monotonic(), result)
        return result


def comparison_leagues(
    api_key: str,
    partner_session: requests.Session,
    partner_headers: dict[str, str],
    account_id: int,
) -> list[dict[str, Any]]:
    """Return leagues configured at AcesHigh and supported by this OddsPapi key."""
    data = _partner_get(
        partner_session,
        partner_headers,
        f"{PARTNER_BASE}/partner-api/partner/Backbone/"
        f"GetOrganizationAll/{account_id}/false/S",
        f"{PARTNER_NAME} league lookup",
    )
    labels: set[str] = set()

    def walk(value: Any) -> None:
        if isinstance(value, dict):
            label = (
                value.get("LeagueDescription")
                or value.get("Description")
                or value.get("Name")
                or value.get("OrganizationLabelParent")
                or value.get("OrganizationLabel")
            )
            if label:
                labels.add(str(label))
            for child in value.values():
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)

    walk((data or {}).get("Payload") if isinstance(data, dict) else None)
    odds_session = requests.Session()
    odds_session.headers.update(
        {"Accept": "application/json", "User-Agent": "limitbot-comparison/1.0"}
    )
    try:
        sports = _odds_get(odds_session, api_key, "/sports")
    finally:
        odds_session.close()
    enabled_sports = {
        row.get("sportId") for row in sports if isinstance(row, dict)
    } if isinstance(sports, list) else set()
    return [
        {
            "slug": slug,
            "name": config["name"],
            "sportId": config["sportId"],
        }
        for slug, config in LEAGUE_CONFIGS.items()
        if config["limitRow"] in labels and config["sportId"] in enabled_sports
    ]


# Kept for callers of the first MLB-only implementation.
def build_mlb_comparison(
    api_key: str,
    partner_session: requests.Session,
    partner_headers: dict[str, str],
    account_id: int,
    force: bool = False,
) -> dict[str, Any]:
    return build_league_comparison(
        api_key, partner_session, partner_headers, account_id, "mlb", force
    )


def _score_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    rows = []
    for period, score in (payload.get("scores") or {}).items():
        if not isinstance(score, dict):
            continue
        rows.append({
            "period": score.get("period") or period,
            "participant1Score": score.get("participant1Score"),
            "participant2Score": score.get("participant2Score"),
            "updatedAt": score.get("updatedAt"),
        })
    return rows


def _monitor_signal(
    bookmaker: dict[str, Any],
    quote_count: int,
    active_quote_count: int,
    aces_open: bool,
) -> tuple[str, str]:
    if bookmaker.get("staleOdds") is True:
        return "hold", "Feed stale — no automatic action"
    if bookmaker.get("suspended") is True:
        return (
            ("would-suspend", f"Would suspend {PARTNER_NAME}")
            if aces_open
            else ("aligned-closed", "Both books closed")
        )
    if bookmaker.get("hasOdds") is False:
        return "hold", "Pinnacle has no odds — verify manually"
    if quote_count and active_quote_count == 0:
        return (
            ("would-suspend", f"Would suspend {PARTNER_NAME}")
            if aces_open
            else ("aligned-closed", "Both books closed")
        )
    if active_quote_count:
        return (
            ("aligned-open", "Both books open")
            if aces_open
            else ("would-reopen", "Would review for reopening")
        )
    return "hold", "No Pinnacle state — no automatic action"


def _build_monitor_uncached(
    api_key: str,
    account_id: int,
    league: str,
) -> dict[str, Any]:
    config = LEAGUE_CONFIGS[league]
    aces_games = _parse_aces_games(_guest_schedule(league), {}, league)
    odds_session = requests.Session()
    odds_session.headers.update(
        {"Accept": "application/json", "User-Agent": "limitbot-trading-monitor/1.0"}
    )
    events: list[dict[str, Any]] = []
    try:
        fixtures = _league_fixtures(odds_session, api_key, league)
        for fixture in fixtures:
            matches = _matching_aces_games(fixture, aces_games)
            if not matches:
                continue
            payload = _odds_get(
                odds_session,
                api_key,
                "/fixtures/odds",
                fixtureId=fixture["fixtureId"],
                bookmakers=BOOKMAKER,
                mainLine=True,
            )
            quote_map = ((payload.get("odds") or {}).get(BOOKMAKER) or {})
            quotes = [quote for quote in quote_map.values() if isinstance(quote, dict)]
            active_quotes = [
                quote for quote in quotes
                if quote.get("active") is True and quote.get("marketActive") is not False
            ]
            bookmaker = ((payload.get("bookmakers") or {}).get(BOOKMAKER) or {})
            aces_open = any(
                entry.get("oddsAmerican") not in (None, "")
                for match in matches
                for entry in match.get("entries") or []
            )
            signal, recommendation = _monitor_signal(
                bookmaker, len(quotes), len(active_quotes), aces_open
            )
            participants = payload.get("participants") or {}
            start_time = payload.get("startTime")
            status = payload.get("status") or {}
            clock = payload.get("clock") or {}
            events.append({
                "fixtureId": payload.get("fixtureId"),
                "fixture": (
                    f"{participants.get('participant1Name')} vs "
                    f"{participants.get('participant2Name')}"
                ),
                "startTimeUtc": (
                    datetime.fromtimestamp(start_time, timezone.utc).isoformat()
                    if isinstance(start_time, (int, float)) else None
                ),
                "status": {
                    "live": status.get("live"),
                    "name": status.get("statusName"),
                },
                "clock": {
                    "currentPeriod": clock.get("currentPeriod"),
                    "remainingTime": clock.get("remainingTime"),
                    "remainingTimeInPeriod": clock.get("remainingTimeInPeriod"),
                },
                "scores": _score_rows(payload),
                "periods": sorted({match.get("period") for match in matches if match.get("period")}),
                "mapping": {
                    "verified": True,
                    "method": "teams-and-start-time",
                    "maxStartDifferenceMinutes": max(
                        match.get("startTimeDifferenceMinutes", 0) for match in matches
                    ),
                    "acesHighGameNumbers": sorted({
                        match.get("gameNumber") for match in matches
                        if match.get("gameNumber") is not None
                    }),
                },
                "acesHigh": {
                    "open": aces_open,
                    "quoteCount": sum(
                        len(match.get("entries") or []) for match in matches
                    ),
                },
                "pinnacle": {
                    "open": bool(active_quotes) and bookmaker.get("suspended") is not True,
                    "suspended": bookmaker.get("suspended"),
                    "staleOdds": bookmaker.get("staleOdds"),
                    "hasOdds": bookmaker.get("hasOdds"),
                    "activeQuoteCount": len(active_quotes),
                    "quoteCount": len(quotes),
                    "updatedAt": bookmaker.get("updatedAt"),
                },
                "signal": signal,
                "recommendation": recommendation,
            })
            time.sleep(0.11)
    finally:
        odds_session.close()

    return {
        "mode": "dry-run",
        "league": config["name"],
        "leagueSlug": league,
        "accountId": account_id,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "eventCount": len(events),
        "suspendedCount": sum(
            event["pinnacle"]["suspended"] is True for event in events
        ),
        "actionCount": sum(
            event["signal"] in {"would-suspend", "would-reopen"} for event in events
        ),
        "events": events,
    }


def build_trading_monitor(
    api_key: str,
    account_id: int,
    league: str = "mlb",
    force: bool = False,
) -> dict[str, Any]:
    """Return mapped Pinnacle/AcesHigh trading signals without making writes."""
    league = str(league or "mlb").strip().lower()
    if league not in LEAGUE_CONFIGS:
        raise ValueError("Unsupported trading-monitor league")
    now = time.monotonic()
    cache_key = (account_id, league)
    with _monitor_cache_lock:
        cached = _monitor_cache.get(cache_key)
        if not force and cached and now - cached[0] < CACHE_SECONDS:
            return cached[1]
        result = _build_monitor_uncached(api_key, account_id, league)
        _monitor_cache[cache_key] = (time.monotonic(), result)
        return result
