from app.config import OLLAMA_MODEL

from .client import OllamaError, call_ollama
from .context import build_task_context, wrap_task_context
from .parser import strip_think, validate_output
from .prompts import AI_PROMPTS

# Modes that benefit from full structured task context (title/status/dates/tags/
# recent activity) rather than just the caller's raw text. Wired from a task_id,
# never required — callers that only ever send free text (title/description/
# labels/*_reframe/etc.) keep working exactly as before.
CONTEXT_AWARE_MODES = {
    "summarize", "root_cause", "task_plan", "next_step", "priority", "task_type",
    "progress_update", "blocker", "release_note", "task_cleanup",
    "acceptance_criteria",
}


def ai_generate(body, tasks=None):
    mode = body.get("mode", "description")
    text_input = (body.get("input") or "").strip()
    task_id = body.get("task_id")
    model = body.get("model") or OLLAMA_MODEL

    prompt_tpl = AI_PROMPTS.get(mode)
    if not prompt_tpl:
        return {"error": f"unknown mode '{mode}'. Valid: {list(AI_PROMPTS)}"}

    final_input = text_input
    if task_id and tasks is not None:
        task = next((t for t in tasks if t.get("id") == task_id), None)
        if task is None:
            return {"error": f"task '{task_id}' not found"}
        context_text = build_task_context(task)
        if mode in CONTEXT_AWARE_MODES:
            final_input = wrap_task_context(context_text, text_input)
        else:
            final_input = wrap_task_context(context_text, text_input) if text_input else context_text

    if not final_input:
        return {"error": "input is required"}

    prompt = prompt_tpl.format(input=final_input)
    try:
        raw = call_ollama(prompt, model)
    except OllamaError as e:
        return {"error": str(e)}
    text = strip_think(raw)
    result, note = validate_output(mode, text)
    response = {"ok": True, "result": result, "model": model}
    if note:
        response["note"] = note
    return response
