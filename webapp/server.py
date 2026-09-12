import hashlib
import io
import json
import os
import re
import urllib.request
import urllib.error
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.table import Table, TableStyleInfo

ROOT = os.path.dirname(os.path.abspath(__file__))
TASKS_PATH = os.path.join(ROOT, "..", "tasks.json")
PLANE_CONFIG_PATH = os.path.join(ROOT, "plane_config.json")
# PLANE_HOST and every other Plane setting are per-install: no org's cookie/workspace/project/user
# is baked into the code. They live only in plane_config.json (gitignored, never shipped) and/or
# env vars, and are filled in per-user via the in-app "Connect to Plane" flow (see
# discover_plane_setup below) — nothing here should ever again hardcode ALT Mobility's own ids.
PLANE_HOST = os.environ.get("PLANE_HOST", "https://plane.alt-mobility.com")
PLANE_PRIORITY_MAP = {"P1": "urgent", "P2": "high", "P3": "medium", "P4": "low"}
STATIC_DIR = os.path.join(ROOT, "static")

STATUSES = ["To Do", "In Progress", "In Review", "Pending", "Done", "Cancelled"]
PRIORITIES = ["P1", "P2", "P3", "P4"]
TYPES = ["Task", "Review"]
DATE_FIELDS = ("discussed_from", "discussed_to", "start_date", "due_date", "done_at", "closed_at", "cancelled_at")
ACTIVITY_LIMIT = 200
ACTIVITY_ORDER = {
    "created": 0,
    "status_snapshot": 1,
    "status_changed": 2,
    "completed": 3,
    "reopened": 4,
    "date_changed": 5,
    "attachment_added": 6,
    "attachment_removed": 7,
    "archived": 8,
    "restored": 9,
    "cancelled": 10,
    "cancel_reason_changed": 11,
    "comment": 12,
}


def now_local():
    return datetime.now().astimezone()


def today_local():
    return now_local().date().isoformat()


def iso_now():
    return now_local().isoformat(timespec="seconds")


def clean_date(v):
    if not v:
        return None
    if isinstance(v, str) and re.match(r"^\d{4}-\d{2}-\d{2}$", v):
        return v
    return None


def date_from_any(*values):
    for value in values:
        if not value:
            continue
        if isinstance(value, str) and re.match(r"^\d{4}-\d{2}-\d{2}", value):
            return value[:10]
    return today_local()


def activity_key(a):
    return (
        a.get("type"),
        a.get("date"),
        a.get("from") or a.get("from_status") or a.get("from_value"),
        a.get("to") or a.get("to_status") or a.get("to_value"),
        a.get("field"),
        json.dumps(a.get("value"), sort_keys=True),
        a.get("inferred", False),
        a.get("note") or a.get("reason") or "",
        a.get("at") or "",
    )


def append_activity(task, activity):
    history = task.setdefault("activity_history", [])
    key = activity_key(activity)
    if any(activity_key(existing) == key for existing in history):
        return False
    history.append(activity)
    sort_history(history)
    if len(history) > ACTIVITY_LIMIT:
        del history[: len(history) - ACTIVITY_LIMIT]
    return True


def append_activity_tracked(task, activity, sink):
    """Same as append_activity, but also records the activity in `sink` when it was actually
    added (not a dedup no-op) — lets a request handler know exactly what changed just now, so it
    can auto-sync only that diff to Plane. See sync_plane_on_activity."""
    if append_activity(task, activity):
        sink.append(activity)
        return True
    return False


def sort_history(history):
    history.sort(key=lambda a: (a.get("at") or a.get("date") or "", ACTIVITY_ORDER.get(a.get("type"), 99)))


def make_activity(task, activity_type, *, inferred=False, source="system", date_value=None, at=None, **extra):
    at = at or iso_now()
    day = date_value or date_from_any(at)
    activity = {
        "type": activity_type,
        "date": day,
        "at": at,
        "inferred": inferred,
        "source": source,
    }
    activity.update(extra)
    digest = hashlib.sha1(json.dumps(activity_key(activity), sort_keys=True).encode("utf-8")).hexdigest()[:10]
    activity["id"] = f"{task.get('id', 'task')}:{activity_type}:{day}:{digest}"
    return activity


def load_tasks():
    # First run on a fresh clone/install: no tasks.json yet — create an empty one instead of
    # crashing, so a new user (or a new DMG-style install with a fresh data dir) just works.
    if not os.path.exists(TASKS_PATH):
        data = {"tasks": [], "_meta": {}, "settings": {}}
        migrate_data(data)
        save_tasks(data)
        return data
    with open(TASKS_PATH) as f:
        data = json.load(f)
    migrate_data(data)
    return data


