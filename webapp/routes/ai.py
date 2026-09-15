from ai.actions import ai_generate
from ai.agent import ai_ask
from ai.fill import ai_fill_task
from app.storage import load_tasks

from .router import route


@route("POST", r"^/api/ai-generate$")
def post_ai_generate(handler, m):
    body = handler._read_body()
    # Loaded unconditionally (cheap local read): needed both for task_id lookups and to pull
    # this person's own past writing as a style reference (see ai.context.build_voice_block).
    tasks = load_tasks()["tasks"]
    result = ai_generate(body, tasks=tasks)
    if "error" in result:
        return handler._send_json(result, status=502)
    handler._send_json(result)


@route("POST", r"^/api/ai-ask$")
def post_ai_ask(handler, m):
    body = handler._read_body()
    tasks = load_tasks()["tasks"]
    result = ai_ask(body.get("question"), tasks, task_id=body.get("task_id"))
    if "error" in result:
        return handler._send_json(result, status=502)
    handler._send_json(result)


@route("POST", r"^/api/ai-fill-task$")
def post_ai_fill_task(handler, m):
    body = handler._read_body()
    tasks = load_tasks()["tasks"]
    result = ai_fill_task(
        body.get("draft"), tasks,
        previous_result=body.get("previous_result"), feedback=body.get("feedback"),
    )
    if "error" in result:
        return handler._send_json(result, status=502)
    handler._send_json(result)
