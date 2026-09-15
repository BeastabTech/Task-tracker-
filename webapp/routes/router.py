import re

ROUTES = {"GET": [], "POST": [], "PATCH": [], "DELETE": []}


def route(method, pattern):
    compiled = re.compile(pattern)

    def decorator(fn):
        ROUTES[method].append((compiled, fn))
        return fn
    return decorator


def dispatch(method, path):
    for pattern, fn in ROUTES.get(method, []):
        m = pattern.match(path)
        if m:
            return fn, m
    return None, None
