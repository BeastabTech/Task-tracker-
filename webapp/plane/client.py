import json
import urllib.error
import urllib.request

from app.config import PLANE_HOST


def plane_request(cfg, method, path, payload=None, force_cookie=False):
    """Low-level helper for any Plane API call. Prefers PAT (X-Api-Key) when set, falls back to cookie auth.
    Pass force_cookie=True to skip PAT and use cookie even when PAT is configured (e.g. on rate-limit)."""
    pat = cfg.get("pat") if not force_cookie else None
    cookie = cfg.get("cookie")
    workspace = cfg.get("workspace")
    project_id = cfg.get("project_id")
    # Cookie auth uses /api/ prefix; PAT uses /api/v1/ — translate path when forcing cookie on a v1 path
    if force_cookie and path.startswith("/api/v1/"):
        path = "/api/" + path[len("/api/v1/"):]
    url = f"{PLANE_HOST}{path}"
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    if pat:
        req.add_header("X-Api-Key", pat)
    else:
        req.add_header("Cookie", cookie)
        req.add_header("Origin", PLANE_HOST)
        req.add_header("Referer", f"{PLANE_HOST}/{workspace}/projects/{project_id}/issues/")
        req.add_header("User-Agent", "Mozilla/5.0 (task-tracker integration)")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8")
            try:
                parsed = json.loads(raw) if raw else None
            except Exception:
                parsed = None
            return resp.status, parsed, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        return e.code, None, raw
    except urllib.error.URLError as e:
        return None, None, str(e.reason)
    except Exception as e:
        return None, None, str(e)


def plane_base(cfg):
    """Returns the correct API base path: /api/v1 for PAT, /api for cookie."""
    return "/api/v1" if cfg.get("pat") else "/api"


def wpp(cfg):
    """Workspace-project path prefix: /api[/v1]/workspaces/{ws}/projects/{pid}"""
    ws = cfg.get("workspace", "")
    pid = cfg.get("project_id", "")
    return f"{plane_base(cfg)}/workspaces/{ws}/projects/{pid}"
