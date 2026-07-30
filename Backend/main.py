import csv
from datetime import datetime, timedelta, timezone
import base64
import hashlib
import json
import os
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import threading
import uuid
import secrets
from zoneinfo import ZoneInfo
from collections import defaultdict, deque
from contextvars import ContextVar
from urllib.parse import urlsplit

import requests
from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import inspect, select, text
from urllib.parse import urlparse, parse_qs

from database import Base, database_session, engine
from model import LoginSession, ScheduledLimit, User

backend_directory = Path(__file__).resolve().parent
app_directory = backend_directory.parent / "Frontend"
login_lock = threading.Lock()
data_lock = threading.Lock()
schedule_timezone = ZoneInfo("America/New_York")

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


def encryption_cipher():
    key = os.getenv("LIMITBOT_ENCRYPTION_KEY", "").encode("ascii")
    if not key:
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


def persist_login(auth, password, access_token, session_id):
    now = utc_now_naive()
    with database_session() as db:
        user = db.scalar(
            select(User).where(User.accesshigh_agent_id == auth["id"])
        )
        encrypted_token = encryption_cipher().encrypt(
            access_token.encode("utf-8")
        ).decode("ascii")
        if user is None:
            user = User(
                accesshigh_agent_id=auth["id"],
                username=auth["username"],
                password_hash=hash_password(password),
                access_token_encrypted=encrypted_token,
            )
            db.add(user)
            db.flush()
        else:
            user.username = auth["username"]
            user.password_hash = hash_password(password)
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
    with login_lock:
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
    }
    agents_by_id = {logged_in_agent_id: root}
    player_counts = {logged_in_agent_id: 0}
    discovery_order = [logged_in_agent_id]
    visited = {logged_in_agent_id}
    pending = [logged_in_agent_id]

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

        payload = data.get("Payload") or []
        if isinstance(payload, dict):
            payload = payload.get("Items") or payload.get("Children") or [payload]
        contains_full_tree = (
            any(
                item.get("ParentId") not in (None, parent_id)
                for item in payload
                if isinstance(item, dict)
            )
        )

        for item in payload:
            if item.get("Id") is None:
                continue
            # A single-node expansion belongs directly beneath the node that
            # was expanded. ParentId is only authoritative when AccessHigh
            # returns an already-flattened complete tree.
            item_parent_id = (
                int(item.get("ParentId") or parent_id)
                if contains_full_tree
                else parent_id
            )
            if item.get("IsPlayer", False):
                player_counts[item_parent_id] = player_counts.get(item_parent_id, 0) + 1
                continue
            agent_id = int(item["Id"])
            if agent_id in visited:
                continue
            visited.add(agent_id)
            count_hint = None
            for key in ("PlayerCount", "PlayersCount", "TotalPlayers", "Count"):
                try:
                    count_hint = int(item[key])
                    break
                except (KeyError, TypeError, ValueError):
                    pass
            agents_by_id[agent_id] = {
                "id": agent_id,
                "name": item.get("AgentName") or f"Agent {agent_id}",
                "parentId": item_parent_id,
                "directPlayers": 0,
                "countHint": count_hint,
            }
            discovery_order.append(agent_id)
            if not contains_full_tree and len(visited) < 500:
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

    def player_count(agent_id):
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
                for key in ("Id", "IdAgent", "AgentId", "IdAccount", "IdCustomer")
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

    # Search results come from Aces High's authorized hierarchy. Add them to the
    # per-session cache so the normal account validation remains the gatekeeper.
    cached_agents = load_agents()
    cached_ids = {agent["id"] for agent in cached_agents}
    cached_agents.extend(
        result for result in results if result["id"] not in cached_ids
    )
    return results


def validate_account_id(account_id):
    if account_id not in {agent["id"] for agent in load_agents()}:
        raise ValueError("Selected agent is not available under this login")
    return account_id


