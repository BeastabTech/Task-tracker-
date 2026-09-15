import re

from app.constants import PRIORITIES, TYPES

_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)


def strip_think(text):
    return _THINK_RE.sub("", text or "").strip()


def validate_output(mode, text):
    """Validate/repair output for modes with a constrained reply format. Returns
    (value, note) — note is None unless the model produced something outside the
    constraint, in which case value is a safe fallback and note explains why."""
    if mode == "priority":
        match = re.search(r"P[1-4]", text or "", re.IGNORECASE)
        if match:
            value = match.group(0).upper()
            if value in PRIORITIES:
                return value, None
        return "P3", f"AI reply did not contain a valid priority ({text!r}); defaulted to P3"

    if mode == "task_type":
        low = (text or "").lower()
        for t in TYPES:
            if t.lower() in low:
                return t, None
        return "Task", f"AI reply did not contain a valid type ({text!r}); defaulted to Task"

    return text, None
