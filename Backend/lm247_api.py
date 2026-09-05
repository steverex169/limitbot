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
from pathlib import Path
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

# Read out of LM247's own bundle: the game-line form binds the circled amount
# to GameLineCircledValue, the grid column is CircledMaxWager, and the save
# goes through SetGameInfo -> POST Game/Update.
#
# UNVERIFIED. These are the names their JavaScript uses internally, which need
# not be the names their API accepts, and Game/Update almost certainly wants
# the whole game object rather than these fields alone. Confirm against a real
# captured request before anything is posted - which is what the template file
# is for.
CIRCLED_VALUE_FIELD = "GameLineCircledValue"
CIRCLED_FLAG_FIELD = "IsCircled"
UPDATE_PATH = "Game/Update"

# Which LM247 market a Pinnacle market writes to. Also unverified.
MARKET_FIELDS = {
    "spread": "Spread",
    "moneyLine": "MoneyLine",
    "total": "Total",
    "teamTotal": "TeamTotal",
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
    if not UPDATE_TEMPLATE_PATH:
        return False, (
            "No captured Game/Update body to build on. Point "
            "LM247_UPDATE_TEMPLATE at a JSON file saved from a real circle, "
            "so the payload is a copy of one that worked rather than a guess"
        )
    if not Path(UPDATE_TEMPLATE_PATH).is_file():
        return False, f"LM247_UPDATE_TEMPLATE does not exist: {UPDATE_TEMPLATE_PATH}"
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

    def game_line(self, game_number: int, period: int = 0) -> Any:
        """One game's line. GET linesmanager/gameLine/{gameNum}"""
        return self._data(f"linesmanager/gameLine/{int(game_number)}", period=period)

    # ---------------------------------------------------------------- writes

    def set_circled_limit(self, game_payload: dict[str, Any], amount: int) -> Any:
        """Circle one game at `amount`.

        Takes the game object as LM247 last returned it and changes only the
        circled amount, rather than assembling a body from scratch: Game/Update
        saves a whole game line, so anything omitted is a field being cleared.

        Refuses unless writes are permitted AND a captured template exists. The
        field names are read from their minified client, and posting a guess at
        which field carries a bet limit is not a way to find out.
        """
        allowed, reason = write_permitted()
        if self._allow_writes is False:
            raise LM247WriteRefused("This client was opened read-only")
        if not allowed:
            raise LM247WriteRefused(reason)

        body = dict(game_payload)
        body[CIRCLED_VALUE_FIELD] = int(amount)
        body[CIRCLED_FLAG_FIELD] = True
        logger.info(
            "LM247 circling game %s at %s",
            body.get("GameNum") or body.get("gameNum") or "?",
            amount,
        )
        return self._request("POST", DATA_API + UPDATE_PATH, json=body)


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
        "unverified": [
            f"{UPDATE_PATH} payload shape",
            CIRCLED_VALUE_FIELD,
            CIRCLED_FLAG_FIELD,
        ],
    }