def account_name(account_id):
    return next(
        (agent["name"] for agent in load_agents() if agent["id"] == account_id),
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
        f"Backbone/GetOrganizationAll/{account_id}/false/S"
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
        if key not in seen_leagues:
            seen_leagues.add(key)
            refreshed_rows.append(row)

    unique_leagues = refreshed_rows
    league_cache[account_id] = refreshed_rows
    write_league_csv(unique_leagues, account_id)
    return unique_leagues


def get_leagues(account_id, force=False):
    if force or account_id not in league_cache:
        return refresh_leagues(account_id)
    return league_cache[account_id]


def dashboard_rows(account_id):
    rows = []
    for row in get_leagues(account_id):
        is_exotic = ".Exotics[" in row.get("JsonPath", "")
        is_game_setup = row.get("PeriodTypes.GameSetup") is True
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
                "spread": row.get("Spread.Amount"),
                "moneyLine": row.get("MoneyLine.Amount"),
                "total": row.get("Total.Amount"),
                "teamTotal": row.get("TeamTotal.Amount"),
                "hasAgentOverrides": any(
                    row.get(f"{key}.HasAgentOverrides") is True
                    for key in ("Spread", "MoneyLine", "Total", "TeamTotal")
                ),
            }
        )
    return rows


def load_period_rows(account_id, organization_id, league_id, force=False):
    cache_key = (account_id, organization_id, league_id)
    if not force and cache_key in period_cache:
        return period_cache[cache_key]

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
    period_cache[cache_key] = rows
    return rows


def period_dashboard_rows(account_id, organization_id, league_id):
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
            "spread": row.get("Spread.Amount"),
            "moneyLine": row.get("MoneyLine.Amount"),
            "total": row.get("Total.Amount"),
            "teamTotal": row.get("TeamTotal.Amount"),
        }
        for row in load_period_rows(account_id, organization_id, league_id)
    ]


def find_limit_row(
    account_id, organization_id, league_id, sport_type_id, period_number=0
):
    if period_number:
        return next(
            (
                row
                for row in load_period_rows(
                    account_id, organization_id, league_id
                )
                if int(row.get("PeriodNumber", 0)) == period_number
                and int(row.get("IdSportType", 0)) == sport_type_id
            ),
            None,
        )
    return next(
        (
            row
            for row in get_leagues(account_id)
            if int(row["IdOrganization"]) == organization_id
            and int(row["IdLeague"]) == league_id
            and int(row["IdSportType"]) == sport_type_id
        ),
        None,
    )


def save_limit_change(request_data):
    allowed_fields = {
        "spread": ("Spread", "Spread.Amount"),
        "moneyLine": ("MoneyLine", "MoneyLine.Amount"),
        "total": ("Total", "Total.Amount"),
        "teamTotal": ("TeamTotal", "TeamTotal.Amount"),
    }

    field = request_data.get("field")
    if field not in allowed_fields:
        raise ValueError("Unsupported limit field")

    try:
        account_id = validate_account_id(int(request_data["accountId"]))
        organization_id = int(request_data["idOrganization"])
        league_id = int(request_data["idLeague"])
        sport_type_id = int(request_data["idSportType"])
        period_number = int(request_data.get("periodNumber", 0) or 0)
        new_value = int(request_data["value"])
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("IDs and limit value must be whole numbers") from error

    if new_value < 0 or new_value > 1_000_000_000:
        raise ValueError("Limit must be between 0 and 1,000,000,000")

    matching_row = find_limit_row(
        account_id, organization_id, league_id, sport_type_id, period_number
    )
    if matching_row is None:
        raise ValueError("The selected league is not in the editable CSV")
    is_exotic = ".Exotics[" in matching_row.get("JsonPath", "")
    if is_exotic:
        raise ValueError("Props/Exotics are pending verification")
    is_game_setup = matching_row.get("PeriodTypes.GameSetup") is True
    if is_game_setup and field != "spread":
        raise ValueError("This league uses only the Spread limit")

    api_field, csv_field = allowed_fields[field]
    change = {
        "IdOrganization": organization_id,
        "IdSportType": sport_type_id,
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

    if period_number:
        load_period_rows(
            account_id, organization_id, league_id, force=True
        )
    else:
        refresh_leagues(account_id)
    verified_row = find_limit_row(
        account_id, organization_id, league_id, sport_type_id, period_number
    )

    if verified_row is None or int(verified_row.get(csv_field, -1)) != new_value:
        raise RuntimeError(
            "Aces High accepted the request but did not apply the new value"
        )

    return {
        "message": "Limit updated and verified",
        "value": new_value,
        "rows": dashboard_rows(account_id),
    }


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
        recurrence_days = sorted({int(day) for day in request_data["recurrenceDays"]})
        recurrence_time = str(request_data["recurrenceTime"])
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
    is_game_setup = matching_row.get("PeriodTypes.GameSetup") is True
    if is_game_setup and request_data["field"] != "spread":
        raise ValueError("This league uses only the Spread limit")
    if value < 0 or value > 1_000_000_000:
        raise ValueError("Limit must be between 0 and 1,000,000,000")

    scheduled_for = next_recurring_run(recurrence_days, recurrence_time)

    job_id = uuid.uuid4().hex
    scheduled_utc = scheduled_for.astimezone(timezone.utc).replace(tzinfo=None)
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
                recurrence_days=",".join(str(day) for day in recurrence_days),
                recurrence_time=recurrence_time,
                status="pending",
            )
        )
        db.commit()

    return {
        "id": job_id,
        "message": "Limit change scheduled",
        "scheduledFor": scheduled_for.strftime("%Y-%m-%d %I:%M %p %Z"),
        "recurrence": recurring_description(recurrence_days, recurrence_time),
    }


