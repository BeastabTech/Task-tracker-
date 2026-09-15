import json
import os

from .config import TASKS_PATH
from .models import normalize_task
from .utils import today_local


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
