"""'Ask AI' — a lightweight, single-shot agentic assistant over the whole task list.

Design note: this deliberately avoids a multi-turn autonomous tool-calling loop. The local
model backing this app (a small Ollama model) is not reliable enough at that to run
unsupervised, and a runaway loop against real task data is not an acceptable risk. Instead:
retrieval (deciding which tasks are relevant to the question) is done deterministically in
Python, then a single Ollama call answers the question and may propose *one* action. Any
proposed action is only ever a suggestion — the frontend previews it and the user must click
Apply, which goes through the exact same PATCH/POST endpoints as every other edit in this app.
Nothing here executes a mutation on its own.
"""

import json
import re
from collections import Counter

from app.config import OLLAMA_MODEL
from app.constants import PRIORITIES, STATUSES
from app.models import is_closed, is_overdue, is_stale

from .client import OllamaError, call_ollama
from .context import build_persona_block, build_task_context, build_voice_block, wrap_task_context
from .parser import strip_think

MAX_INDEX = 120

_STOPWORDS = {
    "the", "a", "an", "is", "are", "was", "were", "to", "of", "in", "on", "for", "and", "or",
    "with", "my", "me", "i", "what", "which", "how", "do", "does", "did", "this", "that",
    "task", "tasks", "any", "there", "have", "has", "please", "can", "you", "show", "list",
}


def _tokenize(text):
    return set(re.findall(r"[a-z0-9]+", (text or "").lower())) - _STOPWORDS


def _task_tokens(t):
    haystack = " ".join([
        t.get("title", ""), t.get("notes", ""),
        " ".join(t.get("project") or []), " ".join(t.get("tags") or []),
        " ".join(t.get("discussed_with") or []),
    ])
    return _tokenize(haystack)


def gather_relevant_tasks(question, tasks, limit=MAX_INDEX):
    """Deterministic retrieval: score every open (or keyword-matched) task by question-keyword
    overlap, with a light bias toward open/overdue work, then take the top `limit`."""
    active = [t for t in tasks if not t.get("archived_at")]
    q_tokens = _tokenize(question)
    scored = []
    for t in active:
        score = len(q_tokens & _task_tokens(t))
        if is_overdue(t):
            score += 1
        if not is_closed(t):
            score += 0.5
        scored.append((score, t.get("updated_at") or "", t))
    scored.sort(key=lambda row: (row[0], row[1]), reverse=True)
    return [t for _, _, t in scored[:limit]]


def _compact_line(t):
    proj = ",".join(t.get("project") or []) or "-"
    tags = ",".join(t.get("tags") or []) or "-"
    due = t.get("due_date") or "-"
    flags = []
    if is_overdue(t):
        flags.append("overdue")
    if is_stale(t):
        flags.append("stale")
    flag_str = f" [{','.join(flags)}]" if flags else ""
    plane = f" | plane:{t['plane_number']}" if t.get("plane_number") else ""
    return f"{t['id']} | {t.get('status')} | {t.get('priority')} | {t.get('type')} | {t.get('title')} | proj:{proj} | tags:{tags} | due:{due}{flag_str}{plane}"


def _stats_summary(tasks):
    active = [t for t in tasks if not t.get("archived_at")]
    by_status = Counter(t.get("status") for t in active)
    overdue = sum(1 for t in active if is_overdue(t))
    stale = sum(1 for t in active if is_stale(t))
    parts = ", ".join(f"{count} {status}" for status, count in by_status.items())
    return f"Totals: {parts} (active: {len(active)}, overdue: {overdue}, stale: {stale})"


AGENT_INSTRUCTIONS = (
    "You are an assistant embedded in this engineer's personal task tracker, shown the current "
    "task data below. Answer the question directly and concisely in plain English, like a "
    "helpful teammate, not a corporate assistant. Reference specific task IDs when useful. Do "
    "not invent tasks, ids, or facts that are not in the data below — if the data does not "
    "answer the question, say so plainly instead of guessing.\n\n"
    "If, and only if, the question clearly asks you to change something (move a task's status, "
    "change its priority, add a comment, archive it, or create a new task), end your reply with "
    "exactly one ACTION block in this exact format, using a real task id from the data below:\n"
    "---ACTION---\n"
    '{"name": "update_status|update_priority|add_comment|archive_task|create_task", "args": {}}\n'
    "---END ACTION---\n"
    "Valid args per action name:\n"
    '  update_status: {"task_id", "status"} — status is one of: ' + ", ".join(STATUSES) + "\n"
    '  update_priority: {"task_id", "priority"} — priority is one of: ' + ", ".join(PRIORITIES) + "\n"
    '  add_comment: {"task_id", "text"}\n'
    '  archive_task: {"task_id"}\n'
    '  create_task: {"title", "priority" (optional), "project" (optional list), "tags" (optional list), "due_date" (optional, YYYY-MM-DD)}\n'
    "Never include an ACTION block for a question that is only asking for information. Do not "
    "explain the ACTION block, and put nothing after it."
)

