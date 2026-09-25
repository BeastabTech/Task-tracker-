from app.config import OLLAMA_MODEL

from .client import OllamaError, call_ollama
from .context import build_persona_block, build_task_context, build_voice_block, wrap_task_context
from .parser import strip_think, validate_output
from .prompts import AI_PROMPTS

# Modes where matching this person's own tone/phrasing actually matters (rewrites, summaries,
# written communication). Constrained/structured modes (priority, task_type, labels, task_plan,
# acceptance_criteria...) are left alone — a style example would only dilute those instructions.
VOICE_MODES = {
    "description", "standup", "summarize", "comment_reframe", "message_reframe", "email_reframe",
    "review_comment", "followup", "decision", "investigation", "progress_update", "blocker",
    "release_note", "daily_summary", "weekly_summary", "task_cleanup", "smart_rewrite",
}

# Modes that read better with the full structured task context (status/dates/tags/recent
# activity) rather than just the caller's raw text, when a task_id is supplied.
CONTEXT_AWARE_MODES = {
    "summarize", "root_cause", "task_plan", "next_step", "priority", "task_type",
    "progress_update", "blocker", "release_note", "task_cleanup", "acceptance_criteria",
}

# Long-form modes that have to cover many tasks one by one (standup, daily/weekly summaries) get
# cut off and start compressing/combining tasks under the default 300-token budget. Give them
# enough room to write a full bullet per task instead.
LONG_FORM_NUM_PREDICT = {
    "standup": 1400,
    "daily_summary": 1200,
    "weekly_summary": 1600,
    "root_cause": 700,
    "task_plan": 700,
}


def ai_generate(body, tasks=None):
    mode = body.get("mode", "description")
    text_input = (body.get("input") or "").strip()
    task_id = body.get("task_id")
    model = body.get("model") or OLLAMA_MODEL
    # Iterative refine: every AI surface in the UI can send back its own last result plus
    # optional free-text feedback ("shorter", "mention the DB angle") to regenerate instead of
    # starting over — see Accept/Reject/Refine-again pattern used across the AI Assist panel,
    # comment reframe, and Add Task AI-fill.
    previous_result = (body.get("previous_result") or "").strip()
    feedback = (body.get("feedback") or "").strip()

    prompt_tpl = AI_PROMPTS.get(mode)
    if not prompt_tpl:
        return {"error": f"unknown mode '{mode}'. Valid: {list(AI_PROMPTS)}"}

    final_input = text_input
    if task_id and tasks is not None:
        task = next((t for t in tasks if t.get("id") == task_id), None)
        if task is None:
            return {"error": f"task '{task_id}' not found"}
        context_text = build_task_context(task)
        final_input = wrap_task_context(context_text, text_input)

    if previous_result:
        refine_block = f"Previous draft:\n{previous_result}"
        refine_block += f"\n\nRevise it based on this feedback: {feedback}" if feedback else "\n\nRevise and improve this draft."
        final_input = f"{final_input}\n\n{refine_block}" if final_input else refine_block

    if not final_input:
        return {"error": "input is required"}

    prompt_body = prompt_tpl.format(input=final_input)
    preamble_parts = [build_persona_block()]
    if mode in VOICE_MODES and tasks:
        voice = build_voice_block(tasks)
        if voice:
            preamble_parts.append(voice)
    prompt = "\n\n".join(preamble_parts) + "\n\n" + prompt_body

    try:
        num_predict = LONG_FORM_NUM_PREDICT.get(mode, 300)
        timeout = 180 if mode in LONG_FORM_NUM_PREDICT else 90
        raw = call_ollama(prompt, model, timeout=timeout, num_predict=num_predict)
    except OllamaError as e:
        return {"error": str(e)}
    text = strip_think(raw)
    result, note = validate_output(mode, text)
    response = {"ok": True, "result": result, "model": model}
    if note:
        response["note"] = note
    return response
