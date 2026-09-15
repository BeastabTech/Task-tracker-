"""AI-fill for the Add Task form: turn a rough draft (title/notes typed so far) into a
complete set of suggested fields (title/description/labels/priority/type/acceptance
criteria) in one model call, returned as a structured suggestion the frontend previews —
never applied without the user checking it in and clicking Apply.
"""

import json
import re

from app.config import OLLAMA_MODEL
from app.constants import PRIORITIES, TYPES

from .client import OllamaError, call_ollama
from .context import build_persona_block, build_voice_block
from .parser import strip_think
from .prompts import AI_PROMPTS

_JSON_RE = re.compile(r"\{.*\}", re.DOTALL)


def _draft_to_text(draft):
    draft = draft or {}
    lines = []
    if draft.get("title"):
        lines.append(f"Title so far: {draft['title']}")
    if draft.get("notes"):
        lines.append(f"Notes so far: {draft['notes']}")
    if draft.get("project"):
        lines.append(f"Project: {', '.join(draft['project'])}")
    if draft.get("tags"):
        lines.append(f"Tags so far: {', '.join(draft['tags'])}")
    if draft.get("priority"):
        lines.append(f"Priority so far: {draft['priority']}")
    if draft.get("type"):
        lines.append(f"Type so far: {draft['type']}")
    if draft.get("due_date"):
        lines.append(f"Due date: {draft['due_date']}")
    return "\n".join(lines) or "(nothing typed yet)"


def _validate_suggestion(raw):
    if not isinstance(raw, dict):
        return None
    out = {}

    title = (raw.get("title") or "").strip()
    if title:
        out["title"] = title[:120]

    description = (raw.get("description") or "").strip()
    if description:
        out["description"] = description

    labels = raw.get("labels")
    if isinstance(labels, list):
        cleaned = [str(x).strip().lower() for x in labels if str(x).strip()]
        cleaned = list(dict.fromkeys(cleaned))[:4]
        if cleaned:
            out["labels"] = cleaned

    if raw.get("priority") in PRIORITIES:
        out["priority"] = raw["priority"]

    if raw.get("type") in TYPES:
        out["type"] = raw["type"]

    criteria = raw.get("acceptance_criteria")
    if isinstance(criteria, list):
        cleaned = [str(x).strip() for x in criteria if str(x).strip()][:6]
        if cleaned:
            out["acceptance_criteria"] = cleaned

    return out or None


def ai_fill_task(draft, tasks=None, previous_result=None, feedback=None, model=None):
    model = model or OLLAMA_MODEL
    input_text = _draft_to_text(draft)

    if previous_result:
        input_text += f"\n\nPrevious suggestion:\n{previous_result}"
        input_text += f"\n\nRevise it based on this feedback: {feedback}" if feedback else "\n\nImprove this suggestion."

    prompt_body = AI_PROMPTS["task_fill"].format(input=input_text)
    preamble = [build_persona_block()]
    if tasks:
        voice = build_voice_block(tasks)
        if voice:
            preamble.append(voice)
    prompt = "\n\n".join(preamble) + "\n\n" + prompt_body

    try:
        raw = call_ollama(prompt, model)
    except OllamaError as e:
        return {"error": str(e)}

    text = strip_think(raw)
    match = _JSON_RE.search(text)
    if not match:
        return {"error": "AI did not return a usable suggestion"}
    try:
        parsed = json.loads(match.group(0))
    except json.JSONDecodeError:
        return {"error": "AI did not return valid JSON"}

    suggestion = _validate_suggestion(parsed)
    if not suggestion:
        return {"error": "AI suggestion was empty or invalid"}
    return {"ok": True, "suggestion": suggestion, "model": model}
