import csv
from datetime import datetime, timedelta, timezone
import base64
import hashlib
import ipaddress
import json
import logging
import os
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import threading
import uuid
import secrets
import signal
from zoneinfo import ZoneInfo
from collections import defaultdict, deque
from contextvars import ContextVar
from urllib.parse import urlsplit
import time  # Added for retry delays

import requests
from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import delete, inspect, select, text, update
from urllib.parse import urlparse, parse_qs
from database import Base, database_session, engine
from model import LoginSession, ScheduledLimit, User
from odds_comparison import (
    ComparisonError,
    build_league_comparison,
    build_trading_monitor,
    comparison_leagues,
)

backend_directory = Path(__file__).resolve().parent
app_directory = backend_directory.parent / "Frontend"
# Serialize logins per username only: a slow upstream response for one account
# must not block every other user's login.
login_locks_guard = threading.Lock()
login_locks = {}
data_lock = threading.Lock()


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

telegram_bot_token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
telegram_chat_id = os.getenv("TELEGRAM_CHAT_ID", "").strip()

login_url = (
    "https://aceshigh.ag/"
    "partner-api/partner/identity/partnerLoginRedir"
)

login_headers = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Content-Type": "application/x-www-form-urlencoded",
    "Origin": "https://aceshigh.ag",
    "Referer": "https://aceshigh.ag/v2/",
    "User-Agent": "Mozilla/5.0",
}

token_url = (
    "https://aceshigh.ag/"
    "partner-api/partner/identity/PartnerLoginFromToken/"
)

token_headers = {
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json;charset=UTF-8",
    "Origin": "https://aceshigh.ag",
    "Referer": "https://aceshigh.ag/partner/index.html",
    "User-Agent": "Mozilla/5.0",
}

api_headers = {
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json;charset=UTF-8",
    "Origin": "https://aceshigh.ag",
    "Referer": "https://aceshigh.ag/partner/index.html",
    "User-Agent": "Mozilla/5.0",
}


auth_sessions = {}
auth_sessions_lock = threading.Lock()
login_attempts = defaultdict(deque)
login_attempts_lock = threading.Lock()
current_auth = ContextVar("current_auth", default=None)
session_idle_timeout = timedelta(minutes=30)
session_max_lifetime = timedelta(hours=12)
login_attempt_window = timedelta(minutes=15)
login_attempt_limit = 5


