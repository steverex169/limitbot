import csv
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import threading
import uuid
from urllib.parse import urlsplit

import requests
from urllib.parse import urlparse, parse_qs

session = requests.Session()
app_directory = Path(__file__).resolve().parent
login_lock = threading.Lock()
schedule_lock = threading.Lock()
schedule_file = app_directory / "scheduled_limits.json"
pakistan_timezone = timezone(timedelta(hours=5), name="PKT")

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

credentials_file = app_directory / "credentials.json"
if not credentials_file.exists():
    raise RuntimeError(
        "Create credentials.json with your Aces High username and password"
    )
with credentials_file.open("r", encoding="utf-8-sig") as stored_credentials:
    login_data = json.load(stored_credentials)
if not login_data.get("username") or not login_data.get("password"):
    raise RuntimeError("credentials.json must contain username and password")

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


def authenticate():
    with login_lock:
        login_response = session.post(
            login_url,
            headers=login_headers,
            data=login_data,
            allow_redirects=False,
            timeout=30,
        )
        print("First login status:", login_response.status_code)

        if login_response.status_code != 302:
            raise RuntimeError(
                f"Aces High login failed with status {login_response.status_code}"
            )

        redirect_url = login_response.headers.get("Location", "")
        fragment = urlparse(redirect_url).fragment
        query_string = fragment.split("?", 1)[1] if "?" in fragment else ""
        fresh_tokens = parse_qs(query_string).get("t", [])

        if not fresh_tokens:
            raise RuntimeError(f"Aces High login failed: {redirect_url}")

        print("Fresh token received")
        token_response = session.post(
            token_url,
            headers=token_headers,
            json={"token": fresh_tokens[0], "version": "2.2.20"},
            timeout=30,
        )
        print("Token login status:", token_response.status_code)
        token_response.raise_for_status()
        token_data = token_response.json()

        if token_data.get("Errors"):
            raise RuntimeError(", ".join(token_data["Errors"]))

        access_token = token_data.get("Payload", {}).get("AccessToken")
        if not access_token:
            raise RuntimeError("Aces High did not return an access token")

        api_headers["Authorization"] = f"Bearer {access_token}"
        print("Login successful")


def api_request(method, url, **kwargs):
    authorization_used = api_headers.get("Authorization")
    response = session.request(method, url, headers=api_headers, **kwargs)

    if response.status_code != 401:
        return response

    print("Access token rejected. Logging in again...")
    if api_headers.get("Authorization") == authorization_used:
        authenticate()

    return session.request(method, url, headers=api_headers, **kwargs)


authenticate()

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

organization_url = (
    "https://aceshigh.ag/partner-api/partner/"
    "Backbone/GetOrganizationAll/968877/false/S"
)

league_rows = []
period_cache = {}


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


csv_path = Path(__file__).resolve().parent / "editable_leagues.csv"
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


