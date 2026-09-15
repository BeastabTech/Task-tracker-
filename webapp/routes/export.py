from urllib.parse import parse_qs, urlsplit

from app.models import filter_tasks_for_export
from app.storage import load_tasks
from app.utils import today_local
from services.export_service import build_export_xlsx

from .router import route


@route("GET", r"^/api/export$")
def get_export(handler, m):
    parsed = urlsplit(handler.path)
    q = parse_qs(parsed.query)
    data = load_tasks()
    filtered = filter_tasks_for_export(data["tasks"], q)
    xlsx_bytes = build_export_xlsx(filtered)
    fname = f"tasks-export-{today_local()}.xlsx"
    handler.send_response(200)
    handler.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    handler.send_header("Content-Disposition", f'attachment; filename="{fname}"')
    handler.send_header("Content-Length", str(len(xlsx_bytes)))
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.end_headers()
    handler.wfile.write(xlsx_bytes)
