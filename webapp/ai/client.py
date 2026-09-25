import json
import urllib.request
import urllib.error

from app.config import OLLAMA_BASE


class OllamaError(Exception):
    pass


def call_ollama(prompt, model, timeout=90, num_predict=300, num_ctx=8192):
    # Ollama silently truncates the prompt to num_ctx tokens when it's not set explicitly
    # (its own default is much smaller than what these models actually support), which was
    # dropping whole sections of a large task list before the model ever saw them.
    payload = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "think": False,
        "options": {"temperature": 0.4, "num_predict": num_predict, "num_ctx": num_ctx},
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{OLLAMA_BASE}/api/chat",
        data=payload,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            msg = data.get("message") or {}
            return (msg.get("content") or "").strip()
    except urllib.error.HTTPError as e:
        body_txt = ""
        try:
            body_txt = e.read().decode("utf-8", errors="replace")[:300]
        except Exception:
            pass
        raise OllamaError(f"Ollama HTTP {e.code}: {e.reason} — {body_txt}") from e
    except urllib.error.URLError as e:
        raise OllamaError(f"Ollama not reachable: {e.reason}") from e
    except Exception as e:
        raise OllamaError(f"{type(e).__name__}: {e}") from e