_ACTION_RE = re.compile(r"-{0,3}\s*ACTION\s*-{0,3}\s*(\{.*?\})\s*-{0,3}\s*END ACTION\s*-{0,3}", re.DOTALL | re.IGNORECASE)


def _find_task(tasks, task_id):
    return next((t for t in tasks if t.get("id") == task_id and not t.get("archived_at")), None)


def validate_action(action, tasks, forced_task_id=None):
    """Whitelist + shape-check a model-proposed action against real task ids and allowed
    values. Returns a normalized {name, args, label} dict, or None if it doesn't hold up.

    forced_task_id: when the caller already knows which single task is in scope (per-task
    Ask AI), override whatever task_id the model guessed — the small local model isn't
    reliable at echoing back an opaque id it was shown once, but there's no ambiguity to
    resolve here since only one task is in play."""
    if not isinstance(action, dict):
        return None
    name = action.get("name")
    args = action.get("args")
    if not isinstance(args, dict):
        return None
    if forced_task_id and name in ("update_status", "update_priority", "add_comment", "archive_task"):
        args = {**args, "task_id": forced_task_id}

    if name == "update_status":
        task = _find_task(tasks, args.get("task_id"))
        status = args.get("status")
        if not task or status not in STATUSES:
            return None
        return {"name": name, "args": {"task_id": task["id"], "status": status},
                "label": f"Move {task['id']} — {task['title']} — to {status}"}

    if name == "update_priority":
        task = _find_task(tasks, args.get("task_id"))
        priority = args.get("priority")
        if not task or priority not in PRIORITIES:
            return None
        return {"name": name, "args": {"task_id": task["id"], "priority": priority},
                "label": f"Set {task['id']} — {task['title']} — priority to {priority}"}

    if name == "add_comment":
        task = _find_task(tasks, args.get("task_id"))
        text = (args.get("text") or "").strip()
        if not task or not text:
            return None
        return {"name": name, "args": {"task_id": task["id"], "text": text},
                "label": f"Add comment on {task['id']} — {task['title']}"}

    if name == "archive_task":
        task = _find_task(tasks, args.get("task_id"))
        if not task:
            return None
        return {"name": name, "args": {"task_id": task["id"]},
                "label": f"Archive {task['id']} — {task['title']}"}

    if name == "create_task":
        title = (args.get("title") or "").strip()
        if not title:
            return None
        out = {"title": title}
        if args.get("priority") in PRIORITIES:
            out["priority"] = args["priority"]
        if isinstance(args.get("project"), list):
            out["project"] = [str(x).strip() for x in args["project"] if str(x).strip()]
        if isinstance(args.get("tags"), list):
            out["tags"] = [str(x).strip() for x in args["tags"] if str(x).strip()]
        if args.get("due_date"):
            out["due_date"] = args["due_date"]
        return {"name": name, "args": out, "label": f"Create task — {title}"}

    return None


def parse_agent_reply(text, tasks, forced_task_id=None):
    """Split a raw model reply into (clean_answer_text, validated_action_or_None)."""
    match = _ACTION_RE.search(text or "")
    if not match:
        return (text or "").strip(), None
    action = None
    try:
        action = validate_action(json.loads(match.group(1)), tasks, forced_task_id=forced_task_id)
    except (json.JSONDecodeError, TypeError):
        action = None
    clean = (text[:match.start()] + text[match.end():]).strip()
    return clean, action


def ai_ask(question, tasks, model=None, task_id=None):
    question = (question or "").strip()
    if not question:
        return {"error": "question is required"}
    model = model or OLLAMA_MODEL

    if task_id:
        focus_task = _find_task(tasks, task_id)
        if not focus_task:
            return {"error": f"task '{task_id}' not found"}
        data_block = build_task_context(focus_task)
    else:
        chosen = gather_relevant_tasks(question, tasks)
        index_text = "\n".join(_compact_line(t) for t in chosen) if chosen else "(no open tasks)"
        data_block = f"{_stats_summary(tasks)}\n\n{index_text}"

    parts = [build_persona_block()]
    voice = build_voice_block(tasks)
    if voice:
        parts.append(voice)
    parts.append(AGENT_INSTRUCTIONS)
    parts.append(wrap_task_context(data_block))
    parts.append(f"Question: {question}")
    prompt = "\n\n".join(parts)

    try:
        raw = call_ollama(prompt, model, timeout=90)
    except OllamaError as e:
        return {"error": str(e)}

    text = strip_think(raw)
    answer, action = parse_agent_reply(text, tasks, forced_task_id=task_id)
    return {"ok": True, "answer": answer, "action": action, "model": model}
