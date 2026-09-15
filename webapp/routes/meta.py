from app.constants import PRIORITIES, STATUSES, TYPES

from .router import route


@route("GET", r"^/api/meta$")
def get_meta(handler, m):
    handler._send_json({"statuses": STATUSES, "priorities": PRIORITIES, "types": TYPES})