def save_tasks(data):
    data.setdefault("_meta", {})
    data["_meta"]["last_regenerated"] = today_local()
    with open(TASKS_PATH, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


def migrate_data(data):
    data.setdefault("_meta", {})
    data["_meta"]["schema_version"] = 2
    data["_meta"].setdefault("activity_migration", "Old tasks receive inferred created/status snapshots only; unknown historical transitions are not invented.")
    data.setdefault("settings", {})
    data["settings"].setdefault("daily_update_backlog_limit", 5)
    data.setdefault("tasks", [])
    for task in data["tasks"]:
        normalize_task(task)


def normalize_task(task):
    task.setdefault("id", "")
    task["title"] = (task.get("title") or "").strip() or "Untitled task"
    task["project"] = as_list(task.get("project"))
    task["tags"] = as_list(task.get("tags"))
    task["discussed_with"] = as_list(task.get("discussed_with"))
    task["attachments"] = as_list(task.get("attachments"))
    task["status"] = task.get("status") if task.get("status") in STATUSES else "To Do"
    task["priority"] = task.get("priority") if task.get("priority") in PRIORITIES else "P3"
    task["type"] = task.get("type") if task.get("type") in TYPES else "Task"
    task["cancel_reason"] = (task.get("cancel_reason") or "").strip()
    for field in DATE_FIELDS:
        task[field] = clean_date(task.get(field))
    if not task.get("discussed_from"):
        task["discussed_from"] = date_from_any(task.get("created_at"), task.get("updated_at"))
    if not task.get("discussed_to"):
        task["discussed_to"] = task.get("discussed_from")
    task["month"] = month_from(task.get("discussed_from"))
    task["updated_at"] = clean_date(task.get("updated_at")) or date_from_any(task.get("updated_ts"), task.get("created_at"), task.get("discussed_from"))
    task["created_at"] = task.get("created_at") or f"{task['updated_at']}T00:00:00"
    task["updated_ts"] = task.get("updated_ts") or task.get("created_at")
    task["archived_at"] = task.get("archived_at") or None
    task["plane_issue_id"] = task.get("plane_issue_id") or None
    task["plane_url"] = task.get("plane_url") or None
    task["plane_cycle_id"] = task.get("plane_cycle_id") or None
    task["plane_cycle_name"] = task.get("plane_cycle_name") or None
    task["plane_cycle_url"] = task.get("plane_cycle_url") or None
    if not isinstance(task.get("activity_history"), list):
        task["activity_history"] = []
    if not task["activity_history"]:
        created_date = date_from_any(task.get("created_at"), task.get("discussed_from"), task.get("updated_at"))
        append_activity(task, make_activity(task, "created", inferred=True, source="migration", date_value=created_date, at=task.get("created_at")))
        status_date = date_from_any(task.get("done_at"), task.get("closed_at"), task.get("updated_at"), task.get("discussed_from"))
        append_activity(
            task,
            make_activity(
                task,
                "status_snapshot",
                inferred=True,
                source="migration",
                date_value=status_date,
                at=task.get("updated_ts"),
                to=task["status"],
            ),
        )
        if task["status"] == "Done" and task.get("done_at"):
            append_activity(
                task,
                make_activity(task, "completed", inferred=True, source="migration", date_value=task["done_at"], at=task.get("updated_ts")),
            )
    sort_history(task["activity_history"])


def next_id(tasks):
    nums = []
    for t in tasks:
        m = re.match(r"T(\d+)", t.get("id", ""))
        if m:
            nums.append(int(m.group(1)))
    n = (max(nums) + 1) if nums else 1
    return f"T{n:03d}"


def as_list(v):
    if v is None:
        return []
    if isinstance(v, list):
        return [str(x).strip() for x in v if str(x).strip()]
    return [p.strip() for p in str(v).split(",") if p.strip()]


def month_from(iso_date):
    if not iso_date:
        return now_local().strftime("%B")
    try:
        y, m, d = [int(x) for x in iso_date.split("-")]
        return date(y, m, d).strftime("%B")
    except (ValueError, TypeError):
        return now_local().strftime("%B")


CLOSED_STATUSES = {"Done", "Cancelled"}
STALE_DAYS = 7


def is_closed(t):
    return t.get("status") in CLOSED_STATUSES


def is_overdue(t):
    return not is_closed(t) and bool(t.get("due_date")) and t["due_date"] < today_local()


def is_stale(t):
    if is_closed(t):
        return False
    updated = t.get("updated_at") or ""
    cutoff = (now_local() - timedelta(days=STALE_DAYS)).date().isoformat()
    return updated <= cutoff


def filter_tasks_for_export(tasks, q):
    def qval(key):
        v = q.get(key)
        return v[0] if v else ""

    status = qval("status")
    project = qval("project")
    tag = qval("tag")
    ttype = qval("type")
    date_from = qval("dateFrom")
    date_to = qval("dateTo")
    search = qval("search").lower()
    special = qval("filter")  # today | overdue | high | stale | archived | review | "" (all)

    out = []
    for t in tasks:
        archived = bool(t.get("archived_at"))
        if special == "archived":
            if not archived:
                continue
        else:
            if archived:
                continue
        if status and t.get("status") != status:
            continue
        if project and project not in (t.get("project") or []):
            continue
        if tag and tag not in (t.get("tags") or []):
            continue
        if ttype and (t.get("type") or "Task") != ttype:
            continue
        if date_from and (t.get("updated_at") or "") < date_from:
            continue
        if date_to and (t.get("updated_at") or "") > date_to:
            continue
        if special == "overdue" and not is_overdue(t):
            continue
        if special == "high" and (t.get("priority") or "P3") not in ("P1", "P2"):
            continue
        if special == "stale" and not is_stale(t):
            continue
        if special == "review" and (t.get("type") or "Task") != "Review":
            continue
        if special == "today" and (t.get("updated_at") != today_local()):
            continue
        if search:
            hay = " ".join([
                t.get("title", ""), t.get("notes", ""),
                *(t.get("discussed_with") or []), *(t.get("project") or []), *(t.get("tags") or []),
            ]).lower()
            if search not in hay:
                continue
        out.append(t)
    return out


def load_plane_config():
    cfg = {}
    if os.path.exists(PLANE_CONFIG_PATH):
        with open(PLANE_CONFIG_PATH) as f:
            cfg = json.load(f)
    # Env vars win when set — lets someone self-host this (Docker, a shared server, etc.)
    # without ever touching the UI or the config file, per-instance, no code changes.
    for key, env_name in (
        ("pat", "PLANE_PAT"),
        ("cookie", "PLANE_COOKIE"),
        ("workspace", "PLANE_WORKSPACE"),
        ("project_id", "PLANE_PROJECT_ID"),
        ("assignee_id", "PLANE_ASSIGNEE_ID"),
    ):
        val = os.environ.get(env_name)
        if val:
            cfg[key] = val
    return cfg


def save_plane_config(cfg):
    with open(PLANE_CONFIG_PATH, "w") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
        f.write("\n")


def extract_plane_cookie(raw):
    """The Plane-cookie settings box expects a raw `Cookie:` header value, but people naturally
    paste a whole 'Copy as cURL' command instead (this project's own working examples are all curls).
    If the input looks like a curl invocation, pull the cookie out of it (`-b '...'`, `--cookie '...'`,
    or `-H 'Cookie: ...'`); otherwise assume it's already a plain cookie string and use it as-is."""
    raw = (raw or "").strip()
    if not raw:
        return raw
    patterns = [
        r"(?:-b|--cookie)\s+'([^']*)'",
        r'(?:-b|--cookie)\s+"([^"]*)"',
        r"-H\s+'Cookie:\s*([^']*)'",
        r'-H\s+"Cookie:\s*([^"]*)"',
    ]
    for pat in patterns:
        m = re.search(pat, raw, re.IGNORECASE)
        if m and m.group(1).strip():
            return m.group(1).strip()
    return raw


def plane_state_id(cfg, status):
    state_name = (cfg.get("status_map") or {}).get(status)
    return (cfg.get("states") or {}).get(state_name)


def _plane_request(cfg, method, path, payload=None, force_cookie=False):
    """Low-level helper for any Plane API call. Prefers PAT (X-Api-Key) when set, falls back to cookie auth.
    Pass force_cookie=True to skip PAT and use cookie even when PAT is configured (e.g. on rate-limit)."""
    pat = cfg.get("pat") if not force_cookie else None
    cookie = cfg.get("cookie")
    workspace = cfg.get("workspace")
    project_id = cfg.get("project_id")
    # Cookie auth uses /api/ prefix; PAT uses /api/v1/ — translate path when forcing cookie on a v1 path
    if force_cookie and path.startswith("/api/v1/"):
        path = "/api/" + path[len("/api/v1/"):]
    url = f"{PLANE_HOST}{path}"
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    if pat:
        req.add_header("X-Api-Key", pat)
    else:
        req.add_header("Cookie", cookie)
        req.add_header("Origin", PLANE_HOST)
        req.add_header("Referer", f"{PLANE_HOST}/{workspace}/projects/{project_id}/issues/")
        req.add_header("User-Agent", "Mozilla/5.0 (task-tracker integration)")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8")
            try:
                parsed = json.loads(raw) if raw else None
            except Exception:
                parsed = None
            return resp.status, parsed, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        return e.code, None, raw
    except urllib.error.URLError as e:
        return None, None, str(e.reason)
    except Exception as e:
        return None, None, str(e)


PLANE_GROUP_TO_STATUS = {
    "backlog": "To Do",
    "unstarted": "To Do",
    "started": "In Progress",
    "completed": "Done",
    "cancelled": "Cancelled",
}

LABEL_COLORS = [
    "#F87171", "#FB923C", "#FBBF24", "#A3E635", "#34D399",
    "#22D3EE", "#60A5FA", "#A78BFA", "#F472B6", "#94A3B8",
]


def _plane_base(cfg):
    """Returns the correct API base path: /api/v1 for PAT, /api for cookie."""
    return "/api/v1" if cfg.get("pat") else "/api"


def _wpp(cfg):
    """Workspace-project path prefix: /api[/v1]/workspaces/{ws}/projects/{pid}"""
    ws = cfg.get("workspace", "")
    pid = cfg.get("project_id", "")
    return f"{_plane_base(cfg)}/workspaces/{ws}/projects/{pid}"


def _label_color(name):
    return LABEL_COLORS[abs(hash(name)) % len(LABEL_COLORS)]


def _refresh_plane_labels(cfg):
    """Fetches all project labels from Plane and caches them in cfg['labels_cache'].
    Returns the cache dict {name_lower: {"id":..., "name":..., "color":...}}."""
    status, data, _ = _plane_request(cfg, "GET", f"{_wpp(cfg)}/labels/")
    if status != 200:
        return cfg.get("labels_cache") or {}
    items = data if isinstance(data, list) else (data.get("results") if isinstance(data, dict) else [])
    cache = {}
    for lbl in (items or []):
        if lbl.get("name") and lbl.get("id"):
            cache[lbl["name"].lower()] = {"id": lbl["id"], "name": lbl["name"], "color": lbl.get("color", "#94A3B8")}
    cfg["labels_cache"] = cache
    return cache


def _resolve_label_ids(cfg, names):
    """Maps a list of label names to Plane label IDs. Creates labels that don't exist yet.
    Returns a list of IDs. Never raises — a failure just means that name is skipped."""
    if not names:
        return []
    cache = cfg.get("labels_cache") or _refresh_plane_labels(cfg)
    ids = []
    for name in names:
        name = name.strip()
        if not name:
            continue
        key = name.lower()
        if key in cache:
            ids.append(cache[key]["id"])
            continue
        # Fuzzy: check if any existing label contains this name or vice versa
        match = next(
            (v for k, v in cache.items() if key in k or k in key),
            None
        )
        if match:
            ids.append(match["id"])
            continue
        # Create the label
        try:
            s, d, _ = _plane_request(cfg, "POST", f"{_wpp(cfg)}/labels/", {
                "name": name,
                "color": _label_color(name),
            })
            if s in (200, 201) and isinstance(d, dict) and d.get("id"):
                cache[key] = {"id": d["id"], "name": name, "color": d.get("color", "")}
                cfg["labels_cache"] = cache
                ids.append(d["id"])
        except Exception:
            pass
    return ids


def discover_plane_setup(cfg):
    """Auto-fills Plane config: user id (for assignee_ids), project states, and label cache.
    With PAT, the /me/ endpoint isn't exposed in v1, so we skip the user lookup and rely on the
    assignee_id already in config (set during initial cookie-based discovery, or hand-edited).
    With cookie auth the full me + states flow runs as before."""
    if not cfg.get("pat"):
        # Cookie path: verify session via /me/
        me_status, me_data, me_raw = _plane_request(cfg, "GET", "/api/users/me/")
        if me_status != 200 or not me_data:
            return {"error": f"Could not verify Plane session ({me_status}): {(me_raw or '')[:200]}"}
        cfg["assignee_id"] = me_data.get("id")
        cfg["assignee_email"] = me_data.get("email")
        assignee_email = me_data.get("email")
    else:
        assignee_email = cfg.get("assignee_email", "")

    st_status, st_data, st_raw = _plane_request(cfg, "GET", f"{_wpp(cfg)}/states/")
    if st_status != 200:
        return {"error": f"Could not fetch project states ({st_status}): {(st_raw or '')[:200]}"}

    states_list = st_data if isinstance(st_data, list) else (st_data.get("results") if isinstance(st_data, dict) else [])
    if not states_list:
        return {"error": f"Could not fetch project states: empty response"}

    states = {s["name"]: s["id"] for s in states_list if s.get("name") and s.get("id")}

    def norm(s):
        return s.lower().replace(" ", "")

    # Never clobber an already hand-tuned mapping — only fill in statuses that aren't mapped yet.
    status_map = dict(cfg.get("status_map") or {})
    for local_status in STATUSES:
        if status_map.get(local_status):
            continue
        match = next((s["name"] for s in states_list if norm(s["name"]) == norm(local_status)), None)
        if not match:
            match = next((s["name"] for s in states_list if local_status.lower() in s["name"].lower()
                          or s["name"].lower() in local_status.lower()), None)
        if not match:
            match = next((s["name"] for s in states_list if PLANE_GROUP_TO_STATUS.get(s.get("group")) == local_status), None)
        if match:
            status_map[local_status] = match

    cfg["states"] = states
    cfg["status_map"] = status_map

    # Fetch label cache so project/tag → label ID resolution works immediately
    label_cache = _refresh_plane_labels(cfg)

    return {
        "ok": True,
        "assignee_email": assignee_email,
        "state_count": len(states),
        "status_map": status_map,
        "label_count": len(label_cache),
    }


def plane_meta_comment_html(task):
    """Builds the 'tracker bookkeeping' block (status/priority/type/project/tags/stakeholders/dates/local id)
    that goes into a Plane *comment* — kept out of the description, which should just hold real notes."""
    rows = []
    rows.append(
        f'<p class="editor-paragraph-block"><strong>Tracker status:</strong> {escape_html_py(task.get("status"))} '
        f'&nbsp; <strong>Priority:</strong> {escape_html_py(task.get("priority"))} '
        f'&nbsp; <strong>Type:</strong> {escape_html_py(task.get("type") or "Task")}</p>'
    )
    proj = ", ".join(task.get("project") or [])
    tags = ", ".join(task.get("tags") or [])
    who = ", ".join(task.get("discussed_with") or [])
    if proj:
        rows.append(f'<p class="editor-paragraph-block"><strong>Project:</strong> {escape_html_py(proj)}</p>')
    if tags:
        rows.append(f'<p class="editor-paragraph-block"><strong>Tags:</strong> {escape_html_py(tags)}</p>')
    if who:
        rows.append(f'<p class="editor-paragraph-block"><strong>Stakeholders:</strong> {escape_html_py(who)}</p>')
    dates = []
    if task.get("discussed_from") or task.get("discussed_to"):
        dates.append(f'Discussed: {task.get("discussed_from") or "?"} to {task.get("discussed_to") or "?"}')
    if task.get("start_date"):
        dates.append(f'Start: {task.get("start_date")}')
    if task.get("due_date"):
        dates.append(f'Due: {task.get("due_date")}')
    if task.get("done_at"):
        dates.append(f'Done: {task.get("done_at")}')
    if task.get("closed_at"):
        dates.append(f'Closed: {task.get("closed_at")}')
    if dates:
        rows.append(f'<p class="editor-paragraph-block"><strong>Dates:</strong> {escape_html_py(" | ".join(dates))}</p>')
    if task.get("cancel_reason"):
        rows.append(f'<p class="editor-paragraph-block"><strong>Cancel reason:</strong> {escape_html_py(task.get("cancel_reason"))}</p>')
    rows.append(f'<p class="editor-paragraph-block"><em>Local tracker id: {escape_html_py(task.get("id"))}</em></p>')
    return "".join(rows)


def get_active_plane_cycle(cfg):
    """Returns {"id": ..., "name": ...} for this project's currently-active Plane cycle, or None.
    Cookie auth: filter list by status=="CURRENT". PAT/v1: use ?cycle_view=current query param."""
    try:
        if cfg.get("pat"):
            # v1 API: ?cycle_view=current returns a direct list of active cycles
            status, data, _ = _plane_request(cfg, "GET", f"{_wpp(cfg)}/cycles/?cycle_view=current")
            if status != 200:
                return None
            cycles = data if isinstance(data, list) else (data.get("results") if isinstance(data, dict) else [])
        else:
            workspace = cfg.get("workspace")
            project_id = cfg.get("project_id")
            status, data, _ = _plane_request(cfg, "GET", f"/api/workspaces/{workspace}/projects/{project_id}/cycles/")
            if status != 200 or not isinstance(data, list):
                return None
            cycles = [c for c in data if c.get("status") == "CURRENT"]
        cycle = cycles[0] if cycles else None
        return {"id": cycle["id"], "name": cycle.get("name")} if cycle else None
    except Exception:
        return None


PLANE_ACTIVE_WORK_STATUSES = {"In Progress", "In Review", "Pending"}


def roll_open_tasks_to_current_cycle():
    """Plane cycles are weekly — they end and a new one goes CURRENT on their own, but nothing
    automatically carries an unfinished issue over into the new one (same as Jira/Linear sprints:
    that's a deliberate human call in most tools, but here it's pure housekeeping worth doing on
    our own). Keeps every still-open, Plane-linked task's cycle in sync with reality:

    1. Was in a specific (now stale) cycle -> rolled into the current one.
    2. No cycle recorded locally at all, but is actively-worked (In Progress/In Review/Pending —
       not just backlog "To Do") -> Plane is checked directly first, since this often just means
       the task was linked before cycle-tracking existed and Plane already has it cycled
       correctly (only our local record is stale, no API mutation needed); only added to the
       current cycle if Plane genuinely has no cycle for it either.

    "To Do" tasks with no cycle are left alone either way — untouched backlog isn't this sweep's
    job, and forcing every one of those into "this week" the first time this runs would be a much
    bigger, unrequested bulk action. Closed/archived tasks are never touched — a Done task staying
    in the cycle it was actually finished in is correct, not a bug."""
    cfg = load_plane_config()
    if not (cfg.get("pat") or cfg.get("cookie")) or not cfg.get("workspace") or not cfg.get("project_id"):
        return {"error": "Plane is not configured yet."}
    active_cycle = get_active_plane_cycle(cfg)
    if not active_cycle:
        return {"ok": True, "cycle_name": None, "moved": [], "failed": []}

    workspace = cfg.get("workspace")
    project_id = cfg.get("project_id")
    data = load_tasks()
    moved, failed = [], []
    for t in data["tasks"]:
        if t.get("archived_at") or t.get("status") in ("Done", "Cancelled"):
            continue
        issue_id = t.get("plane_issue_id")
        if not issue_id:
            continue
        local_cycle_id = t.get("plane_cycle_id")
        if local_cycle_id == active_cycle["id"]:
            continue
        if local_cycle_id is None and t.get("status") not in PLANE_ACTIVE_WORK_STATUSES:
            continue  # untouched backlog with no cycle — not this sweep's job

        try:
            cs, _, _ = _plane_request(
                cfg, "POST",
                f"{_wpp(cfg)}/cycles/{active_cycle['id']}/cycle-issues/",
                {"issues": [issue_id]},
            )
            # v1: returns 200 with cycle-issue objects on success.
            # Cookie API: can return 400 even when it works, so any 2xx or 4xx is treated as
            # attempted. Trust local state update; Plane will show the issue in the cycle.
            ok = cs is not None and (cs < 300 or cs == 400)
        except Exception:
            ok = False

        if ok:
            t["plane_cycle_id"] = active_cycle["id"]
            t["plane_cycle_name"] = active_cycle["name"]
            t["plane_cycle_url"] = f"{PLANE_HOST}/{workspace}/projects/{project_id}/cycles/{active_cycle['id']}/"
            moved.append(t["id"])
        else:
            failed.append(t["id"])

    if moved:
        save_tasks(data)
    return {"ok": True, "cycle_name": active_cycle["name"], "moved": moved, "failed": failed}


def bulk_update_plane_issues(only_labels=False):
    """Push current local state onto ALL already-linked Plane issues in one go.
    only_labels=True: just syncs labels (no title/status/dates PATCH) — faster, no noisy changes.
    only_labels=False: full _push_plane_core_fields (title, status, priority, dates, labels).
    Never adds comments — this is a silent backfill, not a changelog entry."""
    import time
    cfg = load_plane_config()
    if not (cfg.get("pat") or cfg.get("cookie")) or not cfg.get("workspace") or not cfg.get("project_id"):
        return {"error": "Plane is not configured yet."}
    if not cfg.get("assignee_id"):
        return {"error": "Plane connected but assignee_id unknown — reopen Plane settings and save again."}

    data = load_tasks()
    linked = [t for t in data["tasks"] if t.get("plane_issue_id")]

    if only_labels:
        # Pre-resolve all unique label names up front to avoid per-task API calls during PATCH loop
        all_names = set()
        for t in linked:
            for name in list(t.get("project") or []) + list(t.get("tags") or []):
                n = name.strip()
                if n:
                    all_names.add(n)
        _resolve_label_ids(cfg, list(all_names))  # populates cache, creates missing labels
        save_plane_config(cfg)

    ok_ids, failed_ids, errors = [], [], {}
    is_pat = bool(cfg.get("pat"))
    has_cookie = bool(cfg.get("cookie"))
    wpp = _wpp(cfg)
    # If PAT gets rate-limited, flip to cookie for the rest of this run
    use_cookie_fallback = False

    for i, t in enumerate(linked):
        issue_id = t["plane_issue_id"]
        if i > 0 and i % 10 == 0:
            time.sleep(0.5)
        try:
            if only_labels:
                label_names = list(t.get("project") or []) + list(t.get("tags") or [])
                label_ids = _resolve_label_ids(cfg, label_names)
                # When using cookie fallback, label field name is label_ids and path is /api/ (handled in _plane_request)
                if use_cookie_fallback:
                    payload = {"label_ids": label_ids}
                    st, _, raw = _plane_request(cfg, "PATCH", f"{wpp}/issues/{issue_id}/", payload, force_cookie=True)
                else:
                    payload = {"labels": label_ids} if is_pat else {"label_ids": label_ids}
                    st, _, raw = _plane_request(cfg, "PATCH", f"{wpp}/issues/{issue_id}/", payload)
                    if st == 429 and has_cookie:
                        # Switch to cookie for this and all remaining requests
                        use_cookie_fallback = True
                        payload = {"label_ids": label_ids}
                        st, _, raw = _plane_request(cfg, "PATCH", f"{wpp}/issues/{issue_id}/", payload, force_cookie=True)
                err = None if (st and 200 <= st < 300) else {"error": f"Plane API {st}"}
                if err:
                    errors[t["id"]] = f"HTTP {st}: {(raw or '')[:80]}"
            else:
                err = _push_plane_core_fields(cfg, t, issue_id)
            if err:
                failed_ids.append(t["id"])
            else:
                ok_ids.append(t["id"])
        except Exception as e:
            failed_ids.append(t["id"])
            errors[t["id"]] = str(e)

    result = {"ok": True, "updated": len(ok_ids), "failed": len(failed_ids), "failed_ids": failed_ids}
    if errors:
        result["errors"] = errors
    return result


def create_plane_issue(task):
    cfg = load_plane_config()
    workspace = cfg.get("workspace")
    project_id = cfg.get("project_id")
    if not (cfg.get("pat") or cfg.get("cookie")) or not workspace or not project_id:
        return {"error": "Plane is not configured yet — set the PAT or cookie in Plane settings first."}
    assignee_id = cfg.get("assignee_id")
    if not assignee_id:
        return {"error": "Plane connected but your user id wasn't detected yet — reopen Plane settings and save again."}

    # Only on first push — a task already linked keeps whatever cycle it's in (or was moved to
    # by hand in Plane); re-pushing via Update in Plane must never yank it into "this week's"
    # cycle. If no cycle is currently active, this is just None and the issue is created without
    # one, exactly like before.
    active_cycle = get_active_plane_cycle(cfg)
    active_cycle_id = active_cycle["id"] if active_cycle else None

    # Collect label IDs from local project + tags fields — failure is non-fatal
    label_names = list(task.get("project") or []) + list(task.get("tags") or [])
    try:
        label_ids = _resolve_label_ids(cfg, label_names)
    except Exception:
        label_ids = []

    notes = (task.get("notes") or "").strip()
    desc_html = f'<p class="editor-paragraph-block">{escape_html_py(notes)}</p>' if notes else ""
    is_v1 = bool(cfg.get("pat"))
    payload = {
        "project_id": project_id,
        "type_id": None,
        "name": task.get("title", "Untitled task")[:255],
        "description_html": desc_html,
        "estimate_point": None,
        "state_id": plane_state_id(cfg, task.get("status")),
        "parent_id": None,
        "priority": PLANE_PRIORITY_MAP.get(task.get("priority") or "P3", "none"),
        "assignee_ids": [assignee_id],
        "cycle_id": None,
        "module_ids": [],
        "start_date": task.get("discussed_from") or None,
        "target_date": task.get("due_date") or None,
    }
    # v1 uses "labels" (list of UUIDs), cookie API uses "label_ids"
    if is_v1:
        payload["labels"] = label_ids
    else:
        payload["label_ids"] = label_ids

    status, data, raw = _plane_request(cfg, "POST", f"{_wpp(cfg)}/issues/", payload)
    if status is None:
        return {"error": f"Could not reach Plane: {raw}"}
    if status < 200 or status >= 300 or not data:
        return {"error": f"Plane API error {status}: {raw[:300]}"}

    issue_id = data.get("id")
    if not issue_id:
        return {"error": f"Plane didn't return an issue id: {json.dumps(data)[:300]}"}

    # v1: labels set at create time work. For cookie API, PATCH to apply labels after create.
    if not is_v1 and label_ids:
        try:
            _plane_request(cfg, "PATCH", f"{_wpp(cfg)}/issues/{issue_id}/", {"label_ids": label_ids})
        except Exception:
            pass

    # cycle_id in the create payload above is silently ignored by Plane — an issue only actually
    # joins a cycle through this separate cycle-issues call.
    if active_cycle_id:
        try:
            _plane_request(cfg, "POST", f"{_wpp(cfg)}/cycles/{active_cycle_id}/cycle-issues/", {"issues": [issue_id]})
        except Exception:
            pass

    # Bookkeeping (status/priority/type/project/tags/stakeholders/dates) goes into a comment,
    # not the description — keeps the description as just the real notes, per user preference.
    comment_html = plane_meta_comment_html(task)
    _plane_request(cfg, "POST", f"{_wpp(cfg)}/issues/{issue_id}/comments/", {"comment_html": comment_html})

    plane_url = f"{PLANE_HOST}/{workspace}/projects/{project_id}/issues/{issue_id}/"
    return {
        "plane_issue_id": issue_id,
        "plane_url": plane_url,
        "plane_cycle_id": active_cycle_id,
        "plane_cycle_name": active_cycle["name"] if active_cycle else None,
        "plane_cycle_url": f"{PLANE_HOST}/{workspace}/projects/{project_id}/cycles/{active_cycle_id}/" if active_cycle_id else None,
    }


def _push_plane_core_fields(cfg, task, issue_id):
    """Shared PATCH payload builder — pushes title/notes/status/priority/dates/assignee/labels
    onto an already-linked Plane issue. Returns {"error":...} on failure, None on success."""
    label_names = list(task.get("project") or []) + list(task.get("tags") or [])
    try:
        label_ids = _resolve_label_ids(cfg, label_names)
    except Exception:
        label_ids = []
    notes = (task.get("notes") or "").strip()
    desc_html = f'<p class="editor-paragraph-block">{escape_html_py(notes)}</p>' if notes else ""
    payload = {
        "name": task.get("title", "Untitled task")[:255],
        "description_html": desc_html,
        "state_id": plane_state_id(cfg, task.get("status")),
        "priority": PLANE_PRIORITY_MAP.get(task.get("priority") or "P3", "none"),
        "assignee_ids": [cfg.get("assignee_id")],
        "start_date": task.get("discussed_from") or None,
        "target_date": task.get("due_date") or None,
    }
    if cfg.get("pat"):
        payload["labels"] = label_ids
    else:
        payload["label_ids"] = label_ids
    status, data, raw = _plane_request(cfg, "PATCH", f"{_wpp(cfg)}/issues/{issue_id}/", payload)
    if status is None:
        return {"error": f"Could not reach Plane: {raw}"}
    if status < 200 or status >= 300:
        return {"error": f"Plane API error {status}: {(raw or '')[:300]}"}
    return None


def update_plane_issue(task):
    """Pushes the task's CURRENT local state onto its already-linked Plane issue, on-demand
    (the 'Update in Plane' button). Updates the issue's core fields + description (notes), then
    adds a fresh comment with the full current bookkeeping block. See also sync_plane_on_activity
    for the automatic, per-edit version of this."""
    cfg = load_plane_config()
    workspace = cfg.get("workspace")
    project_id = cfg.get("project_id")
    issue_id = task.get("plane_issue_id")
    if not (cfg.get("pat") or cfg.get("cookie")) or not workspace or not project_id:
        return {"error": "Plane is not configured yet — set the PAT or cookie in Plane settings first."}
    if not issue_id:
        return {"error": "This task isn't linked to a Plane issue yet — use Send to Plane first."}
    if not cfg.get("assignee_id"):
        return {"error": "Plane connected but your user id wasn't detected yet — reopen Plane settings and save again."}

    err = _push_plane_core_fields(cfg, task, issue_id)
    if err:
        return err

    comment_html = plane_meta_comment_html(task)
    _plane_request(cfg, "POST", f"{_wpp(cfg)}/issues/{issue_id}/comments/", {"comment_html": comment_html})

    return {"ok": True, "plane_url": task.get("plane_url")}


ACTIVITY_FIELD_LABELS = {
    "due_date": "Due date",
    "start_date": "Start date",
    "discussed_from": "Discussed from",
    "discussed_to": "Discussed to",
    "done_at": "Done date",
    "closed_at": "Closed date",
    "cancelled_at": "Cancelled date",
}


def plane_activity_diff_comment_html(activities):
    """Renders just the activity entries that changed in this request as a short Plane comment
    — e.g. 'Status changed: To Do -> In Progress' — instead of re-dumping the whole bookkeeping
    snapshot, so Plane's Activity feed reads like an actual changelog of what just happened."""
    rows = []
    for a in activities:
        kind = a.get("type")
        if kind == "status_changed":
            row = f'Status changed: {escape_html_py(a.get("from_status") or "—")} → {escape_html_py(a.get("to") or "—")}'
            if a.get("note"):
                row += f' — {escape_html_py(a["note"])}'
            rows.append(row)
        elif kind == "date_changed":
            label = ACTIVITY_FIELD_LABELS.get(a.get("field"), a.get("field") or "Date")
            rows.append(f'{escape_html_py(label)} changed: {escape_html_py(a.get("from_value") or "—")} → {escape_html_py(a.get("to") or "—")}')
        elif kind == "cancel_reason_changed":
            rows.append(f'Cancel reason updated: {escape_html_py(a.get("to") or "—")}')
        elif kind == "completed":
            rows.append("Marked completed")
        elif kind == "reopened":
            rows.append(f'Reopened (was {escape_html_py(a.get("from_status") or "—")})')
        elif kind == "cancelled":
            reason = a.get("reason")
            rows.append(f'Cancelled{" — " + escape_html_py(reason) if reason else ""}')
        elif kind == "archived":
            rows.append("Archived in tracker")
        elif kind == "restored":
            rows.append("Restored from archive")
        elif kind == "attachment_added":
            rows.append(f'Attachment added: {escape_html_py(a.get("label") or "")}')
        elif kind == "attachment_removed":
            rows.append(f'Attachment removed: {escape_html_py(a.get("label") or "")}')
        elif kind == "comment":
            rows.append(f'Comment: {escape_html_py(a.get("text") or "")}')
    if not rows:
        return ""
    items = "".join(f'<p class="editor-paragraph-block">• {row}</p>' for row in rows)
    return f'<p class="editor-paragraph-block"><strong>Tracker activity:</strong></p>{items}'


def sync_plane_on_activity(task, new_activities):
    """Automatic counterpart to the manual 'Update in Plane' button: whenever a live edit adds
    activity to a task that's ALREADY linked to Plane (plane_issue_id set), push the current
    state + a diff-style comment — no button click needed. Tasks not yet linked are left alone;
    creating the link itself stays the explicit 'Send to Plane' action. Never raises — a Plane
    hiccup (expired cookie, network blip) must never break saving the local edit; on failure the
    caller gets back an {"error": ...} to surface as a soft toast, nothing more."""
    issue_id = task.get("plane_issue_id")
    if not issue_id:
        return None
    meaningful = [a for a in new_activities if a.get("type") not in ("created", "status_snapshot")]
    if not meaningful:
        return None
    try:
        cfg = load_plane_config()
        if not (cfg.get("pat") or cfg.get("cookie")) or not cfg.get("workspace") or not cfg.get("project_id") or not cfg.get("assignee_id"):
            return {"error": "Plane sync skipped — Plane isn't fully configured (check Plane settings)."}

        err = _push_plane_core_fields(cfg, task, issue_id)
        if err:
            return err

        comment_html = plane_activity_diff_comment_html(meaningful)
        if comment_html:
            _plane_request(cfg, "POST", f"{_wpp(cfg)}/issues/{issue_id}/comments/", {"comment_html": comment_html})
        return {"ok": True}
    except Exception as e:
        return {"error": str(e)[:200]}


def apply_plane_auto_sync(task, session_activities):
    """Call once, right after save_tasks(), with whatever activity this request actually added
    (via append_activity_tracked). Auto-syncs to Plane if linked; on failure, stamps a transient
    _plane_sync_error onto the response dict for the frontend to toast — never persisted, since
    save_tasks already ran with the clean state. Success is silent by design (no toast spam)."""
    result = sync_plane_on_activity(task, session_activities)
    if result and result.get("error"):
        task["_plane_sync_error"] = result["error"]
    return task


def escape_html_py(s):
    return (
        (s or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def build_export_xlsx(tasks):
    wb = Workbook()
    ws = wb.active
    ws.title = "Tasks"
    FONT = "Arial"
    headers = ["ID", "Type", "Title", "Status", "Priority", "Project(s)", "Tags",
               "Discussed With", "Discussed", "Start", "Due", "Done", "Closed",
               "Notes", "Cancel Reason", "Updated"]

    header_fill = PatternFill("solid", fgColor="4D6D8C")
    header_font = Font(name=FONT, size=10, bold=True, color="FFFFFF")
    thin = Side(style="thin", color="E3DDD0")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    status_fill = {
        "Done": PatternFill("solid", fgColor="E6F0E9"),
        "In Progress": PatternFill("solid", fgColor="E7EDF3"),
        "In Review": PatternFill("solid", fgColor="EFE7F5"),
        "Pending": PatternFill("solid", fgColor="F6ECD9"),
        "To Do": PatternFill("solid", fgColor="EFE9DC"),
        "Cancelled": PatternFill("solid", fgColor="F5E2E0"),
    }

    for c, h in enumerate(headers, start=1):
        cell = ws.cell(row=1, column=c, value=h)
        cell.font = header_font
        cell.fill = header_fill
        cell.border = border
        cell.alignment = Alignment(vertical="center")
    ws.freeze_panes = "A2"

    rows_sorted = sorted(tasks, key=lambda t: (t.get("updated_ts") or t.get("updated_at") or ""), reverse=True)
    row = 2
    for t in rows_sorted:
        discussed = t.get("discussed_from") or ""
        if t.get("discussed_to") and t.get("discussed_to") != discussed:
            discussed = f"{discussed} - {t['discussed_to']}"
        values = [
            t.get("id", ""), t.get("type") or "Task", t.get("title", ""), t.get("status", ""),
            t.get("priority") or "P3", ", ".join(t.get("project") or []), ", ".join(t.get("tags") or []),
            ", ".join(t.get("discussed_with") or []), discussed, t.get("start_date") or "",
            t.get("due_date") or "", t.get("done_at") or "", t.get("closed_at") or "",
            t.get("notes", ""), t.get("cancel_reason", ""), t.get("updated_at", ""),
        ]
        for c, v in enumerate(values, start=1):
            cell = ws.cell(row=row, column=c, value=v)
            cell.font = Font(name=FONT, size=10)
            cell.alignment = Alignment(vertical="top", wrap_text=(c in (3, 14)))
            cell.border = border
        status_cell = ws.cell(row=row, column=4)
        status_cell.fill = status_fill.get(t.get("status", ""), PatternFill())
        row += 1

    last_row = max(row - 1, 1)
    widths = {1: 7, 2: 9, 3: 52, 4: 12, 5: 9, 6: 24, 7: 16, 8: 20, 9: 18, 10: 11, 11: 11, 12: 11, 13: 11, 14: 46, 15: 24, 16: 11}
    for c, w in widths.items():
        ws.column_dimensions[get_column_letter(c)].width = w

    if last_row >= 1:
        table = Table(displayName="ExportedTasks", ref=f"A1:P{last_row}")
        table.tableStyleInfo = TableStyleInfo(name="TableStyleMedium2", showRowStripes=True)
        ws.add_table(table)

    ws2 = wb.create_sheet("Summary")
    ws2["A1"] = "Exported"
    ws2["B1"] = iso_now()
    ws2["A2"] = "Task count"
    ws2["B2"] = len(tasks)
    for cell in (ws2["A1"], ws2["B1"], ws2["A2"], ws2["B2"]):
        cell.font = Font(name=FONT, size=10)
    ws2.column_dimensions["A"].width = 14
    ws2.column_dimensions["B"].width = 24

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path, content_type):
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return {}

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        parsed = urlsplit(self.path)
        path = parsed.path
        if path == "/" or path == "/index.html":
            return self._send_file(os.path.join(STATIC_DIR, "index.html"), "text/html; charset=utf-8")
        if path == "/style.css":
            return self._send_file(os.path.join(STATIC_DIR, "style.css"), "text/css; charset=utf-8")
        if path == "/app.js":
            return self._send_file(os.path.join(STATIC_DIR, "app.js"), "application/javascript; charset=utf-8")
        if path == "/api/tasks":
            return self._send_json(load_tasks())
        if path == "/api/meta":
            return self._send_json({"statuses": STATUSES, "priorities": PRIORITIES, "types": TYPES})
        if path == "/api/plane-config":
            cfg = load_plane_config()
            return self._send_json({
                "configured": bool((cfg.get("pat") or cfg.get("cookie")) and cfg.get("states")),
                "pat_configured": bool(cfg.get("pat")),
                "workspace": cfg.get("workspace", ""),
                "project_id": cfg.get("project_id", ""),
                "assignee_email": cfg.get("assignee_email", ""),
                "states": sorted((cfg.get("states") or {}).keys()),
                "status_map": cfg.get("status_map", {}),
                "labels": sorted(v["name"] for v in (cfg.get("labels_cache") or {}).values()),
                "label_count": len(cfg.get("labels_cache") or {}),
            })
        if path == "/api/export":
            q = parse_qs(parsed.query)
            data = load_tasks()
            filtered = filter_tasks_for_export(data["tasks"], q)
            xlsx_bytes = build_export_xlsx(filtered)
            fname = f"tasks-export-{today_local()}.xlsx"
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
            self.send_header("Content-Disposition", f'attachment; filename="{fname}"')
            self.send_header("Content-Length", str(len(xlsx_bytes)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(xlsx_bytes)
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        if self.path == "/api/plane-config":
            body = self._read_body()
            cfg = load_plane_config()
            if "pat" in body and body["pat"].strip():
                cfg["pat"] = body["pat"].strip()
            if "cookie" in body and body["cookie"].strip():
                cfg["cookie"] = extract_plane_cookie(body["cookie"])
            if "workspace" in body and body["workspace"].strip():
                cfg["workspace"] = body["workspace"].strip()
            if "project_id" in body and body["project_id"].strip():
                cfg["project_id"] = body["project_id"].strip()
            if "status_map" in body and isinstance(body["status_map"], dict):
                cfg["status_map"] = body["status_map"]
            # Auto-detect assignee id + project states the moment we have enough to ask Plane.
            discovery = None
            if (cfg.get("pat") or cfg.get("cookie")) and cfg.get("workspace") and cfg.get("project_id") and not cfg.get("states"):
                discovery = discover_plane_setup(cfg)
            save_plane_config(cfg)
            resp = {"ok": True, "configured": bool((cfg.get("pat") or cfg.get("cookie")) and cfg.get("states"))}
            if discovery:
                resp["discovery"] = discovery
            return self._send_json(resp)

        m = re.match(r"^/api/tasks/([^/]+)/plane$", self.path)
        if m:
            task_id = m.group(1)
            data = load_tasks()
            found = None
            for t in data["tasks"]:
                if t["id"] == task_id:
                    found = t
                    break
            if not found:
                return self._send_json({"error": "not found"}, status=404)
            if found.get("plane_issue_id"):
                return self._send_json({
                    "already_exists": True,
                    "plane_issue_id": found["plane_issue_id"],
                    "plane_url": found.get("plane_url"),
                })
            result = create_plane_issue(found)
            if "error" in result:
                return self._send_json(result, status=502)
            found["plane_issue_id"] = result["plane_issue_id"]
            found["plane_url"] = result["plane_url"]
            found["plane_cycle_id"] = result.get("plane_cycle_id")
            found["plane_cycle_name"] = result.get("plane_cycle_name")
            found["plane_cycle_url"] = result.get("plane_cycle_url")
            found["updated_at"] = today_local()
            found["updated_ts"] = iso_now()
            normalize_task(found)
            save_tasks(data)
            return self._send_json(found)

        m = re.match(r"^/api/tasks/([^/]+)/plane-update$", self.path)
        if m:
            task_id = m.group(1)
            data = load_tasks()
            found = None
            for t in data["tasks"]:
                if t["id"] == task_id:
                    found = t
                    break
            if not found:
                return self._send_json({"error": "not found"}, status=404)
            result = update_plane_issue(found)
            if "error" in result:
                return self._send_json(result, status=502)
            return self._send_json(result)

        if self.path == "/api/plane-cycle-rollover":
            result = roll_open_tasks_to_current_cycle()
            if "error" in result:
                return self._send_json(result, status=502)
            return self._send_json(result)

        if self.path == "/api/plane-labels-refresh":
            cfg = load_plane_config()
            if not (cfg.get("pat") or cfg.get("cookie")) or not cfg.get("workspace") or not cfg.get("project_id"):
                return self._send_json({"error": "Plane is not configured yet."}, status=400)
            cache = _refresh_plane_labels(cfg)
            save_plane_config(cfg)
            return self._send_json({
                "ok": True,
                "label_count": len(cache),
                "labels": sorted(v["name"] for v in cache.values()),
            })

        if self.path == "/api/plane-bulk-update":
            body = self._read_body()
            only_labels = bool(body.get("only_labels", True))
            result = bulk_update_plane_issues(only_labels=only_labels)
            if "error" in result:
                return self._send_json(result, status=502)
            return self._send_json(result)

        m = re.match(r"^/api/tasks/([^/]+)/comments$", self.path)
        if m:
            task_id = m.group(1)
            data = load_tasks()
            body = self._read_body()
            text = (body.get("text") or "").strip()
            if not text:
                return self._send_json({"error": "Comment text is required"}, status=400)
            found = None
            session_activities = []
            for t in data["tasks"]:
                if t["id"] == task_id:
                    found = t
                    normalize_task(t)
                    now = iso_now()
                    append_activity_tracked(t, make_activity(t, "comment", at=now, text=text), session_activities)
                    t["updated_at"] = today_local()
                    t["updated_ts"] = now
                    normalize_task(t)
                    break
            if not found:
                return self._send_json({"error": "not found"}, status=404)
            save_tasks(data)
            found = apply_plane_auto_sync(found, session_activities)
            return self._send_json(found)

        if self.path == "/api/tasks":
            data = load_tasks()
            body = self._read_body()
            today = today_local()
            now = iso_now()
            d_from = body.get("discussed_from") or today
            d_to = body.get("discussed_to") or d_from
            status = body.get("status") if body.get("status") in STATUSES else "To Do"
            task = {
                "id": next_id(data["tasks"]),
                "title": body.get("title", "").strip() or "Untitled task",
                "project": as_list(body.get("project")),
                "month": month_from(d_from),
                "status": status,
                "priority": body.get("priority") if body.get("priority") in PRIORITIES else "P3",
                "type": body.get("type") if body.get("type") in TYPES else "Task",
                "discussed_with": as_list(body.get("discussed_with")),
                "notes": body.get("notes", ""),
                "tags": as_list(body.get("tags")),
                "attachments": as_list(body.get("attachments")),
                "discussed_from": clean_date(d_from) or today,
                "discussed_to": clean_date(d_to) or clean_date(d_from) or today,
                "start_date": clean_date(body.get("start_date")),
                "due_date": clean_date(body.get("due_date")),
                "done_at": today if status == "Done" else None,
                "closed_at": today if status == "Done" else None,
                "cancelled_at": today if status == "Cancelled" else None,
                "cancel_reason": (body.get("cancel_reason") or "").strip(),
                "updated_at": today,
                "created_at": now,
                "updated_ts": now,
                "archived_at": None,
                "activity_history": [],
            }
            append_activity(task, make_activity(task, "created", at=now))
            if status != "To Do":
                append_activity(task, make_activity(task, "status_changed", at=now, from_status=None, to=status))
            if status == "Cancelled":
                append_activity(task, make_activity(task, "cancelled", at=now, reason=task["cancel_reason"]))
            normalize_task(task)
            data["tasks"].append(task)
            save_tasks(data)
            return self._send_json(task, status=201)
        self.send_response(404)
        self.end_headers()

    def do_PATCH(self):
        m = re.match(r"^/api/tasks/([^/]+)/attachments$", self.path)
        if m:
            task_id = m.group(1)
            data = load_tasks()
            body = self._read_body()
            found = None
            session_activities = []
            for t in data["tasks"]:
                if t["id"] == task_id:
                    found = t
                    t.setdefault("attachments", [])
                    label = (body.get("label") or body.get("url") or "").strip()
                    if label:
                        t["attachments"].append(label)
                        append_activity_tracked(t, make_activity(t, "attachment_added", label=label), session_activities)
                    now = iso_now()
                    t["updated_at"] = today_local()
                    t["updated_ts"] = now
                    normalize_task(t)
                    break
            if not found:
                return self._send_json({"error": "not found"}, status=404)
            save_tasks(data)
            found = apply_plane_auto_sync(found, session_activities)
            return self._send_json(found)

        m = re.match(r"^/api/tasks/([^/]+)$", self.path)
        if m:
            task_id = m.group(1)
            data = load_tasks()
            body = self._read_body()
            found = None
            session_activities = []
            for t in data["tasks"]:
                if t["id"] == task_id:
                    found = t
                    normalize_task(t)
                    now = iso_now()
                    today = today_local()
                    for key in ("title", "notes"):
                        if key in body:
                            t[key] = body[key]
                    if "cancel_reason" in body:
                        old_reason = t.get("cancel_reason", "")
                        new_reason = (body.get("cancel_reason") or "").strip()
                        if old_reason != new_reason:
                            t["cancel_reason"] = new_reason
                            append_activity_tracked(t, make_activity(t, "cancel_reason_changed", at=now, from_value=old_reason, to=new_reason), session_activities)
                    for key in DATE_FIELDS:
                        if key in body:
                            old_value = t.get(key)
                            new_value = clean_date(body.get(key))
                            if old_value != new_value:
                                t[key] = new_value
                                append_activity_tracked(t, make_activity(t, "date_changed", at=now, field=key, from_value=old_value, to=new_value), session_activities)
                    if "status" in body:
                        old_status = t.get("status")
                        new_status = body["status"] if body["status"] in STATUSES else old_status
                        status_note = (body.get("status_note") or "").strip()
                        if old_status != new_status:
                            t["status"] = new_status
                            status_changed_kwargs = {"from_status": old_status, "to": new_status}
                            if status_note:
                                status_changed_kwargs["note"] = status_note
                            append_activity_tracked(t, make_activity(t, "status_changed", at=now, **status_changed_kwargs), session_activities)
                            if new_status == "Done" and not t.get("done_at"):
                                t["done_at"] = today
                                append_activity_tracked(t, make_activity(t, "date_changed", at=now, field="done_at", from_value=None, to=t["done_at"]), session_activities)
                            if new_status == "Done" and not t.get("closed_at"):
                                t["closed_at"] = today
                            if new_status == "Done":
                                append_activity_tracked(t, make_activity(t, "completed", at=now), session_activities)
                            if new_status == "Cancelled":
                                if not t.get("cancelled_at"):
                                    t["cancelled_at"] = today
                                    append_activity_tracked(t, make_activity(t, "date_changed", at=now, field="cancelled_at", from_value=None, to=t["cancelled_at"]), session_activities)
                                if not t.get("closed_at"):
                                    t["closed_at"] = today
                                append_activity_tracked(t, make_activity(t, "cancelled", at=now, reason=t.get("cancel_reason", "")), session_activities)
                            if old_status == "Done" and new_status != "Done":
                                append_activity_tracked(t, make_activity(t, "reopened", at=now, from_status=old_status, to=new_status), session_activities)
                            if old_status == "Cancelled" and new_status != "Cancelled":
                                t["cancelled_at"] = None
                                append_activity_tracked(t, make_activity(t, "reopened", at=now, from_status=old_status, to=new_status), session_activities)
                    if "discussed_from" in body:
                        t["month"] = month_from(t.get("discussed_from"))
                    if "project" in body:
                        t["project"] = as_list(body["project"])
                    if "tags" in body:
                        t["tags"] = as_list(body["tags"])
                    if "discussed_with" in body:
                        t["discussed_with"] = as_list(body["discussed_with"])
                    if "attachments" in body and isinstance(body["attachments"], list):
                        t["attachments"] = body["attachments"]
                    if "priority" in body and body["priority"] in PRIORITIES:
                        t["priority"] = body["priority"]
                    if "type" in body and body["type"] in TYPES:
                        t["type"] = body["type"]
                    if "archived_at" in body:
                        old_archived_at = t.get("archived_at")
                        t["archived_at"] = clean_date(body.get("archived_at"))
                        if old_archived_at != t.get("archived_at"):
                            append_activity_tracked(t, make_activity(t, "archived" if t.get("archived_at") else "restored", at=now), session_activities)
                    t["updated_at"] = today
                    t["updated_ts"] = now
                    normalize_task(t)
                    break
            if not found:
                return self._send_json({"error": "not found"}, status=404)
            save_tasks(data)
            found = apply_plane_auto_sync(found, session_activities)
            return self._send_json(found)
        self.send_response(404)
        self.end_headers()

    def do_DELETE(self):
        m = re.match(r"^/api/tasks/([^/]+)/attachments/(\d+)$", self.path)
        if m:
            task_id, idx = m.group(1), int(m.group(2))
            data = load_tasks()
            found = None
            session_activities = []
            for t in data["tasks"]:
                if t["id"] == task_id:
                    found = t
                    if 0 <= idx < len(t.get("attachments", [])):
                        removed = t["attachments"].pop(idx)
                        append_activity_tracked(t, make_activity(t, "attachment_removed", label=removed), session_activities)
                    now = iso_now()
                    t["updated_at"] = today_local()
                    t["updated_ts"] = now
                    normalize_task(t)
                    break
            if not found:
                return self._send_json({"error": "not found"}, status=404)
            save_tasks(data)
            found = apply_plane_auto_sync(found, session_activities)
            return self._send_json(found)

        m = re.match(r"^/api/tasks/([^/]+)$", self.path)
        if m:
            task_id = m.group(1)
            data = load_tasks()
            found = None
            now = iso_now()
            today = today_local()
            session_activities = []
            for t in data["tasks"]:
                if t["id"] == task_id:
                    found = t
                    normalize_task(t)
                    if not t.get("archived_at"):
                        t["archived_at"] = today
                        append_activity_tracked(t, make_activity(t, "archived", at=now), session_activities)
                    t["updated_at"] = today
                    t["updated_ts"] = now
                    break
            if not found:
                return self._send_json({"error": "not found"}, status=404)
            save_tasks(data)
            found = apply_plane_auto_sync(found, session_activities)
            return self._send_json(found)
        self.send_response(404)
        self.end_headers()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8787))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Task tracker running at http://127.0.0.1:{port}")
    server.serve_forever()
