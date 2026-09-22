from app.storage import load_tasks, save_tasks
from app.utils import iso_now, today_local
from app.models import normalize_task
from plane.config import extract_plane_cookie, load_plane_config, save_plane_config
from plane.labels import refresh_plane_labels
from plane.sync import (
    backfill_bug_module,
    bulk_update_plane_issues,
    create_plane_issue,
    discover_plane_setup,
    roll_open_tasks_to_current_cycle,
    update_plane_issue,
)
from services.task_service import find_task

from .router import route


@route("GET", r"^/api/plane-config$")
def get_plane_config(handler, m):
    cfg = load_plane_config()
    handler._send_json({
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


@route("POST", r"^/api/plane-config$")
def post_plane_config(handler, m):
    body = handler._read_body()
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
    discovery = None
    if (cfg.get("pat") or cfg.get("cookie")) and cfg.get("workspace") and cfg.get("project_id") and not cfg.get("states"):
        discovery = discover_plane_setup(cfg)
    save_plane_config(cfg)
    resp = {"ok": True, "configured": bool((cfg.get("pat") or cfg.get("cookie")) and cfg.get("states"))}
    if discovery:
        resp["discovery"] = discovery
    handler._send_json(resp)


@route("POST", r"^/api/tasks/([^/]+)/plane$")
def send_to_plane(handler, m):
    task_id = m.group(1)
    data = load_tasks()
    found = find_task(data["tasks"], task_id)
    if not found:
        return handler._send_json({"error": "not found"}, status=404)
    if found.get("plane_issue_id"):
        return handler._send_json({
            "already_exists": True,
            "plane_issue_id": found["plane_issue_id"],
            "plane_url": found.get("plane_url"),
        })
    result = create_plane_issue(found)
    if "error" in result:
        return handler._send_json(result, status=502)
    found["plane_issue_id"] = result["plane_issue_id"]
    found["plane_url"] = result["plane_url"]
    found["plane_number"] = result.get("plane_number")
    found["plane_cycle_id"] = result.get("plane_cycle_id")
    found["plane_cycle_name"] = result.get("plane_cycle_name")
    found["plane_cycle_url"] = result.get("plane_cycle_url")
    found["plane_module_id"] = result.get("plane_module_id")
    found["plane_module_name"] = result.get("plane_module_name")
    found["plane_module_url"] = result.get("plane_module_url")
    found["updated_at"] = today_local()
    found["updated_ts"] = iso_now()
    normalize_task(found)
    save_tasks(data)
    handler._send_json(found)


@route("POST", r"^/api/tasks/([^/]+)/plane-update$")
def send_plane_update(handler, m):
    task_id = m.group(1)
    data = load_tasks()
    found = find_task(data["tasks"], task_id)
    if not found:
        return handler._send_json({"error": "not found"}, status=404)
    result = update_plane_issue(found)
    if "error" in result:
        return handler._send_json(result, status=502)
    handler._send_json(result)


@route("POST", r"^/api/plane-cycle-rollover$")
def plane_cycle_rollover(handler, m):
    result = roll_open_tasks_to_current_cycle()
    if "error" in result:
        return handler._send_json(result, status=502)
    handler._send_json(result)


@route("POST", r"^/api/plane-module-backfill$")
def plane_module_backfill(handler, m):
    result = backfill_bug_module()
    if "error" in result:
        return handler._send_json(result, status=502)
    handler._send_json(result)


@route("POST", r"^/api/plane-labels-refresh$")
def plane_labels_refresh(handler, m):
    cfg = load_plane_config()
    if not (cfg.get("pat") or cfg.get("cookie")) or not cfg.get("workspace") or not cfg.get("project_id"):
        return handler._send_json({"error": "Plane is not configured yet."}, status=400)
    cache = refresh_plane_labels(cfg)
    save_plane_config(cfg)
    handler._send_json({
        "ok": True,
        "label_count": len(cache),
        "labels": sorted(v["name"] for v in cache.values()),
    })


@route("POST", r"^/api/plane-bulk-update$")
def plane_bulk_update(handler, m):
    body = handler._read_body()
    only_labels = bool(body.get("only_labels", True))
    result = bulk_update_plane_issues(only_labels=only_labels)
    if "error" in result:
        return handler._send_json(result, status=502)
    handler._send_json(result)
