import csv
from datetime import datetime, timedelta, timezone
import base64
import hashlib
import ipaddress
import json
import logging
import logging.handlers
import os
from pathlib import Path
import random
import re
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import threading
import uuid
import secrets
import signal
from zoneinfo import ZoneInfo
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor
from contextvars import ContextVar, copy_context
from urllib.parse import urlsplit
import time  # Added for retry delays

import requests
from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import bindparam, case, delete, func, inspect, select, text, update
from urllib.parse import urlparse, parse_qs
from database import Base, database_session, engine
import frontend_assets
from model import (
    AgentTreeCache,
    LimitChange,
    LimitTracker,
    LoginSession,
    PinnacleLimitSample,
    ScheduledLimit,
    User,
)
from odds_comparison import (
    ComparisonError,
    LEAGUE_CONFIGS,
    RateLimited,
    build_league_comparison,
    build_trading_monitor,
    comparison_leagues,
    sample_pinnacle_limits,
)

backend_directory = Path(__file__).resolve().parent
app_directory = backend_directory.parent / "Frontend"
# The dashboard is authored as one file per page, stylesheet and script; these
# stitch those back into the single index.html, styles.css and script.js the
# browser asks for. See frontend_assets for why it is composed and not linked.
composed_assets = frontend_assets.build(app_directory)
# Routes the shell answers. The dashboard is a single page that swaps sections
# on navigation, so each of these serves the same composed document and the
# client-side router decides what to show.
page_routes = frozenset({
    "/",
    "/activity_logs",
    "/activity_logs/",
    "/pinnacle_aceshigh",
    "/pinnacle_aceshigh/",
    "/trading_monitor",
    "/trading_monitor/",
    "/telegram_alerts",
    "/telegram_alerts/",
    "/build_ramp",
    "/build_ramp/",
})
# Serialize logins per username only: a slow upstream response for one account
# must not block every other user's login.
login_locks_guard = threading.Lock()
login_locks = {}
data_lock = threading.Lock()

# AccessHigh expands one hierarchy node per request, so a large agent tree
# costs one upstream round trip per node. The walk is pure network wait, so
# each level is fetched concurrently instead of one node at a time.
# AccessHigh rate limits this endpoint, so the walk stays deliberately
# modest: the tree is cached afterwards, which makes a slower walk far
# cheaper than a rate-limited one that fails outright.
hierarchy_worker_count = max(
    1, min(32, int(os.getenv("HIERARCHY_WORKERS", "4")))
)
# A blue limit carries this account's own value rather than an inherited one,
# and is never overwritten regardless of who set it. Black and orange limits
# are writable. Set SKIP_BLUE=off to disable the guard entirely.
skip_blue_limits = os.getenv("SKIP_BLUE", "on").strip().lower() not in {
    "off", "false", "0", "no"
}
rate_limit_retry_limit = max(
    1, min(20, int(os.getenv("HIERARCHY_RETRIES", "8")))
)


def eastern_timestamp(value):
    """Format an Eastern timestamp with the label the operators read.

    Eastern is EDT for most of the year, but the desk works in "EST" as the
    name of the zone itself, so the abbreviation is fixed while the clock
    time stays true New York local time. Scheduling is unaffected: this only
    decides what the label says.
    """
    return value.astimezone(schedule_timezone).strftime(
        "%Y-%m-%d %I:%M %p EST"
    )


def rate_limit_retry_delay(response, attempt):
    """How long to wait before retrying a rate-limited AccessHigh request."""
    try:
        delay = float(response.headers.get("Retry-After", "").strip())
    except ValueError:
        delay = 0.5 * (2 ** attempt)
    # Jitter stops the concurrent workers retrying in lockstep and tripping
    # the same limit all over again.
    return max(0.5, min(30.0, delay)) + random.uniform(0, 0.5)
# How long a stored hierarchy is served before it is refreshed. A stale tree
# is still returned immediately and refreshed behind the request, so a login
# never waits for the walk once the tree has been built at least once.
agent_tree_ttl = timedelta(
    seconds=max(0, int(os.getenv("AGENT_TREE_TTL_SECONDS", "900")))
)
agent_refresh_guard = threading.Lock()
agent_refresh_in_flight = set()


def upstream_session():
    """A requests session sized for the concurrent hierarchy walk.

    The default connection pool holds ten sockets, which the walk would
    exhaust and then rebuild on every request.
    """
    session = requests.Session()
    pool_size = max(10, hierarchy_worker_count + 4)
    adapter = requests.adapters.HTTPAdapter(
        pool_connections=pool_size, pool_maxsize=pool_size
    )
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


def login_serialization_lock(username):
    key = username.casefold()
    with login_locks_guard:
        if len(login_locks) > 1000:
            for stale_key in [
                existing
                for existing, lock in login_locks.items()
                if existing != key and not lock.locked()
            ]:
                del login_locks[stale_key]
        return login_locks.setdefault(key, threading.Lock())
schedule_timezone = ZoneInfo("America/New_York")

allowed_limit_fields = {
    "spread": "Spread",
    "moneyLine": "MoneyLine",
    "total": "Total",
    "teamTotal": "TeamTotal",
}

limit_mode_prefixes = {
    "normal": "",
    "early": "Early",
}
app_environment = os.getenv("APP_ENV", "development").lower()
server_host = os.getenv("HOST", "127.0.0.1")
try:
    server_port = int(os.getenv("PORT", "8000"))
except ValueError as error:
    raise RuntimeError("PORT must be a valid number") from error
if server_port < 1 or server_port > 65535:
    raise RuntimeError("PORT must be between 1 and 65535")
trust_proxy_headers = os.getenv("TRUST_PROXY_HEADERS", "").lower() in {
    "1", "true", "yes"
}
shutdown_event = threading.Event()
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger("aceshigh-dashboard")

# Container logs die with the container, so every redeploy used to destroy the
# history of why a scheduled limit failed. Point LOG_FILE at a mounted volume
# and the record outlives the container that wrote it.
log_file_path = os.getenv("LOG_FILE", "").strip()
if log_file_path:
    try:
        Path(log_file_path).parent.mkdir(parents=True, exist_ok=True)
        file_handler = logging.handlers.RotatingFileHandler(
            log_file_path,
            maxBytes=int(os.getenv("LOG_FILE_MAX_BYTES", str(16 * 1024 * 1024))),
            backupCount=int(os.getenv("LOG_FILE_BACKUPS", "5")),
            encoding="utf-8",
        )
        file_handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)s %(message)s")
        )
        logging.getLogger().addHandler(file_handler)
        logger.info("Logging to %s", log_file_path)
    except Exception:
        # A log file that cannot be opened must never stop the app booting.
        logger.warning("Could not open %s for logging", log_file_path, exc_info=True)

telegram_bot_token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
telegram_chat_id = os.getenv("TELEGRAM_CHAT_ID", "").strip()

# Which site this deployment manages. betwar.ag runs the identical platform at
# the identical version, so only the host differs - every path, payload and
# header below is unchanged. Run one container per site, each with its own
# database: agent ids are assigned per site and would collide in a shared one.
partner_host = os.getenv("PARTNER_HOST", "aceshigh.ag").strip().lower()
# What to call the site in anything the operator reads.
partner_name = os.getenv("PARTNER_NAME", "").strip() or (
    "Aces High" if partner_host == "aceshigh.ag" else partner_host
)
# BetWar does not use the lines comparison page. Keep the shared application
# deployment-aware instead of maintaining a second frontend or only hiding a
# link while leaving the route and APIs active.
pinnacle_comparison_enabled = partner_host != "betwar.ag"
trading_monitor_enabled = partner_host != "betwar.ag"
partner_origin = f"https://{partner_host}"
partner_api = f"{partner_origin}/partner-api/partner"

login_url = f"{partner_api}/identity/partnerLoginRedir"

login_headers = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Content-Type": "application/x-www-form-urlencoded",
    "Origin": partner_origin,
    "Referer": f"{partner_origin}/v2/",
    "User-Agent": "Mozilla/5.0",
}

token_url = f"{partner_api}/identity/PartnerLoginFromToken/"

token_headers = {
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json;charset=UTF-8",
    "Origin": partner_origin,
    "Referer": f"{partner_origin}/partner/index.html",
    "User-Agent": "Mozilla/5.0",
}

api_headers = {
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json;charset=UTF-8",
    "Origin": partner_origin,
    "Referer": f"{partner_origin}/partner/index.html",
    "User-Agent": "Mozilla/5.0",
}


auth_sessions = {}
auth_sessions_lock = threading.Lock()
hierarchy_confirmations = {}
hierarchy_confirmations_lock = threading.Lock()
hierarchy_confirmation_ttl = timedelta(minutes=5)
login_attempts = defaultdict(deque)
login_attempts_lock = threading.Lock()
current_auth = ContextVar("current_auth", default=None)
session_idle_timeout = timedelta(minutes=30)
session_max_lifetime = timedelta(hours=12)
login_attempt_window = timedelta(minutes=15)
login_attempt_limit = 5


def utc_now_naive():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def normalize_telegram_audience(value):
    audience = str(value or "all").strip().lower()
    return audience if audience in {"all", "aceshigh", "betwar"} else "all"


# Each site runs its own bot against its own database, so an alert from this
# deployment may only reach the recipients marked for this site. "All" sets
# both columns, which is how one person receives alerts from both bots.
telegram_site_column = "is_betwar" if partner_host == "betwar.ag" else "is_aceshigh"


def send_telegram_success_message(message, chat_id=None, audience="all"):
    """
    Send a Telegram notification after a successful limit save.

    Telegram Alerts recipients are managed from the dashboard. When at least
    one recipient is saved for this user, every saved recipient receives the
    alert. TELEGRAM_CHAT_ID remains only as a fallback when no dashboard
    recipients exist yet. Failure here must never break the limit-save flow.
    """
    if not telegram_bot_token:
        return

    target_chat_ids = []
    audience = normalize_telegram_audience(audience)

    if chat_id not in (None, ""):
        target_chat_ids = [str(chat_id).strip()]
    else:
        auth = current_auth.get() or {}
        user_id = auth.get("userId")
        if user_id is not None:
            try:
                # Always restricted to this site's recipients. A schedule
                # may narrow it further, but never widen it to the other
                # site - that site has its own bot and its own list.
                # Recipients belong to the site, not to whoever typed them
                # in: two people logging into the same deployment are running
                # the same book and expect the same alerts.
                membership_clause = f"WHERE {telegram_site_column} = 1 "
                if audience == "aceshigh" and telegram_site_column != "is_aceshigh":
                    membership_clause = "WHERE 0 = 1 "
                elif audience == "betwar" and telegram_site_column != "is_betwar":
                    membership_clause = "WHERE 0 = 1 "
                with database_session() as db:
                    target_chat_ids = [
                        str(row[0]).strip()
                        for row in db.execute(
                            text(
                                "SELECT chat_id FROM telegram_recipients "
                                f"{membership_clause}"
                                "ORDER BY created_at ASC"
                            )
                        )
                        if row[0] not in (None, "")
                    ]
            except Exception:
                logger.warning(
                    "Could not load Telegram alert recipients",
                    exc_info=True,
                )

        if audience == "all" and not target_chat_ids and telegram_chat_id:
            target_chat_ids = [telegram_chat_id]

    # Preserve order while preventing duplicate sends.
    target_chat_ids = list(dict.fromkeys(
        chat_id_value
        for chat_id_value in target_chat_ids
        if chat_id_value
    ))

    for target_chat_id in target_chat_ids:
        try:
            response = requests.post(
                f"https://api.telegram.org/bot{telegram_bot_token}/sendMessage",
                json={
                    "chat_id": target_chat_id,
                    "text": message,
                    "disable_web_page_preview": True,
                },
                timeout=30,
            )
            response.raise_for_status()
            data = response.json()
            if not data.get("ok", False):
                raise RuntimeError(data.get("description", "Telegram send failed"))
        except Exception as error:
            logger.warning(
                "Telegram success message failed for chat %s: %s",
                target_chat_id,
                error,
            )


def build_limit_success_message(
    account_id,
    organization_id,
    league_id,
    sport_type_id,
    period_number,
    field,
    new_value,
    change_type="Immediate limit",
    outcome_line="Applied successfully",
    customer_support_agent=None,
):
    source_type, schedule_id = current_change_source.get() or (None, None)
    audience_label = change_type
    if source_type == "schedule" and schedule_id:
        try:
            with database_session() as db:
                stored_job = db.get(ScheduledLimit, schedule_id)
            if stored_job and stored_job.recurrence_days and stored_job.recurrence_time:
                audience_label = "Recurring schedule limit"
            else:
                audience_label = "One-time schedule limit"
        except Exception:
            audience_label = "Schedule limit"
    elif source_type == "tracker":
        # Otherwise a tracker's writes are indistinguishable from somebody
        # pressing Save, which is the one thing the alert has to make clear.
        audience_label = (
            "Early tracked limit"
            if change_type.lower().startswith("early")
            else "Tracked limit"
        )
    elif change_type.lower().startswith("early"):
        audience_label = "Early limit"
    else:
        audience_label = "Immediate limit"

    row = find_limit_row(
        account_id,
        organization_id,
        league_id,
        sport_type_id,
        period_number,
    )

    # Use the selected agent's display name in Telegram notifications.
    auth = current_auth.get() or {}
    if int(account_id) == int(auth.get("id", -1)):
        agent_name = auth.get("username") or f"Agent {account_id}"
    else:
        agent_name = next(
            (
                agent.get("name")
                for agent in (auth.get("agents") or [])
                if int(agent.get("id", -1)) == int(account_id)
            ),
            None,
        )
        if not agent_name:
            try:
                agent_name = next(
                    (
                        agent.get("name")
                        for agent in load_agents()
                        if int(agent.get("id", -1)) == int(account_id)
                    ),
                    None,
                )
            except Exception:
                agent_name = None
        agent_name = agent_name or f"Agent {account_id}"

    # The dashboard already has the operator-facing league/period labels.
    # Prefer those over the internal parent label such as "BIG SIX".
    if row:
        organization_label = (
            row.get("organizationLabel")
            or row.get("OrganizationLabel")
            or row.get("OrganizationLabelParent")
            or ""
        )
        period_description = (
            row.get("periodDescription")
            or row.get("PeriodDescription")
            or ""
        )
        if (
            organization_label
            and period_description
            # OrganizationLabel usually already ends with the period, which is
            # how "Baseball -- Full Game" became "... -- Full Game -- Full Game".
            and not organization_label.strip().endswith(period_description.strip())
        ):
            league_name = f"{organization_label} -- {period_description}"
        elif organization_label:
            league_name = organization_label
        else:
            league_name = (
                organization_label
                or row.get("leagueName")
                or row.get("LeagueName")
                or row.get("name")
                or f"League {league_id}"
            )
    else:
        league_name = f"League {league_id}"

    field_label = {
        "spread": "Spread",
        "moneyLine": "Money line",
        "total": "Total",
        "teamTotal": "Team total",
    }.get(field, field)
    support_agent_line = (
        f"Customer Support Agent: {customer_support_agent}\n"
        if customer_support_agent
        else ""
    )
    return (
        # Both sites can share one bot, so the alert has to name the site it
        # came from. Hardcoding AcesHigh.ag here made every BetWar alert claim
        # to be an AcesHigh one.
        f"Success: {audience_label} saved on {partner_host}\n"
        f"Agent: {agent_name}\n"
        f"{support_agent_line}"
        f"League: {league_name}\n"
        f"{field_label}: {new_value}\n"
        f"{outcome_line}"
    )


def encryption_cipher():
    key = os.getenv("LIMITBOT_ENCRYPTION_KEY", "").encode("ascii")
    if not key:
        if os.getenv("APP_ENV", "").lower() == "production":
            raise RuntimeError(
                "LIMITBOT_ENCRYPTION_KEY is required in production"
            )
        key_file = backend_directory / ".limitbot.key"
        try:
            key = key_file.read_bytes().strip()
        except FileNotFoundError:
            key = Fernet.generate_key()
            try:
                file_descriptor = os.open(
                    key_file,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                    0o600,
                )
                with os.fdopen(file_descriptor, "wb") as stored_key:
                    stored_key.write(key)
            except FileExistsError:
                key = key_file.read_bytes().strip()
    try:
        return Fernet(key)
    except (ValueError, TypeError) as error:
        raise RuntimeError("LIMITBOT_ENCRYPTION_KEY is invalid") from error


def hash_password(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1, dklen=32
    )
    return "scrypt$16384$8$1${}${}".format(
        base64.urlsafe_b64encode(salt).decode("ascii"),
        base64.urlsafe_b64encode(digest).decode("ascii"),
    )


