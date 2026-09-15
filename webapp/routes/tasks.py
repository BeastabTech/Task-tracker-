from app.storage import load_tasks, save_tasks
from plane.sync import apply_plane_auto_sync
from services.task_service import (
    add_comment,
    apply_attachment_patch,
    apply_task_patch,
    archive_task,
    build_new_task,
    find_task,
    remove_attachment,
)

from .router import route


@route("GET", r"^/api/tasks$")
def get_tasks(handler, m):
    handler._send_json(load_tasks())


@route("POST", r"^/api/tasks$")
def create_task(handler, m):
    data = load_tasks()
    body = handler._read_body()
    task = build_new_task(data["tasks"], body)
    data["tasks"].append(task)
    save_tasks(data)
    handler._send_json(task, status=201)


@route("PATCH", r"^/api/tasks/([^/]+)/attachments$")
def patch_attachments(handler, m):
    task_id = m.group(1)
    data = load_tasks()
    body = handler._read_body()
    found = find_task(data["tasks"], task_id)
    if not found:
        return handler._send_json({"error": "not found"}, status=404)
    session_activities = apply_attachment_patch(found, body)
    save_tasks(data)
    found = apply_plane_auto_sync(found, session_activities)
    handler._send_json(found)


@route("PATCH", r"^/api/tasks/([^/]+)$")
def patch_task(handler, m):
    task_id = m.group(1)
    data = load_tasks()
    body = handler._read_body()
    found = find_task(data["tasks"], task_id)
    if not found:
        return handler._send_json({"error": "not found"}, status=404)
    session_activities = apply_task_patch(found, body)
    save_tasks(data)
    found = apply_plane_auto_sync(found, session_activities)
    handler._send_json(found)


@route("DELETE", r"^/api/tasks/([^/]+)/attachments/(\d+)$")
def delete_attachment(handler, m):
    task_id, idx = m.group(1), int(m.group(2))
    data = load_tasks()
    found = find_task(data["tasks"], task_id)
    if not found:
        return handler._send_json({"error": "not found"}, status=404)
    session_activities = remove_attachment(found, idx)
    save_tasks(data)
    found = apply_plane_auto_sync(found, session_activities)
    handler._send_json(found)


@route("DELETE", r"^/api/tasks/([^/]+)$")
def delete_task(handler, m):
    task_id = m.group(1)
    data = load_tasks()
    found = find_task(data["tasks"], task_id)
    if not found:
        return handler._send_json({"error": "not found"}, status=404)
    session_activities = archive_task(found)
    save_tasks(data)
    found = apply_plane_auto_sync(found, session_activities)
    handler._send_json(found)


@route("POST", r"^/api/tasks/([^/]+)/comments$")
def post_comment(handler, m):
    task_id = m.group(1)
    data = load_tasks()
    body = handler._read_body()
    text = (body.get("text") or "").strip()
    if not text:
        return handler._send_json({"error": "Comment text is required"}, status=400)
    found = find_task(data["tasks"], task_id)
    if not found:
        return handler._send_json({"error": "not found"}, status=404)
    session_activities = add_comment(found, text)
    save_tasks(data)
    found = apply_plane_auto_sync(found, session_activities)
    handler._send_json(found)
