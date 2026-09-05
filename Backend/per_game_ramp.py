"""Match Pinnacle fixtures to LM247 games and work out a per-game limit.

This is the join the two systems do not have. Pinnacle knows what each game is
worth and LM247 has somewhere to put it; neither knows about the other, and
LM247's own Pinnacle autopilot moves lines rather than limits.

Everything here is pure. It takes a Pinnacle snapshot and an LM247 snapshot and
returns a plan - what it *would* write, per game, with the reason attached. No
network, no switches, no writes. That is what makes it possible to look at a
full day's plan before anything is turned on, and it is why the matching lives
here rather than inside either client.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable

# How far apart two kick-off times may be and still be the same game. Books
# disagree by a few minutes on start times, and a doubleheader is the reason
# this is not simply "same day".
START_TOLERANCE_SECONDS = 45 * 60

# Words that carry no identity, so "Boston Red Sox" and "Red Sox" match.
_NOISE = re.compile(
    r"\b(fc|cf|sc|ac|university|univ|state|st|the|of|at)\b", re.IGNORECASE
)
_PUNCT = re.compile(r"[^a-z0-9 ]+")


def normalize_team(name: object) -> str:
    text = _PUNCT.sub(" ", str(name or "").casefold())
    return " ".join(text.split())


def team_tokens(name: object) -> set[str]:
    """The parts of a team name that actually identify it."""
    stripped = _NOISE.sub(" ", normalize_team(name))
    return {token for token in stripped.split() if len(token) > 1}


def teams_match(left: object, right: object) -> bool:
    """Whether two books are naming the same team.

    Exact after normalising, or one name's identifying words are a subset of
    the other's - which is what makes "Miami Florida" and "Miami" the same
    while keeping "Miami" and "Miami Ohio" apart, since Ohio is a token the
    other side does not have.
    """
    a, b = normalize_team(left), normalize_team(right)
    if not a or not b:
        return False
    if a == b:
        return True
    ta, tb = team_tokens(left), team_tokens(right)
    if not ta or not tb:
        return False
    return ta <= tb or tb <= ta


def parse_start(value: object) -> float | None:
    """Epoch seconds from an ISO timestamp, or None."""
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


@dataclass(frozen=True)
class GameLimit:
    """One market on one game, and what we would set it to."""

    market: str
    pinnacle: float
    line: float | None
    target: int


@dataclass
class PlannedGame:
    """One matched game, with every market planned for it."""

    league: str
    pinnacle_event: str
    lm_game_number: Any
    lm_event: str
    starts_at: str | None
    hours_to_start: float | None
    limits: list[GameLimit] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "league": self.league,
            "pinnacleEvent": self.pinnacle_event,
            "gameNumber": self.lm_game_number,
            "lmEvent": self.lm_event,
            "startsAt": self.starts_at,
            "hoursToStart": self.hours_to_start,
            "limits": [
                {
                    "market": limit.market,
                    "pinnacle": limit.pinnacle,
                    "line": limit.line,
                    "target": limit.target,
                }
                for limit in self.limits
            ],
        }


def scale_limit(pinnacle_limit: float, scale_percent: float, *, floor: int = 100,
                step: int = 100) -> int:
    """Pinnacle's number at our share of it, rounded to something readable.

    Their level reflects their volume and never transfers; only the shape
    does. Rounding to a hundred is so the result reads as a number somebody
    chose rather than the output of a multiplication.
    """
    value = float(pinnacle_limit) * (float(scale_percent) / 100.0)
    if value <= 0:
        return floor
    return max(floor, int(round(value / step)) * step)


def index_lm_games(lm_games: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Normalise whatever LM247 returns into the few fields matching needs.

    Their field names are not confirmed, so several spellings are accepted and
    a game that yields neither team is dropped rather than half-matched.
    """
    out = []
    for game in lm_games or []:
        home = (
            game.get("HomeTeam") or game.get("homeTeam")
            or game.get("Home") or game.get("home")
        )
        away = (
            game.get("AwayTeam") or game.get("awayTeam")
            or game.get("Away") or game.get("away")
        )
        if not home or not away:
            continue
        out.append({
            "raw": game,
            "home": home,
            "away": away,
            "gameNumber": (
                game.get("GameNum") or game.get("gameNum")
                or game.get("GameNumber") or game.get("Id") or game.get("id")
            ),
            "starts": parse_start(
                game.get("GameDateTime") or game.get("gameDateTime")
                or game.get("EventDate") or game.get("startTime")
            ),
        })
    return out


