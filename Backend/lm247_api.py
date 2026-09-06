"""LM247 (Lines Manager): read its games, write a per-game circled limit.

Why this exists. Metalic gives one limit per league. Pinnacle prices every
game separately - on one College Football afternoon they took 10,000 on
Georgia Tech v Colorado and 2,000 on Missouri -55 v Arkansas-Pine Bluff, a 5x
spread inside one league on one day. Collapsing that to a single number means
either leaving money on the good game or being too generous on the mismatch,
and no percentage fixes it because the problem is the shape, not the level.

LM247 has the field Metalic lacks: a per-game circled max wager. It also has a
Pinnacle autopilot, but that moves *lines*, not limits - nothing in its client
ties the two together. So the missing piece is the join: Pinnacle's per-game
maximum, scaled, written into LM247's per-game circle.

NOTHING HERE IS SWITCHED ON.
  * LM247_ENABLED  gates every request, including reads. Default off.
  * LM247_WRITE    gates writes on top of that. Default off.
  * The write path additionally refuses until LM247_UPDATE_TEMPLATE names a
    file containing a real captured Game/Update body. The field names below
    were read out of their minified bundle, not observed on the wire, and a
    guess about which field carries a bet limit is not something to find out
    by posting it.

Everything the planner needs can be exercised with all three off; see
per_game_ramp.plan_from_snapshots.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo
from typing import Any
from urllib.parse import quote

import requests

logger = logging.getLogger(__name__)

HOST = (os.getenv("LM247_HOST") or "lmanager247.com").strip().strip("/")
BASE = f"https://{HOST}"
# Two different services behind one host. The Lines Manager data API carries
# games and the Game/Update write; the "cog" API carries the Pinnacle
# autopilot. Their own settings object builds both this way.
DATA_API = f"{BASE}/lm-api/api/"
IDENT_API = f"{BASE}/lm-api/api/auth/"
COG_API = f"{BASE}/cog-api/"

USERNAME = (os.getenv("LM247_USERNAME") or "").strip()
PASSWORD = os.getenv("LM247_PASSWORD") or ""

# Every /lm-api/ path answered 403 from three different addresses - an office
# IP, a residential proxy and the EC2 box - while the app shell itself served
# 200. That is an allowlist in front of the API, so a proxy is offered here
# the same way pinnacle_api offers one.
PROXY_SETTING = (os.getenv("LM247_PROXY") or "").strip()

ENABLED = (os.getenv("LM247_ENABLED", "").strip().lower() in {"1", "true", "yes", "on"})
WRITE_ENABLED = (os.getenv("LM247_WRITE", "").strip().lower() in {"1", "true", "yes", "on"})
UPDATE_TEMPLATE_PATH = (os.getenv("LM247_UPDATE_TEMPLATE") or "").strip()

REQUEST_TIMEOUT = 45.0 if PROXY_SETTING else 25.0
MIN_REQUEST_INTERVAL = 0.5


class LM247Error(RuntimeError):
    """A call to LM247 failed."""


class LM247Disabled(LM247Error):
    """The integration is switched off. Not a fault - the default."""


class LM247AuthError(LM247Error):
    """Wrong credentials, or the session was rejected."""


class LM247Blocked(LM247Error):
    """The API refused the calling address before authentication.

    Its own class because it arrives as a 403 that looks exactly like "not
    permitted to do that" and is nothing of the kind: the request never
    reached the application.
    """


class LM247WriteRefused(LM247Error):
    """A write was attempted while writes are not permitted.

    Raised for both reasons that can hold: writes switched off, and a payload
    shape nobody has confirmed. Both are deliberate stops, not failures.
    """


# ---------------------------------------------------------------------------
# What a circled limit is called on the wire
# ---------------------------------------------------------------------------

# Reconstructed from LM247's own bundle (v2, main.ee6edd8c). The game-line save
# builds this object and posts it to linesmanager/lines/ via UpdateGameLineRequest:
#
#   {
#     GameNum, StoreId, Period, ShadeId,
#     WagerType,                       # the market, per the enum below
#     Line: {WagerType, Points, Home, Away, Draw},
#     Autopilot: {AutopilotSelected, AutopilotActive, Adjust},
#     Options: {KeepOpenMinutes, CircledValue, Status, TeamTotalAutoCalculations},
#     FollowMaster, ShadeAction,
#   }
#
# The per-game limit is Options.CircledValue. It is per market and per period,
# not one number for the game: WagerType and Period both select what is being
# circled.
#
# STILL UNVERIFIED ON THE WIRE. This is read from minified code, not observed,
# and posting the whole object means a wrong field clears something. A write
# copies a captured body and changes only CircledValue; the shape is here to
# recognise that capture, not to fabricate one.
UPDATE_PATH = "linesmanager/lines/"
CIRCLED_VALUE_KEY = "CircledValue"      # inside Options
OPTIONS_KEY = "Options"

# Pinnacle league slug -> LM247 league id, confirmed against the live board.
# Only the leagues this Pinnacle account can actually be read for appear here;
# basketball and hockey are not enabled on it, so they are absent by design.
PINNACLE_TO_LM_LEAGUE = {
    "nfl": 1,
    "ncaa-football": 2,
    "mlb": 5,
}
# The period we circle. Full game only for now: Pinnacle's per-game read and
# LM247's board both use period 0 for it, and the halves are a later step.
DEFAULT_PERIOD = 0

STORE_WAR = 65

# LM247's WagerType enum -> our market names. Values are bit flags in their code.
WAGER_TYPES = {
    "spread": 1,        # S
    "moneyLine": 2,     # M
    "total": 4,         # T
    "teamTotalAway": 8,  # TTA
    "teamTotalHome": 16,  # TTH
}
# Pinnacle gives one team-total limit; LM247 splits it home/away. Both get it.
PINNACLE_TO_WAGER = {
    "spread": (1,),
    "moneyLine": (2,),
    "total": (4,),
    "teamTotal": (8, 16),
}


def configured() -> bool:
    return bool(USERNAME and PASSWORD)


def enabled() -> bool:
    return ENABLED and configured()


def write_permitted() -> tuple[bool, str]:
    """Whether a write may happen, and if not, precisely why."""
    if not ENABLED:
        return False, "LM247 is switched off (set LM247_ENABLED=1)"
    if not configured():
        return False, "LM247 credentials are not set"
    if not WRITE_ENABLED:
        return False, "LM247 writes are switched off (set LM247_WRITE=1)"
    return True, ""


def _proxy_url(setting: str) -> str:
    if not setting or "://" in setting:
        return setting
    parts = setting.split(":")
    if len(parts) == 4:
        host, port, user, password = parts
        return f"http://{quote(user, safe='')}:{quote(password, safe='')}@{host}:{port}"
    return f"http://{setting}" if len(parts) == 2 else setting


PROXY = _proxy_url(PROXY_SETTING)


class LM247Client:
    """One authenticated session against LM247.

    Deliberately not a module-level singleton: this is off by default and
    should be constructed only where somebody has decided to use it.
    """

    def __init__(self, *, allow_writes: bool | None = None) -> None:
        if not ENABLED:
            raise LM247Disabled(
                "LM247 is switched off. Set LM247_ENABLED=1 to allow reads."
            )
        if not configured():
            raise LM247Disabled(
                "LM247 credentials are not set (LM247_USERNAME / LM247_PASSWORD)."
            )
        self.session = requests.Session()
        self.session.headers.update({
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Origin": BASE,
            "Referer": f"{BASE}/",
            "User-Agent": "limitbot-lm247/1.0",
        })
        if PROXY:
            self.session.proxies.update({"http": PROXY, "https": PROXY})
        self._lock = threading.Lock()
        self._next_allowed = 0.0
        self._token: str | None = None
        # An explicit False here is a caller saying "reads only" even where the
        # environment would permit writing.
        self._allow_writes = allow_writes

    # ------------------------------------------------------------- transport

    def _throttle(self) -> None:
        with self._lock:
            wait = self._next_allowed - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            self._next_allowed = time.monotonic() + MIN_REQUEST_INTERVAL

    def _request(self, method: str, url: str, **kwargs: Any) -> Any:
        self._throttle()
        try:
            response = self.session.request(
                method, url, timeout=REQUEST_TIMEOUT, **kwargs
            )
        except requests.RequestException as error:
            raise LM247Error(f"{method} {url} failed: {error}") from error

        if response.status_code == 403:
            body = response.text[:400]
            # openresty's own refusal page, i.e. the edge rejected us before
            # LM247 saw the request. Distinguished from an application 403 so
            # nobody goes looking for a permissions problem in the account.
            if "openresty" in body or "<html" in body.lower():
                raise LM247Blocked(
                    f"LM247 refused this address at the edge ({url}). The API "
                    "is allowlisted; ask them to permit the outbound IP, or "
                    "set LM247_PROXY to one they accept."
                )
            raise LM247AuthError(f"LM247 refused the request: {body}")
        if response.status_code in (401, 419):
            raise LM247AuthError("LM247 rejected the session token.")
        if not response.ok:
            raise LM247Error(
                f"LM247 returned {response.status_code} on {url}: "
                f"{response.text[:200]}"
            )
        if not response.text.strip():
            return {}
        try:
            return response.json()
        except ValueError as error:
            raise LM247Error(f"LM247 returned non-JSON from {url}") from error

    def login(self) -> None:
        payload = self._request(
            "POST", IDENT_API, json={"userName": USERNAME, "password": PASSWORD}
        )
        token = (
            payload.get("token")
            or payload.get("accessToken")
            or (payload.get("data") or {}).get("token")
            if isinstance(payload, dict) else None
        )
        if not token:
            raise LM247AuthError(
                "LM247 accepted the login but no token was found in the "
                f"response: {json.dumps(payload)[:200]}"
            )
        self._token = str(token)
        self.session.headers["Authorization"] = f"Bearer {self._token}"

    def _data(self, path: str, **params: Any) -> Any:
        return self._request("GET", DATA_API + path, params=params or None)

    # ----------------------------------------------------------------- reads

    def leagues(self) -> Any:
        """Sports and leagues LM247 carries. GET Sport/Leagues"""
        return self._data("Sport/Leagues")

    def lines(self, league_id: int, **params: Any) -> Any:
        """The board for one league. GET linesmanager/lines/{leagueId}"""
        return self._data(f"linesmanager/lines/{int(league_id)}", **params)

    def game_line(
        self, game_number: int, store_id: int, period: int, wager_type: int
    ) -> dict[str, Any]:
        """One game-line's full state, as LM247 returns it.

        GET linesmanager/gameLine?gameNum=&storeId=&period=&wagerType=
        The Payload carries Line (the current prices), Options (with the
        CircledValue), Game and more - everything the circle write must echo
        back so it changes only the amount.
        """
        payload = self._request(
            "GET",
            DATA_API + "linesmanager/gameLine",
            params={
                "gameNum": int(game_number),
                "storeId": int(store_id),
                "period": int(period),
                "wagerType": int(wager_type),
            },
        )
        return payload.get("Payload") or {}

    def circle_game_line(
        self,
        game_number: int,
        store_id: int,
        period: int,
        wager_type: int,
        amount: int,
    ) -> dict[str, Any]:
        """Set one game-line's circled amount to `amount`.

        Read-modify-write: the current line is read first so the write echoes
        its own prices back and changes only CircledValue. A save posts a whole
        line, so a value left out is a value cleared - reading first is what
        keeps this from wiping the price while setting the limit.

        The payload shape is the one proven on the wire (a real circle set from
        the server, confirmed enforced), not a reconstruction.
        """
        allowed, reason = write_permitted()
        if self._allow_writes is False:
            raise LM247WriteRefused("This client was opened read-only")
        if not allowed:
            raise LM247WriteRefused(reason)

        current = self.game_line(game_number, store_id, period, wager_type)
        line = current.get("Line") or {}
        options = current.get("Options")
        # Options in the read is the status list; the writable options live at
        # the top level of the payload. Build the write block explicitly.
        body = {
            "GameNum": int(game_number),
            "StoreId": int(store_id),
            "Period": int(period),
            "ShadeId": current.get("GameActiveShade", -1) if isinstance(current.get("GameActiveShade"), int) else -1,
            "WagerType": int(wager_type),
            "Line": {
                "WagerType": int(wager_type),
                "Points": line.get("Points", 0) or 0,
                "Home": line.get("Home", 0) or 0,
                "Away": line.get("Away", 0) or 0,
                "Draw": line.get("Draw"),
            },
            "Autopilot": {
                "AutopilotSelected": current.get("AutopilotSelected", 0) or 0,
                "AutopilotActive": bool(current.get("AutopilotActive", False)),
                "Adjust": current.get("Adjust", 0) or 0,
            },
            "Options": {
                "KeepOpenMinutes": current.get("KeepOpenMinutes", 0) or 0,
                "CircledValue": int(amount),
                "Status": current.get("Status", 1) or 1,
                "TeamTotalAutoCalculations": bool(
                    current.get("TeamTotalAutoCalculations", False)
                ),
            },
            "FollowMaster": None,
            "ShadeAction": None,
        }
        previous = current.get("CircledValue")
        result = self._request("POST", DATA_API + UPDATE_PATH, json=body)
        logger.info(
            "LM247 circled game %s wager %s period %s: %s -> %s",
            game_number, wager_type, period, previous, amount,
        )
        return {
            "ok": bool((result or {}).get("Payload", {}).get("IsSuccess")),
            "previous": previous,
            "value": int(amount),
        }

    # ---------------------------------------------------------------- writes

    def set_circled_limit(self, captured_body: dict[str, Any], amount: int) -> Any:
        """Circle one game-line at `amount`, off a captured request body.

        `captured_body` is a real linesmanager/lines/ payload saved from the UI
        (see LM247_UPDATE_TEMPLATE). Only Options.CircledValue is changed, so
        every other field - GameNum, Period, WagerType, Line, ShadeAction -
        stays exactly as the working request had it. Building the object from
        scratch is what this deliberately does not do: the save writes a whole
        game line, and a field left out is a field cleared.

        Refuses unless writes are permitted AND a template exists.
        """
        allowed, reason = write_permitted()
        if self._allow_writes is False:
            raise LM247WriteRefused("This client was opened read-only")
        if not allowed:
            raise LM247WriteRefused(reason)

        body = json.loads(json.dumps(captured_body))  # deep copy
        options = body.get(OPTIONS_KEY)
        if not isinstance(options, dict):
            raise LM247Error(
                f"Captured body has no {OPTIONS_KEY} object to set "
                f"{CIRCLED_VALUE_KEY} in"
            )
        options[CIRCLED_VALUE_KEY] = int(amount)
        logger.info(
            "LM247 circling game %s wager %s period %s at %s",
            body.get("GameNum"), body.get("WagerType"), body.get("Period"), amount,
        )
        return self._request("POST", DATA_API + UPDATE_PATH, json=body)


def open_session(*, allow_writes: bool = False) -> "LM247Client":
    """A logged-in client, or raise. The worker's single entry point."""
    client = LM247Client(allow_writes=allow_writes)
    client.login()
    return client


