"""Read-only MLB comparison between AcesHigh and Pinnacle/OddsPapi."""

from __future__ import annotations

from datetime import datetime, timezone
import re
import threading
import time
from typing import Any

import requests


ACESHIGH_BASE = "https://aceshigh.ag"
PLAYER_API = f"{ACESHIGH_BASE}/player-api"
ODDSPAPI_BASE = "https://v5.oddspapi.io/en"
BOOKMAKER = "pinnacle"
CACHE_SECONDS = 45

PUBLIC_HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json;charset=UTF-8",
    "Origin": ACESHIGH_BASE,
    "Referer": f"{ACESHIGH_BASE}/v2/",
    "User-Agent": "limitbot-comparison/1.0",
}

MARKET_LIMIT_KEYS = {
    "moneyline": "MoneyLine",
    "spread": "Spread",
    "total": "Total",
    "teamtotal": "TeamTotal",
}

_cache_lock = threading.Lock()
_comparison_cache: dict[int, tuple[float, dict[str, Any]]] = {}


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
) -> dict[str, dict[str, float | int | None]]:
    data = _partner_get(
        session,
        headers,
        f"{ACESHIGH_BASE}/partner-api/partner/Backbone/"
        f"GetOrganizationAll/{account_id}/true/S",
        "AcesHigh MLB limit lookup",
    )
    baseball_row: dict[str, Any] | None = None

    def walk(value: Any) -> None:
        nonlocal baseball_row
        if isinstance(value, dict):
            label = (
                value.get("LeagueDescription")
                or value.get("Description")
                or value.get("Name")
                or value.get("OrganizationLabelParent")
                or value.get("OrganizationLabel")
                or ""
            )
            if label == "Baseball -- Full Game":
                baseball_row = value
            for child in value.values():
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)

    walk((data or {}).get("Payload") if isinstance(data, dict) else None)
    if baseball_row is None:
        raise ComparisonError("AcesHigh MLB limits are unavailable for this agent")

    result = {"Full Game": _limit_values(baseball_row)}
    organization_id = baseball_row.get("IdOrganization") or baseball_row.get("Id")
    if isinstance(organization_id, int):
        periods = _partner_get(
            session,
            headers,
            f"{ACESHIGH_BASE}/partner-api/partner/Backbone/"
            f"GetOrganizationPeriods/{account_id}/{organization_id}/S",
            "AcesHigh MLB period limit lookup",
        )
        for period in (periods or {}).get("Payload") or []:
            if not isinstance(period, dict):
                continue
            description = str(period.get("PeriodDescription") or "")
            if "inning" in description.lower():
                result["1st 5 Innings"] = _limit_values(period)
    return result


def _guest_schedule() -> list[dict[str, Any]]:
    session = requests.Session()
    try:
        try:
            token_response = session.post(
                f"{PLAYER_API}/identity/GuestToken",
                headers=PUBLIC_HEADERS,
                data="null",
                timeout=30,
            )
        except requests.RequestException as error:
            raise ComparisonError(
                f"AcesHigh guest login failed: {type(error).__name__}"
            ) from None
        token_data = _json(token_response, "AcesHigh guest login")
        token = token_data.get("AccessToken") if isinstance(token_data, dict) else None
        if not token:
            raise ComparisonError("AcesHigh guest login did not return a token")
        headers = {**PUBLIC_HEADERS, "Authorization": f"Bearer {token}"}
        try:
            response = session.post(
                f"{PLAYER_API}/api/wager/public/schedules/S/0",
                headers=headers,
                json=[
                    {"IdSport": 1, "Period": 0},
                    {"IdSport": 1, "Period": 1},
                ],
                timeout=30,
            )
        except requests.RequestException as error:
            raise ComparisonError(
                f"AcesHigh MLB schedule failed: {type(error).__name__}"
            ) from None
        data = _json(response, "AcesHigh MLB schedule")
        return data if isinstance(data, list) else []
    finally:
        session.close()


def _normalize_team(name: object) -> str:
    text = re.sub(r"\([^)]*\)", "", str(name or "")).lower()
    return "".join(re.findall(r"[a-z0-9]+", text))


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


