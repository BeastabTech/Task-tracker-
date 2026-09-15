from app.constants import ACTIVITY_FIELD_LABELS
from app.utils import escape_html_py


def plane_state_id(cfg, status):
    state_name = (cfg.get("status_map") or {}).get(status)
    return (cfg.get("states") or {}).get(state_name)


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