def find_lm_game(
    pinnacle_home: object,
    pinnacle_away: object,
    pinnacle_start: float | None,
    lm_games: list[dict[str, Any]],
) -> dict[str, Any] | None:
    """The LM247 game that is this Pinnacle fixture, or None.

    Both teams must match and the start times must agree. Requiring the time
    as well as the names is what keeps the two halves of a doubleheader apart,
    and returning None rather than a best guess is deliberate: a limit written
    to the wrong game is worse than one not written at all.
    """
    candidates = [
        game for game in lm_games
        if teams_match(pinnacle_home, game["home"])
        and teams_match(pinnacle_away, game["away"])
    ]
    if not candidates:
        return None
    if pinnacle_start is None:
        return candidates[0] if len(candidates) == 1 else None

    timed = [
        (abs(game["starts"] - pinnacle_start), game)
        for game in candidates
        if game["starts"] is not None
    ]
    timed = [pair for pair in timed if pair[0] <= START_TOLERANCE_SECONDS]
    if not timed:
        # Names matched but no start time is close enough to be sure.
        return None
    timed.sort(key=lambda pair: pair[0])
    return timed[0][1]


def plan_from_snapshots(
    pinnacle_readings: Iterable[dict[str, Any]],
    lm_games: Iterable[dict[str, Any]],
    *,
    scale_percent: float = 50.0,
    period: str = "Full Game",
    markets: Iterable[str] | None = None,
) -> dict[str, Any]:
    """What we would circle, per game, given both snapshots.

    `pinnacle_readings` is pinnacle_api.league_readings() output: one row per
    game, period and market, carrying the limit and the line.
    """
    wanted = set(markets) if markets else {"spread", "moneyLine", "total", "teamTotal"}
    indexed = index_lm_games(lm_games)

    by_fixture: dict[str, list[dict[str, Any]]] = {}
    for reading in pinnacle_readings or []:
        if reading.get("period") != period:
            continue
        if reading.get("field") not in wanted:
            continue
        by_fixture.setdefault(str(reading.get("fixtureId")), []).append(reading)

    planned: list[PlannedGame] = []
    unmatched: list[dict[str, Any]] = []

    for readings in by_fixture.values():
        first = readings[0]
        event = str(first.get("event") or "")
        home, _, away = event.partition(" v ")
        match = find_lm_game(home, away, parse_start(first.get("startsAt")), indexed)
        if match is None:
            unmatched.append({
                "league": first.get("league"),
                "pinnacleEvent": event,
                "startsAt": first.get("startsAt"),
                "reason": "No LM247 game with both teams and a matching start time",
            })
            continue

        game = PlannedGame(
            league=str(first.get("leagueName") or first.get("league") or ""),
            pinnacle_event=event,
            lm_game_number=match["gameNumber"],
            lm_event=f"{match['home']} v {match['away']}",
            starts_at=first.get("startsAt"),
            hours_to_start=first.get("hoursToStart"),
        )
        for reading in sorted(readings, key=lambda r: str(r.get("field"))):
            game.limits.append(GameLimit(
                market=str(reading.get("field")),
                pinnacle=float(reading.get("limit") or 0),
                line=reading.get("line"),
                target=scale_limit(float(reading.get("limit") or 0), scale_percent),
            ))
        planned.append(game)

    planned.sort(key=lambda g: (g.league, g.starts_at or "", g.pinnacle_event))
    return {
        "scalePercent": scale_percent,
        "period": period,
        "matched": len(planned),
        "unmatched": len(unmatched),
        "games": [game.as_dict() for game in planned],
        "skipped": unmatched,
        # Said explicitly so a plan can never be mistaken for something that
        # happened. Nothing in this module writes.
        "applied": False,
    }


def render_plan(plan: dict[str, Any], limit: int = 40) -> str:
    """The plan as a table, for reading before anything is switched on."""
    lines = [
        f"Per-game plan - {plan['period']} at {plan['scalePercent']:g}% of Pinnacle",
        f"{plan['matched']} games matched, {plan['unmatched']} not matched, "
        f"applied={plan['applied']}",
        "",
        f"  {'game':<40}{'market':<11}{'pinnacle':>10}{'line':>8}{'would set':>11}",
    ]
    for game in plan["games"][:limit]:
        for index, limit_row in enumerate(game["limits"]):
            label = f"{game['pinnacleEvent'][:38]}" if index == 0 else ""
            line = "" if limit_row["line"] is None else f"{limit_row['line']:g}"
            lines.append(
                f"  {label:<40}{limit_row['market']:<11}"
                f"{limit_row['pinnacle']:>10,.0f}{line:>8}{limit_row['target']:>11,}"
            )
    for skipped in plan["skipped"][:10]:
        lines.append(f"  [no match] {skipped['pinnacleEvent']}")
    return "\n".join(lines)
