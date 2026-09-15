import re
from datetime import date, datetime


def now_local():
    return datetime.now().astimezone()


def today_local():
    return now_local().date().isoformat()


def iso_now():
    return now_local().isoformat(timespec="seconds")


def clean_date(v):
    if not v:
        return None
    if isinstance(v, str) and re.match(r"^\d{4}-\d{2}-\d{2}$", v):
        return v
    return None


def date_from_any(*values):
    for value in values:
        if not value:
            continue
        if isinstance(value, str) and re.match(r"^\d{4}-\d{2}-\d{2}", value):
            return value[:10]
    return today_local()


def as_list(v):
    if v is None:
        return []
    if isinstance(v, list):
        return [str(x).strip() for x in v if str(x).strip()]
    return [p.strip() for p in str(v).split(",") if p.strip()]


def month_from(iso_date):
    if not iso_date:
        return now_local().strftime("%B")
    try:
        y, m, d = [int(x) for x in iso_date.split("-")]
        return date(y, m, d).strftime("%B")
    except (ValueError, TypeError):
        return now_local().strftime("%B")


def escape_html_py(s):
    return (
        (s or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )
