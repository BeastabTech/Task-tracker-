import hashlib

from app.constants import LABEL_COLORS

from .client import plane_request, wpp


def label_color(name):
    """Deterministic color per label name. Previously used Python's built-in hash(), which is
    randomized per process (PYTHONHASHSEED) — the same label name could pick a different color
    on every server restart. sha1 is stable across runs and processes."""
    digest = hashlib.sha1(name.encode("utf-8")).hexdigest()
    return LABEL_COLORS[int(digest, 16) % len(LABEL_COLORS)]


def refresh_plane_labels(cfg):
    """Fetches all project labels from Plane and caches them in cfg['labels_cache'].
    Returns the cache dict {name_lower: {"id":..., "name":..., "color":...}}."""
    status, data, _ = plane_request(cfg, "GET", f"{wpp(cfg)}/labels/")
    if status != 200:
        return cfg.get("labels_cache") or {}
    items = data if isinstance(data, list) else (data.get("results") if isinstance(data, dict) else [])
    cache = {}
    for lbl in (items or []):
        if lbl.get("name") and lbl.get("id"):
            cache[lbl["name"].lower()] = {"id": lbl["id"], "name": lbl["name"], "color": lbl.get("color", "#94A3B8")}
    cfg["labels_cache"] = cache
    return cache


def resolve_label_ids(cfg, names):
    """Maps a list of label names to Plane label IDs. Creates labels that don't exist yet.
    Returns a list of IDs. Never raises — a failure just means that name is skipped."""
    if not names:
        return []
    cache = cfg.get("labels_cache") or refresh_plane_labels(cfg)
    ids = []
    cache_refreshed = False
    for name in names:
        name = name.strip()
        if not name:
            continue
        key = name.lower()
        if key in cache:
            ids.append(cache[key]["id"])
            continue
        # Fuzzy: check if any existing label contains this name or vice versa
        match = next((v for k, v in cache.items() if key in k or k in key), None)
        if match:
            ids.append(match["id"])
            continue
        # Cache miss — refresh once from Plane before trying to create
        if not cache_refreshed:
            cache = refresh_plane_labels(cfg)
            cache_refreshed = True
            if key in cache:
                ids.append(cache[key]["id"])
                continue
            match = next((v for k, v in cache.items() if key in k or k in key), None)
            if match:
                ids.append(match["id"])
                continue
        # Try to create the label
        try:
            s, d, raw = plane_request(cfg, "POST", f"{wpp(cfg)}/labels/", {
                "name": name,
                "color": label_color(name),
            })
            if s in (200, 201) and isinstance(d, dict) and d.get("id"):
                cache[key] = {"id": d["id"], "name": name, "color": d.get("color", "")}
                cfg["labels_cache"] = cache
                ids.append(d["id"])
            elif s == 409 and isinstance(d, dict) and d.get("id"):
                # Label already exists in Plane but wasn't in our cache
                cache[key] = {"id": d["id"], "name": name, "color": ""}
                cfg["labels_cache"] = cache
                ids.append(d["id"])
        except Exception:
            pass
    return ids
