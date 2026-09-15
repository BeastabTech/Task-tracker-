from app.activity import append_activity, append_activity_tracked, make_activity
from app.constants import DATE_FIELDS, PRIORITIES, STATUSES, TYPES
from app.models import next_id, normalize_task
from app.utils import as_list, clean_date, iso_now, month_from, today_local


def find_task(tasks, task_id):
    for t in tasks:
        if t["id"] == task_id:
            return t
    return None


def build_new_task(tasks, body):
    today = today_local()
    now = iso_now()
    d_from = body.get("discussed_from") or today
    d_to = body.get("discussed_to") or d_from
    status = body.get("status") if body.get("status") in STATUSES else "To Do"
    task = {
        "id": next_id(tasks),
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
    return task


def apply_task_patch(t, body):
    """Mutates `t` in place per the PATCH /api/tasks/<id> field set. Returns the list of newly
    added activities from this request (for Plane auto-sync diffing)."""
    session_activities = []
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
            append_activity_tracked(
                t, make_activity(t, "cancel_reason_changed", at=now, from_value=old_reason, to=new_reason),
                session_activities,
            )

    for key in DATE_FIELDS:
        if key in body:
            old_value = t.get(key)
            new_value = clean_date(body.get(key))
            if old_value != new_value:
                t[key] = new_value
                append_activity_tracked(
                    t, make_activity(t, "date_changed", at=now, field=key, from_value=old_value, to=new_value),
                    session_activities,
                )

    if "status" in body:
        old_status = t.get("status")
        new_status = body["status"] if body["status"] in STATUSES else old_status
        status_note = (body.get("status_note") or "").strip()
        if old_status != new_status:
            t["status"] = new_status
            status_changed_kwargs = {"from_status": old_status, "to": new_status}
            if status_note:
                status_changed_kwargs["note"] = status_note
            append_activity_tracked(
                t, make_activity(t, "status_changed", at=now, **status_changed_kwargs), session_activities,
            )
            if new_status == "Done" and not t.get("done_at"):
                t["done_at"] = today
                append_activity_tracked(
                    t, make_activity(t, "date_changed", at=now, field="done_at", from_value=None, to=t["done_at"]),
                    session_activities,
                )
            if new_status == "Done" and not t.get("closed_at"):
                t["closed_at"] = today
            if new_status == "Done":
                append_activity_tracked(t, make_activity(t, "completed", at=now), session_activities)
            if new_status == "Cancelled":
                if not t.get("cancelled_at"):
                    t["cancelled_at"] = today
                    append_activity_tracked(
                        t, make_activity(t, "date_changed", at=now, field="cancelled_at", from_value=None, to=t["cancelled_at"]),
                        session_activities,
                    )
                if not t.get("closed_at"):
                    t["closed_at"] = today
                append_activity_tracked(
                    t, make_activity(t, "cancelled", at=now, reason=t.get("cancel_reason", "")), session_activities,
                )
            if old_status == "Done" and new_status != "Done":
                append_activity_tracked(
                    t, make_activity(t, "reopened", at=now, from_status=old_status, to=new_status), session_activities,
                )
            if old_status == "Cancelled" and new_status != "Cancelled":
                t["cancelled_at"] = None
                append_activity_tracked(
                    t, make_activity(t, "reopened", at=now, from_status=old_status, to=new_status), session_activities,
                )

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
            append_activity_tracked(
                t, make_activity(t, "archived" if t.get("archived_at") else "restored", at=now), session_activities,
            )

    t["updated_at"] = today
    t["updated_ts"] = now
    normalize_task(t)
    return session_activities


def apply_attachment_patch(t, body):
    session_activities = []
    t.setdefault("attachments", [])
    label = (body.get("label") or body.get("url") or "").strip()
    if label:
        t["attachments"].append(label)
        append_activity_tracked(t, make_activity(t, "attachment_added", label=label), session_activities)
    now = iso_now()
    t["updated_at"] = today_local()
    t["updated_ts"] = now
    normalize_task(t)
    return session_activities


def remove_attachment(t, idx):
    session_activities = []
    if 0 <= idx < len(t.get("attachments", [])):
        removed = t["attachments"].pop(idx)
        append_activity_tracked(t, make_activity(t, "attachment_removed", label=removed), session_activities)
    now = iso_now()
    t["updated_at"] = today_local()
    t["updated_ts"] = now
    normalize_task(t)
    return session_activities


def add_comment(t, text):
    session_activities = []
    normalize_task(t)
    now = iso_now()
    append_activity_tracked(t, make_activity(t, "comment", at=now, text=text), session_activities)
    t["updated_at"] = today_local()
    t["updated_ts"] = now
    normalize_task(t)
    return session_activities


def archive_task(t):
    session_activities = []
    normalize_task(t)
    now = iso_now()
    today = today_local()
    if not t.get("archived_at"):
        t["archived_at"] = today
        append_activity_tracked(t, make_activity(t, "archived", at=now), session_activities)
    t["updated_at"] = today
    t["updated_ts"] = now
    return session_activities