def hash_session_token(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def build_auth_from_database(user, login_session, session_hash=None):
    try:
        access_token = encryption_cipher().decrypt(
            user.access_token_encrypted.encode("ascii")
        ).decode("utf-8")
    except InvalidToken as error:
        raise PermissionError("Stored AccessHigh session is invalid") from error
    return {
        "http": upstream_session(),
        "headers": {**api_headers, "Authorization": f"Bearer {access_token}"},
        "id": int(user.accesshigh_agent_id),
        "username": user.username,
        "agents": None,
        "createdAt": login_session.created_at.replace(tzinfo=timezone.utc),
        "lastSeen": login_session.last_seen.replace(tzinfo=timezone.utc),
        "sessionHash": session_hash,
        "userId": user.id,
        "dbSessionId": login_session.id,
    }


def build_worker_auth(user):
    try:
        access_token = encryption_cipher().decrypt(
            user.access_token_encrypted.encode("ascii")
        ).decode("utf-8")
    except InvalidToken as error:
        raise PermissionError("Stored AccessHigh session is invalid") from error
    return {
        "http": upstream_session(),
        "headers": {**api_headers, "Authorization": f"Bearer {access_token}"},
        "id": int(user.accesshigh_agent_id),
        "username": user.username,
        "agents": None,
        "createdAt": datetime.now(timezone.utc),
        "lastSeen": datetime.now(timezone.utc),
        "sessionHash": None,
        "userId": user.id,
        "dbSessionId": None,
    }


def refresh_worker_auth(user_id):
    """Create and persist a fresh AcesHigh token for scheduled automation."""
    with database_session() as db:
        user = db.get(User, user_id)
        if user is None:
            raise RuntimeError("Schedule owner no longer exists")
        username = user.username
        expected_agent_id = int(user.accesshigh_agent_id)
        encrypted_password = user.password_encrypted

    if not encrypted_password:
        raise RuntimeError(
            "Automatic AcesHigh authentication is not configured. "
            "Log out and log in once, then the schedule can retry."
        )
    try:
        password = encryption_cipher().decrypt(
            encrypted_password.encode("ascii")
        ).decode("utf-8")
    except InvalidToken as error:
        raise RuntimeError(
            "Stored AcesHigh credentials cannot be decrypted"
        ) from error

    try:
        fresh_auth = authenticate(username, password)
    finally:
        password = None
    if int(fresh_auth["id"]) != expected_agent_id:
        fresh_auth["http"].close()
        raise RuntimeError("Refreshed AcesHigh account does not match schedule owner")
    fresh_token = fresh_auth.pop("accessToken")
    with database_session() as db:
        user = db.get(User, user_id)
        if user is None:
            raise RuntimeError("Schedule owner no longer exists")
        user.username = fresh_auth["username"]
        user.access_token_encrypted = encryption_cipher().encrypt(
            fresh_token.encode("utf-8")
        ).decode("ascii")
        db.commit()

    fresh_auth.update({
        "sessionHash": None,
        "userId": user_id,
        "dbSessionId": None,
    })
    return fresh_auth


def persist_login(auth, password, access_token, session_id):
    now = utc_now_naive()
    with database_session() as db:
        user = db.scalar(
            select(User).where(User.accesshigh_agent_id == auth["id"])
        )
        encrypted_token = encryption_cipher().encrypt(
            access_token.encode("utf-8")
        ).decode("ascii")
        encrypted_password = encryption_cipher().encrypt(
            password.encode("utf-8")
        ).decode("ascii")
        if user is None:
            user = User(
                accesshigh_agent_id=auth["id"],
                username=auth["username"],
                password_hash=hash_password(password),
                password_encrypted=encrypted_password,
                access_token_encrypted=encrypted_token,
            )
            db.add(user)
            db.flush()
        else:
            user.username = auth["username"]
            user.password_hash = hash_password(password)
            user.password_encrypted = encrypted_password
            user.access_token_encrypted = encrypted_token

        login_session = LoginSession(
            user_id=user.id,
            token_hash=hash_session_token(session_id),
            created_at=now,
            last_seen=now,
            expires_at=now + session_max_lifetime,
        )
        db.add(login_session)
        db.commit()
        db.refresh(login_session)
        auth["userId"] = user.id
        auth["dbSessionId"] = login_session.id
        return {
            "selectedAgentId": user.selected_agent_id,
            "searchQuery": user.search_query or "",
            "rowTypeFilter": user.row_type_filter or "all",
        }


def user_preferences(auth):
    with database_session() as db:
        user = db.get(User, auth["userId"])
        return {
            "selectedAgentId": user.selected_agent_id,
            "searchQuery": user.search_query or "",
            "rowTypeFilter": user.row_type_filter or "all",
        }


def save_user_preferences(auth, request_data):
    allowed_keys = {"selectedAgentId", "searchQuery", "rowTypeFilter"}
    if not set(request_data).issubset(allowed_keys):
        raise ValueError("Unsupported preference")
    with database_session() as db:
        user = db.get(User, auth["userId"])
        if "selectedAgentId" in request_data:
            selected_agent_id = validate_account_id(
                int(request_data["selectedAgentId"])
            )
            user.selected_agent_id = selected_agent_id
        if "searchQuery" in request_data:
            search_query = str(request_data["searchQuery"]).strip()
            if len(search_query) > 200:
                raise ValueError("Search value is too long")
            user.search_query = search_query
        if "rowTypeFilter" in request_data:
            row_type_filter = str(request_data["rowTypeFilter"])
            if row_type_filter not in {"all", "League", "Summary"}:
                raise ValueError("Invalid row filter")
            user.row_type_filter = row_type_filter
        db.commit()
    return user_preferences(auth)


def authenticate(username, password):
    with login_serialization_lock(username):
        upstream = upstream_session()
        login_response = upstream.post(
            login_url,
            headers=login_headers,
            data={"username": username, "password": password},
            allow_redirects=False,
            timeout=30,
        )

        if login_response.status_code != 302:
            raise ValueError("Invalid AccessHigh username or password")

        redirect_url = login_response.headers.get("Location", "")
        fragment = urlparse(redirect_url).fragment
        query_string = fragment.split("?", 1)[1] if "?" in fragment else ""
        fresh_tokens = parse_qs(query_string).get("t", [])

        if not fresh_tokens:
            raise ValueError("Invalid AccessHigh username or password")

        token_response = upstream.post(
            token_url,
            headers=token_headers,
            json={"token": fresh_tokens[0], "version": "2.2.20"},
            timeout=30,
        )
        token_response.raise_for_status()
        token_data = token_response.json()

        if token_data.get("Errors"):
            upstream_errors = ", ".join(token_data["Errors"])
            # AccessHigh reports a rejected username or password here rather
            # than on the redirect, and it used to surface as "AccessHigh
            # login is currently unavailable" — telling every user who
            # mistyped a password that the service was down.
            if "invalid username or password" in upstream_errors.casefold():
                raise ValueError("Invalid AccessHigh username or password")
            raise RuntimeError(upstream_errors)

        access_token = token_data.get("Payload", {}).get("AccessToken")
        if not access_token:
            raise RuntimeError("Aces High did not return an access token")

        payload = token_data["Payload"]
        return {
            "http": upstream,
            "headers": {**api_headers, "Authorization": f"Bearer {access_token}"},
            "id": int(payload["IdAgent"]),
            "username": payload.get("Username") or username,
            "agents": None,
            "createdAt": datetime.now(timezone.utc),
            "lastSeen": datetime.now(timezone.utc),
            "accessToken": access_token,
        }


def auth_context():
    auth = current_auth.get()
    if auth is None:
        raise PermissionError("Login required")
    return auth


def api_request(method, url, **kwargs):
    auth = auth_context()
    response = auth["http"].request(
        method, url, headers=auth["headers"], **kwargs
    )
    if response.status_code == 401:
        with auth_sessions_lock:
            auth_sessions.pop(auth.get("sessionHash"), None)
        if auth.get("dbSessionId"):
            with database_session() as db:
                stored_session = db.get(LoginSession, auth["dbSessionId"])
                if stored_session:
                    stored_session.expires_at = utc_now_naive()
                    db.commit()
        raise PermissionError("Your AccessHigh session expired. Please log in again.")
    return response


def build_agent_tree(auth):
    """Walk the complete AccessHigh hierarchy for a logged-in agent."""
    started_at = time.monotonic()
    logged_in_agent_id = auth["id"]
    root = {
        "id": logged_in_agent_id,
        "name": auth["username"],
        "parentId": logged_in_agent_id,
        "directPlayers": 0,
        "countHint": 0,
    }
    agents_by_id = {logged_in_agent_id: root}
    player_counts = {logged_in_agent_id: 0}
    discovery_order = [logged_in_agent_id]
    visited = {logged_in_agent_id}
    pending = [logged_in_agent_id]

    def hierarchy_value(item, *keys):
        fields = {str(key).casefold(): value for key, value in item.items()}
        return next(
            (
                fields[key.casefold()]
                for key in keys
                if fields.get(key.casefold()) not in (None, "")
            ),
            None,
        )

    def hierarchy_count(item):
        value = hierarchy_value(
            item,
            "PlayerCount",
            "PlayersCount",
            "TotalPlayers",
            "CustomerCount",
            "CustomersCount",
            "TotalCustomers",
            "AccountCount",
            "AccountsCount",
            "TotalAccounts",
            "CountPlayers",
            "CountCustomers",
            "PlayerQty",
            "CustomerQty",
            "QtyPlayers",
            "QtyCustomers",
            "Count",
        )
        try:
            return int(str(value).replace(",", ""))
        except (TypeError, ValueError):
            return None

    def hierarchy_bool(item, *keys):
        value = hierarchy_value(item, *keys)
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return value != 0
        return str(value).strip().lower() in {"1", "true", "yes", "y"}

    def hierarchy_parent_id(item, fallback_parent_id):
        try:
            return int(hierarchy_value(item, "ParentId", "IdParent") or fallback_parent_id)
        except (TypeError, ValueError):
            return fallback_parent_id

    def hierarchy_agent_id(item):
        value = hierarchy_value(item, "IdAgent", "AgentId", "Id")
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    def hierarchy_is_customer(item):
        if hierarchy_bool(item, "IsPlayer", "isPlayer", "IsCustomer", "isCustomer"):
            return True
        return hierarchy_value(
            item,
            "IdPlayer",
            "PlayerId",
            "IdCustomer",
            "CustomerId",
            "PlayerName",
            "CustomerName",
        ) is not None and hierarchy_value(item, "AgentName", "Agent") is None

    def hierarchy_items(payload):
        if isinstance(payload, list):
            return payload
        if not isinstance(payload, dict):
            return []

        items = []
        for key in (
            "Items",
            "Children",
            "Agents",
            "SubAgents",
            "Players",
            "Customers",
            "Accounts",
        ):
            value = hierarchy_value(payload, key)
            if isinstance(value, list):
                items.extend(value)
        return items or [payload]

    # AccessHigh throttles this endpoint per account, so a 429 seen by one
    # worker pauses all of them. Retrying without slowing the whole walk down
    # just trips the same limit again.
    rate_limit_guard = threading.Lock()
    rate_limited_until = 0.0

    def hold_off_while_rate_limited():
        while True:
            with rate_limit_guard:
                remaining = rate_limited_until - time.monotonic()
            if remaining <= 0:
                return
            time.sleep(min(remaining, 5.0))

    def note_rate_limit(response, attempt):
        nonlocal rate_limited_until
        delay = rate_limit_retry_delay(response, attempt)
        with rate_limit_guard:
            rate_limited_until = max(
                rate_limited_until, time.monotonic() + delay
            )

    def expand_node(parent_id):
        for attempt in range(rate_limit_retry_limit):
            hold_off_while_rate_limited()
            response = api_request(
                "GET",
                f"{partner_api}/accounts/"
                f"hierarchy/node/{parent_id}?IdAgent={logged_in_agent_id}",
                timeout=30,
            )
            # A rate-limited node is a wait, not a failure. Losing the whole
            # hierarchy over one throttled request would leave the dashboard
            # with no agents at all.
            if response.status_code != 429:
                break
            note_rate_limit(response, attempt)
            if attempt == rate_limit_retry_limit - 1:
                logger.warning(
                    "AccessHigh kept rate limiting hierarchy node %s", parent_id
                )
        response.raise_for_status()
        data = response.json()
        if data.get("Errors"):
            raise RuntimeError(", ".join(data["Errors"]))

        return hierarchy_items(data.get("Payload") or [])

    def absorb(parent_id, payload):
        contains_full_tree = (
            any(
                hierarchy_value(item, "ParentId", "IdParent") not in (None, parent_id)
                for item in payload
                if isinstance(item, dict)
            )
        )

        for item in payload:
            if not isinstance(item, dict):
                continue
            # A single-node expansion belongs directly beneath the node that
            # was expanded. ParentId is only authoritative when AccessHigh
            # returns an already-flattened complete tree.
            item_parent_id = (
                hierarchy_parent_id(item, parent_id)
                if contains_full_tree
                else parent_id
            )
            if hierarchy_is_customer(item):
                player_counts[item_parent_id] = player_counts.get(item_parent_id, 0) + 1
                continue
            agent_id = hierarchy_agent_id(item)
            if agent_id is None:
                continue
            if agent_id in visited:
                continue
            visited.add(agent_id)
            agents_by_id[agent_id] = {
                "id": agent_id,
                "name": item.get("AgentName") or f"Agent {agent_id}",
                "parentId": item_parent_id,
                "directPlayers": 0,
                "countHint": hierarchy_count(item),
            }
            discovery_order.append(agent_id)
            if len(visited) < 500:
                pending.append(agent_id)

    # AccessHigh returns one expanded hierarchy node at a time. Walk every agent
    # node so accounts nested under intermediary agents are also available.
    # A level is requested concurrently because the walk is pure network wait,
    # and the replies are absorbed in queue order so the tree comes out
    # identical to the one a node-at-a-time walk builds.
    with ThreadPoolExecutor(max_workers=hierarchy_worker_count) as pool:
        while pending:
            level = pending
            pending = []
            # Worker threads start with an empty context, so every task carries
            # its own copy of this request's authentication. One context cannot
            # be entered twice, hence a separate copy per task.
            replies = [
                pool.submit(copy_context().run, expand_node, node_id)
                for node_id in level
            ]
            try:
                payloads = [reply.result() for reply in replies]
            except BaseException:
                for reply in replies:
                    reply.cancel()
                raise
            for parent_id, payload in zip(level, payloads):
                absorb(parent_id, payload)

    for agent_id, count in player_counts.items():
        if agent_id in agents_by_id:
            agents_by_id[agent_id]["directPlayers"] = count

    children = {agent_id: [] for agent_id in agents_by_id}
    for agent_id in discovery_order[1:]:
        parent_id = agents_by_id[agent_id]["parentId"]
        children.setdefault(parent_id, []).append(agent_id)
    for child_ids in children.values():
        child_ids.sort(key=lambda agent_id: agents_by_id[agent_id]["name"].casefold())

    player_report_counts = {}
    try:
        response = api_request(
            "GET",
            f"{partner_api}/agent/reports/"
            f"management/playercount?IdAgent={logged_in_agent_id}",
            timeout=30,
        )
        response.raise_for_status()
        data = response.json()
        payload = (
            data.get("Payload")
            if isinstance(data, dict) and "Payload" in data
            else data.get("Result")
            if isinstance(data, dict) and "Result" in data
            else data.get("result")
            if isinstance(data, dict) and "result" in data
            else data
        )
        if isinstance(payload, dict) and isinstance(payload.get("Content"), list):
            report_rows = payload["Content"]
        elif isinstance(payload, list):
            report_rows = payload
        else:
            report_rows = []

        for row in report_rows:
            if not isinstance(row, dict):
                continue
            row_id = hierarchy_value(row, "AccountId", "IdAgent", "IdCustomer", "Id")
            row_count = hierarchy_value(
                row,
                "LastWeekTotal",
                "TotalPlayers",
                "PlayersThisWeek",
                "This_Week",
                "CustomerCount",
                "Count",
            )
            try:
                row_id = int(row_id)
                row_count = int(str(row_count).replace(",", ""))
            except (TypeError, ValueError):
                continue
            player_report_counts[row_id] = row_count
    except Exception:
        player_report_counts = {}

    def player_count(agent_id):
        if agent_id in player_report_counts:
            return player_report_counts[agent_id]
        agent = agents_by_id[agent_id]
        child_total = sum(player_count(child_id) for child_id in children[agent_id])
        calculated = agent["directPlayers"] + child_total
        return calculated if calculated else (agent.get("countHint") or 0)

    agents = []

    def append_tree(agent_id, depth):
        agent = agents_by_id[agent_id]
        child_ids = children[agent_id]
        agents.append({
            "id": agent["id"],
            "name": agent["name"],
            "parentId": agent["parentId"],
            "depth": depth,
            "count": player_count(agent_id),
            "hasChildren": bool(child_ids),
        })
        for child_id in child_ids:
            append_tree(child_id, depth + 1)

    append_tree(logged_in_agent_id, 0)

    logger.info(
        "Built agent hierarchy for %s: %s agents in %.1fs",
        logged_in_agent_id,
        len(agents),
        time.monotonic() - started_at,
    )
    return agents


def read_agent_tree_cache(agent_id):
    try:
        with database_session() as db:
            stored = db.get(AgentTreeCache, int(agent_id))
            if stored is None:
                return None
            agents = json.loads(stored.tree_json)
            updated_at = stored.updated_at
    except Exception:
        logger.warning("Stored agent hierarchy is unreadable", exc_info=True)
        return None
    if not isinstance(agents, list) or not agents:
        return None
    return agents, updated_at


def write_agent_tree_cache(agent_id, agents):
    try:
        with database_session() as db:
            stored = db.get(AgentTreeCache, int(agent_id))
            if stored is None:
                stored = AgentTreeCache(accesshigh_agent_id=int(agent_id))
                db.add(stored)
            stored.tree_json = json.dumps(agents)
            stored.agent_count = len(agents)
            stored.updated_at = utc_now_naive()
            db.commit()
    except Exception:
        # A hierarchy that cannot be stored only costs the next login the walk.
        logger.warning("Storing the agent hierarchy failed", exc_info=True)


def refresh_agent_tree_in_background(auth):
    agent_id = int(auth["id"])
    with agent_refresh_guard:
        if agent_id in agent_refresh_in_flight:
            return
        agent_refresh_in_flight.add(agent_id)

    def refresh():
        # A new thread starts with an empty context, so the walk needs this
        # login installed before it can reach AccessHigh.
        current_auth.set(auth)
        try:
            agents = build_agent_tree(auth)
            auth["agents"] = agents
            write_agent_tree_cache(agent_id, agents)
        except Exception:
            # The stored hierarchy stays in service; the next request that
            # finds it stale starts another refresh.
            logger.warning(
                "Background agent hierarchy refresh failed", exc_info=True
            )
        finally:
            with agent_refresh_guard:
                agent_refresh_in_flight.discard(agent_id)

    threading.Thread(
        target=refresh, name=f"agent-refresh-{agent_id}", daemon=True
    ).start()


def load_agents(force=False):
    auth = auth_context()
    if auth["agents"] is not None and not force:
        return auth["agents"]
    if not force:
        stored = read_agent_tree_cache(auth["id"])
        if stored is not None:
            agents, updated_at = stored
            auth["agents"] = agents
            # The stored hierarchy is served immediately. Once it ages past the
            # TTL it is rebuilt behind this request, so only the first ever
            # login for an account waits for the upstream walk.
            if utc_now_naive() - updated_at > agent_tree_ttl:
                refresh_agent_tree_in_background(auth)
            return agents
    agents = build_agent_tree(auth)
    auth["agents"] = agents
    write_agent_tree_cache(auth["id"], agents)
    return agents


def search_agents(search_value):
    search_value = str(search_value).strip()
    if not search_value:
        return load_agents()
    if len(search_value) > 100:
        raise ValueError("Agent search is too long")

    auth = auth_context()
    response = api_request(
        "GET",
        f"{partner_api}/agent/search",
        params={
            "IdAgent": auth["id"],
            "searchValue": search_value,
            "AgentOnly": "true",
            "MasterAgentOnly": "true",
            "CustomersOnly": "true",
            "SearchByAccountOnly": "false",
        },
        timeout=30,
    )
    response.raise_for_status()
    data = response.json()
    if data.get("Errors"):
        raise RuntimeError(", ".join(data["Errors"]))

    payload = data.get("Payload") or []
    if isinstance(payload, dict):
        for key in ("Items", "Results", "Agents", "Data"):
            if isinstance(payload.get(key), list):
                payload = payload[key]
                break
        else:
            payload = [payload]

    results = []
    seen = set()
    for item in payload:
        if not isinstance(item, dict):
            continue

        # The search response has used different property casing across Aces
        # High versions, so read its display fields case-insensitively.
        item_fields = {str(key).casefold(): value for key, value in item.items()}

        def search_field(*keys):
            return next(
                (
                    item_fields[key.casefold()]
                    for key in keys
                    if item_fields.get(key.casefold()) not in (None, "")
                ),
                None,
            )

        raw_id = next(
            (
                search_field(key)
                for key in ("IdCustomer", "CustomerId", "IdPlayer", "PlayerId", "IdAccount", "AccountId", "IdAgent", "AgentId", "Id")
                if search_field(key) is not None
            ),
            None,
        )
        try:
            agent_id = int(raw_id)
        except (TypeError, ValueError):
            continue
        if agent_id in seen:
            continue
        seen.add(agent_id)
        upstream_label = search_field(
            "DisplayName",
            "DisplayText",
            "SearchDisplay",
            "SearchText",
            "Label",
            "Description",
        )
        account = search_field(
            "Account",
            "AccountName",
            "AccountCode",
            "AccountNumber",
            "CustomerAccount",
            "Login",
            "LoginName",
            "Username",
            "UserName",
            "Customer",
            "CustomerName",
            "AgentName",
            "AgentCode",
            "Name",
        )
        password = search_field(
            "Password",
            "Pwd",
            "CustomerPassword",
            "CustomerPwd",
            "AccountPassword",
        )
        parent_agent = search_field(
            "ParentAgent",
            "MasterAgent",
            "ParentAgentName",
            "MasterAgentName",
            "MasterAgentAccount",
            "AgentUserName",
            "AgentUsername",
            "AgentAccount",
            "CreatedBy",
            "Parent",
            "Agent",
        )
        complete_upstream_label = (
            str(upstream_label)
            if upstream_label
            and "(PWD:" in str(upstream_label).upper()
            and " - " in str(upstream_label)
            else None
        )
        if not complete_upstream_label and not account:
            continue
        display_name = complete_upstream_label or str(account)
        if not complete_upstream_label:
            if password:
                display_name += f" (PWD:{password})"
            if parent_agent:
                display_name += f" - {parent_agent}"

        results.append({
            "id": agent_id,
            "name": display_name,
            "account": account or display_name,
            "parentAgent": parent_agent,
            "parentId": search_field("ParentId"),
            "depth": 0,
            "count": next(
                (
                    search_field(key)
                    for key in ("PlayerCount", "PlayersCount", "TotalPlayers", "Count")
                    if search_field(key) is not None
                ),
                0,
            ),
            "hasChildren": bool(search_field("HasChildren") or False),
        })

    auth = auth_context()
    auth["searchableAgentIds"] = {result["id"] for result in results}

    return results


def validate_account_id(account_id):
    auth = auth_context()
    # The logged-in account is always valid. Do not walk the complete upstream
    # hierarchy for the dashboard's default/root account on every API call.
    if int(account_id) == int(auth["id"]):
        return account_id
    if account_id in auth.get("searchableAgentIds", set()):
        return account_id
    cached_agents = auth.get("agents") or []
    valid_ids = {agent["id"] for agent in cached_agents}
    if account_id in valid_ids:
        return account_id
    # Customer accounts found via search are not part of the agent hierarchy.
    # After a restart the rebuilt auth has no search results yet, so also
    # accept the account the user had validated and persisted previously.
    if auth.get("userId") is not None:
        with database_session() as db:
            user = db.get(User, auth["userId"])
            if user is not None and user.selected_agent_id == account_id:
                return account_id
    # Only unknown accounts require a hierarchy lookup. Normal dashboard,
    # schedule, and comparison reads use one of the fast paths above.
    valid_ids = {agent["id"] for agent in load_agents()}
    if account_id in valid_ids:
        return account_id
    raise ValueError("Selected agent is not available under this login")


def account_name(account_id):
    auth = auth_context()
    if int(account_id) == int(auth["id"]):
        return auth["username"]
    return next(
        (
            agent["name"]
            for agent in (auth.get("agents") or [])
            if agent["id"] == account_id
        ),
        f"Agent {account_id}",
    )

# LIMIT CHANGE CODE (DISABLED — remove "# " only when intentionally saving)
# save_limit_url = (
#     "https://aceshigh.ag/"
#     "partner-api/partner/Backbone/save/"
# )
#
# save_limit_payload = {
#     "IdCustomer": "968877",
#     "AllPeriods": False,
#     "AllHierarchy": False,
#     "RemoveBlue": False,
#     "RemoveBlueSpecific": False,
#     "UpdateDetails": False,
#     "AllPlayers": False,
#     "BBWagerType": ["S"],
#     "Changes": [
#         {
#             "IdOrganization": 1,
#             "IdSportType": 0,
#             "Spread": None,
#             "YesNoSpread": None,
#             "MoneyLine": None,
#             "YesNoMoneyLine": None,
#             "Total": None,
#             "YesNoTotal": None,
#             "TeamTotal": None,
#             "YesNoTeamTotal": None,
#             "EarlySpread": None,
#             "EarlyMoneyLine": None,
#             "EarlyTotal": None,
#             "EarlyTeamTotal": None,
#             "TeamTotalPeriod": None,
#             "DetailPeriod": None,
#         }
#     ],
#     "AgentsFilterList": [-1],
#     "IdLeague": 0,
# }
#
# save_limit_response = session.post(
#     save_limit_url,
#     headers=api_headers,
#     json=save_limit_payload,
#     timeout=30,
# )
#
# print("Save status:", save_limit_response.status_code)
# print("Save response:", save_limit_response.text)

def organization_url(account_id):
    """The account's own limits, not the ceilings it inherits.

    The path segment before the wager type is AccessHigh's "Show Agent
    Limits" switch. Sending `true` returns the parent agent's limits for
    every account, so a sub-account read as its parent: account 996059
    showed Spread 75550 under `true` against the 100 AccessHigh displays,
    and `false` returns 100. Everything downstream depends on this being the
    account's own value, including the skip check and the change log.
    """
    return (
        f"{partner_api}/Backbone/GetOrganizationAll/{account_id}/false/S"
    )

league_rows = []
period_cache = {}
league_cache = {}


def flatten_values(value, prefix="", output=None):
    if output is None:
        output = {}

    if isinstance(value, dict):
        for key, child in value.items():
            if key == "Items":
                continue

            child_prefix = f"{prefix}.{key}" if prefix else key
            flatten_values(child, child_prefix, output)

    elif isinstance(value, list):
        output[prefix] = ", ".join(str(item) for item in value)

    elif value is not None:
        output[prefix] = value

    return output


def collect_leagues(value, path="Payload"):
    if isinstance(value, dict):
        league_id = value.get("IdLeague")

        if isinstance(league_id, int) and league_id > 0:
            organization_label = (
                value.get("OrganizationLabel")
                or value.get("OrganizationLabelParent")
                or ""
            )
            period_description = (
                value.get("PeriodDescription")
                or value.get("OrganizationPeriod")
                or ""
            )
            league_name = (
                value.get("LeagueDescription")
                or value.get("Description")
                or value.get("Name")
                or organization_label
            )
            if not period_description and " -- " in league_name:
                period_description = league_name.split(" -- ", 1)[1].strip()

            row = flatten_values(value)
            row.update(
                {
                    "IdLeague": league_id,
                    "IdOrganization": value.get(
                        "IdOrganization", value.get("Id", "")
                    ),
                    "IdSportType": value.get("IdSportType", ""),
                    "LeagueName": league_name,
                    "OrganizationLabel": organization_label,
                    "OrganizationLabelParent": value.get(
                        "OrganizationLabelParent", ""
                    ),
                    "PeriodDescription": period_description,
                    "RowType": "Summary" if value.get("Items") else "League",
                    "JsonPath": path,
                }
            )
            league_rows.append(row)

        for key, child in value.items():
            collect_leagues(child, f"{path}.{key}")

    elif isinstance(value, list):
        for index, child in enumerate(value):
            collect_leagues(child, f"{path}[{index}]")


def csv_path(account_id):
    return backend_directory / f"editable_leagues_{account_id}.csv"
leading_fieldnames = [
    "IdLeague",
    "IdOrganization",
    "IdSportType",
    "LeagueName",
    "OrganizationLabel",
    "OrganizationLabelParent",
    "PeriodDescription",
    "RowType",
    "JsonPath",
]
unique_leagues = []


def write_league_csv(rows, account_id):
    all_fieldnames = set()
    for row in rows:
        all_fieldnames.update(row)

    fieldnames = leading_fieldnames + sorted(
        all_fieldnames.difference(leading_fieldnames)
    )

    with csv_path(account_id).open("w", newline="", encoding="utf-8-sig") as csv_file:
        writer = csv.DictWriter(csv_file, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def refresh_leagues(account_id):
    global unique_leagues

    response = api_request(
        "GET",
        organization_url(account_id),
        timeout=30,
    )
    response.raise_for_status()
    data = response.json()

    if data.get("Errors"):
        raise RuntimeError(", ".join(data["Errors"]))

    # league_rows is shared globally, so protect the complete parsing process
    # from simultaneous requests for different accounts.
    with data_lock:
        league_rows.clear()
        collect_leagues(data.get("Payload", {}))

        refreshed_rows = []
        seen_leagues = set()
        for row in league_rows:
            key = (
                row["JsonPath"],
                row["IdLeague"],
                row["IdOrganization"],
                row["IdSportType"],
            )
            if key in seen_leagues:
                continue

            seen_leagues.add(key)
            refreshed_rows.append(row)

        # Store an independent copy for this account so another account refresh
        # cannot overwrite or mutate the values returned for this account.
        refreshed_rows = list(refreshed_rows)
        league_cache[account_id] = refreshed_rows

        # League refreshes can change the underlying period values. Remove only
        # this account's cached periods so the next period request is fresh.
        stale_period_keys = [
            cache_key
            for cache_key in period_cache
            if cache_key[0] == account_id
        ]
        for cache_key in stale_period_keys:
            period_cache.pop(cache_key, None)

        unique_leagues = refreshed_rows
        write_league_csv(refreshed_rows, account_id)

        return list(refreshed_rows)


def get_leagues(account_id, force=False):
    # force=True always requests the current values directly from Aces High.
    if force:
        return refresh_leagues(account_id)

    with data_lock:
        cached_rows = league_cache.get(account_id)
        if cached_rows is not None:
            return list(cached_rows)

    return refresh_leagues(account_id)


def display_limit_value(row, field):
    """The number AccessHigh itself shows for this limit.

    `.AmountMax` is the effective limit and is what AccessHigh displays.
    Where a wager limit caps the configured amount the two diverge, and the
    capped figure is the real one: account 996059's Hockey Total carries
    Amount 2500 against AmountMax 500 with HasWagerLimitOverrides set, and
    AccessHigh shows 500.

    A previous change preferred `.Amount` on the grounds that AccessHigh's
    grid binds its input to it. That binding is real but it is not what the
    row displays, and the change made every capped limit read high. Prefer
    `.AmountMax`, falling back to `.Amount` only when it is absent.
    """
    amount_max = row.get(f"{field}.AmountMax")
    if amount_max not in (None, ""):
        return amount_max
    return row.get(f"{field}.Amount")


def display_early_limit_value(row, field):
    amount = row.get(f"{field}.Amount")
    if amount not in (None, ""):
        return amount
    amount_max = row.get(f"{field}.AmountMax")
    if amount_max not in (None, ""):
        return amount_max
    return row.get(field)

# Set for the duration of a scheduled run so a change can be attributed to the
# job that made it rather than looking like someone typed it.
current_change_source = ContextVar("current_change_source", default=None)


def record_limit_change(
    account_id, organization_id, league_id, sport_type_id,
    period_number, field, limit_mode, old_value, new_value,
    customer_support_agent=None,
    target_scope="selected",
    affected_agents=None,
    affected_customers=None,
    changed_at=None,
):
    """Log a limit that actually changed. Never let logging break the save."""
    try:
        source, schedule_id = current_change_source.get() or ("manual", None)
        auth = current_auth.get() or {}
        with database_session() as db:
            db.add(LimitChange(
                user_id=auth.get("userId"),
                account_id=int(account_id),
                organization_id=safe_int(organization_id),
                league_id=safe_int(league_id),
                sport_type_id=safe_int(sport_type_id),
                period_number=safe_int(period_number),
                field=field,
                limit_mode=limit_mode,
                old_value=None if old_value in (None, "") else safe_int(old_value),
                new_value=int(new_value),
                source=source,
                schedule_id=schedule_id,
                customer_support_agent=customer_support_agent,
                target_scope=target_scope,
                affected_agents=affected_agents,
                affected_customers=affected_customers,
                changed_at=changed_at or utc_now_naive(),
            ))
            db.commit()
    except Exception:
        logger.warning("Could not record the limit change", exc_info=True)


def limit_change_counts(account_id):
    """How many times each limit on this account has changed, and when last.

    One grouped query for the whole account rather than a query per row.
    """
    counts = {}
    try:
        with database_session() as db:
            rows = db.execute(
                select(
                    LimitChange.organization_id,
                    LimitChange.league_id,
                    LimitChange.sport_type_id,
                    LimitChange.period_number,
                    LimitChange.field,
                    LimitChange.limit_mode,
                    func.count().label("cycles"),
                    func.max(LimitChange.changed_at).label("last_changed"),
                )
                .where(LimitChange.account_id == int(account_id))
                .group_by(
                    LimitChange.organization_id,
                    LimitChange.league_id,
                    LimitChange.sport_type_id,
                    LimitChange.period_number,
                    LimitChange.field,
                    LimitChange.limit_mode,
                )
            )
            for row in rows:
                key = (
                    safe_int(row.organization_id),
                    safe_int(row.league_id),
                    safe_int(row.sport_type_id),
                    safe_int(row.period_number),
                    row.field,
                    row.limit_mode,
                )
                counts[key] = (row.cycles, row.last_changed)
    except Exception:
        logger.warning("Could not read limit change counts", exc_info=True)
    return counts


def limit_set_by_us(account_id, organization_id, league_id,
                    sport_type_id, period_number, field, limit_mode):
    """Has this bot written this exact limit before?

    Distinguishes a blue limit the bot created - which it may update - from
    one a person set deliberately, which it must leave alone. Unknown on a
    read failure, and an unknown limit is treated as not ours, so the
    cautious answer is the default.
    """
    try:
        with database_session() as db:
            return db.scalar(
                select(func.count())
                .select_from(LimitChange)
                .where(
                    LimitChange.account_id == int(account_id),
                    LimitChange.organization_id == safe_int(organization_id),
                    LimitChange.league_id == safe_int(league_id),
                    LimitChange.sport_type_id == safe_int(sport_type_id),
                    LimitChange.period_number == safe_int(period_number),
                    LimitChange.field == field,
                    LimitChange.limit_mode == limit_mode,
                )
            ) > 0
    except Exception:
        logger.warning("Could not check the limit change log", exc_info=True)
        return False


def limit_colour(row, field, is_early):
    """The colour AccessHigh paints this limit, from its own rules.

    Taken from getBBInputClass in AccessHigh's bundle: csPlayerLimit is blue
    (#0026ff) and wins outright, csWagerLimit is orange (#ff6a00) and applies
    only when no player override exists, and a cell with neither class stays
    black. Both flags travel in the payload the dashboard already fetches.
    """
    base = allowed_limit_fields[field]
    prefix = f"{base}.EarlyLimit" if is_early else base

    def flag(name):
        value = row.get(f"{prefix}.{name}")
        if isinstance(value, str):
            return value.strip().casefold() == "true"
        return bool(value)

    if flag("HasPlayerOverrides"):
        return "blue"
    if flag("HasWagerLimitOverrides"):
        return "orange"
    return "black"


def stored_limit_value(row, field, is_early):
    """The value AccessHigh currently holds for one market on one row.

    Read exactly the way the dashboard displays it, so "already 500" means
    the same number the operator is looking at.
    """
    base = allowed_limit_fields[field]
    if is_early:
        return display_early_limit_value(row, f"{base}.EarlyLimit")
    return display_limit_value(row, base)


def dashboard_rows(account_id, force=False):
    rows = []
    cycles = limit_change_counts(account_id)
    for row in get_leagues(account_id, force=force):
        is_exotic = ".Exotics[" in row.get("JsonPath", "")
        is_game_setup = row.get("PeriodTypes.GameSetup") is True
        supports_early_limit = any(
            row.get(f"{field}.EarlyLimit.Amount") not in (None, "")
            or row.get(f"{field}.EarlyLimit.AmountMax") not in (None, "")
            for field in ("Spread", "MoneyLine", "Total", "TeamTotal")
        )
        editable_fields = (
            []
            if is_exotic
            else ["spread"]
            if is_game_setup
            else ["spread", "moneyLine", "total", "teamTotal"]
        )
        rows.append(
            {
                "accountId": account_id,
                "idLeague": row["IdLeague"],
                "idOrganization": row["IdOrganization"],
                "idSportType": row["IdSportType"],
                "idParent": row.get("IdParent", 0),
                "periodNumber": row.get("PeriodNumber", 0),
                "leagueName": row["LeagueName"],
                "organizationLabel": row["OrganizationLabel"],
                "periodDescription": row["PeriodDescription"],
                "rowType": row["RowType"],
                "level": 0 if row["RowType"] == "Summary" else 1,
                "hasPeriods": (
                    row["RowType"] == "League"
                    and not is_exotic
                    and not is_game_setup
                    and any(
                        int(row.get(key, 0) or 0) > 0
                        for key in (
                            "PeriodTypes.PeriodTypeHalvesQuarters",
                            "PeriodTypes.PeriodTypeHalvesOnly",
                            "PeriodTypes.PeriodTypeInnings",
                            "PeriodTypes.PeriodTypePeriods3",
                        )
                    )
                ),
                "editable": True,
                "editableFields": editable_fields,
                "disabledReason": (
                    "Props/Exotics are pending verification"
                    if is_exotic
                    else ""
                ),
                "supportsEarlyLimit": supports_early_limit,
                # AccessHigh's own colour for each market, so the grid can be
                # read the same way as the system it mirrors.
                "colours": {
                    name: limit_colour(row, name, False)
                    for name in allowed_limit_fields
                },
                "earlyColours": {
                    name: limit_colour(row, name, True)
                    for name in allowed_limit_fields
                },
                # How many times each limit has actually been changed.
                "cycles": {
                    name: cycles.get((
                        safe_int(row["IdOrganization"]),
                        safe_int(row["IdLeague"]),
                        safe_int(row["IdSportType"]),
                        safe_int(row.get("PeriodNumber", 0)),
                        name,
                        "normal",
                    ), (0, None))[0]
                    for name in allowed_limit_fields
                },
                "earlyCycles": {
                    name: cycles.get((
                        safe_int(row["IdOrganization"]),
                        safe_int(row["IdLeague"]),
                        safe_int(row["IdSportType"]),
                        safe_int(row.get("PeriodNumber", 0)),
                        name,
                        "early",
                    ), (0, None))[0]
                    for name in allowed_limit_fields
                },
                "spread": display_limit_value(row, "Spread"),
                "moneyLine": display_limit_value(row, "MoneyLine"),
                "total": display_limit_value(row, "Total"),
                "teamTotal": display_limit_value(row, "TeamTotal"),
                "earlySpread": display_early_limit_value(row, "Spread.EarlyLimit"),
                "earlyMoneyLine": display_early_limit_value(row, "MoneyLine.EarlyLimit"),
                "earlyTotal": display_early_limit_value(row, "Total.EarlyLimit"),
                "earlyTeamTotal": display_early_limit_value(row, "TeamTotal.EarlyLimit"),
                "hasAgentOverrides": any(
                    row.get(f"{key}.HasAgentOverrides") is True
                    for key in ("Spread", "MoneyLine", "Total", "TeamTotal")
                ),
            }
        )
    return rows


def load_period_rows(account_id, organization_id, league_id, force=False):
    cache_key = (account_id, organization_id, league_id)

    if not force:
        with data_lock:
            cached_rows = period_cache.get(cache_key)
            if cached_rows is not None:
                return list(cached_rows)

    response = api_request(
        "GET",
        f"{partner_api}/Backbone/GetOrganizationPeriods/"
        f"{account_id}/{organization_id}/S",
        timeout=30,
    )
    response.raise_for_status()
    data = response.json()
    if data.get("Errors"):
        raise RuntimeError(", ".join(data["Errors"]))

    rows = []
    for value in data.get("Payload") or []:
        row = flatten_values(value)
        rows.append(
            {
                "IdLeague": league_id,
                "IdOrganization": value.get("Id", organization_id),
                "IdSportType": value.get("IdSportType", 0),
                "IdParent": value.get("IdParent", 0),
                "PeriodNumber": value.get("PeriodNumber", 0),
                "LeagueName": value.get("PeriodDescription") or "Period",
                "OrganizationLabel": value.get("OrganizationLabelParent", ""),
                "OrganizationLabelParent": value.get(
                    "OrganizationLabelParent", ""
                ),
                "PeriodDescription": value.get("PeriodDescription", ""),
                "RowType": "Period",
                "JsonPath": f"Periods[{value.get('PeriodNumber', 0)}]",
                **row,
            }
        )

    with data_lock:
        period_cache[cache_key] = list(rows)

    return rows


def period_dashboard_rows(
    account_id,
    organization_id,
    league_id,
    force=False,
):
    return [
        {
            "accountId": account_id,
            "idLeague": row["IdLeague"],
            "idOrganization": row["IdOrganization"],
            "idSportType": row["IdSportType"],
            "idParent": row["IdParent"],
            "periodNumber": row["PeriodNumber"],
            "leagueName": row["LeagueName"],
            "organizationLabel": row["OrganizationLabel"],
            "periodDescription": row["PeriodDescription"],
            "rowType": "Period",
            "level": 2,
            "hasPeriods": False,
            "editable": True,
            "editableFields": ["spread", "moneyLine", "total", "teamTotal"],
            "disabledReason": "",
            "supportsEarlyLimit": any(
                row.get(f"{field}.EarlyLimit.Amount") not in (None, "")
                or row.get(f"{field}.EarlyLimit.AmountMax") not in (None, "")
                for field in ("Spread", "MoneyLine", "Total", "TeamTotal")
            ),
            "spread": display_limit_value(row, "Spread"),
            "moneyLine": display_limit_value(row, "MoneyLine"),
            "total": display_limit_value(row, "Total"),
            "teamTotal": display_limit_value(row, "TeamTotal"),
            "earlySpread": display_early_limit_value(row, "Spread.EarlyLimit"),
            "earlyMoneyLine": display_early_limit_value(row, "MoneyLine.EarlyLimit"),
            "earlyTotal": display_early_limit_value(row, "Total.EarlyLimit"),
            "earlyTeamTotal": display_early_limit_value(row, "TeamTotal.EarlyLimit"),
        }
        for row in load_period_rows(
            account_id,
            organization_id,
            league_id,
            force=force,
        )
    ]


def safe_int(val, default=0):
    if val is None or val == "":
        return default
    try:
        return int(val)
    except (ValueError, TypeError):
        try:
            return int(float(val))
        except (ValueError, TypeError):
            return default


def find_limit_row(
    account_id, organization_id, league_id, sport_type_id, period_number=0
):
    organization_id = safe_int(organization_id)
    league_id = safe_int(league_id)
    sport_type_id = safe_int(sport_type_id)
    period_number = safe_int(period_number)

    if period_number:
        period_rows = load_period_rows(account_id, organization_id, league_id)
        match = next(
            (
                row
                for row in period_rows
                if safe_int(row.get("PeriodNumber")) == period_number
                and (not sport_type_id or safe_int(row.get("IdSportType")) == sport_type_id)
            ),
            None,
        )
        if match is None and period_rows:
            match = next(
                (row for row in period_rows if safe_int(row.get("PeriodNumber")) == period_number),
                None,
            )
        return match

    leagues = get_leagues(account_id)
    match = next(
        (
            row
            for row in leagues
            if safe_int(row.get("IdOrganization")) == organization_id
            and safe_int(row.get("IdLeague")) == league_id
            and (not sport_type_id or safe_int(row.get("IdSportType")) == sport_type_id)
        ),
        None,
    )
    if match is None and leagues:
        match = next(
            (
                row
                for row in leagues
                if safe_int(row.get("IdOrganization")) == organization_id
                and safe_int(row.get("IdLeague")) == league_id
            ),
            None,
        )
    return match

# While testing, limits may only be written on named accounts. Empty means no
# restriction, which is normal operation; a populated list is a hard stop that
# every write passes through, whoever asked for it - a person on the dashboard,
# a schedule, or a tracker.
write_allowed_accounts = {
    int(part)
    for part in os.getenv("WRITE_ALLOWED_ACCOUNTS", "").replace(" ", "").split(",")
    if part.strip().lstrip("-").isdigit()
}


def write_allowed(account_id):
    if not write_allowed_accounts:
        return True
    try:
        return int(account_id) in write_allowed_accounts
    except (TypeError, ValueError):
        return False


def save_single_limit(
    account_id,
    organization_id,
    league_id,
    sport_type_id,
    period_number,
    field,
    new_value,
    api_field,
    return_full=False,
    change_type="Immediate limit",
    telegram_audience="all",
    skip_blue=True,
    customer_support_agent=None,
):
    """Helper function to save a single limit change"""
    # Checked before anything is read or written, so a blocked account cannot
    # even spend a request against AccessHigh.
    if not write_allowed(account_id):
        note = (
            f"Blocked: limit changes are restricted to the test accounts, "
            f"and {account_id} is not one of them"
        )
        logger.warning("Refused a limit write on account %s", account_id)
        if return_full:
            return {
                "message": note,
                "value": new_value,
                "rows": dashboard_rows(account_id),
                "changed": False,
                "note": note,
            }
        return {"success": False, "value": new_value, "changed": False, "note": note}

    previous_value = None
    matching_row = find_limit_row(
        account_id, organization_id, league_id, sport_type_id, period_number
    )
    
    if matching_row:
        org_id = safe_int(matching_row.get("IdOrganization"), organization_id)
        sport_id = safe_int(matching_row.get("IdSportType"), sport_type_id)
        is_exotic = ".Exotics[" in matching_row.get("JsonPath", "")
        if is_exotic:
            raise ValueError("Props/Exotics are pending verification")
    else:
        org_id = safe_int(organization_id)
        sport_id = safe_int(sport_type_id)

    # Writing a value AccessHigh already holds spends a rate-limited request
    # for no change, and a needless write is also a needless chance to mark a
    # limit. Report the skip instead of performing it.
    if matching_row is not None:
        is_early = api_field.startswith("Early")

        # A blue limit carries a player-level override. Writing over it would
        # silently discard that override, so leave it alone unless the caller
        # has explicitly asked to.
        # A blue limit is never written, whoever set it. Black and orange are
        # fair game. Note this means a limit the bot itself turned blue is
        # skipped from then on, which is the intended behaviour.
        if (
            skip_blue
            and skip_blue_limits
            and limit_colour(matching_row, field, is_early) == "blue"
        ):
            note = "Skipped, limit is blue"
            logger.info(
                "Skipped %s for account %s: limit is blue",
                api_field,
                account_id,
            )
            if return_full:
                return {
                    "message": note,
                    "value": new_value,
                    "rows": dashboard_rows(account_id),
                    "changed": False,
                    "note": note,
                }
            return {
                "success": True,
                "value": new_value,
                "changed": False,
                "note": note,
            }

        current_value = stored_limit_value(
            matching_row, field, is_early
        )
        previous_value = current_value
        if current_value not in (None, "") and safe_int(current_value, -1) == new_value:
            note = f"No change needed, already {new_value:,}"
            logger.info(
                "Skipped %s for account %s: already %s",
                api_field,
                account_id,
                new_value,
            )
            if return_full:
                return {
                    "message": note,
                    "value": new_value,
                    "rows": dashboard_rows(account_id),
                    "changed": False,
                    "note": note,
                }
            return {
                "success": True,
                "value": new_value,
                "changed": False,
                "note": note,
            }

    change = {
        "IdOrganization": org_id,
        "IdSportType": sport_id,
        "Spread": None,
        "YesNoSpread": None,
        "MoneyLine": None,
        "YesNoMoneyLine": None,
        "Total": None,
        "YesNoTotal": None,
        "TeamTotal": None,
        "YesNoTeamTotal": None,
        "EarlySpread": None,
        "EarlyMoneyLine": None,
        "EarlyTotal": None,
        "EarlyTeamTotal": None,
        "TeamTotalPeriod": None,
        "DetailPeriod": period_number or None,
    }
    change[api_field] = new_value

    payload = {
        "IdCustomer": str(account_id),
        "AllPeriods": False,
        "AllHierarchy": False,
        "RemoveBlue": False,
        "RemoveBlueSpecific": False,
        "UpdateDetails": False,
        "AllPlayers": False,
        "BBWagerType": ["S"],
        "Changes": [change],
        "AgentsFilterList": [-1],
        "IdLeague": 0,
    }

    # Saving several fields on one row fires several of these back to back,
    # which is exactly the pattern AccessHigh rate limits. A throttled save
    # waits and retries rather than dropping the operator's change.
    for attempt in range(rate_limit_retry_limit):
        save_response = api_request(
            "POST",
            f"{partner_api}/Backbone/save/",
            json=payload,
            timeout=30,
        )
        if save_response.status_code != 429:
            break
        if attempt == rate_limit_retry_limit - 1:
            logger.warning(
                "AccessHigh kept rate limiting the save of %s for account %s",
                api_field,
                account_id,
            )
            break
        time.sleep(rate_limit_retry_delay(save_response, attempt))
    save_response.raise_for_status()
    save_data = save_response.json()

    if save_data.get("Errors"):
        raise RuntimeError(", ".join(save_data["Errors"]))

    # Update caches for period rows if needed, but avoid full refresh to preserve updated values
    try:
        if period_number:
            load_period_rows(account_id, org_id, league_id, force=True)
        else:
            # Intentionally skip full refresh to keep the locally updated row.
            pass
    except Exception as e:
        logger.warning("Cache update after limit save failed: %s", e)

    # Patch the cached row immediately so dashboard_rows reflects the new value
    # without waiting for API propagation. Always update both Amount and AmountMax
    # because display_limit_value prefers AmountMax over Amount.
    updated_row = find_limit_row(
        account_id, org_id, league_id, sport_id, period_number
    )
    if updated_row:
        updated_row[f"{api_field}.Amount"] = new_value
        updated_row[f"{api_field}.AmountMax"] = new_value

    # The write succeeded, so this counts as a cycle. Skips never reach here.
    record_limit_change(
        account_id,
        org_id,
        league_id,
        sport_id,
        period_number,
        field,
        "early" if api_field.startswith("Early") else "normal",
        previous_value,
        new_value,
        customer_support_agent=customer_support_agent,
    )

    source_type, _ = current_change_source.get() or (None, None)
    # A scheduled run is announced once by the worker, which is the only place
    # that knows the whole outcome: a summary row updates its children through
    # calls that never reach here, and a run that changed nothing returns
    # before this point. Announcing here too would both duplicate and mislead.
    if return_full and source_type != "schedule":
        telegram_message = build_limit_success_message(
            account_id,
            organization_id,
            league_id,
            sport_type_id,
            period_number,
            field,
            new_value,
            change_type=change_type,
            customer_support_agent=customer_support_agent,
        )
        send_telegram_success_message(
            telegram_message,
            audience=telegram_audience,
        )

    if return_full:
        return {
            "message": "Limit updated successfully",
            "value": new_value,
            "rows": dashboard_rows(account_id),
            "changed": True,
            "note": None,
        }
    return {"success": True, "value": new_value, "changed": True, "note": None}

def save_limit_change(request_data):
    field = request_data.get("field")
    if field not in allowed_limit_fields:
        raise ValueError("Unsupported limit field")
    limit_mode = str(request_data.get("limitMode", "normal")).strip().lower()
    if limit_mode not in limit_mode_prefixes:
        raise ValueError("Unsupported limit mode")
    telegram_audience = normalize_telegram_audience(
        request_data.get("telegramAudience", "all")
    )
    customer_support_agent = str(
        request_data.get("customerSupportAgent", "")
    ).strip()
    source_type, _ = current_change_source.get() or ("manual", None)
    if source_type not in {"schedule", "tracker"}:
        if not customer_support_agent:
            raise ValueError("Enter the Customer Support Agent name")
        if len(customer_support_agent) > 100:
            raise ValueError(
                "Customer Support Agent name must be 100 characters or fewer"
            )

    try:
        account_id = validate_account_id(safe_int(request_data["accountId"]))
        organization_id = safe_int(request_data["idOrganization"])
        league_id = safe_int(request_data["idLeague"])
        sport_type_id = safe_int(request_data["idSportType"])
        period_number = safe_int(request_data.get("periodNumber", 0))
        new_value = safe_int(request_data["value"])
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("IDs and limit value must be whole numbers") from error

    if new_value < 0 or new_value > 1_000_000_000:
        raise ValueError("Limit must be between 0 and 1,000,000,000")

    # Get all dashboard rows to check if this is a Summary (parent row)
    all_rows = dashboard_rows(account_id, force=False)

    # Check if the requested row is a Summary
    is_summary = False
    for row in all_rows:
        if (safe_int(row.get("idOrganization")) == organization_id and
            safe_int(row.get("periodNumber", 0)) == period_number and
            row.get("rowType") == "Summary"):
            if safe_int(row.get("idLeague")) == league_id or league_id == 0:
                is_summary = True
                break

    if is_summary:
        # Parent row: update all child leagues under this organization
        child_rows = []
        for row in all_rows:
            if row.get("rowType") == "Summary":
                continue
            if safe_int(row.get("idOrganization")) == organization_id:
                raw_row = find_limit_row(
                    account_id,
                    safe_int(row.get("idOrganization")),
                    safe_int(row.get("idLeague")),
                    safe_int(row.get("idSportType")),
                    safe_int(row.get("periodNumber", 0))
                )
                if raw_row and ".Exotics[" not in raw_row.get("JsonPath", ""):
                    child_rows.append(row)

        if not child_rows:
            api_field = f"{limit_mode_prefixes[limit_mode]}{allowed_limit_fields[field]}"
            return save_single_limit(
                account_id,
                organization_id,
                league_id,
                sport_type_id,
                period_number,
                field,
                new_value,
                api_field,
                change_type="Early limit" if limit_mode == "early" else "Immediate limit",
                return_full=True,
                telegram_audience=telegram_audience,
                customer_support_agent=customer_support_agent,
            )

        successful_updates = []
        skipped_updates = []
        failed_updates = []

        for child in child_rows:
            try:
                api_field = f"{limit_mode_prefixes[limit_mode]}{allowed_limit_fields[field]}"
                child_outcome = save_single_limit(
                    account_id,
                    safe_int(child["idOrganization"]),
                    safe_int(child["idLeague"]),
                    safe_int(child["idSportType"]),
                    safe_int(child.get("periodNumber", 0)),
                    field,
                    new_value,
                    api_field,
                    change_type="Early limit" if limit_mode == "early" else "Immediate limit",
                    telegram_audience=telegram_audience,
                    customer_support_agent=customer_support_agent,
                )
                target = (
                    skipped_updates
                    if isinstance(child_outcome, dict)
                    and child_outcome.get("changed") is False
                    else successful_updates
                )
                target.append({
                    "league": child.get("leagueName", "League"),
                    "id": child.get("idLeague")
                })
            except PermissionError:
                # Let the schedule worker renew authentication and retry the
                # complete parent update instead of recording every child as
                # an ordinary validation failure.
                raise
            except Exception as e:
                failed_updates.append({
                    "league": child.get("leagueName", "League"),
                    "id": child.get("idLeague"),
                    "error": str(e)
                })

        # A parent whose children were all already correct has not failed.
        if not successful_updates and not skipped_updates:
            first_error = failed_updates[0]['error'] if failed_updates else 'unknown error'
            raise ValueError(f"Failed to update child leagues: {first_error}")

        # Refresh cache only for period updates; avoid full refresh to preserve updated values
        try:
            if period_number:
                refresh_leagues(account_id)
            else:
                pass
        except Exception as e:
            logger.exception("Failed to refresh leagues after parent update: %s", e)

        parent_message = f"Updated {len(successful_updates)} leagues under parent limit"
        if skipped_updates:
            parent_message += (
                f", {len(skipped_updates)} already at {new_value:,}"
            )
        return {
            "message": parent_message,
            "value": new_value,
            "rows": dashboard_rows(account_id),
            "successful": successful_updates,
            "skipped": skipped_updates or None,
            "failed": failed_updates if failed_updates else None,
            "changed": bool(successful_updates),
            "note": (
                None
                if successful_updates
                else f"No change needed, {len(skipped_updates)} leagues already at {new_value:,}"
            ),
        }
    else:
        # Regular single league / child update
        try:
            api_field = f"{limit_mode_prefixes[limit_mode]}{allowed_limit_fields[field]}"
            return save_single_limit(
                account_id,
                organization_id,
                league_id,
                sport_type_id,
                period_number,
                field,
                new_value,
                api_field,
                change_type="Early limit" if limit_mode == "early" else "Immediate limit",
                return_full=True,
                telegram_audience=telegram_audience,
                customer_support_agent=customer_support_agent,
            )
        except RuntimeError as e:
            logger.exception("RuntimeError during limit save")
            raise ValueError(str(e)) from e


def normalize_hierarchy_changes(request_data):
    """Validate a batch for one native all-hierarchy save."""
    raw_changes = request_data.get("changes")
    if not isinstance(raw_changes, list) or not raw_changes:
        raise ValueError("Choose at least one limit to update")
    if len(raw_changes) > len(allowed_limit_fields):
        raise ValueError("Too many limits in one update")

    customer_support_agent = str(
        request_data.get("customerSupportAgent", "")
    ).strip()
    if not customer_support_agent:
        raise ValueError("Enter the Customer Support Agent name")
    if len(customer_support_agent) > 100:
        raise ValueError(
            "Customer Support Agent name must be 100 characters or fewer"
        )

    normalized = []
    row_identity = None
    seen_fields = set()
    for raw in raw_changes:
        if not isinstance(raw, dict):
            raise ValueError("Invalid limit change")
        field = raw.get("field")
        if field not in allowed_limit_fields or field in seen_fields:
            raise ValueError("Unsupported or duplicate limit field")
        limit_mode = str(raw.get("limitMode", "normal")).strip().lower()
        if limit_mode not in limit_mode_prefixes:
            raise ValueError("Unsupported limit mode")
        try:
            account_id = validate_account_id(safe_int(raw["accountId"]))
            organization_id = safe_int(raw["idOrganization"])
            league_id = safe_int(raw["idLeague"])
            sport_type_id = safe_int(raw["idSportType"])
            period_number = safe_int(raw.get("periodNumber", 0))
            new_value = safe_int(raw["value"])
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError("IDs and limit value must be whole numbers") from error
        if new_value < 0 or new_value > 1_000_000_000:
            raise ValueError("Limit must be between 0 and 1,000,000,000")

        identity = (
            account_id,
            organization_id,
            league_id,
            sport_type_id,
            period_number,
            limit_mode,
        )
        if row_identity is None:
            row_identity = identity
        elif identity != row_identity:
            raise ValueError("All-agent updates must belong to the same league row")

        matching_row = find_limit_row(
            account_id,
            organization_id,
            league_id,
            sport_type_id,
            period_number,
        )
        if matching_row is None:
            raise ValueError("The selected league row is no longer available")
        if ".Exotics[" in matching_row.get("JsonPath", ""):
            raise ValueError("Props/Exotics are pending verification")

        api_field = (
            f"{limit_mode_prefixes[limit_mode]}{allowed_limit_fields[field]}"
        )
        old_value = stored_limit_value(
            matching_row, field, api_field.startswith("Early")
        )
        normalized.append({
            "accountId": account_id,
            "idOrganization": safe_int(
                matching_row.get("IdOrganization"), organization_id
            ),
            "idLeague": league_id,
            "idSportType": safe_int(
                matching_row.get("IdSportType"), sport_type_id
            ),
            "periodNumber": period_number,
            "field": field,
            "apiField": api_field,
            "limitMode": limit_mode,
            "oldValue": old_value,
            "value": new_value,
        })
        seen_fields.add(field)

    return normalized, customer_support_agent


def hierarchy_agent_ids():
    auth = auth_context()
    ids = [safe_int(auth["id"])]
    ids.extend(safe_int(agent.get("id")) for agent in load_agents())
    return sorted({agent_id for agent_id in ids if agent_id > 0})


def hierarchy_payload(changes, agent_ids, include_changes):
    auth = auth_context()
    first = changes[0]
    api_change = {
        "IdOrganization": first["idOrganization"],
        "IdSportType": first["idSportType"],
        "Spread": None,
        "YesNoSpread": None,
        "MoneyLine": None,
        "YesNoMoneyLine": None,
        "Total": None,
        "YesNoTotal": None,
        "TeamTotal": None,
        "YesNoTeamTotal": None,
        "EarlySpread": None,
        "EarlyMoneyLine": None,
        "EarlyTotal": None,
        "EarlyTeamTotal": None,
        "TeamTotalPeriod": None,
        "DetailPeriod": first["periodNumber"] or None,
    }
    for change in changes:
        api_change[change["apiField"]] = change["value"]
    return {
        "IdCustomer": str(auth["id"]),
        "AllPeriods": False,
        # The native UI previews the explicitly selected agent list, then
        # enables hierarchy propagation only for the confirmed save.
        "AllHierarchy": bool(include_changes),
        "RemoveBlue": False,
        "RemoveBlueSpecific": False,
        "UpdateDetails": False,
        "AllPlayers": False,
        "BBWagerType": ["S"],
        "Changes": [api_change] if include_changes else None,
        "AgentsFilterList": agent_ids,
        "IdLeague": 0,
    }


def preview_hierarchy_limit_changes(request_data):
    changes, customer_support_agent = normalize_hierarchy_changes(request_data)
    agent_ids = hierarchy_agent_ids()
    if not agent_ids:
        raise ValueError("No agents are available for this account")
    if write_allowed_accounts and any(
        not write_allowed(agent_id) for agent_id in agent_ids
    ):
        raise ValueError("The all-agent update includes a restricted account")

    response = api_request(
        "POST",
        f"{partner_api}/Backbone/CheckAffectedAccounts/",
        json=hierarchy_payload(changes, agent_ids, include_changes=False),
        timeout=30,
    )
    response.raise_for_status()
    data = response.json()
    if data.get("Errors"):
        raise RuntimeError(", ".join(data["Errors"]))
    payload = data.get("Payload") or {}
    affected_agents = safe_int(payload.get("TotalAgents"), len(agent_ids))
    affected_customers = safe_int(payload.get("TotalCustomers"), 0)

    auth = auth_context()
    confirmation_token = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    with hierarchy_confirmations_lock:
        expired = [
            token for token, item in hierarchy_confirmations.items()
            if item["expiresAt"] <= now
        ]
        for token in expired:
            hierarchy_confirmations.pop(token, None)
        hierarchy_confirmations[confirmation_token] = {
            "sessionHash": auth.get("sessionHash"),
            "userId": auth.get("userId"),
            "changes": changes,
            "customerSupportAgent": customer_support_agent,
            "agentIds": agent_ids,
            "affectedAgents": affected_agents,
            "affectedCustomers": affected_customers,
            "expiresAt": now + hierarchy_confirmation_ttl,
        }
    return {
        "confirmationToken": confirmation_token,
        "affectedAgents": affected_agents,
        "affectedCustomers": affected_customers,
        "playersIncluded": False,
        "expiresInSeconds": int(hierarchy_confirmation_ttl.total_seconds()),
    }


def save_hierarchy_limit_changes(request_data):
    confirmation_token = str(request_data.get("confirmationToken", "")).strip()
    if not confirmation_token:
        raise ValueError("Preview the affected accounts before saving")
    auth = auth_context()
    with hierarchy_confirmations_lock:
        pending = hierarchy_confirmations.pop(confirmation_token, None)
    if (
        pending is None
        or pending["expiresAt"] <= datetime.now(timezone.utc)
        or pending["sessionHash"] != auth.get("sessionHash")
        or pending["userId"] != auth.get("userId")
    ):
        raise ValueError("The all-agent confirmation expired. Preview it again")

    changes = pending["changes"]
    agent_ids = pending["agentIds"]
    response = api_request(
        "POST",
        f"{partner_api}/Backbone/save/",
        json=hierarchy_payload(changes, agent_ids, include_changes=True),
        timeout=30,
    )
    response.raise_for_status()
    data = response.json()
    if data.get("Errors"):
        raise RuntimeError(", ".join(data["Errors"]))

    with data_lock:
        for agent_id in agent_ids:
            league_cache.pop(agent_id, None)
        for cache_key in list(period_cache):
            if cache_key[0] in agent_ids:
                period_cache.pop(cache_key, None)

    changed_at = utc_now_naive()
    for change in changes:
        record_limit_change(
            change["accountId"],
            change["idOrganization"],
            change["idLeague"],
            change["idSportType"],
            change["periodNumber"],
            change["field"],
            change["limitMode"],
            change["oldValue"],
            change["value"],
            customer_support_agent=pending["customerSupportAgent"],
            target_scope="all_agents",
            affected_agents=pending["affectedAgents"],
            affected_customers=pending["affectedCustomers"],
            changed_at=changed_at,
        )

    fields = ", ".join(
        limit_field_labels.get(change["field"], change["field"])
        for change in changes
    )
    send_telegram_success_message(
        f"All-agent immediate limit update\n"
        f"Fields: {fields}\n"
        f"Agents affected: {pending['affectedAgents']:,}\n"
        f"Customers affected: {pending['affectedCustomers']:,}\n"
        f"Customer Support Agent: {pending['customerSupportAgent']}"
    )
    return {
        "message": "Limits updated for all agents",
        "changed": True,
        "affectedAgents": pending["affectedAgents"],
        "affectedCustomers": pending["affectedCustomers"],
        "playersIncluded": False,
    }



def telegram_recipient_rows():
    """Everyone this site alerts, whoever added them.

    Scoped per login originally, which meant two people running the same book
    from the same deployment each saw half the list - and, worse, each only
    alerted their own half. The database is already per site, so the site is
    the right scope.
    """
    with database_session() as db:
        rows = db.execute(
            text(
                "SELECT id, name, chat_id, is_aceshigh, is_betwar, created_at "
                "FROM telegram_recipients "
                "ORDER BY created_at DESC, name ASC"
            )
        ).mappings().all()

    return [
        {
            "id": str(row["id"]),
            "name": row["name"],
            "chatId": row["chat_id"],
            "isAcesHigh": bool(row["is_aceshigh"]),
            "isBetWar": bool(row["is_betwar"]),
            "createdAt": (
                row["created_at"].replace(tzinfo=timezone.utc).isoformat()
                if row["created_at"]
                else None
            ),
        }
        for row in rows
    ]


def add_telegram_recipient(request_data):
    auth = auth_context()
    name = str(request_data.get("name", "")).strip()
    chat_id = str(request_data.get("chatId", "")).strip()
    if partner_host == "betwar.ag":
        is_aceshigh, is_betwar = False, True
    else:
        is_aceshigh = bool(request_data.get("isAcesHigh"))
        is_betwar = bool(request_data.get("isBetWar"))

    if not name:
        raise ValueError("Enter a name for this Telegram recipient")
    if len(name) > 100:
        raise ValueError("Telegram recipient name must be 100 characters or fewer")
    if not chat_id:
        raise ValueError("Enter a Telegram Chat ID")
    if len(chat_id) > 64 or not chat_id.lstrip("-").isdigit():
        raise ValueError("Telegram Chat ID must be a valid numeric chat ID")
    if not (is_aceshigh or is_betwar):
        raise ValueError("Select at least one membership")

    with database_session() as db:
        existing = db.execute(
            text(
                "SELECT name FROM telegram_recipients WHERE chat_id = :chat_id"
            ),
            {"chat_id": chat_id},
        ).scalar()
    if existing:
        raise ValueError(
            f"That Telegram Chat ID is already saved as {existing}"
        )

    recipient_id = uuid.uuid4().hex
    try:
        with database_session() as db:
            db.execute(
                text(
                    "INSERT INTO telegram_recipients "
                    "(id, user_id, name, chat_id, is_aceshigh, is_betwar, created_at) "
                    "VALUES (:id, :user_id, :name, :chat_id, :is_aceshigh, :is_betwar, :created_at)"
                ),
                {
                    "id": recipient_id,
                    "user_id": auth["userId"],
                    "name": name,
                    "chat_id": chat_id,
                    "is_aceshigh": is_aceshigh,
                    "is_betwar": is_betwar,
                    "created_at": utc_now_naive(),
                },
            )
            db.commit()
    except Exception as error:
        if "duplicate" in str(error).casefold():
            raise ValueError("That Telegram Chat ID is already saved") from error
        raise

    return {
        "message": "Telegram recipient added",
        "recipient": {
            "id": recipient_id,
            "name": name,
            "chatId": chat_id,
            "isAcesHigh": is_aceshigh,
            "isBetWar": is_betwar,
        },
    }


def edit_telegram_recipient(request_data):
    auth = auth_context()
    recipient_id = str(request_data.get("id", "")).strip()
    name = str(request_data.get("name", "")).strip()
    chat_id = str(request_data.get("chatId", "")).strip()
    if partner_host == "betwar.ag":
        is_aceshigh, is_betwar = False, True
    else:
        is_aceshigh = bool(request_data.get("isAcesHigh"))
        is_betwar = bool(request_data.get("isBetWar"))

    if len(recipient_id) != 32:
        raise ValueError("Invalid Telegram recipient")
    if not name:
        raise ValueError("Enter a name for this Telegram recipient")
    if len(name) > 100:
        raise ValueError("Telegram recipient name must be 100 characters or fewer")
    if not chat_id:
        raise ValueError("Enter a Telegram Chat ID")
    if len(chat_id) > 64 or not chat_id.lstrip("-").isdigit():
        raise ValueError("Telegram Chat ID must be a valid numeric chat ID")
    if not (is_aceshigh or is_betwar):
        raise ValueError("Select at least one membership")

    try:
        with database_session() as db:
            updated = db.execute(
                text(
                    "UPDATE telegram_recipients "
                    "SET name = :name, chat_id = :chat_id, "
                    "is_aceshigh = :is_aceshigh, is_betwar = :is_betwar "
                    "WHERE id = :id"
                ),
                {
                    "id": recipient_id,
                    "user_id": auth["userId"],
                    "name": name,
                    "chat_id": chat_id,
                    "is_aceshigh": is_aceshigh,
                    "is_betwar": is_betwar,
                },
            ).rowcount
            db.commit()
    except Exception as error:
        if "duplicate" in str(error).casefold():
            raise ValueError("That Telegram Chat ID is already saved") from error
        raise

    if not updated:
        raise ValueError("Telegram recipient not found")

    return {
        "message": "Telegram recipient updated",
            "recipient": {
                "id": recipient_id,
                "name": name,
                "chatId": chat_id,
                "isAcesHigh": is_aceshigh,
                "isBetWar": is_betwar,
            },
        }


def delete_telegram_recipient(request_data):
    auth = auth_context()
    recipient_id = str(request_data.get("id", "")).strip()
    if len(recipient_id) != 32:
        raise ValueError("Invalid Telegram recipient")

    with database_session() as db:
        removed = db.execute(
            text(
                "DELETE FROM telegram_recipients "
                "WHERE id = :id"
            ),
            {"id": recipient_id},
        ).rowcount
        db.commit()

    if not removed:
        raise ValueError("Telegram recipient not found")

    return {"message": "Telegram recipient deleted", "id": recipient_id}


weekday_names = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")


def next_recurring_run(recurrence_days, recurrence_time, after=None):
    try:
        days = sorted({int(day) for day in recurrence_days})
        hour, minute = (int(part) for part in recurrence_time.split(":", 1))
    except (TypeError, ValueError) as error:
        raise ValueError("Select valid weekdays and an Eastern time") from error
    if not days or any(day < 0 or day > 6 for day in days):
        raise ValueError("Select at least one valid weekday")
    if hour < 0 or hour > 23 or minute < 0 or minute > 59:
        raise ValueError("Select a valid Eastern time")

    after = after or datetime.now(schedule_timezone)
    if after.tzinfo is None:
        after = after.replace(tzinfo=schedule_timezone)
    else:
        after = after.astimezone(schedule_timezone)
    for offset in range(8):
        candidate_date = (after + timedelta(days=offset)).date()
        if candidate_date.weekday() not in days:
            continue
        candidate = datetime(
            candidate_date.year,
            candidate_date.month,
            candidate_date.day,
            hour,
            minute,
            tzinfo=schedule_timezone,
        )
        if candidate > after:
            return candidate
    raise RuntimeError("Could not calculate the next recurring run")

def next_one_time_run(recurrence_time, after=None):
    try:
        hour, minute = (int(part) for part in recurrence_time.split(":", 1))
    except (TypeError, ValueError) as error:
        raise ValueError("Select a valid Eastern time") from error
    if hour < 0 or hour > 23 or minute < 0 or minute > 59:
        raise ValueError("Select a valid Eastern time")

    after = after or datetime.now(schedule_timezone)
    if after.tzinfo is None:
        after = after.replace(tzinfo=schedule_timezone)
    else:
        after = after.astimezone(schedule_timezone)

    candidate = datetime(
        after.year,
        after.month,
        after.day,
        hour,
        minute,
        tzinfo=schedule_timezone,
    )
    if candidate <= after:
        candidate += timedelta(days=1)
    return candidate


short_weekday_names = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


def recurring_day_text(recurrence_days):
    """Name a set of weekdays in as few words as it takes.

    Spelling every day out produced "Every Wednesday, Thursday, Friday,
    Saturday, Sunday", which wrapped to four lines in the schedules table and
    made one row three times taller than its neighbours.
    """
    days = sorted({int(day) for day in recurrence_days})
    if not days:
        return ""
    if days == [0, 1, 2, 3, 4, 5, 6]:
        return "Every day"
    if days == [0, 1, 2, 3, 4]:
        return "Weekdays"
    if days == [5, 6]:
        return "Weekends"
    # A run of consecutive days reads as a range. Only the plain Mon..Sun
    # order is collapsed; a set that wraps past Sunday stays a list.
    if len(days) > 2 and days == list(range(days[0], days[-1] + 1)):
        return f"{short_weekday_names[days[0]]}-{short_weekday_names[days[-1]]}"
    return ", ".join(short_weekday_names[day] for day in days)


def recurring_description(recurrence_days, recurrence_time):
    day_text = recurring_day_text(recurrence_days)
    display_time = datetime.strptime(recurrence_time, "%H:%M").strftime("%I:%M %p")
    return f"{day_text} at {display_time} ET"


def create_schedule(request_data):
    auth = auth_context()
    try:
        account_id = validate_account_id(int(request_data["accountId"]))
        organization_id = int(request_data["idOrganization"])
        league_id = int(request_data["idLeague"])
        sport_type_id = int(request_data["idSportType"])
        period_number = int(request_data.get("periodNumber", 0) or 0)
        value = int(request_data["value"])
        one_time_schedule = bool(request_data.get("oneTimeSchedule"))
        limit_mode = str(request_data.get("limitMode", "normal")).strip().lower()
        telegram_audience = normalize_telegram_audience(
            request_data.get("telegramAudience", "all")
        )
        recurrence_days = sorted({int(day) for day in request_data.get("recurrenceDays", [])})
        recurrence_time = str(request_data.get("recurrenceTime", ""))
        customer_support_agent = str(
            request_data.get("customerSupportAgent", "")
        ).strip()
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("Enter a valid limit, weekdays, and Eastern time") from error

    if not write_allowed(account_id):
        raise ValueError(
            f"Limit changes are restricted to the test accounts while testing, "
            f"so you cannot schedule one on account {account_id}"
        )

    matching_row = find_limit_row(
        account_id, organization_id, league_id, sport_type_id, period_number
    )
    if matching_row is None:
        raise ValueError("The selected league is not in the editable CSV")
    if ".Exotics[" in matching_row.get("JsonPath", ""):
        raise ValueError("Props/Exotics are pending verification")
    if request_data.get("field") not in {
        "spread",
        "moneyLine",
        "total",
        "teamTotal",
    }:
        raise ValueError("Unsupported limit field")
    if limit_mode not in limit_mode_prefixes:
        raise ValueError("Unsupported limit mode")
    is_game_setup = matching_row.get("PeriodTypes.GameSetup") is True
    if is_game_setup and request_data["field"] != "spread":
        raise ValueError("This league uses only the Spread limit")
    if value < 0 or value > 1_000_000_000:
        raise ValueError("Limit must be between 0 and 1,000,000,000")
    if not recurrence_time:
        raise ValueError("Select an Eastern time")
    if not customer_support_agent:
        raise ValueError("Enter the Customer Support Agent name")
    if len(customer_support_agent) > 100:
        raise ValueError("Customer Support Agent name must be 100 characters or fewer")

    if not recurrence_days:
        one_time_schedule = True
        scheduled_for = next_one_time_run(recurrence_time)
        stored_recurrence_days = None
        stored_recurrence_time = None
    else:
        scheduled_for = next_recurring_run(recurrence_days, recurrence_time)
        stored_recurrence_days = ",".join(str(day) for day in recurrence_days)
        stored_recurrence_time = recurrence_time

    job_id = uuid.uuid4().hex
    scheduled_utc = scheduled_for.astimezone(timezone.utc).replace(tzinfo=None)
    scheduled_for_utc = scheduled_for.astimezone(timezone.utc)
    with database_session() as db:
        db.add(
            ScheduledLimit(
                id=job_id,
                user_id=auth["userId"],
                login_session_id=auth["dbSessionId"],
                account_id=account_id,
                organization_id=organization_id,
                league_id=league_id,
                sport_type_id=sport_type_id,
                period_number=period_number,
                field=request_data["field"],
                value=value,
                scheduled_for=scheduled_utc,
                recurrence_days=stored_recurrence_days,
                recurrence_time=stored_recurrence_time,
                telegram_audience=telegram_audience,
                is_early_limit=limit_mode == "early",
                status="pending",
            )
        )
        db.flush()
        db.execute(
            text(
                "UPDATE scheduled_limits "
                "SET customer_support_agent = :customer_support_agent "
                "WHERE id = :job_id"
            ),
            {
                "customer_support_agent": customer_support_agent or None,
                "job_id": job_id,
            },
        )
        db.commit()

    return {
        "id": job_id,
        "message": "Limit change scheduled",
        "scheduledFor": eastern_timestamp(scheduled_for),
        "scheduledForUtc": scheduled_for_utc.isoformat(),
        "limitMode": limit_mode,
        "telegramAudience": telegram_audience,
        "customerSupportAgent": customer_support_agent,
        "recurrence": (
            recurring_description(recurrence_days, recurrence_time)
            if stored_recurrence_days
            else "Runs once"
        ),
    }


# A ramp is one recurring schedule per league, market and step, so the count
# grows quickly. This is a guard against a mis-click creating thousands, not a
# considered maximum.
ramp_schedule_limit = int(os.getenv("RAMP_SCHEDULE_LIMIT", "1200") or 1200)


limit_field_labels = {
    "spread": "Spread",
    "moneyLine": "Money line",
    "total": "Total",
    "teamTotal": "Team total",
}


# Which recorded distance-from-kick-off each ramp position is read from. The
# first step of a day is the quiet market, the last is the busy one.
ramp_curve_windows = {
    "start": (6.0, 1e9),
    "mid": (3.0, 6.0),
    "end": (0.0, 3.0),
}


def pinnacle_curve(league_slug=None):
    """Pinnacle's recorded limits by league, market and distance from start.

    This is the measured curve the ramp is built from. Only the shape carries
    over to a smaller book, so the caller scales it; what is returned here is
    Pinnacle's own numbers, unmodified.
    """
    rows = []
    with database_session() as db:
        query = select(
            PinnacleLimitSample.league,
            PinnacleLimitSample.period,
            PinnacleLimitSample.field,
            PinnacleLimitSample.hours_to_start,
            PinnacleLimitSample.limit_value,
        )
        if league_slug:
            query = query.where(PinnacleLimitSample.league == league_slug)
        rows = db.execute(query).all()

    buckets = {}
    for league, period, field, hours, value in rows:
        for name, (low, high) in ramp_curve_windows.items():
            if low <= float(hours) < high:
                buckets.setdefault((league, period, field), {}).setdefault(
                    name, []
                ).append(float(value))

    curve = {}
    for (league, period, field), by_window in buckets.items():
        entry = {}
        for name, values in by_window.items():
            values.sort()
            middle = len(values) // 2
            entry[name] = {
                "median": (
                    values[middle]
                    if len(values) % 2
                    else (values[middle - 1] + values[middle]) / 2
                ),
                "lowest": values[0],
                "samples": len(values),
            }
        curve[f"{league}|{period}|{field}"] = entry
    return {
        "windows": {
            name: {"fromHours": low, "toHours": None if high > 1e8 else high}
            for name, (low, high) in ramp_curve_windows.items()
        },
        "curve": curve,
    }


def league_slug_for_row(league_name):
    """The OddsPapi league a limit row belongs to, or None.

    LEAGUE_CONFIGS carries AccessHigh's own label for each league, so this is
    an exact match rather than a guess.
    """
    label = str(league_name or "").strip().casefold()
    if not label:
        return None
    for slug, config in LEAGUE_CONFIGS.items():
        if str(config.get("limitRow", "")).strip().casefold() == label:
            return slug
    return None


def pinnacle_ramp_value(curve, slug, period, field, window, scale_percent):
    """One step's limit, read from the recorded curve and scaled.

    Pinnacle's level reflects their volume, not a three-hundred-customer
    book's, so it is never used raw: the percentage is the operator's own risk
    appetite and the shape is all that is borrowed. Rounded to the nearest
    hundred so the result reads as a number somebody chose.
    """
    entry = (curve or {}).get(f"{slug}|{period}|{field}")
    if not entry:
        return None
    window_entry = entry.get(window)
    median = (window_entry or {}).get("median")
    if not median:
        return None
    value = float(median) * (float(scale_percent) / 100.0)
    if value <= 0:
        return None
    return max(100, int(round(value / 100.0)) * 100)


def tracker_history_rows(account_id, limit=60):
    """What the live tracker has actually written, most recent first.

    Read from the change log rather than kept separately: every write already
    records its old and new value and what caused it, so a tracker's history is
    a filter on that, not a second copy that could disagree with it.
    """
    auth = auth_context()
    selected_account_id = int(account_id)
    conditions = [
        LimitChange.user_id == auth["userId"],
        LimitChange.source == "tracker",
        LimitChange.account_id == selected_account_id,
    ]

    with database_session() as db:
        changes = db.execute(
            select(LimitChange)
            .where(*conditions)
            .order_by(LimitChange.changed_at.desc())
            .limit(max(1, min(int(limit), 200)))
        ).scalars().all()

        # The tracker rows carry the readable league and period names; the
        # change log only has ids.
        trackers = db.execute(
            select(LimitTracker).where(
                LimitTracker.user_id == auth["userId"],
                LimitTracker.account_id == selected_account_id,
            )
        ).scalars().all()

    named = {
        (t.organization_id, t.league_id, t.sport_type_id, t.period_number): (
            t.league_name, t.period_label, t.scale_percent
        )
        for t in trackers
    }

    rows = []
    for change in changes:
        key = (
            change.organization_id,
            change.league_id,
            change.sport_type_id,
            change.period_number,
        )
        league_name, period_label, scale = named.get(
            key, (f"League {change.league_id}", "", None)
        )
        rows.append({
            "at": (
                eastern_timestamp(change.changed_at.replace(tzinfo=timezone.utc))
                if change.changed_at else None
            ),
            "leagueName": league_name,
            "period": period_label,
            "field": change.field,
            "from": change.old_value,
            "to": change.new_value,
            "scalePercent": scale,
        })
    return rows


def limit_tracker_rows(account_id):
    """Every tracked limit for this account, with what the last cycle saw."""
    auth = auth_context()
    conditions = [
        LimitTracker.user_id == auth["userId"],
        LimitTracker.account_id == int(account_id),
    ]
    with database_session() as db:
        rows = db.execute(
            select(LimitTracker).where(*conditions).order_by(
                LimitTracker.league_name, LimitTracker.field
            )
        ).scalars().all()
        return [{
            "id": row.id,
            "accountId": row.account_id,
            "leagueName": row.league_name,
            "leagueSlug": row.league_slug,
            "period": row.period_label,
            "field": row.field,
            "scalePercent": row.scale_percent,
            "enabled": row.enabled,
            "pinnacle": row.last_pinnacle_value,
            "value": row.last_written_value,
            "note": row.last_note,
            "checkedAt": (
                eastern_timestamp(row.last_checked_at.replace(tzinfo=timezone.utc))
                if row.last_checked_at else None
            ),
            "writtenAt": (
                eastern_timestamp(row.last_written_at.replace(tzinfo=timezone.utc))
                if row.last_written_at else None
            ),
        } for row in rows]


def pinnacle_period_label(period_description):
    """The label Pinnacle samples are stored under, for an AccessHigh period.

    The two do not use the same words: AccessHigh calls the baseball period
    row "Innings" while Pinnacle records "1st 5 Innings". A tracker storing
    AccessHigh's wording would look up a key that does not exist and quietly
    never write, so the translation happens once, here.
    """
    text_value = str(period_description or "").strip()
    lowered = text_value.lower()
    if not lowered or lowered in {"full game", "game"}:
        return "Full Game"
    if "inning" in lowered:
        return "1st 5 Innings"
    if "2nd half" in lowered or "second half" in lowered:
        return "2nd Half"
    if "half" in lowered:
        return "1st Half"
    # Quarters and thirds are not among the periods the sampler records, so
    # they resolve to nothing and are reported rather than guessed at.
    return text_value


def create_limit_trackers(request_data):
    """Put a set of limits under live tracking.

    One tracker per league and market. There is no ramp to configure: the
    shape comes from Pinnacle, whose limit climbs as a fixture takes two-way
    money, and this follows it at whatever share the operator chose.
    """
    auth = auth_context()
    targets = request_data.get("targets") or []
    fields = [
        field for field in (request_data.get("fields") or [])
        if field in allowed_limit_fields
    ]
    if not targets:
        raise ValueError("Select at least one league")
    if not fields:
        raise ValueError("Select at least one limit type")

    try:
        account_id = validate_account_id(int(request_data["accountId"]))
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("Select an agent before tracking limits") from error
    if not write_allowed(account_id):
        raise ValueError(
            f"Limit changes are restricted to the test accounts while testing, "
            f"so you cannot track limits on account {account_id}"
        )

    try:
        scale_percent = int(request_data.get("scalePercent", 50) or 50)
    except (TypeError, ValueError) as error:
        raise ValueError("Enter a valid percentage") from error
    if not 1 <= scale_percent <= 200:
        raise ValueError("The percentage must be between 1 and 200")

    limit_mode = str(request_data.get("limitMode", "normal")).strip().lower()
    if limit_mode not in limit_mode_prefixes:
        raise ValueError("Unsupported limit mode")
    is_early_limit = limit_mode == "early"

    customer_support_agent = str(
        request_data.get("customerSupportAgent", "")
    ).strip()
    if not customer_support_agent:
        raise ValueError("Enter the Customer Support Agent name")

    created = 0
    replaced = 0
    skipped = []

    with database_session() as db:
        for target in targets:
            league_label = str(
                target.get("leagueName") or f"League {target.get('idLeague')}"
            )
            slug = league_slug_for_row(league_label)
            if not slug:
                skipped.append(
                    f"{league_label} is not a league Pinnacle data is kept for"
                )
                continue
            try:
                organization_id = int(target["idOrganization"])
                league_id = int(target["idLeague"])
                sport_type_id = int(target["idSportType"])
                period_number = int(target.get("periodNumber", 0) or 0)
            except (KeyError, TypeError, ValueError):
                skipped.append(f"{league_label} is missing its league ids")
                continue

            period_label = pinnacle_period_label(target.get("periodDescription"))
            if period_label not in {"Full Game", "1st Half", "2nd Half", "1st 5 Innings"}:
                skipped.append(
                    f"{league_label}: Pinnacle limits are not recorded for "
                    f"the {period_label} period"
                )
                continue

            allowed = target.get("editableFields")
            for field in fields:
                if isinstance(allowed, list) and allowed and field not in allowed:
                    skipped.append(
                        f"{league_label} does not use the "
                        f"{limit_field_labels.get(field, field)} limit"
                    )
                    continue
                # Tracking the same limit twice would have two cycles writing
                # different numbers to it, so a repeat replaces.
                replaced += db.execute(
                    delete(LimitTracker).where(
                        LimitTracker.user_id == auth["userId"],
                        LimitTracker.account_id == int(account_id),
                        LimitTracker.organization_id == organization_id,
                        LimitTracker.league_id == league_id,
                        LimitTracker.sport_type_id == sport_type_id,
                        LimitTracker.period_number == period_number,
                        LimitTracker.field == field,
                        LimitTracker.is_early_limit == is_early_limit,
                    )
                ).rowcount
                db.add(LimitTracker(
                    id=uuid.uuid4().hex,
                    user_id=auth["userId"],
                    account_id=int(account_id),
                    organization_id=organization_id,
                    league_id=league_id,
                    sport_type_id=sport_type_id,
                    period_number=period_number,
                    field=field,
                    is_early_limit=is_early_limit,
                    league_slug=slug,
                    period_label=pinnacle_period_label(
                        target.get("periodDescription")
                    ),
                    league_name=league_label,
                    scale_percent=scale_percent,
                    enabled=True,
                    customer_support_agent=customer_support_agent[:100],
                ))
                created += 1
        if not created:
            raise ValueError(
                skipped[0] if skipped else "No limits could be tracked"
            )
        db.commit()

    parts = [f"Tracking {created:,} limit{'' if created == 1 else 's'}"]
    if replaced:
        parts.append(f"replacing {replaced:,} already tracked")
    return {
        "message": ", ".join(parts),
        "created": created,
        "replaced": replaced,
        "skipped": sorted(set(skipped))[:20],
    }


def delete_limit_trackers(request_data):
    auth = auth_context()
    tracker_id = str(request_data.get("id", "")).strip()
    conditions = [LimitTracker.user_id == auth["userId"]]
    if tracker_id:
        conditions.append(LimitTracker.id == tracker_id)
    else:
        account_id = validate_account_id(safe_int(request_data["accountId"]))
        if int(account_id) != int(auth["id"]):
            conditions.append(LimitTracker.account_id == int(account_id))
    with database_session() as db:
        removed = db.execute(delete(LimitTracker).where(*conditions)).rowcount
        db.commit()
    return {
        "message": f"Stopped tracking {removed:,} limit{'' if removed == 1 else 's'}",
        "removed": removed,
    }


def create_schedule_ramp(request_data):
    """Create a whole limit ramp in one action.

    A ramp is the same limit rising through the day - low in the morning when
    a game has taken no money, higher near the start once it has. Each step is
    an ordinary recurring schedule; there is no new machinery here, only a way
    to create a few hundred of them without a few hundred clicks.

    Written as one transaction rather than a call to `create_schedule` per
    row. A three-step ramp over fifty leagues and four markets is six hundred
    schedules, and six hundred separate commits against RDS took long enough
    that the request could time out with the ramp half created.
    """
    auth = auth_context()

    steps = request_data.get("steps") or []
    targets = request_data.get("targets") or []
    fields = [
        field for field in (request_data.get("fields") or [])
        if field in allowed_limit_fields
    ]

    if not steps:
        raise ValueError("Add at least one time and limit to the ramp")
    if not targets:
        raise ValueError("Select at least one league")
    if not fields:
        raise ValueError("Select at least one limit type")

    try:
        account_id = validate_account_id(int(request_data["accountId"]))
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("Select an agent before building a ramp") from error
    if not write_allowed(account_id):
        raise ValueError(
            f"Limit changes are restricted to the test accounts while testing, "
            f"so you cannot build a ramp on account {account_id}"
        )

    limit_mode = str(request_data.get("limitMode", "normal")).strip().lower()
    if limit_mode not in limit_mode_prefixes:
        raise ValueError("Unsupported limit mode")
    is_early_limit = limit_mode == "early"

    telegram_audience = normalize_telegram_audience(
        request_data.get("telegramAudience", "all")
    )

    customer_support_agent = str(
        request_data.get("customerSupportAgent", "")
    ).strip()
    if not customer_support_agent:
        raise ValueError("Enter the Customer Support Agent name")
    if len(customer_support_agent) > 100:
        raise ValueError("Customer Support Agent name must be 100 characters or fewer")

    try:
        recurrence_days = sorted(
            {int(day) for day in request_data.get("recurrenceDays", [])}
        )
    except (TypeError, ValueError) as error:
        raise ValueError("Select valid weekdays") from error
    if any(day < 0 or day > 6 for day in recurrence_days):
        raise ValueError("Select valid weekdays")

    # A ramp can take its numbers from the recorded Pinnacle curve instead of
    # by hand. Each step then names a part of the day rather than an amount,
    # and every league and market gets its own value - Pinnacle takes 5,600 on
    # a baseball moneyline and 750 on a football one, so a single number
    # across leagues would be meaningless.
    try:
        scale_percent = int(request_data.get("pinnacleScalePercent", 0) or 0)
    except (TypeError, ValueError) as error:
        raise ValueError("Enter a valid Pinnacle percentage") from error
    from_pinnacle = scale_percent > 0
    if from_pinnacle and not 1 <= scale_percent <= 200:
        raise ValueError("The Pinnacle percentage must be between 1 and 200")

    cleaned_steps = []
    step_times = set()
    for step in steps:
        try:
            step_time = str(step["time"]).strip()
        except (KeyError, TypeError) as error:
            raise ValueError("Every ramp step needs a time") from error
        if from_pinnacle:
            step_value = str(step.get("window") or "").strip().lower()
            if step_value not in ramp_curve_windows:
                raise ValueError(
                    "Every ramp step needs a part of the day to read Pinnacle from"
                )
        else:
            try:
                step_value = int(step["value"])
            except (KeyError, TypeError, ValueError) as error:
                raise ValueError(
                    "Every ramp step needs a time and a limit"
                ) from error
        # Anchored to real clock times: the old pattern also accepted 24:00
        # through 29:59, which passed here and failed later per schedule.
        if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", step_time):
            raise ValueError(f"'{step_time}' is not a valid Eastern time")
        if not from_pinnacle and (
            step_value < 0 or step_value > 1_000_000_000
        ):
            raise ValueError("Every ramp limit must be between 0 and 1,000,000,000")
        # Two steps at one time are two schedules racing to write different
        # numbers to the same limit, and which one lands is undefined.
        if step_time in step_times:
            raise ValueError(
                f"Two steps are both set to {step_time}. Give each step its own time."
            )
        step_times.add(step_time)
        cleaned_steps.append((step_time, step_value))
    cleaned_steps.sort()

    total = len(targets) * len(fields) * len(cleaned_steps)
    if total > ramp_schedule_limit:
        raise ValueError(
            f"That ramp would create {total:,} schedules, above the "
            f"{ramp_schedule_limit:,} limit. Choose fewer leagues, markets or steps."
        )

    skipped = []
    planned = []
    plan_curve_keys = {}
    curve = pinnacle_curve().get("curve") if from_pinnacle else None

    for target in targets:
        league_label = str(
            target.get("leagueName") or f"League {target.get('idLeague')}"
        )
        try:
            organization_id = int(target["idOrganization"])
            league_id = int(target["idLeague"])
            sport_type_id = int(target["idSportType"])
            period_number = int(target.get("periodNumber", 0) or 0)
        except (KeyError, TypeError, ValueError):
            skipped.append(f"{league_label} is missing its league ids")
            continue

        # Looked up once per league rather than once per league, market and
        # step, which is the same answer for a fraction of the work.
        matching_row = find_limit_row(
            account_id, organization_id, league_id, sport_type_id, period_number
        )
        if matching_row is None:
            skipped.append(
                f"{league_label} is no longer in this agent's editable leagues"
            )
            continue
        if ".Exotics[" in matching_row.get("JsonPath", ""):
            skipped.append(f"{league_label}: props/exotics are pending verification")
            continue

        is_game_setup = matching_row.get("PeriodTypes.GameSetup") is True
        # A league that only carries a Spread limit rejects the others; that is
        # expected for those leagues, not a fault worth failing the ramp over.
        allowed = target.get("editableFields")
        for field in fields:
            if is_game_setup and field != "spread":
                skipped.append(f"{league_label} uses only the Spread limit")
                continue
            if isinstance(allowed, list) and allowed and field not in allowed:
                skipped.append(
                    f"{league_label} does not use the "
                    f"{limit_field_labels.get(field, field)} limit"
                )
                continue
            key = (organization_id, league_id, sport_type_id, period_number, field)
            if from_pinnacle:
                slug = league_slug_for_row(league_label)
                if not slug:
                    skipped.append(
                        f"{league_label} is not a league Pinnacle data is recorded for"
                    )
                    continue
                plan_curve_keys[key] = (
                    slug,
                    str(target.get("periodDescription") or "Full Game"),
                )
            planned.append(key)

    if not planned:
        raise ValueError(
            skipped[0] if skipped else "No schedules could be created"
        )

    # Every schedule at one step time runs at the same moment, so the next run
    # is worked out once per step instead of once per schedule. That also
    # stops a ramp created across a minute boundary landing on two dates.
    if recurrence_days:
        stored_recurrence_days = ",".join(str(day) for day in recurrence_days)
        step_runs = {
            step_time: next_recurring_run(recurrence_days, step_time)
            for step_time, _ in cleaned_steps
        }
    else:
        stored_recurrence_days = None
        step_runs = {
            step_time: next_one_time_run(step_time)
            for step_time, _ in cleaned_steps
        }

    # Re-running the builder to correct a time or a number used to leave the
    # first ramp in place, so both sets fired and the later write won by
    # accident. Replacing the pending recurring schedules this ramp covers
    # makes a second run a correction rather than a duplicate.
    replace_existing = (
        bool(stored_recurrence_days)
        and request_data.get("replaceExisting", True) is not False
    )

    created_ids = []
    replaced = 0

    with database_session() as db:
        if replace_existing:
            for (
                organization_id,
                league_id,
                sport_type_id,
                period_number,
                field,
            ) in set(planned):
                replaced += db.execute(
                    delete(ScheduledLimit).where(
                        ScheduledLimit.user_id == auth["userId"],
                        ScheduledLimit.account_id == int(account_id),
                        ScheduledLimit.organization_id == organization_id,
                        ScheduledLimit.league_id == league_id,
                        ScheduledLimit.sport_type_id == sport_type_id,
                        ScheduledLimit.period_number == period_number,
                        ScheduledLimit.field == field,
                        ScheduledLimit.is_early_limit == is_early_limit,
                        ScheduledLimit.status == "pending",
                        # A job the worker has already claimed is left alone,
                        # and a one-off scheduled by hand is not this ramp's
                        # to remove.
                        ScheduledLimit.recurrence_days.is_not(None),
                    )
                ).rowcount

        for (
            organization_id,
            league_id,
            sport_type_id,
            period_number,
            field,
        ) in planned:
            key = (
                organization_id,
                league_id,
                sport_type_id,
                period_number,
                field,
            )
            for step_time, step_value in cleaned_steps:
                if from_pinnacle:
                    slug, period_description = plan_curve_keys[key]
                    step_value = pinnacle_ramp_value(
                        curve,
                        slug,
                        period_description,
                        field,
                        step_value,
                        scale_percent,
                    )
                    if step_value is None:
                        # Nothing recorded for this market at this part of the
                        # day yet. Say so rather than inventing a limit.
                        skipped.append(
                            f"{slug.upper()} {limit_field_labels.get(field, field)}: "
                            f"no Pinnacle readings yet for the {step_time} step"
                        )
                        continue
                job_id = uuid.uuid4().hex
                db.add(
                    ScheduledLimit(
                        id=job_id,
                        user_id=auth["userId"],
                        login_session_id=auth["dbSessionId"],
                        account_id=account_id,
                        organization_id=organization_id,
                        league_id=league_id,
                        sport_type_id=sport_type_id,
                        period_number=period_number,
                        field=field,
                        value=step_value,
                        scheduled_for=step_runs[step_time]
                        .astimezone(timezone.utc)
                        .replace(tzinfo=None),
                        recurrence_days=stored_recurrence_days,
                        recurrence_time=step_time if stored_recurrence_days else None,
                        telegram_audience=telegram_audience,
                        is_early_limit=is_early_limit,
                        status="pending",
                    )
                )
                created_ids.append(job_id)

        db.flush()
        # customer_support_agent has no mapped attribute on ScheduledLimit, so
        # it is set the same way create_schedule sets it - in chunks here,
        # because a ramp can be a thousand ids.
        for start in range(0, len(created_ids), 500):
            db.execute(
                text(
                    "UPDATE scheduled_limits "
                    "SET customer_support_agent = :customer_support_agent "
                    "WHERE id IN :job_ids"
                ).bindparams(bindparam("job_ids", expanding=True)),
                {
                    "customer_support_agent": customer_support_agent,
                    "job_ids": created_ids[start:start + 500],
                },
            )
        db.commit()

    created = len(created_ids)
    logger.info(
        "Created ramp of %s schedules for account %s (user %s), replacing %s",
        created,
        account_id,
        auth["userId"],
        replaced,
    )

    parts = [f"Created {created:,} scheduled limit{'' if created == 1 else 's'}"]
    if replaced:
        parts.append(f"replacing {replaced:,} already scheduled")
    if skipped:
        parts.append(f"{len(skipped)} skipped")

    return {
        "message": ", ".join(parts),
        "created": created,
        "replaced": replaced,
        # Deduplicated: a league that does not use a market says so once, not
        # once per step.
        "skipped": sorted(set(skipped))[:20],
        "failed": [],
    }


def cancel_schedule(request_data):
    auth = auth_context()
    schedule_id = str(request_data.get("id", "")).strip()
    if len(schedule_id) != 32:
        raise ValueError("Invalid schedule")
    with database_session() as db:
        # Conditional update so a job the worker claims between our read and
        # write cannot be marked cancelled while it is actually executing.
        cancelled = db.execute(
            update(ScheduledLimit)
            .where(
                ScheduledLimit.id == schedule_id,
                ScheduledLimit.user_id == auth["userId"],
                ScheduledLimit.status.in_(("pending", "failed")),
            )
            .values(status="cancelled", error=None)
        ).rowcount
        db.commit()
        if not cancelled:
            schedule = db.scalar(
                select(ScheduledLimit).where(
                    ScheduledLimit.id == schedule_id,
                    ScheduledLimit.user_id == auth["userId"],
                )
            )
            if schedule is None:
                raise ValueError("Schedule not found")
            if schedule.status == "running":
                raise ValueError("This schedule is currently running")
            raise ValueError("This schedule is no longer active")
    return {"message": "Recurring schedule cancelled", "id": schedule_id}


def delete_schedule(request_data):
    """Permanently remove one schedule from Activity Logs."""
    auth = auth_context()
    schedule_id = str(request_data.get("id", "")).strip()
    if len(schedule_id) != 32:
        raise ValueError("Invalid schedule")

    account_id = validate_account_id(safe_int(request_data["accountId"]))

    with database_session() as db:
        removed = db.execute(
            delete(ScheduledLimit).where(
                ScheduledLimit.id == schedule_id,
                ScheduledLimit.user_id == auth["userId"],
                ScheduledLimit.account_id == int(account_id),
                ScheduledLimit.status != "running",
            )
        ).rowcount
        db.commit()

        if not removed:
            schedule = db.scalar(
                select(ScheduledLimit).where(
                    ScheduledLimit.id == schedule_id,
                    ScheduledLimit.user_id == auth["userId"],
                    ScheduledLimit.account_id == int(account_id),
                )
            )
            if schedule is None:
                raise ValueError("Schedule not found")
            if schedule.status == "running":
                raise ValueError(
                    "This schedule is currently running and cannot be deleted"
                )
            raise ValueError("Could not delete schedule")

    logger.info(
        "Deleted schedule %s for account %s (user %s)",
        schedule_id,
        account_id,
        auth["userId"],
    )
    return {"message": "Schedule deleted", "id": schedule_id}


def delete_all_schedules(request_data):
    """Remove the schedule history the operator is currently looking at.

    Scoped exactly like the Activity Log itself: the root account clears
    everything it scheduled, a selected sub-agent clears only that account.
    A job the worker has already claimed is left alone so a delete cannot
    race a write that is part-way to AccessHigh.
    """
    auth = auth_context()
    account_id = validate_account_id(safe_int(request_data["accountId"]))

    conditions = [ScheduledLimit.user_id == auth["userId"]]
    if int(account_id) != int(auth["id"]):
        conditions.append(ScheduledLimit.account_id == int(account_id))

    with database_session() as db:
        running = db.scalar(
            select(func.count())
            .select_from(ScheduledLimit)
            .where(*conditions, ScheduledLimit.status == "running")
        )
        removed = db.execute(
            delete(ScheduledLimit).where(
                *conditions, ScheduledLimit.status != "running"
            )
        ).rowcount
        db.commit()

    logger.info(
        "Deleted %s schedules for account %s (user %s)",
        removed,
        account_id,
        auth["userId"],
    )
    message = f"Deleted {removed} schedule{'' if removed == 1 else 's'}"
    if running:
        message += (
            f". {running} currently running "
            f"{'was' if running == 1 else 'were'} left in place"
        )
    return {"message": message, "deleted": removed, "running": running}


def claim_due_jobs():
    with database_session() as db:
        due_job_ids = list(
            db.scalars(
                select(ScheduledLimit.id).where(
                    ScheduledLimit.status == "pending",
                    ScheduledLimit.scheduled_for <= utc_now_naive(),
                )
            )
        )
        claimed_ids = []
        for job_id in due_job_ids:
            # Conditional claim: a job cancelled between the select and this
            # update stays cancelled and is never executed.
            claimed = db.execute(
                update(ScheduledLimit)
                .where(
                    ScheduledLimit.id == job_id,
                    ScheduledLimit.status == "pending",
                )
                .values(status="running")
            ).rowcount
            if claimed:
                claimed_ids.append(job_id)
        db.commit()
        return claimed_ids


def record_job_result(job_id, error, note=None):
    try:
        with database_session() as db:
            stored_job = db.get(ScheduledLimit, job_id)
            if stored_job is None:
                return
            run_at = utc_now_naive()
            stored_job.last_run_at = run_at
            stored_job.last_run_status = "failed" if error else "completed"
            stored_job.error = str(error) if error else None
            stored_job.run_note = None if error else note
            if not error:
                stored_job.completed_at = run_at
            if stored_job.recurrence_days and stored_job.recurrence_time:
                try:
                    days = [
                        int(day) for day in stored_job.recurrence_days.split(",")
                    ]
                    next_run = next_recurring_run(
                        days,
                        stored_job.recurrence_time,
                        datetime.now(schedule_timezone),
                    )
                    stored_job.scheduled_for = next_run.astimezone(
                        timezone.utc
                    ).replace(tzinfo=None)
                    stored_job.status = "pending"
                except Exception:
                    logger.exception("Could not compute next run for %s", job_id)
                    stored_job.status = "failed"
                    stored_job.error = (
                        f"{stored_job.error or 'Run failed'} "
                        "(could not compute next recurrence)"
                    )
            else:
                stored_job.status = "failed" if error else "completed"
            db.commit()
    except Exception:
        logger.exception("Could not record result for job %s", job_id)


def notify_schedule_outcome(job, request_data, outcome_line):
    """Announce a scheduled run, whatever it did.

    A schedule that changes nothing still ran, and the person who set it up
    wants to know that. Alerting only on a real change meant a recurring job
    that found its limit already correct - or skipped a blue one - went silent
    and looked broken.
    """
    try:
        message = build_limit_success_message(
            request_data["accountId"],
            request_data["idOrganization"],
            request_data["idLeague"],
            request_data["idSportType"],
            request_data["periodNumber"],
            request_data["field"],
            request_data["value"],
            change_type=(
                "Early limit" if request_data.get("limitMode") == "early"
                else "Immediate limit"
            ),
            outcome_line=outcome_line,
        )
        send_telegram_success_message(
            message,
            audience=job.telegram_audience or "all",
        )
    except Exception:
        # A notification must never turn a completed run into a failed one.
        logger.warning(
            "Could not send the Telegram alert for job %s", job.id, exc_info=True
        )


# When a ramp fires, every league and market for one account comes due in the
# same second. Each job refreshing separately meant hundreds of identical
# GetOrganizationAll calls in a burst, which is exactly how AccessHigh starts
# rate limiting. One refresh serves the whole burst.
league_refresh_times = {}
league_refresh_guard = threading.Lock()
league_refresh_window = int(os.getenv("LEAGUE_REFRESH_WINDOW", "60") or 60)


def refresh_leagues_if_stale(account_id, max_age_seconds=None):
    """Refresh this account's leagues unless another job just did.

    Values cannot meaningfully change in the seconds between two jobs of the
    same batch, so a short window keeps the decide-against-current-values
    guarantee while collapsing a burst into a single call.
    """
    window = (
        league_refresh_window if max_age_seconds is None else max_age_seconds
    )
    key = int(account_id)
    now = time.monotonic()
    with league_refresh_guard:
        last = league_refresh_times.get(key)
        if last is not None and now - last < window:
            return False
        # Claim the slot before the call so two threads cannot both refresh.
        league_refresh_times[key] = now
    try:
        refresh_leagues(account_id)
        return True
    except Exception:
        with league_refresh_guard:
            # A failed refresh must not suppress the next attempt.
            if league_refresh_times.get(key) == now:
                league_refresh_times.pop(key, None)
        raise


def execute_scheduled_job(job_id):
    auth = None
    job = None
    request_data = None
    try:
        with database_session() as db:
            job = db.get(ScheduledLimit, job_id)
            user = db.get(User, job.user_id)
        if user is None:
            raise RuntimeError("Schedule owner no longer exists")
        auth = build_worker_auth(user)
        # The account was validated against the user's hierarchy or search
        # results when the schedule was created; searched customer accounts
        # are not rediscoverable from a fresh worker auth, so trust the job.
        auth["searchableAgentIds"] = {job.account_id}
        current_auth.set(auth)
        current_change_source.set(("schedule", job_id))

        # league_cache is process-wide and this job may be running hours after
        # it was filled. Decide skip-or-write against AccessHigh's current
        # values, not a stale copy.
        try:
            refresh_leagues_if_stale(job.account_id)
        except Exception:
            logger.warning(
                "Could not refresh leagues before job %s; using cached values",
                job_id,
                exc_info=True,
            )

        request_data = {
            "accountId": job.account_id,
            "idOrganization": job.organization_id,
            "idLeague": job.league_id,
            "idSportType": job.sport_type_id,
            "periodNumber": job.period_number,
            "field": job.field,
            "value": job.value,
            "limitMode": "early" if job.is_early_limit else "normal",
            "telegramAudience": job.telegram_audience or "all",
        }
        outcome = None
        try:
            outcome = save_limit_change(request_data)
        except PermissionError:
            # Access tokens are short-lived, while recurring schedules may run
            # days later. Renew securely and retry the write exactly once.
            try:
                auth["http"].close()
            except Exception:
                pass
            logger.info(
                "Automation token rejected for job %s; renewing it", job_id
            )
            auth = refresh_worker_auth(user.id)
            auth["searchableAgentIds"] = {job.account_id}
            current_auth.set(auth)
            logger.info(
                "Automation token renewed for job %s; retrying the write",
                job_id,
            )
            try:
                outcome = save_limit_change(request_data)
            except PermissionError as retry_error:
                # A token AccessHigh has only just issued being rejected is a
                # different fault from one that simply aged out, and "log in
                # again" is meaningless advice for an unattended job. Say what
                # actually happened so the log names the real problem.
                raise RuntimeError(
                    "AccessHigh rejected the automation token immediately "
                    "after renewing it, so the scheduled limit could not be "
                    "written"
                ) from retry_error
        note = outcome.get("note") if isinstance(outcome, dict) else None
        record_job_result(job_id, error=None, note=note)
        logger.info(
            "Scheduled limit completed: %s%s", job_id, f" ({note})" if note else ""
        )
        notify_schedule_outcome(job, request_data, note or "Applied successfully")
    except Exception as error:
        logger.exception("Scheduled limit failed: %s", job_id)
        record_job_result(job_id, error=error)
        # A schedule that failed is the case most worth hearing about.
        if job is not None and request_data is not None:
            notify_schedule_outcome(job, request_data, f"Failed: {error}")
    finally:
        current_auth.set(None)
        current_change_source.set(None)
        if auth is not None:
            try:
                auth["http"].close()
            except Exception:
                pass
        
def prune_expired_sessions():
    now = datetime.now(timezone.utc)
    with auth_sessions_lock:
        expired = [
            (session_hash, auth)
            for session_hash, auth in auth_sessions.items()
            if now - auth["lastSeen"] > session_idle_timeout
            or now - auth["createdAt"] > session_max_lifetime
        ]
        for session_hash, _ in expired:
            del auth_sessions[session_hash]
    for _, auth in expired:
        try:
            auth["http"].close()
        except Exception:
            pass
    with database_session() as db:
        db.execute(
            delete(LoginSession).where(
                LoginSession.expires_at <= utc_now_naive()
            )
        )
        db.commit()
    with login_attempts_lock:
        cutoff = now - login_attempt_window
        for key in [
            key
            for key, attempts in login_attempts.items()
            if not attempts or attempts[-1] < cutoff
        ]:
            del login_attempts[key]


# How often Pinnacle's limits are recorded, and how long the readings are kept.
# Only one deployment needs to collect them: the readings describe Pinnacle,
# not a partner site, so the second site would store the same numbers twice.
pinnacle_sample_minutes = int(os.getenv("PINNACLE_SAMPLE_MINUTES", "60") or 60)
pinnacle_sample_days = int(os.getenv("PINNACLE_SAMPLE_DAYS", "60") or 60)
pinnacle_sampling_enabled = (
    os.getenv("PINNACLE_SAMPLING", "").strip().lower()
    not in {"off", "false", "0", "no"}
)


def record_pinnacle_samples():
    """Take one reading of every league's Pinnacle limits."""
    api_key = os.getenv("ODDSPAPI_KEY", "").strip()
    if not api_key:
        return 0

    stored = 0
    now = datetime.now(timezone.utc)
    for league in LEAGUE_CONFIGS:
        if shutdown_event.is_set():
            break
        try:
            samples = sample_pinnacle_limits(api_key, league)
        except RateLimited:
            # The quota is shared with the comparison page. Give the rest of
            # this cycle up rather than keep pushing against the limiter
            # somebody's page load also depends on.
            logger.info(
                "Pinnacle sampling stopped early: OddsPapi is rate limiting"
            )
            break
        except Exception:
            # One league failing must not stop the rest, and a sampling
            # failure must never affect anything a person is doing.
            logger.warning(
                "Could not sample Pinnacle limits for %s", league, exc_info=True
            )
            continue
        if not samples:
            continue
        try:
            with database_session() as db:
                db.add_all([
                    PinnacleLimitSample(
                        league=sample["league"],
                        period=sample["period"],
                        field=sample["field"],
                        fixture_id=sample["fixtureId"],
                        hours_to_start=sample["hoursToStart"],
                        limit_value=sample["limit"],
                        sampled_at=now.replace(tzinfo=None),
                    )
                    for sample in samples
                ])
                db.commit()
            stored += len(samples)
        except Exception:
            logger.warning(
                "Could not store Pinnacle samples for %s", league, exc_info=True
            )
    if stored:
        logger.info("Recorded %d Pinnacle limit readings", stored)
    return stored


def prune_pinnacle_samples():
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(
        days=pinnacle_sample_days
    )
    with database_session() as db:
        db.execute(
            delete(PinnacleLimitSample).where(
                PinnacleLimitSample.sampled_at < cutoff
            )
        )
        db.commit()


def run_pinnacle_sampler():
    """Record Pinnacle's limits on a timer, forever, without ever failing loudly."""
    if not pinnacle_sampling_enabled:
        logger.info("Pinnacle sampling is disabled")
        return
    # A short first delay keeps startup responsive and staggers the two sites
    # if both are ever asked to sample.
    shutdown_event.wait(30)
    while not shutdown_event.is_set():
        try:
            record_pinnacle_samples()
            prune_pinnacle_samples()
        except Exception:
            logger.exception("Pinnacle sampler iteration failed")
        shutdown_event.wait(max(60, pinnacle_sample_minutes * 60))


# How often a tracked limit is compared against Pinnacle, and how much it has
# to have moved before a write is worth making. Rewriting for a 2% drift would
# spend AccessHigh's rate limit to no purpose.
tracker_interval_minutes = int(os.getenv("TRACKER_INTERVAL_MINUTES", "10") or 10)
tracker_min_change_percent = float(os.getenv("TRACKER_MIN_CHANGE_PERCENT", "8") or 8)
# Only fixtures this close to kick-off count towards the live number. Without
# a window a single game three days out would hold the limit down all day, and
# the ramp would never rise.
tracker_window_hours = float(os.getenv("TRACKER_WINDOW_HOURS", "12") or 12)
# "lowest" or "median". Lowest is the safe reading for a limit that covers a
# whole league; median is available for comparison.
tracker_basis = (
    "median" if os.getenv("TRACKER_BASIS", "").strip().lower() == "median"
    else "lowest"
)
tracker_enabled = (
    os.getenv("LIMIT_TRACKER", "").strip().lower()
    not in {"off", "false", "0", "no"}
)


def tracker_pinnacle_levels(api_key, league_slug):
    """Pinnacle's current limit per period and market for one league.

    Two rules decide which readings count, and both matter more than they look.

    Only fixtures that have not started. Pinnacle's in-play limits behave
    nothing like its pre-game ones - on one board the same market read 6,750
    before kick-off and 29,605 once running - and a limit covering games that
    have not started should not be set from games that have.

    Only fixtures inside the window. A game three days out carries a tiny
    limit and would hold the whole league down all day, which is the opposite
    of following the market.

    What is taken from what remains is the lowest, not the typical. One limit
    covers every fixture in the league, so the exposure is set by the game
    Pinnacle trusts least; the median leaves you above Pinnacle on exactly
    that game.
    """
    samples = sample_pinnacle_limits(api_key, league_slug)
    grouped = {}
    for sample in samples:
        hours = sample["hoursToStart"]
        if hours < 0 or hours > tracker_window_hours:
            continue
        grouped.setdefault(
            (sample["period"], sample["field"]), []
        ).append(sample["limit"])

    levels = {}
    for key, values in grouped.items():
        values.sort()
        if tracker_basis == "median":
            middle = len(values) // 2
            levels[key] = (
                values[middle]
                if len(values) % 2
                else (values[middle - 1] + values[middle]) / 2
            )
        else:
            levels[key] = values[0]
    return levels


def run_tracker_cycle():
    """Move every enabled tracked limit to its share of Pinnacle's current one."""
    api_key = os.getenv("ODDSPAPI_KEY", "").strip()
    if not api_key:
        return 0

    with database_session() as db:
        trackers = db.execute(
            select(LimitTracker).where(LimitTracker.enabled.is_(True))
        ).scalars().all()
        trackers = [
            {
                "id": t.id, "userId": t.user_id, "accountId": t.account_id,
                "organizationId": t.organization_id, "leagueId": t.league_id,
                "sportTypeId": t.sport_type_id, "periodNumber": t.period_number,
                "field": t.field, "isEarly": t.is_early_limit,
                "slug": t.league_slug, "period": t.period_label,
                "scale": t.scale_percent, "lastWritten": t.last_written_value,
            }
            for t in trackers
        ]
    if not trackers:
        return 0

    levels_by_slug = {}
    written = 0
    now = datetime.now(timezone.utc).replace(tzinfo=None)

    for tracker in trackers:
        if shutdown_event.is_set():
            break
        slug = tracker["slug"]
        if slug not in levels_by_slug:
            try:
                levels_by_slug[slug] = tracker_pinnacle_levels(api_key, slug)
            except RateLimited:
                logger.info("Tracker cycle stopped early: OddsPapi is rate limiting")
                break
            except Exception:
                logger.warning(
                    "Could not read Pinnacle for %s", slug, exc_info=True
                )
                levels_by_slug[slug] = {}
        levels = levels_by_slug[slug]
        level = levels.get((tracker["period"], tracker["field"]))

        note = None
        target = None
        if not level:
            # Distinguish a market Pinnacle is not posting from a board with
            # nothing on it. Baseball's 1st-5 runline is the case that matters:
            # it appears only sometimes, and blaming kick-off times for it sent
            # somebody looking for a fault that was not there.
            period_has_any = any(
                key[0] == tracker["period"] for key in levels
            )
            note = (
                f"Pinnacle is not posting a "
                f"{limit_field_labels.get(tracker['field'], tracker['field']).lower()} "
                f"for {tracker['period']} right now"
                if period_has_any
                else "No Pinnacle fixtures near kick-off"
            )
        else:
            target = max(100, int(round(level * tracker["scale"] / 100.0 / 100.0)) * 100)
            previous = tracker["lastWritten"]
            if previous and previous > 0:
                drift = abs(target - previous) / float(previous) * 100.0
                if drift < tracker_min_change_percent:
                    note = f"Held at {previous:,}, Pinnacle moved {drift:.0f}%"
                    target = None

        if target is not None:
            try:
                tracker["pinnacle"] = level
                outcome = write_tracked_limit(tracker, target)
                note = outcome["note"]
                if outcome["changed"]:
                    written += 1
            except Exception as error:
                note = f"Failed: {error}"
                logger.warning(
                    "Tracker %s could not write", tracker["id"], exc_info=True
                )

        with database_session() as db:
            row = db.get(LimitTracker, tracker["id"])
            if row is not None:
                row.last_checked_at = now
                row.last_pinnacle_value = level
                row.last_note = (note or "")[:255]
                if target is not None and note and note.startswith("Set to"):
                    row.last_written_value = target
                    row.last_written_at = now
                db.commit()

    if written:
        logger.info("Tracker moved %d limits", written)
    return written


def write_tracked_limit(tracker, target):
    """Write one tracked limit, ignoring the blue rule for this model only.

    Every write on a sub-account marks the limit blue, so a tracker that
    honoured the blue rule would move a limit once and then skip it for ever.
    The rule still applies everywhere else; it exists to protect a player
    override somebody set by hand, and nothing here touches those.
    """
    with database_session() as db:
        user = db.get(User, tracker["userId"])
    if user is None:
        return {"changed": False, "note": "Tracker owner no longer exists"}

    auth = build_worker_auth(user)
    auth["searchableAgentIds"] = {tracker["accountId"]}
    token = current_auth.set(auth)
    source = current_change_source.set(("tracker", tracker["id"]))
    try:
        refresh_leagues_if_stale(tracker["accountId"])
        api_field = (
            f"{limit_mode_prefixes['early' if tracker['isEarly'] else 'normal']}"
            f"{allowed_limit_fields[tracker['field']]}"
        )
        outcome = save_single_limit(
            tracker["accountId"],
            tracker["organizationId"],
            tracker["leagueId"],
            tracker["sportTypeId"],
            tracker["periodNumber"],
            tracker["field"],
            target,
            api_field,
            return_full=False,
            change_type="Tracked limit",
            skip_blue=False,
        )
        changed = bool(outcome.get("changed", True))
        if changed:
            # Only when a limit actually moves. A tracker checks every few
            # minutes and mostly finds nothing to do; alerting on every check
            # would bury the ones that matter.
            try:
                send_telegram_success_message(
                    build_limit_success_message(
                        tracker["accountId"],
                        tracker["organizationId"],
                        tracker["leagueId"],
                        tracker["sportTypeId"],
                        tracker["periodNumber"],
                        tracker["field"],
                        target,
                        change_type=(
                            "Early tracked limit" if tracker["isEarly"]
                            else "Tracked limit"
                        ),
                        outcome_line=(
                            f"Following Pinnacle at {tracker['scale']}%"
                            + (
                                f" (Pinnacle {tracker['pinnacle']:,.0f})"
                                if tracker.get("pinnacle") else ""
                            )
                        ),
                    )
                )
            except Exception:
                # A notification must never turn a good write into a failure.
                logger.warning(
                    "Could not alert for tracker %s", tracker["id"], exc_info=True
                )
        return {
            "changed": changed,
            "note": (
                f"Set to {target:,}" if changed
                else outcome.get("note") or f"Already {target:,}"
            ),
        }
    finally:
        current_change_source.reset(source)
        current_auth.reset(token)
        try:
            auth["http"].close()
        except Exception:
            pass


def run_limit_tracker():
    if not tracker_enabled:
        logger.info("Limit tracker is disabled")
        return
    shutdown_event.wait(45)
    while not shutdown_event.is_set():
        try:
            run_tracker_cycle()
        except Exception:
            logger.exception("Tracker cycle failed")
        shutdown_event.wait(max(60, tracker_interval_minutes * 60))


def run_schedule_worker():
    # Any exception escaping this loop silently stops all scheduled limits
    # until a restart, so every iteration must survive failures.
    prune_countdown = 0
    while not shutdown_event.is_set():
        try:
            claimed_ids = claim_due_jobs()
        except Exception:
            logger.exception("Schedule worker could not poll for due jobs")
            shutdown_event.wait(5)
            continue

        for job_id in claimed_ids:
            execute_scheduled_job(job_id)

        if prune_countdown <= 0:
            prune_countdown = 300
            try:
                prune_expired_sessions()
            except Exception:
                logger.exception("Session cleanup failed")
        prune_countdown -= 1

        shutdown_event.wait(0.25)


def schedule_status_rows(account_id):
    auth = auth_context()
    # Schedule history is database-backed and must remain available even when
    # AcesHigh is rate-limiting its hierarchy endpoint. Use hierarchy data only
    # when this session has already loaded it successfully.
    agents = auth.get("agents") or []
    agent_names = {
        int(agent["id"]): agent.get("name") or f"Agent {agent['id']}"
        for agent in agents
    }
    agent_names.setdefault(int(auth["id"]), auth["username"])

    # The logged-in root/main agent owns the combined schedule history for
    # every account it scheduled under. A selected child/sub-agent must still
    # see only schedules for that specific account.
    schedule_query = select(ScheduledLimit).where(
        ScheduledLimit.user_id == auth["userId"]
    )
    if int(account_id) != int(auth["id"]):
        schedule_query = schedule_query.where(
            ScheduledLimit.account_id == int(account_id)
        )

    # Activity Logs must also include real immediate writes. Scheduled and
    # tracker writes already have their own views, so only manual changes are
    # added here; including every LimitChange would duplicate each completed
    # schedule beside its ScheduledLimit row.
    manual_query = select(LimitChange).where(
        LimitChange.user_id == auth["userId"],
        LimitChange.source == "manual",
    )
    if int(account_id) != int(auth["id"]):
        manual_query = manual_query.where(
            LimitChange.account_id == int(account_id)
        )

    with database_session() as db:
        jobs = list(
            db.scalars(
                schedule_query.order_by(
                    # Anything still waiting to run sorts above anything
                    # already finished, so a completed job never sits on top
                    # of one the operator is still waiting on. Newest first
                    # within each group.
                    case(
                        (
                            ScheduledLimit.status.in_(
                                ("pending", "running")
                            ),
                            0,
                        ),
                        else_=1,
                    ),
                    ScheduledLimit.created_at.desc(),
                )
            )
        )
        manual_changes = list(
            db.scalars(
                manual_query.order_by(LimitChange.changed_at.desc())
            )
        )

        # Customer Support Agent is an additive display field. Existing
        # recurring history must remain available even before this new column
        # has been migrated on an older database.
        existing_schedule_columns = {
            column["name"]
            for column in inspect(engine).get_columns("scheduled_limits")
        }
        if "customer_support_agent" in existing_schedule_columns:
            support_agent_rows = db.execute(
                text(
                    "SELECT id, customer_support_agent "
                    "FROM scheduled_limits WHERE user_id = :user_id"
                ),
                {"user_id": auth["userId"]},
            )
            customer_support_agents = {
                str(row[0]): row[1] for row in support_agent_rows
            }
        else:
            customer_support_agents = {}

    # A root history can contain schedules from many different agents. Resolve
    # league names once per scheduled account so the Activity Logs table does
    # not depend on the currently selected agent's league rows.
    league_names = {}
    activity_account_ids = {
        int(item.account_id) for item in [*jobs, *manual_changes]
    }
    for scheduled_account_id in sorted(activity_account_ids):
        try:
            account_leagues = get_leagues(scheduled_account_id)
        except Exception as error:
            logger.warning(
                "Could not resolve league names for account %s: %s",
                scheduled_account_id,
                error,
            )
            account_leagues = []

        for league_row in account_leagues:
            organization_id = safe_int(league_row.get("IdOrganization"))
            league_id = safe_int(league_row.get("IdLeague"))
            sport_type_id = safe_int(league_row.get("IdSportType"))
            league_name = (
                league_row.get("LeagueName")
                or league_row.get("leagueName")
                or league_row.get("Description")
            )
            if not league_name:
                continue

            league_names.setdefault(
                (
                    scheduled_account_id,
                    organization_id,
                    league_id,
                    sport_type_id,
                ),
                league_name,
            )
            league_names.setdefault(
                (
                    scheduled_account_id,
                    organization_id,
                    league_id,
                    None,
                ),
                league_name,
            )

    schedule_rows = [{
        "activityType": "schedule",
        "id": job.id,
        "status": job.status,
        "scheduledFor": eastern_timestamp(
            job.scheduled_for.replace(tzinfo=timezone.utc)
        ),
        "scheduledForUtc": job.scheduled_for.replace(
            tzinfo=timezone.utc
        ).isoformat(),
        "accountId": job.account_id,
        "agentName": agent_names.get(
            int(job.account_id), f"Agent {job.account_id}"
        ),
        "customerSupportAgent": customer_support_agents.get(str(job.id)),
        "idOrganization": job.organization_id,
        "idLeague": job.league_id,
        "leagueName": (
            league_names.get((
                int(job.account_id),
                int(job.organization_id),
                int(job.league_id),
                int(job.sport_type_id),
            ))
            or league_names.get((
                int(job.account_id),
                int(job.organization_id),
                int(job.league_id),
                None,
            ))
            or f"League {job.league_id}"
        ),
        "idSportType": job.sport_type_id,
        "periodNumber": job.period_number,
        "field": job.field,
        "value": job.value,
        "limitMode": "early" if job.is_early_limit else "normal",
        "recurring": bool(job.recurrence_days and job.recurrence_time),
        "recurrence": (
            recurring_description(
                [int(day) for day in job.recurrence_days.split(",")],
                job.recurrence_time,
            )
            if job.recurrence_days and job.recurrence_time
            else None
        ),
        "lastRunStatus": job.last_run_status,
        "lastRunAt": (
            eastern_timestamp(job.last_run_at.replace(tzinfo=timezone.utc))
            if job.last_run_at
            else None
        ),
        "lastRunAtUtc": (
            job.last_run_at.replace(tzinfo=timezone.utc).isoformat()
            if job.last_run_at
            else None
        ),
        "createdAt": eastern_timestamp(
            job.created_at.replace(tzinfo=timezone.utc)
        ),
        "createdAtUtc": job.created_at.replace(
            tzinfo=timezone.utc
        ).isoformat(),
        "completedAt": (
            eastern_timestamp(job.completed_at.replace(tzinfo=timezone.utc))
            if job.completed_at
            else None
        ),
        # The reason a run failed is the single most useful thing the log can
        # show, and it was being stored and then never surfaced.
        "error": job.error,
        # Why a successful run changed nothing, when that is the case.
        "runNote": getattr(job, "run_note", None),
    } for job in jobs]

    manual_rows = []
    for change in manual_changes:
        changed_at = change.changed_at.replace(tzinfo=timezone.utc)
        old_value = (
            f"{change.old_value:,}"
            if change.old_value is not None
            else "not set"
        )
        target_scope = getattr(change, "target_scope", "selected") or "selected"
        affected_agents = getattr(change, "affected_agents", None)
        affected_customers = getattr(change, "affected_customers", None)
        scope_note = ""
        if target_scope == "all_agents":
            scope_note = (
                f" · Pushed to {affected_agents or 0:,} agents; "
                f"{affected_customers or 0:,} customers affected"
            )
        manual_rows.append({
            "activityType": "immediate",
            "id": f"change-{change.id}",
            "status": "completed",
            "scheduledFor": None,
            "scheduledForUtc": None,
            "accountId": change.account_id,
            "agentName": agent_names.get(
                int(change.account_id), f"Agent {change.account_id}"
            ),
            "customerSupportAgent": change.customer_support_agent,
            "targetScope": target_scope,
            "affectedAgents": affected_agents,
            "affectedCustomers": affected_customers,
            "idOrganization": change.organization_id,
            "idLeague": change.league_id,
            "leagueName": (
                league_names.get((
                    int(change.account_id),
                    int(change.organization_id),
                    int(change.league_id),
                    int(change.sport_type_id),
                ))
                or league_names.get((
                    int(change.account_id),
                    int(change.organization_id),
                    int(change.league_id),
                    None,
                ))
                or f"League {change.league_id}"
            ),
            "idSportType": change.sport_type_id,
            "periodNumber": change.period_number,
            "field": change.field,
            "value": change.new_value,
            "limitMode": change.limit_mode,
            "recurring": False,
            "recurrence": None,
            "lastRunStatus": "completed",
            "lastRunAt": eastern_timestamp(changed_at),
            "lastRunAtUtc": changed_at.isoformat(),
            "createdAt": eastern_timestamp(changed_at),
            "createdAtUtc": changed_at.isoformat(),
            "completedAt": eastern_timestamp(changed_at),
            "error": None,
            "runNote": (
                f"Changed from {old_value} to {change.new_value:,}{scope_note}"
            ),
        })

    # Waiting jobs remain at the top. Everything else, including immediate
    # writes, follows in reverse chronological order.
    return sorted(
        [*schedule_rows, *manual_rows],
        key=lambda row: (
            0 if row["status"] in {"pending", "running"} else 1,
            -datetime.fromisoformat(row["createdAtUtc"]).timestamp(),
        ),
    )



class DashboardHandler(SimpleHTTPRequestHandler):
    server_version = "AcesHighDashboard"
    sys_version = ""

    def __init__(self, *args, **kwargs):
        super().__init__(
            *args,
            directory=str(app_directory),
            **kwargs,
        )

    def request_path(self):
        return urlsplit(self.path).path

    def request_header(self, name, default=""):
        headers = getattr(self, "headers", None)
        if headers is None:
            return default
        return headers.get(name, default)

    def session_id(self):
        cookies = {}
        for part in self.request_header("Cookie").split(";"):
            if "=" in part:
                key, value = part.strip().split("=", 1)
                cookies[key] = value
        return cookies.get("limitbot_session")

    def require_auth(self):
        session_id = self.session_id()
        if not session_id:
            self.send_json(401, {"error": "Login required"})
            return None
        now_db = utc_now_naive()
        session_hash = hash_session_token(session_id)
        with database_session() as db:
            login_session = db.scalar(
                select(LoginSession).where(
                    LoginSession.token_hash == session_hash
                )
            )
            if (
                login_session is None
                or login_session.expires_at <= now_db
                or now_db - login_session.last_seen > session_idle_timeout
            ):
                if login_session is not None:
                    login_session.expires_at = now_db
                    db.commit()
                with auth_sessions_lock:
                    auth_sessions.pop(session_hash, None)
                self.send_json(401, {"error": "Login required"})
                return None
            user = login_session.user
            login_session.last_seen = now_db
            db.commit()
            with auth_sessions_lock:
                auth = auth_sessions.get(session_hash)
            if auth is None:
                auth = build_auth_from_database(user, login_session, session_hash)
                with auth_sessions_lock:
                    auth_sessions[session_hash] = auth
        auth["lastSeen"] = now_db.replace(tzinfo=timezone.utc)
        current_auth.set(auth)
        return auth

    def valid_origin(self):
        origin = self.request_header("Origin")
        host = self.request_header("Host")
        return origin in {f"http://{host}", f"https://{host}"}

    def client_ip(self):
        client_address = getattr(self, "client_address", ("unknown",))
        if trust_proxy_headers:
            # The trusted proxy appends the real client IP as the last entry;
            # earlier entries are client-supplied and must not be trusted.
            forwarded_for = self.request_header("X-Forwarded-For").rsplit(",", 1)[-1].strip()
            try:
                return str(ipaddress.ip_address(forwarded_for))
            except ValueError:
                pass
        return client_address[0]

    def is_https(self):
        return (
            app_environment == "production"
            or
            (
                trust_proxy_headers
                and self.request_header("X-Forwarded-Proto").lower() == "https"
            )
            or getattr(self.connection, "cipher", None) is not None
        )

    def log_message(self, format_string, *args):
        try:
            logger.info("%s %s", self.client_ip(), format_string % args)
        except Exception:
            logger.info("unknown %s", format_string % args)

    def server_error(self, context, error, message):
        logger.error("%s: %s", context, type(error).__name__, exc_info=True)
        self.send_json(502, {"error": message})

    def comparison_error(self, context, error, fallback):
        """A ComparisonError already says which site failed and what to do
        about it, so send that text rather than a generic 502 message."""
        logger.error("%s: %s", context, error, exc_info=True)
        self.send_json(502, {"error": str(error) or fallback})

    def session_cookie(self, session_id, delete=False):
        secure = "; Secure" if self.is_https() else ""
        expiry = "; Max-Age=0" if delete else f"; Max-Age={int(session_max_lifetime.total_seconds())}"
        return (
            f"limitbot_session={session_id}; HttpOnly; SameSite=Strict; "
            f"Path=/{expiry}{secure}"
        )

    def login_rate_key(self, username):
        return (self.client_ip(), username.casefold())

    def login_rate_limited(self, key):
        cutoff = datetime.now(timezone.utc) - login_attempt_window
        with login_attempts_lock:
            attempts = login_attempts.get(key)
            if attempts is None:
                return False
            while attempts and attempts[0] < cutoff:
                attempts.popleft()
            if not attempts:
                # Drop empty entries so probing many usernames cannot grow
                # this dict without bound.
                del login_attempts[key]
                return False
            return len(attempts) >= login_attempt_limit

    def record_login_failure(self, key):
        with login_attempts_lock:
            login_attempts[key].append(datetime.now(timezone.utc))

    def clear_login_failures(self, key):
        with login_attempts_lock:
            login_attempts.pop(key, None)

    def read_json(self):
        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length <= 0 or content_length > 10_000:
            raise ValueError("Invalid request size")

        return json.loads(self.rfile.read(content_length).decode("utf-8"))

    def send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_response(self, *args, **kwargs):
        self.cache_control_sent = False
        super().send_response(*args, **kwargs)

    def send_header(self, keyword, value):
        if keyword.lower() == "cache-control":
            self.cache_control_sent = True
        super().send_header(keyword, value)

    def end_headers(self):
        if not getattr(self, "cache_control_sent", False):
            # Static assets carried only Last-Modified, so browsers cached
            # them heuristically. A deploy could leave a browser running the
            # previous script.js against the new index.html, which mismatches
            # the two without any visible error. Revalidate every load; an
            # unchanged file still answers 304.
            self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; "
            "style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
            "base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        )
        if self.is_https():
            self.send_header(
                "Strict-Transport-Security",
                "max-age=31536000; includeSubDomains",
            )
        super().end_headers()

    def redirect(self, location):
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def composed_asset(self, path):
        """Which assembled bundle answers this path, if any.

        The per-page and per-concern sources stay reachable at their own paths
        for debugging; these are what the shell actually links.
        """
        if path == "/styles.css":
            return composed_assets["css"]
        if path == "/script.js":
            return composed_assets["js"]
        if path in page_routes:
            return composed_assets["html"]
        return None

    def do_HEAD(self):
        """Route HEAD the same way as GET.

        These paths have no file behind them any more, so the inherited
        do_HEAD would look for one on disk and answer 404. serve() omits the
        body for a HEAD, so the headers still describe the real response.
        """
        path = self.request_path()

        if path == "/index.html":
            self.redirect("/")
            return

        if not pinnacle_comparison_enabled and path in {
            "/pinnacle_aceshigh", "/pinnacle_aceshigh/",
        }:
            self.redirect("/")
            return

        if not trading_monitor_enabled and path in {
            "/trading_monitor", "/trading_monitor/",
        }:
            self.redirect("/")
            return

        asset = self.composed_asset(path)
        if asset is not None:
            self.send_composed(asset)
            return

        super().do_HEAD()

    def send_composed(self, asset):
        """Serve one of the assembled Frontend bundles."""
        try:
            frontend_assets.serve(self, asset)
        except (OSError, ValueError) as error:
            self.server_error(
                "Frontend asset build failed", error, "The page is unavailable"
            )

    def do_GET(self):
        path = self.request_path()
        query = parse_qs(urlsplit(self.path).query)

        if not pinnacle_comparison_enabled and path in {
            "/pinnacle_aceshigh", "/pinnacle_aceshigh/",
        }:
            self.redirect("/")
            return

        if not trading_monitor_enabled and path in {
            "/trading_monitor", "/trading_monitor/",
        }:
            self.redirect("/")
            return

        if path == "/api/health":
            try:
                with engine.connect() as connection:
                    connection.execute(text("SELECT 1"))
                self.send_json(200, {"status": "ok"})
            except Exception as error:
                logger.error("Health check failed: %s", type(error).__name__)
                self.send_json(503, {"status": "unavailable"})
            return

        if path == "/api/session":
            auth = self.require_auth()
            if auth:
                self.send_json(200, {
                    "username": auth["username"],
                    "id": auth["id"],
                    "preferences": user_preferences(auth),
                    "partnerName": partner_name,
                    "pinnacleComparisonEnabled": pinnacle_comparison_enabled,
                    "tradingMonitorEnabled": trading_monitor_enabled,
                    "telegramSite": "betwar" if partner_host == "betwar.ag" else "aceshigh",
                })
            return

        if path.startswith("/api/") and not self.require_auth():
            return

        if (
            not pinnacle_comparison_enabled
            and path.startswith("/api/pinnacle-comparison")
        ):
            self.send_json(404, {"error": "This page is not enabled for BetWar"})
            return

        if not trading_monitor_enabled and path == "/api/trading-monitor":
            self.send_json(404, {"error": "This page is not enabled for BetWar"})
            return

        if path == "/api/telegram-chats":
            try:
                self.send_json(200, {"recipients": telegram_recipient_rows()})
            except Exception as error:
                self.server_error(
                    "Telegram recipient load failed",
                    error,
                    "Telegram recipients are unavailable",
                )
            return

        if path == "/api/agents":
            try:
                auth = auth_context()
                self.send_json(
                    200,
                    {
                        "parentId": auth["id"],
                        "parentName": auth["username"],
                        # Served from this login, then from the stored tree,
                        # and only walked upstream when neither is available.
                        # Authentication itself never waits for that walk.
                        # ?refresh=1 forces a rebuild for a hierarchy that
                        # changed and has to be picked up right now.
                        "agents": load_agents(
                            force=query.get("refresh", ["0"])[0] == "1"
                        ),
                        "preferences": user_preferences(auth),
                    },
                )
            except PermissionError as error:
                self.send_json(401, {"error": str(error)})
            except Exception as error:
                self.server_error("Agent load failed", error, "Agent data is unavailable")
            return

        if path == "/api/pinnacle-comparison/leagues":
            try:
                auth = auth_context()
                requested_account = query.get("accountId", [auth["id"]])[0]
                account_id = validate_account_id(int(requested_account))
                api_key = os.getenv("ODDSPAPI_KEY", "").strip()
                if not api_key:
                    self.send_json(
                        503,
                        {"error": "OddsPapi is not configured on this server"},
                    )
                    return
                self.send_json(
                    200,
                    {"leagues": comparison_leagues(
                        api_key,
                        auth["http"],
                        auth["headers"],
                        account_id,
                    )},
                )
            except (KeyError, TypeError, ValueError) as error:
                self.send_json(400, {"error": str(error)})
            except PermissionError as error:
                self.send_json(401, {"error": str(error)})
            except ComparisonError as error:
                self.comparison_error(
                    "Comparison league discovery failed",
                    error,
                    f"{partner_name} or OddsPapi league data is unavailable",
                )
            except Exception as error:
                self.server_error(
                    "Comparison league discovery failed",
                    error,
                    "Comparison league data is unavailable",
                )
            return

        if path == "/api/pinnacle-comparison":
            try:
                auth = auth_context()
                requested_account = query.get("accountId", [auth["id"]])[0]
                account_id = validate_account_id(int(requested_account))
                api_key = os.getenv("ODDSPAPI_KEY", "").strip()
                if not api_key:
                    self.send_json(
                        503,
                        {"error": "OddsPapi is not configured on this server"},
                    )
                    return
                force = query.get("refresh", [""])[0].lower() in {
                    "1", "true", "yes",
                }
                league = query.get("league", ["mlb"])[0]
                self.send_json(
                    200,
                    build_league_comparison(
                        api_key,
                        auth["http"],
                        auth["headers"],
                        account_id,
                        league=league,
                        force=force,
                    ),
                )
            except (KeyError, TypeError, ValueError) as error:
                self.send_json(400, {"error": str(error)})
            except PermissionError as error:
                self.send_json(401, {"error": str(error)})
            except ComparisonError as error:
                self.comparison_error(
                    "League comparison failed",
                    error,
                    f"Pinnacle or {partner_name} comparison data is unavailable",
                )
            except Exception as error:
                self.server_error(
                    "League comparison failed",
                    error,
                    "Comparison data is unavailable",
                )
            return

        if path == "/api/trading-monitor":
            try:
                auth = auth_context()
                requested_account = query.get("accountId", [auth["id"]])[0]
                account_id = validate_account_id(int(requested_account))
                api_key = os.getenv("ODDSPAPI_KEY", "").strip()
                if not api_key:
                    self.send_json(
                        503,
                        {"error": "OddsPapi is not configured on this server"},
                    )
                    return
                force = query.get("refresh", [""])[0].lower() in {
                    "1", "true", "yes",
                }
                league = query.get("league", ["mlb"])[0]
                self.send_json(
                    200,
                    build_trading_monitor(
                        api_key,
                        account_id,
                        league=league,
                        force=force,
                    ),
                )
            except (KeyError, TypeError, ValueError) as error:
                self.send_json(400, {"error": str(error)})
            except PermissionError as error:
                self.send_json(401, {"error": str(error)})
            except ComparisonError as error:
                self.comparison_error(
                    "Trading monitor failed",
                    error,
                    f"Pinnacle or {partner_name} monitor data is unavailable",
                )
            except Exception as error:
                self.server_error(
                    "Trading monitor failed",
                    error,
                    "Trading monitor data is unavailable",
                )
            return

        if path == "/api/agent-search":
            try:
                search_value = query.get("q", [""])[0]
                self.send_json(200, {"agents": search_agents(search_value)})
            except (TypeError, ValueError) as error:
                self.send_json(400, {"error": str(error)})
            except PermissionError as error:
                self.send_json(401, {"error": str(error)})
            except Exception as error:
                self.server_error("Agent search failed", error, "Agent search is unavailable")
            return

        if path == "/api/leagues":
            try:
                account_id = validate_account_id(int(query["accountId"][0]))
                self.send_json(
                    200,
                    {
                        "accountId": account_id,
                        "accountName": account_name(account_id),
                        "rows": dashboard_rows(account_id, force=True),
                    },
                )
            except (KeyError, TypeError, ValueError) as error:
                self.send_json(400, {"error": str(error)})
            except Exception as error:
                self.server_error("League load failed", error, "League data is unavailable")
            return

        if path == "/api/trackers":
            try:
                account_id = validate_account_id(int(query["accountId"][0]))
                self.send_json(
                    200,
                    {
                        "trackers": limit_tracker_rows(account_id),
                        "history": tracker_history_rows(account_id),
                        "intervalMinutes": tracker_interval_minutes,
                        "windowHours": tracker_window_hours,
                        "minChangePercent": tracker_min_change_percent,
                        "basis": tracker_basis,
                    },
                )
            except (KeyError, TypeError, ValueError) as error:
                self.send_json(400, {"error": str(error)})
            except PermissionError as error:
                self.send_json(401, {"error": str(error)})
            except Exception as error:
                self.server_error(
                    "Tracker load failed", error, "Tracked limits are unavailable"
                )
            return

        if path == "/api/schedules":
            try:
                account_id = validate_account_id(int(query["accountId"][0]))
                self.send_json(
                    200, {"schedules": schedule_status_rows(account_id)}
                )
            except (KeyError, TypeError, ValueError) as error:
                self.send_json(400, {"error": str(error)})
            except PermissionError as error:
                self.send_json(401, {"error": str(error)})
            except Exception as error:
                self.server_error("Schedule load failed", error, "Schedule data is unavailable")
            return

        if path == "/api/periods":
            try:
                account_id = validate_account_id(int(query["accountId"][0]))
                organization_id = int(query["idOrganization"][0])
                league_id = int(query["idLeague"][0])
                self.send_json(
                    200,
                    {
                        "rows": period_dashboard_rows(
                            account_id,
                            organization_id,
                            league_id,
                            force=True,
                        )
                    },
                )
            except (KeyError, TypeError, ValueError) as error:
                self.send_json(400, {"error": str(error)})
            except Exception as error:
                self.server_error("Period load failed", error, "Period data is unavailable")
            return

        if path == "/index.html":
            self.redirect("/")
            return

        asset = self.composed_asset(path)
        if asset is not None:
            self.send_composed(asset)
            return

        super().do_GET()

    def do_POST(self):
        path = self.request_path()

        if not self.valid_origin():
            self.send_json(403, {"error": "Invalid request origin"})
            return

        if path == "/api/login":
            rate_key = None
            try:
                request_data = self.read_json()
                username = str(request_data.get("username", "")).strip()
                password = str(request_data.get("password", ""))
                if not username or not password or len(username) > 100 or len(password) > 200:
                    raise ValueError("Enter your AccessHigh username and password")
                rate_key = self.login_rate_key(username)
                if self.login_rate_limited(rate_key):
                    self.send_json(
                        429,
                        {"error": "Too many login attempts. Try again in 15 minutes."},
                    )
                    return
                auth = authenticate(username, password)
                session_id = secrets.token_urlsafe(32)
                session_hash = hash_session_token(session_id)
                auth["sessionHash"] = session_hash
                current_auth.set(auth)
                preferences = persist_login(
                    auth, password, auth.pop("accessToken"), session_id
                )
                with auth_sessions_lock:
                    auth_sessions[session_hash] = auth
                self.clear_login_failures(rate_key)
                body = json.dumps({
                    "username": auth["username"],
                    "id": auth["id"],
                    "preferences": preferences,
                    "partnerName": partner_name,
                    "pinnacleComparisonEnabled": pinnacle_comparison_enabled,
                    "tradingMonitorEnabled": trading_monitor_enabled,
                    "telegramSite": "betwar" if partner_host == "betwar.ag" else "aceshigh",
                }).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header(
                    "Set-Cookie",
                    self.session_cookie(session_id),
                )
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
            except ValueError as error:
                if rate_key is not None:
                    self.record_login_failure(rate_key)
                self.send_json(401, {"error": str(error)})
            except Exception as error:
                # This path used to swallow the cause completely, which left
                # a failing login with nothing at all to diagnose it from.
                logger.error(
                    "AccessHigh login failed for %s: %s",
                    username or "unknown",
                    type(error).__name__,
                    exc_info=True,
                )
                self.send_json(502, {"error": "AccessHigh login is currently unavailable"})
            return

        if path == "/api/logout":
            session_id = self.session_id()
            session_hash = hash_session_token(session_id) if session_id else None
            with auth_sessions_lock:
                auth_sessions.pop(session_hash, None)
            if session_id:
                with database_session() as db:
                    login_session = db.scalar(
                        select(LoginSession).where(
                            LoginSession.token_hash == session_hash
                        )
                    )
                    if login_session:
                        for job in db.scalars(
                            select(ScheduledLimit).where(
                                ScheduledLimit.login_session_id == login_session.id,
                            )
                        ):
                            job.login_session_id = None
                        db.delete(login_session)
                        db.commit()
            self.send_response(204)
            self.send_header(
                "Set-Cookie",
                self.session_cookie("", delete=True),
            )
            self.end_headers()
            return

        if path not in {
            "/api/limits",
            "/api/limits/hierarchy/preview",
            "/api/limits/hierarchy",
            "/api/schedules",
            "/api/schedules/ramp",
            "/api/trackers",
            "/api/trackers/delete",
            "/api/schedules/cancel",
            "/api/schedules/delete",
            "/api/schedules/delete-all",
            "/api/telegram-chats",
            "/api/telegram-chats/edit",
            "/api/telegram-chats/delete",
            "/api/preferences",
        }:
            self.send_json(404, {"error": "Not found"})
            return

        if not self.require_auth():
            return
        try:
            request_data = self.read_json()
            result = (
                preview_hierarchy_limit_changes(request_data)
                if path == "/api/limits/hierarchy/preview"
                else save_hierarchy_limit_changes(request_data)
                if path == "/api/limits/hierarchy"
                else create_limit_trackers(request_data)
                if path == "/api/trackers"
                else delete_limit_trackers(request_data)
                if path == "/api/trackers/delete"
                else create_schedule_ramp(request_data)
                if path == "/api/schedules/ramp"
                else cancel_schedule(request_data)
                if path == "/api/schedules/cancel"
                else delete_schedule(request_data)
                if path == "/api/schedules/delete"
                else delete_all_schedules(request_data)
                if path == "/api/schedules/delete-all"
                else create_schedule(request_data)
                if path == "/api/schedules"
                else add_telegram_recipient(request_data)
                if path == "/api/telegram-chats"
                else edit_telegram_recipient(request_data)
                if path == "/api/telegram-chats/edit"
                else delete_telegram_recipient(request_data)
                if path == "/api/telegram-chats/delete"
                else save_user_preferences(auth_context(), request_data)
                if path == "/api/preferences"
                else save_limit_change(request_data)
            )
            self.send_json(200, result)
        except (KeyError, TypeError, ValueError) as error:
            self.send_json(400, {"error": str(error)})
        except PermissionError as error:
            self.send_json(401, {"error": str(error)})
        except Exception as error:
            self.server_error("Authenticated operation failed", error, "Operation failed")


def migrate_schedule_columns():
    existing = {
        column["name"] for column in inspect(engine).get_columns("scheduled_limits")
    }
    additions = {
        "recurrence_days": "VARCHAR(20) NULL",
        "recurrence_time": "VARCHAR(5) NULL",
        "telegram_audience": "VARCHAR(10) NOT NULL DEFAULT 'all'",
        "is_early_limit": "BOOLEAN NOT NULL DEFAULT FALSE",
        "last_run_status": "VARCHAR(20) NULL",
        "last_run_at": "DATETIME NULL",
        "customer_support_agent": "VARCHAR(100) NULL",
        "telegram_recipient_name": "VARCHAR(100) NULL",
        "telegram_chat_id": "VARCHAR(64) NULL",
        # Added to the model without a migration entry, so it existed only on
        # the database someone had altered by hand. Every ScheduledLimit query
        # names it, so the site whose database lacked it could not read or run
        # a single schedule.
        "telegram_audience": "VARCHAR(10) NOT NULL DEFAULT 'all'",
        "run_note": "VARCHAR(255) NULL",
    }
    with engine.begin() as connection:
        for column_name, column_type in additions.items():
            if column_name not in existing:
                connection.execute(
                    text(
                        f"ALTER TABLE scheduled_limits "
                        f"ADD COLUMN {column_name} {column_type}"
                    )
                )


def migrate_limit_change_columns():
    existing = {
        column["name"] for column in inspect(engine).get_columns("limit_changes")
    }
    additions = {
        "customer_support_agent": "VARCHAR(100) NULL",
        "target_scope": "VARCHAR(20) NOT NULL DEFAULT 'selected'",
        "affected_agents": "INTEGER NULL",
        "affected_customers": "INTEGER NULL",
    }
    with engine.begin() as connection:
        for column_name, column_type in additions.items():
            if column_name in existing:
                continue
            connection.execute(
                text(
                    "ALTER TABLE limit_changes "
                    f"ADD COLUMN {column_name} {column_type}"
                )
            )


def migrate_telegram_recipients():
    with engine.begin() as connection:
        connection.execute(
            text(
                "CREATE TABLE IF NOT EXISTS telegram_recipients ("
                "id VARCHAR(32) NOT NULL PRIMARY KEY, "
                "user_id INTEGER NOT NULL, "
                "name VARCHAR(100) NOT NULL, "
                "chat_id VARCHAR(64) NOT NULL, "
                "is_aceshigh BOOLEAN NOT NULL DEFAULT FALSE, "
                "is_betwar BOOLEAN NOT NULL DEFAULT FALSE, "
                "created_at DATETIME NOT NULL, "
                "UNIQUE KEY uq_telegram_recipient_user_chat (user_id, chat_id)"
                ")"
            )
        )
        existing = {
            column["name"]
            for column in inspect(engine).get_columns("telegram_recipients")
        }
        for column_name in ("is_aceshigh", "is_betwar"):
            if column_name not in existing:
                connection.execute(
                    text(
                        f"ALTER TABLE telegram_recipients "
                        f"ADD COLUMN {column_name} BOOLEAN NOT NULL DEFAULT FALSE"
                    )
                )
        # Recipients saved before the columns existed default to false on both,
        # which now means "send this person nothing". They were added when every
        # recipient got every alert, so restore that rather than silently
        # muting them. The form always sets at least one column, so a row with
        # neither can only be one of these.
        connection.execute(
            text(
                "UPDATE telegram_recipients SET is_aceshigh = 1, is_betwar = 1 "
                "WHERE is_aceshigh = 0 AND is_betwar = 0"
            )
        )
        if partner_host == "betwar.ag":
            # This deployment has its own database and bot. Membership choices
            # for another site are misleading here, so every local recipient
            # belongs only to BetWar.
            connection.execute(
                text(
                    "UPDATE telegram_recipients "
                    "SET is_aceshigh = 0, is_betwar = 1"
                )
            )


def migrate_user_columns():
    existing = {
        column["name"] for column in inspect(engine).get_columns("users")
    }
    if "password_encrypted" not in existing:
        with engine.begin() as connection:
            connection.execute(
                text("ALTER TABLE users ADD COLUMN password_encrypted TEXT NULL")
            )


def recover_schedules_on_startup():
    with database_session() as db:
        schedules = list(
            db.scalars(
                select(ScheduledLimit).where(
                    ScheduledLimit.status.in_(("pending", "running")),
                )
            )
        )
        now_utc = utc_now_naive()
        now_et = datetime.now(schedule_timezone)
        for schedule in schedules:
            # Jobs stranded in "running" by a crash or redeploy must run
            # again instead of staying stuck and uncancellable forever.
            schedule.status = "pending"
            is_recurring = bool(
                schedule.recurrence_days and schedule.recurrence_time
            )
            # A run that came due while the process was down stays due so the
            # worker executes it late rather than silently skipping it. Only
            # future recurring runs are realigned to Eastern time.
            if is_recurring and schedule.scheduled_for > now_utc:
                days = [int(day) for day in schedule.recurrence_days.split(",")]
                next_run = next_recurring_run(
                    days, schedule.recurrence_time, now_et
                )
                schedule.scheduled_for = next_run.astimezone(
                    timezone.utc
                ).replace(tzinfo=None)
        db.commit()


encryption_cipher()
Base.metadata.create_all(bind=engine)
migrate_user_columns()
migrate_schedule_columns()
migrate_limit_change_columns()
migrate_telegram_recipients()
recover_schedules_on_startup()
logger.info("Dashboard listening on http://%s:%s", server_host, server_port)

schedule_worker = threading.Thread(target=run_schedule_worker, daemon=True)
schedule_worker.start()
pinnacle_sampler = threading.Thread(target=run_pinnacle_sampler, daemon=True)
pinnacle_sampler.start()
limit_tracker = threading.Thread(target=run_limit_tracker, daemon=True)
limit_tracker.start()
server = ThreadingHTTPServer((server_host, server_port), DashboardHandler)

def stop_server(_signum, _frame):
    raise KeyboardInterrupt


signal.signal(signal.SIGTERM, stop_server)

try:
    server.serve_forever()
except KeyboardInterrupt:
    print("\nDashboard stopped")
finally:
    shutdown_event.set()
    server.server_close()
    schedule_worker.join(timeout=5)
