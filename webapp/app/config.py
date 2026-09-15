import os

# webapp/ — same value as the old server.py's ROOT (dirname of the script itself).
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TASKS_PATH = os.path.join(ROOT, "..", "tasks.json")
PLANE_CONFIG_PATH = os.path.join(ROOT, "plane_config.json")
STATIC_DIR = os.path.join(ROOT, "static")

# PLANE_HOST and every other Plane setting are per-install: no org's cookie/workspace/project/user
# is baked into the code. They live only in plane_config.json (gitignored, never shipped) and/or
# env vars, and are filled in per-user via the in-app "Connect to Plane" flow.
PLANE_HOST = os.environ.get("PLANE_HOST", "https://plane.alt-mobility.com")

OLLAMA_BASE = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "gemma4:e4b")

# Optional free-text persona the AI prompts and Ask AI assistant use to write in this user's
# voice/role (e.g. "Mehul, a backend engineer at Alt Mobility working mostly on IoT/fleet APIs").
# Unset by default — AI output then falls back to a generic engineer persona.
AI_USER_CONTEXT = os.environ.get("AI_USER_CONTEXT", "").strip()