def write_league_csv(rows):
    all_fieldnames = set()
    for row in rows:
        all_fieldnames.update(row)

    fieldnames = leading_fieldnames + sorted(
        all_fieldnames.difference(leading_fieldnames)
    )

    with csv_path.open("w", newline="", encoding="utf-8-sig") as csv_file:
        writer = csv.DictWriter(csv_file, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def refresh_leagues():
    global unique_leagues

    response = api_request(
        "GET",
        organization_url,
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
    write_league_csv(unique_leagues)
    return unique_leagues


def dashboard_rows():
    rows = []
    for row in unique_leagues:
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


def load_period_rows(organization_id, league_id, force=False):
    cache_key = (organization_id, league_id)
    if not force and cache_key in period_cache:
        return period_cache[cache_key]

    response = api_request(
        "GET",
        "https://aceshigh.ag/partner-api/partner/Backbone/"
        f"GetOrganizationPeriods/968877/{organization_id}/S",
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


def period_dashboard_rows(organization_id, league_id):
    return [
        {
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
        for row in load_period_rows(organization_id, league_id)
    ]


def find_limit_row(organization_id, league_id, sport_type_id, period_number=0):
    if period_number:
        return next(
            (
                row
                for row in load_period_rows(organization_id, league_id)
                if int(row.get("PeriodNumber", 0)) == period_number
                and int(row.get("IdSportType", 0)) == sport_type_id
            ),
            None,
        )
    return next(
        (
            row
            for row in unique_leagues
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
        organization_id, league_id, sport_type_id, period_number
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
        "IdCustomer": "968877",
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
        load_period_rows(organization_id, league_id, force=True)
    else:
        refresh_leagues()
    verified_row = find_limit_row(
        organization_id, league_id, sport_type_id, period_number
    )

    if verified_row is None or int(verified_row.get(csv_field, -1)) != new_value:
        raise RuntimeError(
            "Aces High accepted the request but did not apply the new value"
        )

    return {
        "message": "Limit updated and verified",
        "value": new_value,
        "rows": dashboard_rows(),
    }


def read_schedules():
    if not schedule_file.exists():
        return []
    try:
        with schedule_file.open("r", encoding="utf-8") as stored_schedules:
            data = json.load(stored_schedules)
            return data if isinstance(data, list) else []
    except (OSError, json.JSONDecodeError):
        return []


scheduled_limits = read_schedules()


def write_schedules():
    with schedule_file.open("w", encoding="utf-8") as stored_schedules:
        json.dump(scheduled_limits, stored_schedules, indent=2)


def create_schedule(request_data):
    try:
        organization_id = int(request_data["idOrganization"])
        league_id = int(request_data["idLeague"])
        sport_type_id = int(request_data["idSportType"])
        period_number = int(request_data.get("periodNumber", 0) or 0)
        value = int(request_data["value"])
        scheduled_for = datetime.fromisoformat(str(request_data["scheduledFor"]))
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("Enter a valid limit and Pakistan date/time") from error

    matching_row = find_limit_row(
        organization_id, league_id, sport_type_id, period_number
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

    if scheduled_for.tzinfo is None:
        scheduled_for = scheduled_for.replace(tzinfo=pakistan_timezone)
    else:
        scheduled_for = scheduled_for.astimezone(pakistan_timezone)

    now = datetime.now(pakistan_timezone)
    if scheduled_for <= now:
        raise ValueError("Schedule time must be in the future")
    if scheduled_for > now + timedelta(days=365):
        raise ValueError("Schedule time cannot be more than one year ahead")

    job = {
        "id": uuid.uuid4().hex,
        "scheduledFor": scheduled_for.isoformat(),
        "status": "pending",
        "request": {
            "idOrganization": organization_id,
            "idLeague": league_id,
            "idSportType": sport_type_id,
            "periodNumber": period_number,
            "field": request_data["field"],
            "value": value,
        },
    }
    with schedule_lock:
        scheduled_limits.append(job)
        write_schedules()

    return {
        "id": job["id"],
        "message": "Limit change scheduled",
        "scheduledFor": scheduled_for.strftime("%Y-%m-%d %I:%M %p PKT"),
    }


def run_schedule_worker():
    while True:
        due_jobs = []
        now = datetime.now(pakistan_timezone)
        with schedule_lock:
            for job in scheduled_limits:
                if job.get("status") != "pending":
                    continue
                try:
                    due_at = datetime.fromisoformat(job["scheduledFor"])
                except (KeyError, ValueError):
                    job["status"] = "failed"
                    job["error"] = "Invalid stored schedule time"
                    continue
                if due_at <= now:
                    job["status"] = "running"
                    due_jobs.append(job)
            if due_jobs:
                write_schedules()

        for job in due_jobs:
            try:
                save_limit_change(job["request"])
                job["status"] = "completed"
                job["completedAt"] = datetime.now(pakistan_timezone).isoformat()
                print(f"Scheduled limit completed: {job['id']}")
            except Exception as error:
                job["status"] = "failed"
                job["error"] = str(error)
                print(f"Scheduled limit failed: {job['id']} - {error}")
            finally:
                with schedule_lock:
                    write_schedules()

        threading.Event().wait(1)


def schedule_status_rows():
    with schedule_lock:
        return [
            {
                "id": job["id"],
                "status": job["status"],
                "scheduledFor": datetime.fromisoformat(job["scheduledFor"]).strftime(
                    "%Y-%m-%d %I:%M %p PKT"
                ),
                **job["request"],
            }
            for job in scheduled_limits
            if job.get("status") in {"pending", "running", "completed", "failed"}
        ]


class DashboardHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(
            *args,
            directory=str(app_directory),
            **kwargs,
        )

    def request_path(self):
        return urlsplit(self.path).path

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

    def redirect(self, location):
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def do_GET(self):
        path = self.request_path()

        if path == "/api/leagues":
            self.send_json(
                200,
                {
                    "accountId": 968877,
                    "accountName": "AHAGENT2",
                    "rows": dashboard_rows(),
                },
            )
            return

        if path == "/api/schedules":
            self.send_json(200, {"schedules": schedule_status_rows()})
            return

        if path == "/api/periods":
            try:
                query = parse_qs(urlsplit(self.path).query)
                organization_id = int(query["idOrganization"][0])
                league_id = int(query["idLeague"][0])
                self.send_json(
                    200,
                    {"rows": period_dashboard_rows(organization_id, league_id)},
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

        if path not in {"/api/limits", "/api/schedules"}:
            self.send_json(404, {"error": "Not found"})
            return

        try:
            request_data = self.read_json()
            result = (
                create_schedule(request_data)
                if path == "/api/schedules"
                else save_limit_change(request_data)
            )
            self.send_json(200, result)
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
        except Exception as error:
            self.send_json(502, {"error": str(error)})


print("Loading editable leagues...")
refresh_leagues()
print(f"Saved {len(unique_leagues)} league rows to: {csv_path}")
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