def run_schedule_worker():
    while True:
        with database_session() as db:
            due_jobs = list(
                db.scalars(
                    select(ScheduledLimit).where(
                        ScheduledLimit.status == "pending",
                        ScheduledLimit.scheduled_for <= utc_now_naive(),
                    )
                )
            )
            due_job_ids = [job.id for job in due_jobs]
            for job in due_jobs:
                job.status = "running"
            db.commit()

        for job_id in due_job_ids:
            try:
                with database_session() as db:
                    job = db.get(ScheduledLimit, job_id)
                    user = db.get(User, job.user_id)
                if user is None:
                    raise RuntimeError("Schedule owner no longer exists")
                auth = build_worker_auth(user)
                current_auth.set(auth)
                save_limit_change({
                    "accountId": job.account_id,
                    "idOrganization": job.organization_id,
                    "idLeague": job.league_id,
                    "idSportType": job.sport_type_id,
                    "periodNumber": job.period_number,
                    "field": job.field,
                    "value": job.value,
                })
                with database_session() as db:
                    stored_job = db.get(ScheduledLimit, job_id)
                    completed_at = utc_now_naive()
                    stored_job.completed_at = completed_at
                    stored_job.last_run_at = completed_at
                    stored_job.last_run_status = "completed"
                    stored_job.error = None
                    if stored_job.recurrence_days and stored_job.recurrence_time:
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
                    else:
                        stored_job.status = "completed"
                    db.commit()
                print(f"Scheduled limit completed: {job_id}")
            except Exception as error:
                with database_session() as db:
                    stored_job = db.get(ScheduledLimit, job_id)
                    if stored_job:
                        failed_at = utc_now_naive()
                        stored_job.last_run_at = failed_at
                        stored_job.last_run_status = "failed"
                        stored_job.error = str(error)
                        if stored_job.recurrence_days and stored_job.recurrence_time:
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
                        else:
                            stored_job.status = "failed"
                        db.commit()
                print(f"Scheduled limit failed: {job_id} - {error}")

        threading.Event().wait(1)


def schedule_status_rows(account_id):
    auth = auth_context()
    with database_session() as db:
        jobs = list(
            db.scalars(
                select(ScheduledLimit)
                .where(
                    ScheduledLimit.user_id == auth["userId"],
                    ScheduledLimit.account_id == account_id,
                )
                .order_by(ScheduledLimit.created_at)
            )
        )
        return [{
            "id": job.id,
            "status": job.status,
            "scheduledFor": job.scheduled_for.replace(
                tzinfo=timezone.utc
            ).astimezone(schedule_timezone).strftime("%Y-%m-%d %I:%M %p %Z"),
            "accountId": job.account_id,
            "idOrganization": job.organization_id,
            "idLeague": job.league_id,
            "idSportType": job.sport_type_id,
            "periodNumber": job.period_number,
            "field": job.field,
            "value": job.value,
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
        } for job in jobs]


class DashboardHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(
            *args,
            directory=str(app_directory),
            **kwargs,
        )

    def request_path(self):
        return urlsplit(self.path).path

    def session_id(self):
        cookies = {}
        for part in self.headers.get("Cookie", "").split(";"):
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
        origin = self.headers.get("Origin")
        host = self.headers.get("Host")
        return origin in {f"http://{host}", f"https://{host}"}

    def is_https(self):
        return (
            self.headers.get("X-Forwarded-Proto", "").lower() == "https"
            or getattr(self.connection, "cipher", None) is not None
        )

    def session_cookie(self, session_id, delete=False):
        secure = "; Secure" if self.is_https() else ""
        expiry = "; Max-Age=0" if delete else f"; Max-Age={int(session_max_lifetime.total_seconds())}"
        return (
            f"limitbot_session={session_id}; HttpOnly; SameSite=Strict; "
            f"Path=/{expiry}{secure}"
        )

    def login_rate_key(self, username):
        return (self.client_address[0], username.casefold())

    def login_rate_limited(self, key):
        cutoff = datetime.now(timezone.utc) - login_attempt_window
        with login_attempts_lock:
            attempts = login_attempts[key]
            while attempts and attempts[0] < cutoff:
                attempts.popleft()
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
            "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
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
            auth = auth_context()
            self.send_json(
                200,
                {
                    "parentId": auth["id"],
                    "parentName": auth["username"],
                    "agents": load_agents(),
                    "preferences": user_preferences(auth),
                },
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
                self.send_json(502, {"error": str(error)})
            return

        if path == "/api/leagues":
            try:
                account_id = validate_account_id(int(query["accountId"][0]))
                self.send_json(
                    200,
                    {
                        "accountId": account_id,
                        "accountName": account_name(account_id),
                        "rows": dashboard_rows(account_id),
                    },
                )
            except (KeyError, TypeError, ValueError) as error:
                self.send_json(400, {"error": str(error)})
            except Exception as error:
                self.send_json(502, {"error": str(error)})
            return

        if path == "/api/schedules":
            try:
                account_id = validate_account_id(int(query["accountId"][0]))
                self.send_json(
                    200, {"schedules": schedule_status_rows(account_id)}
                )
            except (KeyError, TypeError, ValueError) as error:
                self.send_json(400, {"error": str(error)})
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
                            account_id, organization_id, league_id
                        )
                    },
                )
            except (KeyError, TypeError, ValueError) as error:
                self.send_json(400, {"error": str(error)})
            except Exception as error:
                self.send_json(502, {"error": str(error)})
            return

        if path == "/":
            self.redirect("/index.html")
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
                # Verify and cache the hierarchy before considering login complete.
                load_agents()
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

        if path not in {"/api/limits", "/api/schedules", "/api/preferences"}:
            self.send_json(404, {"error": "Not found"})
            return

        if not self.require_auth():
            return
        try:
            request_data = self.read_json()
            result = (
                create_schedule(request_data)
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
            self.send_json(502, {"error": str(error)})


def migrate_schedule_columns():
    existing = {
        column["name"] for column in inspect(engine).get_columns("scheduled_limits")
    }
    additions = {
        "recurrence_days": "VARCHAR(20) NULL",
        "recurrence_time": "VARCHAR(5) NULL",
        "last_run_status": "VARCHAR(20) NULL",
        "last_run_at": "DATETIME NULL",
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


def realign_recurring_schedules_to_et():
    with database_session() as db:
        schedules = list(
            db.scalars(
                select(ScheduledLimit).where(
                    ScheduledLimit.recurrence_days.is_not(None),
                    ScheduledLimit.recurrence_time.is_not(None),
                    ScheduledLimit.status.in_(("pending", "running")),
                )
            )
        )
        now_et = datetime.now(schedule_timezone)
        for schedule in schedules:
            days = [int(day) for day in schedule.recurrence_days.split(",")]
            next_run = next_recurring_run(days, schedule.recurrence_time, now_et)
            schedule.scheduled_for = next_run.astimezone(timezone.utc).replace(
                tzinfo=None
            )
            schedule.status = "pending"
        db.commit()


encryption_cipher()
Base.metadata.create_all(bind=engine)
migrate_schedule_columns()
realign_recurring_schedules_to_et()
print("Dashboard: http://127.0.0.1:8000")

schedule_worker = threading.Thread(target=run_schedule_worker, daemon=True)
schedule_worker.start()
server = ThreadingHTTPServer(("127.0.0.1", 8000), DashboardHandler)

try:
    server.serve_forever()
except KeyboardInterrupt:
    print("\nDashboard stopped")
finally:
    server.server_close()