def _parse_aces_games(
    schedule: list[dict[str, Any]],
    limits: dict[str, dict[str, float | int | None]],
) -> list[dict[str, Any]]:
    games: list[dict[str, Any]] = []
    for envelope in schedule:
        sc = envelope.get("sc") if isinstance(envelope, dict) else None
        if not isinstance(sc, dict) or str(sc.get("l") or "") != "MLB":
            continue
        period_number = sc.get("p")
        period = "Full Game" if period_number == 0 else str(sc.get("pd") or "")
        odds_period = "result" if period_number == 0 else "p1+p2+p3+p4+p5"
        period_limits = limits.get(period, {})
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
                        "period": period,
                        "oddsPeriod": odds_period,
                        "teamKeys": {_normalize_team(name) for name in names},
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


def _mlb_fixtures(session: requests.Session, api_key: str) -> list[dict[str, Any]]:
    fixtures: list[dict[str, Any]] = []
    seen: set[str] = set()
    for path in ("/fixtures/live", "/fixtures/today"):
        data = _odds_get(
            session,
            api_key,
            path,
            bookmakers=BOOKMAKER,
            sportId=13,
        )
        for fixture in data if isinstance(data, list) else []:
            fixture_id = fixture.get("fixtureId")
            tournament = fixture.get("tournament") or {}
            if (
                isinstance(fixture_id, str)
                and fixture_id not in seen
                and str(tournament.get("tournamentName") or "").upper() == "MLB"
            ):
                seen.add(fixture_id)
                fixtures.append(fixture)
    return sorted(fixtures, key=lambda fixture: fixture.get("startTime") or 0)


def _matching_aces_games(
    fixture: dict[str, Any],
    games: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    participants = fixture.get("participants") or {}
    keys = {
        _normalize_team(participants.get("participant1Name")),
        _normalize_team(participants.get("participant2Name")),
    }
    if "" in keys or len(keys) != 2:
        return []
    matches = [game for game in games if game["teamKeys"] == keys]
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
            if desired_period != "result" and handicap == 0:
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


def _market_label(key: str) -> str:
    return {
        "moneyline": "Moneyline",
        "spread": "Spread",
        "total-over": "Total Over",
        "total-under": "Total Under",
        "teamtotal-over": "Team Total Over",
        "teamtotal-under": "Team Total Under",
    }.get(key, key)


def _comparison_section(
    fixture: dict[str, Any],
    aces_game: dict[str, Any],
    pinnacle_entries: list[dict[str, Any]],
) -> dict[str, Any]:
    pinnacle_by_key = {_entry_key(entry): entry for entry in pinnacle_entries}
    rows = []
    for aces in aces_game["entries"]:
        pinnacle = pinnacle_by_key.get(_entry_key(aces))
        if pinnacle is None:
            continue
        rows.append(
            {
                "market": _market_label(aces["marketKey"]),
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
) -> dict[str, Any]:
    limits = _load_aceshigh_limits(
        partner_session,
        partner_headers,
        account_id,
    )
    aces_games = _parse_aces_games(_guest_schedule(), limits)
    odds_session = requests.Session()
    odds_session.headers.update(
        {"Accept": "application/json", "User-Agent": "limitbot-comparison/1.0"}
    )
    try:
        currency = _pinnacle_currency(odds_session, api_key)
        fixtures = _mlb_fixtures(odds_session, api_key)
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
        "league": "MLB",
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


def build_mlb_comparison(
    api_key: str,
    partner_session: requests.Session,
    partner_headers: dict[str, str],
    account_id: int,
    force: bool = False,
) -> dict[str, Any]:
    """Return the current MLB comparison, cached briefly per AcesHigh agent."""
    now = time.monotonic()
    with _cache_lock:
        cached = _comparison_cache.get(account_id)
        if not force and cached and now - cached[0] < CACHE_SECONDS:
            return cached[1]
        result = _build_uncached(
            api_key,
            partner_session,
            partner_headers,
            account_id,
        )
        _comparison_cache[account_id] = (time.monotonic(), result)
        return result
