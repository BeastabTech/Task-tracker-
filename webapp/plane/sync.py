import json
import time

from app.config import PLANE_HOST
from app.constants import PLANE_ACTIVE_WORK_STATUSES, PLANE_GROUP_TO_STATUS, PLANE_PRIORITY_MAP, STATUSES
from app.storage import load_tasks, save_tasks
from app.utils import escape_html_py

from .client import plane_request, wpp
from .config import load_plane_config, save_plane_config
from .labels import refresh_plane_labels, resolve_label_ids
from .mapper import plane_activity_diff_comment_html, plane_meta_comment_html, plane_state_id


def discover_plane_setup(cfg):
    """Auto-fills Plane config: user id (for assignee_ids), project states, and label cache.
    With PAT, the /me/ endpoint isn't exposed in v1, so we skip the user lookup and rely on the
    assignee_id already in config (set during initial cookie-based discovery, or hand-edited).
    With cookie auth the full me + states flow runs as before."""
    if not cfg.get("pat"):
        # Cookie path: verify session via /me/
        me_status, me_data, me_raw = plane_request(cfg, "GET", "/api/users/me/")
        if me_status != 200 or not me_data:
            return {"error": f"Could not verify Plane session ({me_status}): {(me_raw or '')[:200]}"}
        cfg["assignee_id"] = me_data.get("id")
        cfg["assignee_email"] = me_data.get("email")
        assignee_email = me_data.get("email")
    else:
        assignee_email = cfg.get("assignee_email", "")

    st_status, st_data, st_raw = plane_request(cfg, "GET", f"{wpp(cfg)}/states/")
    if st_status != 200:
        return {"error": f"Could not fetch project states ({st_status}): {(st_raw or '')[:200]}"}

    states_list = st_data if isinstance(st_data, list) else (st_data.get("results") if isinstance(st_data, dict) else [])
    if not states_list:
        return {"error": "Could not fetch project states: empty response"}

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
    label_cache = refresh_plane_labels(cfg)

    return {
        "ok": True,
        "assignee_email": assignee_email,
        "state_count": len(states),
        "status_map": status_map,
        "label_count": len(label_cache),
    }


