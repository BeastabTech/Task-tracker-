import hashlib
import json

from .constants import ACTIVITY_LIMIT, ACTIVITY_ORDER
from .utils import date_from_any, iso_now


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
    can auto-sync only that diff to Plane. See plane.sync.sync_plane_on_activity."""
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
