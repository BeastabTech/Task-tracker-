import json
import os
import re

from app.config import PLANE_CONFIG_PATH


def load_plane_config():
    cfg = {}
    if os.path.exists(PLANE_CONFIG_PATH):
        with open(PLANE_CONFIG_PATH) as f:
            cfg = json.load(f)
    # Env vars win when set — lets someone self-host this (Docker, a shared server, etc.)
    # without ever touching the UI or the config file, per-instance, no code changes.
    for key, env_name in (
        ("pat", "PLANE_PAT"),
        ("cookie", "PLANE_COOKIE"),
        ("workspace", "PLANE_WORKSPACE"),
        ("project_id", "PLANE_PROJECT_ID"),
        ("assignee_id", "PLANE_ASSIGNEE_ID"),
    ):
        val = os.environ.get(env_name)
        if val:
            cfg[key] = val
    return cfg


def save_plane_config(cfg):
    with open(PLANE_CONFIG_PATH, "w") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
        f.write("\n")


def extract_plane_cookie(raw):
    """The Plane-cookie settings box expects a raw `Cookie:` header value, but people naturally
    paste a whole 'Copy as cURL' command instead (this project's own working examples are all curls).
    If the input looks like a curl invocation, pull the cookie out of it (`-b '...'`, `--cookie '...'`,
    or `-H 'Cookie: ...'`); otherwise assume it's already a plain cookie string and use it as-is."""
    raw = (raw or "").strip()
    if not raw:
        return raw
    patterns = [
        r"(?:-b|--cookie)\s+'([^']*)'",
        r'(?:-b|--cookie)\s+"([^"]*)"',
        r"-H\s+'Cookie:\s*([^']*)'",
        r'-H\s+"Cookie:\s*([^"]*)"',
    ]
    for pat in patterns:
        m = re.search(pat, raw, re.IGNORECASE)
        if m and m.group(1).strip():
            return m.group(1).strip()
    return raw