def utc_now_naive():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def send_telegram_success_message(message):
    """
    Send a Telegram notification after a successful limit save.
    Failure here must never break the main limit-save flow.
    """
    if not telegram_bot_token or not telegram_chat_id:
        return

    try:
        response = requests.post(
            f"https://api.telegram.org/bot{telegram_bot_token}/sendMessage",
            json={
                "chat_id": telegram_chat_id,
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
        logger.warning("Telegram success message failed: %s", error)


def build_limit_success_message(
    account_id,
    organization_id,
    league_id,
    sport_type_id,
    period_number,
    field,
    new_value,
    change_type="Immediate limit",
):
    row = find_limit_row(
        account_id,
        organization_id,
        league_id,
        sport_type_id,
        period_number,
    )
    league_name = (
        row.get("leagueName")
        or row.get("LeagueName")
        or row.get("name")
        or f"League {league_id}"
    ) if row else f"League {league_id}"
    field_label = {
        "spread": "Spread",
        "moneyLine": "Money line",
        "total": "Total",
        "teamTotal": "Team total",
    }.get(field, field)
    return (
        f"Success: {change_type} saved on AcesHigh.ag\n"
        f"{league_name}\n"
        f"{field_label}: {new_value}\n"
        f"Applied successfully"
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
        "http": requests.Session(),
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
        "http": requests.Session(),
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
        upstream = requests.Session()
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
            raise RuntimeError(", ".join(token_data["Errors"]))

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


def load_agents(force=False):
    auth = auth_context()
    if auth["agents"] is not None and not force:
        return auth["agents"]
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

    # AccessHigh returns one expanded hierarchy node at a time. Walk every agent
    # node so accounts nested under intermediary agents are also available.
    while pending:
        parent_id = pending.pop(0)
        response = api_request(
            "GET",
            "https://aceshigh.ag/partner-api/partner/accounts/"
            f"hierarchy/node/{parent_id}?IdAgent={logged_in_agent_id}",
            timeout=30,
        )
        response.raise_for_status()
        data = response.json()
        if data.get("Errors"):
            raise RuntimeError(", ".join(data["Errors"]))

        payload = hierarchy_items(data.get("Payload") or [])
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
            "https://aceshigh.ag/partner-api/partner/agent/reports/"
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

    auth["agents"] = agents
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
        "https://aceshigh.ag/partner-api/partner/agent/search",
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
    return (
        "https://aceshigh.ag/partner-api/partner/"
        f"Backbone/GetOrganizationAll/{account_id}/true/S"
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

def dashboard_rows(account_id, force=False):
    rows = []
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
        "https://aceshigh.ag/partner-api/partner/Backbone/"
        f"GetOrganizationPeriods/{account_id}/{organization_id}/S",
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
):
    """Helper function to save a single limit change"""
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

    save_response = api_request(
        "POST",
        "https://aceshigh.ag/partner-api/partner/Backbone/save/",
        json=payload,
        timeout=30,
    )
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

    if return_full:
        telegram_message = build_limit_success_message(
            account_id,
            organization_id,
            league_id,
            sport_type_id,
            period_number,
            field,
            new_value,
            change_type=change_type,
        )
        send_telegram_success_message(telegram_message)

    if return_full:
        return {
            "message": "Limit updated successfully",
            "value": new_value,
            "rows": dashboard_rows(account_id),
        }
    return {"success": True, "value": new_value}

def save_limit_change(request_data):
    field = request_data.get("field")
    if field not in allowed_limit_fields:
        raise ValueError("Unsupported limit field")
    limit_mode = str(request_data.get("limitMode", "normal")).strip().lower()
    if limit_mode not in limit_mode_prefixes:
        raise ValueError("Unsupported limit mode")

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
                return_full=True
            )

        successful_updates = []
        failed_updates = []

        for child in child_rows:
            try:
                api_field = f"{limit_mode_prefixes[limit_mode]}{allowed_limit_fields[field]}"
                save_single_limit(
                    account_id,
                    safe_int(child["idOrganization"]),
                    safe_int(child["idLeague"]),
                    safe_int(child["idSportType"]),
                    safe_int(child.get("periodNumber", 0)),
                    field,
                    new_value,
                    api_field,
                    change_type="Early limit" if limit_mode == "early" else "Immediate limit",
                )
                successful_updates.append({
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

        if not successful_updates:
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

        return {
            "message": f"Updated {len(successful_updates)} leagues under parent limit",
            "value": new_value,
            "rows": dashboard_rows(account_id),
            "successful": successful_updates,
            "failed": failed_updates if failed_updates else None
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
                return_full=True
            )
        except RuntimeError as e:
            logger.exception("RuntimeError during limit save")
            raise ValueError(str(e)) from e


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


def recurring_description(recurrence_days, recurrence_time):
    days = [weekday_names[int(day)] for day in recurrence_days]
    day_text = (
        "Monday through Friday"
        if recurrence_days == [0, 1, 2, 3, 4]
        else ", ".join(days)
    )
    display_time = datetime.strptime(recurrence_time, "%H:%M").strftime("%I:%M %p")
    return f"Every {day_text} at {display_time} ET"


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
        recurrence_days = sorted({int(day) for day in request_data.get("recurrenceDays", [])})
        recurrence_time = str(request_data.get("recurrenceTime", ""))
        customer_support_agent = str(
            request_data.get("customerSupportAgent", "")
        ).strip()
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("Enter a valid limit, weekdays, and Eastern time") from error

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
    if recurrence_days and not customer_support_agent:
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
        "scheduledFor": scheduled_for.strftime("%Y-%m-%d %I:%M %p %Z"),
        "scheduledForUtc": scheduled_for_utc.isoformat(),
        "limitMode": limit_mode,
        "customerSupportAgent": customer_support_agent,
        "recurrence": (
            recurring_description(recurrence_days, recurrence_time)
            if stored_recurrence_days
            else "Runs once"
        ),
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


def record_job_result(job_id, error):
    try:
        with database_session() as db:
            stored_job = db.get(ScheduledLimit, job_id)
            if stored_job is None:
                return
            run_at = utc_now_naive()
            stored_job.last_run_at = run_at
            stored_job.last_run_status = "failed" if error else "completed"
            stored_job.error = str(error) if error else None
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


def execute_scheduled_job(job_id):
    auth = None
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
        request_data = {
            "accountId": job.account_id,
            "idOrganization": job.organization_id,
            "idLeague": job.league_id,
            "idSportType": job.sport_type_id,
            "periodNumber": job.period_number,
            "field": job.field,
            "value": job.value,
            "limitMode": "early" if job.is_early_limit else "normal",
        }
        try:
            save_limit_change(request_data)
        except PermissionError:
            # Access tokens are short-lived, while recurring schedules may run
            # days later. Renew securely and retry the write exactly once.
            try:
                auth["http"].close()
            except Exception:
                pass
            auth = refresh_worker_auth(user.id)
            auth["searchableAgentIds"] = {job.account_id}
            current_auth.set(auth)
            save_limit_change(request_data)
        record_job_result(job_id, error=None)
        logger.info("Scheduled limit completed: %s", job_id)
    except Exception as error:
        logger.exception("Scheduled limit failed: %s", job_id)
        record_job_result(job_id, error=error)
    finally:
        current_auth.set(None)
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

        shutdown_event.wait(1)


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

    with database_session() as db:
        jobs = list(
            db.scalars(
                schedule_query.order_by(ScheduledLimit.created_at)
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
    for scheduled_account_id in sorted({int(job.account_id) for job in jobs}):
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

    return [{
        "id": job.id,
        "status": job.status,
        "scheduledFor": job.scheduled_for.replace(
            tzinfo=timezone.utc
        ).astimezone(schedule_timezone).strftime("%Y-%m-%d %I:%M %p %Z"),
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
            job.last_run_at.replace(tzinfo=timezone.utc)
            .astimezone(schedule_timezone)
            .strftime("%Y-%m-%d %I:%M %p %Z")
            if job.last_run_at
            else None
        ),
        "lastRunAtUtc": (
            job.last_run_at.replace(tzinfo=timezone.utc).isoformat()
            if job.last_run_at
            else None
        ),
    } for job in jobs]



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

    def end_headers(self):
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

    def do_GET(self):
        path = self.request_path()
        query = parse_qs(urlsplit(self.path).query)

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
                })
            return

        if path.startswith("/api/") and not self.require_auth():
            return

        if path == "/api/agents":
            try:
                auth = auth_context()
                self.send_json(
                    200,
                    {
                        "parentId": auth["id"],
                        "parentName": auth["username"],
                        # Reuse the hierarchy after its first dashboard load.
                        # Authentication itself intentionally does not wait for
                        # this potentially expensive AcesHigh tree walk.
                        "agents": load_agents(),
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
                self.server_error(
                    "Comparison league discovery failed",
                    error,
                    "AcesHigh or OddsPapi league data is unavailable",
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
                self.server_error(
                    "League comparison failed",
                    error,
                    "Pinnacle or AcesHigh comparison data is unavailable",
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
                self.server_error(
                    "Trading monitor failed",
                    error,
                    "Pinnacle or AcesHigh monitor data is unavailable",
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

        if path in {
            "/",
            "/activity_logs",
            "/activity_logs/",
            "/pinnacle_aceshigh",
            "/pinnacle_aceshigh/",
        }:
            self.path = "/index.html"
            super().do_GET()
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
            except Exception:
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
            "/api/schedules",
            "/api/schedules/cancel",
            "/api/preferences",
        }:
            self.send_json(404, {"error": "Not found"})
            return

        if not self.require_auth():
            return
        try:
            request_data = self.read_json()
            result = (
                cancel_schedule(request_data)
                if path == "/api/schedules/cancel"
                else create_schedule(request_data)
                if path == "/api/schedules"
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
        "is_early_limit": "BOOLEAN NOT NULL DEFAULT FALSE",
        "last_run_status": "VARCHAR(20) NULL",
        "last_run_at": "DATETIME NULL",
        "customer_support_agent": "VARCHAR(100) NULL",
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
recover_schedules_on_startup()
logger.info("Dashboard listening on http://%s:%s", server_host, server_port)

schedule_worker = threading.Thread(target=run_schedule_worker, daemon=True)
schedule_worker.start()
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