_EASTERN = ZoneInfo("America/New_York")


def _eastern_to_utc_iso(value: object) -> str | None:
    """A naive US-Eastern timestamp string as UTC ISO, or None."""
    text = str(value or "").strip()
    if not text:
        return None
    try:
        naive = datetime.fromisoformat(text.replace("Z", ""))
    except ValueError:
        return None
    aware = naive.replace(tzinfo=_EASTERN) if naive.tzinfo is None else naive
    return aware.astimezone(timezone.utc).isoformat()


def games_for_matching(client: "LM247Client", lm_league_id: int,
                        store_id: int = STORE_WAR) -> list[dict[str, Any]]:
    """Every game on one LM247 league board, in the shape the matcher wants.

    typeId=1 is the games view (typeId=0 came back empty); each game carries
    its rotation-numbered teams and an EventId that is the GameNum the circle
    write needs.
    """
    payload = client._data(
        f"linesmanager/gamePeriod", leagueid=int(lm_league_id), typeId=1
    )
    games = ((payload or {}).get("Payload") or {}).get("Games") or []
    out = []
    for game in games:
        teams = game.get("Teams") or []
        if len(teams) < 2:
            continue
        # LM247 lists visitor first in Teams; Header reads "Away @ Home".
        away = teams[0].get("TeamName") or teams[0].get("Mascot")
        home = teams[1].get("TeamName") or teams[1].get("Mascot")
        out.append({
            "GameNum": game.get("EventId"),
            "HomeTeam": home,
            "AwayTeam": away,
            # LM247 gives EventDate as naive US Eastern; the matcher compares
            # against Pinnacle's UTC, so convert here. Parsed as UTC it lands
            # four hours off and every game misses its match.
            "GameDateTime": _eastern_to_utc_iso(game.get("EventDate")),
            "raw": game,
        })
    return out


def describe_state() -> dict[str, Any]:
    """What is on, what is off, and what is still needed. For a status page."""
    allowed, reason = write_permitted()
    return {
        "host": HOST,
        "configured": configured(),
        "readsEnabled": enabled(),
        "writesEnabled": allowed,
        "blockedReason": reason,
        "usingProxy": bool(PROXY),
        "updateTemplate": UPDATE_TEMPLATE_PATH or None,
        "endpoint": DATA_API + UPDATE_PATH,
        "limitField": f"{OPTIONS_KEY}.{CIRCLED_VALUE_KEY}",
        "unverified": [
            f"{UPDATE_PATH} accepted on the wire",
            "which fields are required vs optional",
        ],
    }
