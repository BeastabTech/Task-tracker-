import re
from datetime import timedelta

from .activity import append_activity, make_activity, sort_history
from .constants import CLOSED_STATUSES, DATE_FIELDS, PRIORITIES, STALE_DAYS, STATUSES, TYPES
from .utils import as_list, clean_date, date_from_any, month_from, now_local, today_local


def normalize_task(task):
    task.setdefault("id", "")
    task["title"] = (task.get("title") or "").strip() or "Untitled task"
    task["project"] = as_list(task.get("project"))
    task["tags"] = as_list(task.get("tags"))
    task["discussed_with"] = as_list(task.get("discussed_with"))
    task["attachments"] = as_list(task.get("attachments"))
    task["acceptance_criteria"] = as_list(task.get("acceptance_criteria"))
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
    task["plane_number"] = task.get("plane_number") or None
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
