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

CLOSED_STATUSES = {"Done", "Cancelled"}
STALE_DAYS = 7

PLANE_PRIORITY_MAP = {"P1": "urgent", "P2": "high", "P3": "medium", "P4": "low"}

PLANE_GROUP_TO_STATUS = {
    "backlog": "To Do",
    "unstarted": "To Do",
    "started": "In Progress",
    "completed": "Done",
    "cancelled": "Cancelled",
}

PLANE_ACTIVE_WORK_STATUSES = {"In Progress", "In Review", "Pending"}

# Plane module every Slack-alert-driven bug/incident task should sit in (see TKT-1608, which
# this convention was copied from). Matched by name via the Plane API, not a hardcoded id, since
# module ids differ per Plane project/workspace.
PLANE_BUG_MODULE_NAME = "slack bug / incident"


def is_slack_bug_incident_task(tags):
    tags = tags or []
    return "Slack Bug" in tags or ("Bug" in tags and "Incident" in tags)

LABEL_COLORS = [
    "#F87171", "#FB923C", "#FBBF24", "#A3E635", "#34D399",
    "#22D3EE", "#60A5FA", "#A78BFA", "#F472B6", "#94A3B8",
]

ACTIVITY_FIELD_LABELS = {
    "due_date": "Due date",
    "start_date": "Start date",
    "discussed_from": "Discussed from",
    "discussed_to": "Discussed to",
    "done_at": "Done date",
    "closed_at": "Closed date",
    "cancelled_at": "Cancelled date",
}