def get_active_plane_cycle(cfg):
    """Returns {"id": ..., "name": ...} for this project's currently-active Plane cycle, or None.
    Cookie auth: filter list by status=="CURRENT". PAT/v1: use ?cycle_view=current query param."""
    try:
        if cfg.get("pat"):
            # v1 API: ?cycle_view=current returns a direct list of active cycles
            status, data, _ = plane_request(cfg, "GET", f"{wpp(cfg)}/cycles/?cycle_view=current")
            if status != 200:
                return None
            cycles = data if isinstance(data, list) else (data.get("results") if isinstance(data, dict) else [])
        else:
            workspace = cfg.get("workspace")
            project_id = cfg.get("project_id")
            status, data, _ = plane_request(cfg, "GET", f"/api/workspaces/{workspace}/projects/{project_id}/cycles/")
            if status != 200 or not isinstance(data, list):
                return None
            cycles = [c for c in data if c.get("status") == "CURRENT"]
        cycle = cycles[0] if cycles else None
        return {"id": cycle["id"], "name": cycle.get("name")} if cycle else None
    except Exception:
        return None


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
            cs, _, _ = plane_request(
                cfg, "POST",
                f"{wpp(cfg)}/cycles/{active_cycle['id']}/cycle-issues/",
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
    only_labels=False: full push_plane_core_fields (title, status, priority, dates, labels).
    Never adds comments — this is a silent backfill, not a changelog entry."""
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
        resolve_label_ids(cfg, list(all_names))  # populates cache, creates missing labels
        save_plane_config(cfg)

    ok_ids, failed_ids, errors = [], [], {}
    is_pat = bool(cfg.get("pat"))
    has_cookie = bool(cfg.get("cookie"))
    prefix = wpp(cfg)
    # If PAT gets rate-limited, flip to cookie for the rest of this run
    use_cookie_fallback = False

    for i, t in enumerate(linked):
        issue_id = t["plane_issue_id"]
        if i > 0 and i % 10 == 0:
            time.sleep(0.5)
        try:
            if only_labels:
                label_names = list(t.get("project") or []) + list(t.get("tags") or [])
                label_ids = resolve_label_ids(cfg, label_names)
                # When using cookie fallback, label field name is label_ids and path is /api/ (handled in plane_request)
                if use_cookie_fallback:
                    payload = {"label_ids": label_ids}
                    st, _, raw = plane_request(cfg, "PATCH", f"{prefix}/issues/{issue_id}/", payload, force_cookie=True)
                else:
                    payload = {"labels": label_ids} if is_pat else {"label_ids": label_ids}
                    st, _, raw = plane_request(cfg, "PATCH", f"{prefix}/issues/{issue_id}/", payload)
                    if st == 429 and has_cookie:
                        # Switch to cookie for this and all remaining requests
                        use_cookie_fallback = True
                        payload = {"label_ids": label_ids}
                        st, _, raw = plane_request(cfg, "PATCH", f"{prefix}/issues/{issue_id}/", payload, force_cookie=True)
                err = None if (st and 200 <= st < 300) else {"error": f"Plane API {st}"}
                if err:
                    errors[t["id"]] = f"HTTP {st}: {(raw or '')[:80]}"
            else:
                err = push_plane_core_fields(cfg, t, issue_id)
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


def get_project_identifier(cfg):
    """Plane's short project prefix (e.g. "TKT") used to build human-readable issue numbers
    like "TKT-1549" from an issue's sequence_id. Cached in plane_config.json once fetched —
    it never changes for a given project."""
    identifier = cfg.get("project_identifier")
    if identifier:
        return identifier
    try:
        status, data, _ = plane_request(cfg, "GET", f"{wpp(cfg)}/")
        if status == 200 and isinstance(data, dict) and data.get("identifier"):
            identifier = data["identifier"]
            cfg["project_identifier"] = identifier
            save_plane_config(cfg)
            return identifier
    except Exception:
        pass
    return None


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
        label_ids = resolve_label_ids(cfg, label_names)
    except Exception:
        label_ids = []

    notes = (task.get("notes") or "").strip()
    desc_html = f'<p class="editor-paragraph-block">{escape_html_py(notes)}</p>' if notes else "<p></p>"
    is_v1 = bool(cfg.get("pat"))
    sid = plane_state_id(cfg, task.get("status"))
    payload = {
        "project_id": project_id,
        "type_id": None,
        "name": task.get("title", "Untitled task")[:255],
        "description_html": desc_html,
        "estimate_point": None,
        "parent_id": None,
        "priority": PLANE_PRIORITY_MAP.get(task.get("priority") or "P3", "none"),
        "cycle_id": None,
        "module_ids": [],
        "start_date": task.get("discussed_from") or None,
        "target_date": task.get("due_date") or None,
    }
    # v1 (PAT) uses "state"/"labels"/"assignees"; cookie API uses "state_id"/"label_ids"/"assignee_ids"
    if is_v1:
        payload["state"] = sid
        payload["labels"] = label_ids
        payload["assignees"] = [assignee_id]
    else:
        payload["state_id"] = sid
        payload["label_ids"] = label_ids
        payload["assignee_ids"] = [assignee_id]

    status, data, raw = plane_request(cfg, "POST", f"{wpp(cfg)}/issues/", payload)
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
            plane_request(cfg, "PATCH", f"{wpp(cfg)}/issues/{issue_id}/", {"label_ids": label_ids})
        except Exception:
            pass

    # cycle_id in the create payload above is silently ignored by Plane — an issue only actually
    # joins a cycle through this separate cycle-issues call.
    if active_cycle_id:
        try:
            plane_request(cfg, "POST", f"{wpp(cfg)}/cycles/{active_cycle_id}/cycle-issues/", {"issues": [issue_id]})
        except Exception:
            pass

    # Bookkeeping (status/priority/type/project/tags/stakeholders/dates) goes into a comment,
    # not the description — keeps the description as just the real notes, per user preference.
    comment_html = plane_meta_comment_html(task)
    plane_request(cfg, "POST", f"{wpp(cfg)}/issues/{issue_id}/comments/", {"comment_html": comment_html})

    identifier = get_project_identifier(cfg)
    seq = data.get("sequence_id")
    plane_number = f"{identifier}-{seq}" if identifier and seq else None

    plane_url = f"{PLANE_HOST}/{workspace}/projects/{project_id}/issues/{issue_id}/"
    return {
        "plane_issue_id": issue_id,
        "plane_url": plane_url,
        "plane_number": plane_number,
        "plane_cycle_id": active_cycle_id,
        "plane_cycle_name": active_cycle["name"] if active_cycle else None,
        "plane_cycle_url": f"{PLANE_HOST}/{workspace}/projects/{project_id}/cycles/{active_cycle_id}/" if active_cycle_id else None,
    }


def push_plane_core_fields(cfg, task, issue_id):
    """Shared PATCH payload builder — pushes title/notes/status/priority/dates/assignee/labels
    onto an already-linked Plane issue. Returns {"error":...} on failure, None on success."""
    label_names = list(task.get("project") or []) + list(task.get("tags") or [])
    try:
        label_ids = resolve_label_ids(cfg, label_names)
    except Exception:
        label_ids = []
    notes = (task.get("notes") or "").strip()
    desc_html = f'<p class="editor-paragraph-block">{escape_html_py(notes)}</p>' if notes else "<p></p>"
    sid = plane_state_id(cfg, task.get("status"))
    is_pat = bool(cfg.get("pat"))
    payload = {
        "name": task.get("title", "Untitled task")[:255],
        "description_html": desc_html,
        "priority": PLANE_PRIORITY_MAP.get(task.get("priority") or "P3", "none"),
        "start_date": task.get("discussed_from") or None,
        "target_date": task.get("due_date") or None,
    }
    # v1 (PAT) uses "state"/"labels"/"assignees"; legacy cookie API uses "state_id"/"label_ids"/"assignee_ids"
    if is_pat:
        payload["state"] = sid
        payload["labels"] = label_ids
        payload["assignees"] = [cfg.get("assignee_id")]
    else:
        payload["state_id"] = sid
        payload["label_ids"] = label_ids
        payload["assignee_ids"] = [cfg.get("assignee_id")]
    status, data, raw = plane_request(cfg, "PATCH", f"{wpp(cfg)}/issues/{issue_id}/", payload)
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

    err = push_plane_core_fields(cfg, task, issue_id)
    if err:
        return err

    comment_html = plane_meta_comment_html(task)
    plane_request(cfg, "POST", f"{wpp(cfg)}/issues/{issue_id}/comments/", {"comment_html": comment_html})

    return {"ok": True, "plane_url": task.get("plane_url")}


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

        err = push_plane_core_fields(cfg, task, issue_id)
        if err:
            return err

        comment_html = plane_activity_diff_comment_html(meaningful)
        if comment_html:
            plane_request(cfg, "POST", f"{wpp(cfg)}/issues/{issue_id}/comments/", {"comment_html": comment_html})
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
