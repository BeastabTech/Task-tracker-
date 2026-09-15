from ai.actions import ai_generate
from app.storage import load_tasks

from .router import route


@route("POST", r"^/api/ai-generate$")
def post_ai_generate(handler, m):
    body = handler._read_body()
    tasks = load_tasks()["tasks"] if body.get("task_id") else None
    result = ai_generate(body, tasks=tasks)
    if "error" in result:
        return handler._send_json(result, status=502)
    handler._send_json(result)
