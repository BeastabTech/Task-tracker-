import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from app.config import STATIC_DIR
import routes

_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


def _safe_static_path(url_path):
    """Resolves a request path to a file under STATIC_DIR, or None if it doesn't exist or would
    escape STATIC_DIR (path traversal via '..' or similar)."""
    rel = url_path.lstrip("/") or "index.html"
    candidate = os.path.normpath(os.path.join(STATIC_DIR, rel))
    static_root = os.path.normpath(STATIC_DIR)
    if candidate != static_root and not candidate.startswith(static_root + os.sep):
        return None
    if not os.path.isfile(candidate):
        return None
    return candidate


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path, content_type):
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return {}

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def _dispatch(self, method):
        parsed = urlsplit(self.path)
        path = parsed.path
        fn, m = routes.dispatch(method, path)
        if fn:
            return fn(self, m)
        if method == "GET":
            static_path = _safe_static_path(path if path != "/" else "/index.html")
            if static_path:
                ext = os.path.splitext(static_path)[1]
                content_type = _CONTENT_TYPES.get(ext, "application/octet-stream")
                return self._send_file(static_path, content_type)
        self.send_response(404)
        self.end_headers()

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PATCH(self):
        self._dispatch("PATCH")

    def do_DELETE(self):
        self._dispatch("DELETE")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8787))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Task tracker running at http://127.0.0.1:{port}")
    server.serve_forever()
