"""Runtime helpers for tests exported by StepForge (by Md Zarin Tasnim). Same rules as StepForge's own checks."""
import json
import random as _random
import re
import string
import time
import uuid
from datetime import date, timedelta
from decimal import Decimal

from faker import Faker

_faker = Faker()

RUN_ID = f"{int(time.time() * 1000):x}{_random.randint(0, 9999)}"
"""A unique id for this test run, like StepForge's {{run.id}}."""


def _length(v):
    if isinstance(v, (str, list, dict)):
        return len(v)
    return None


def _is_num(v):
    return isinstance(v, (int, float, Decimal)) and not isinstance(v, bool)


def _json_default(v):
    # Database drivers return Decimal for NUMERIC columns: compared as the number it is.
    if isinstance(v, Decimal):
        return int(v) if v == v.to_integral_value() else float(v)
    return str(v)


def _same(a, b):
    # 1 == 1.0 == Decimal("1"), but True is not 1.
    if _is_num(a) and _is_num(b):
        return a == b
    if a == b and type(a) is type(b):
        return True
    # "200" equals 200: values read from the page are always strings.
    if (_is_num(a) and isinstance(b, str)) or (_is_num(b) and isinstance(a, str)):
        return _num_text(a) == _num_text(b)
    return json.dumps(a, default=_json_default) == json.dumps(b, default=_json_default)


def _num_text(v):
    if isinstance(v, Decimal):
        v = int(v) if v == v.to_integral_value() else float(v)
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def _range(e):
    def n(v):
        return None if v is None or v == "" else float(v)

    if isinstance(e, (list, tuple)):
        return n(e[0] if len(e) > 0 else None), n(e[1] if len(e) > 1 else None)
    if isinstance(e, dict):
        return n(e.get("min")), n(e.get("max"))
    m = re.match(r"^\s*(-?[\d.]*)\s*\.\.\s*(-?[\d.]*)\s*$", str(e if e is not None else ""))
    return (n(m.group(1)), n(m.group(2))) if m else (None, None)


def _as_list(v):
    return v if isinstance(v, list) else [v]


def _empty(v):
    return v is None or v == "" or _length(v) == 0


def _number(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return float("nan")


def compare(actual, operator, expected=None):
    """Compares a value with one of StepForge's operators (equals, contains, gt, matches, inRange…)."""
    if operator == "equals":
        return _same(actual, expected)
    if operator == "notEquals":
        return not _same(actual, expected)
    if operator == "contains":
        if isinstance(actual, list):
            return any(_same(x, expected) for x in actual)
        return str(expected) in ("" if actual is None else str(actual))
    if operator == "notContains":
        return not compare(actual, "contains", expected)
    if operator == "matches":
        return re.search(str(expected), "" if actual is None else str(actual)) is not None
    if operator in ("lt", "lte", "gt", "gte"):
        a, e = _number(actual), _number(expected)
        return {"lt": a < e, "lte": a <= e, "gt": a > e, "gte": a >= e}[operator]
    if operator == "exists":
        return actual is not None
    if operator == "notExists":
        return actual is None
    if operator == "isEmpty":
        return _empty(actual)
    if operator == "isNotEmpty":
        return not _empty(actual)
    if operator == "lengthEquals":
        return _length(actual) == int(_number(expected))
    if operator == "noNulls":
        return all(x is not None for x in _as_list(actual))
    if operator == "unique":
        seen = [json.dumps(x, default=str) for x in _as_list(actual)]
        return len(set(seen)) == len(seen)
    if operator == "inRange":
        lo, hi = _range(expected)
        for x in _as_list(actual):
            n = _number(x)
            if x is None or n != n or (lo is not None and n < lo) or (hi is not None and n > hi):
                return False
        return True
    raise ValueError(f'Unknown operator "{operator}"')


def check(actual, operator, expected, what):
    """Fails the test unless `compare` holds."""
    extra = f" {json.dumps(expected, default=str)}" if expected is not None else ""
    assert compare(actual, operator, expected), (
        f"Expected {what}{extra}, but got {json.dumps(actual, default=str)}"
    )


_TOKEN = re.compile(
    r"\.\.([\w$-]+)|\.([\w$-]+)|\[\s*'([^']*)'\s*\]|\[\s*\"([^\"]*)\"\s*\]|\[(\*|-?\d+)\]|\.(\*)"
    r"|\[\s*(-?\d*)\s*:\s*(-?\d*)\s*\]"
    r"|\[\?\(\s*@((?:\.[\w$-]+)*)\s*(?:(===?|!==?|<=|>=|<|>)\s*('[^']*'|\"[^\"]*\"|[^)\s]+)\s*)?\)\]"
)


def _literal(raw):
    """A JSONPath literal in a filter: 'text', "text", a number, true, false or null."""
    t = raw.strip()
    if len(t) >= 2 and t[0] == t[-1] and t[0] in "'\"":
        return t[1:-1]
    if t in ("true", "false"):
        return t == "true"
    if t == "null":
        return None
    try:
        return float(t) if any(c in t for c in ".eE") else int(t)
    except ValueError:
        return t


def _holds(a, op, b):
    """A filter comparison, as StepForge's JSONPath evaluates it ("2" == 2; < and > on numbers when one side is one)."""
    if op in ("==", "==="):
        return _same(a, b)
    if op in ("!=", "!=="):
        return not _same(a, b)
    if a is None or b is None:
        return False
    if _is_num(a) or _is_num(b):
        x, y = _number(a), _number(b)
    else:
        x, y = str(a), str(b)
    return {"<": x < y, "<=": x <= y, ">": x > y, ">=": x >= y}[op]


def json_path(data, path):
    """A small JSONPath: $, .key, ['key'], [n], [*], ..key, slices ([0:2], [-1:]) and filters on a field
    ([?(@.id==2)], [?(@.price<10)], [?(@.email)]). Lists come back for wildcards, slices and filters."""
    nodes, multi = [data], False

    def kids(n):
        return n if isinstance(n, list) else list(n.values()) if isinstance(n, dict) else []

    for m in _TOKEN.finditer(re.sub(r"^\$", "", path)):
        deep, dot, sq, dq, idx, star, start, stop, fpath, fop, fval = m.groups()
        if deep:
            multi, found = True, []

            def visit(n):
                if isinstance(n, dict):
                    if deep in n:
                        found.append(n[deep])
                for k in kids(n):
                    visit(k)

            for n in nodes:
                visit(n)
            nodes = found
        elif idx == "*" or star:
            multi = True
            nodes = [k for n in nodes for k in kids(n)]
        elif idx is not None:
            i = int(idx)
            nodes = [n[i] for n in nodes if isinstance(n, list) and -len(n) <= i < len(n)]
        elif start is not None:
            multi = True
            lo, hi = (int(start) if start else None), (int(stop) if stop else None)
            nodes = [k for n in nodes if isinstance(n, list) for k in n[lo:hi]]
        elif fpath is not None:
            multi = True
            expected = _literal(fval) if fop else None
            kept = []
            for k in (k for n in nodes for k in kids(n)):
                v = field(k, fpath[1:]) if fpath else k
                if (_holds(v, fop, expected) if fop else v is not None and v is not False):
                    kept.append(k)
            nodes = kept
        else:
            key = dot or sq or dq
            nodes = [n[key] for n in nodes if isinstance(n, dict) and key in n]
    return nodes if multi else (nodes[0] if nodes else None)


def field(obj, path):
    """Reads `user.email`-style nested values."""
    for k in path.split("."):
        obj = obj.get(k) if isinstance(obj, dict) else None
    return obj


def capture(text, pattern):
    """First capture group of a regular expression (or the whole match)."""
    m = re.search(pattern, "" if text is None else str(text))
    if not m:
        return None
    return m.group(1) if m.groups() else m.group(0)


def text(v):
    """A value as text, the way StepForge types it into a field."""
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (dict, list)):
        return json.dumps(v)
    return _num_text(v)


def random_value(kind):
    """{{random.*}} values."""
    if kind == "email":
        return f"sf.{int(time.time() * 1000):x}{_random.randint(1000, 9999)}@example.test"
    if kind == "uuid":
        return str(uuid.uuid4())
    if kind == "number":
        return _random.randint(0, 999_999)
    if kind == "digits6":
        return f"{_random.randint(0, 999_999):06d}"
    if kind == "timestamp":
        return int(time.time() * 1000)
    return "".join(_random.choices(string.ascii_lowercase + string.digits, k=8))


def _pattern(p):
    return "".join(
        str(_random.randint(0, 9)) if c == "#" else _random.choice(string.ascii_uppercase) if c == "?"
        else _random.choice(string.ascii_uppercase + string.digits) if c == "*" else c
        for c in p
    )


def fake(kind, **o):
    """Test data, like StepForge's "Generate data" step."""
    if kind == "name":
        return _faker.name()
    if kind == "firstName":
        return _faker.first_name()
    if kind == "lastName":
        return _faker.last_name()
    if kind == "email":
        return f"{_faker.user_name()}{_random.randint(1, 999)}@{o.get('domain', 'example.test')}".lower()
    if kind == "phone":
        return _pattern(o.get("pattern", "+1-555-###-####"))
    if kind == "date":
        if o.get("direction") == "future":
            return (date.today() + timedelta(days=_random.randint(1, int(o.get("days", 30))))).isoformat()
        return (date.today() - timedelta(days=_random.randint(1, 365 * int(o.get("years", 1))))).isoformat()
    if kind == "birthdate":
        return _faker.date_of_birth(minimum_age=int(o.get("minAge", 18)), maximum_age=int(o.get("maxAge", 80))).isoformat()
    if kind == "number":
        return _random.randint(int(o.get("min", 0)), int(o.get("max", 1000)))
    if kind == "uuid":
        return str(uuid.uuid4())
    if kind == "word":
        return _faker.word()
    if kind == "sentence":
        return _faker.sentence()
    if kind == "address":
        return _faker.street_address()
    if kind == "company":
        return _faker.company()
    if kind == "pattern":
        return _pattern(o.get("pattern", "####"))
    raise ValueError(f'Unknown data kind "{kind}"')


def pick(result, target):
    """Reads an assertion target from an API or database result, as StepForge does."""
    t = target.strip()
    if "rows" in result:
        rows, columns = result["rows"], result["columns"]
        if t in ("rowCount", "count"):
            return result["rowCount"]
        if t in ("affected", "affectedRows"):
            return result.get("affected") or 0
        if t == "rows":
            return rows
        if t == "columns":
            return columns
        if t in ("time", "durationMs"):
            return result["ms"]
        if t in ("value", "scalar"):
            if not rows:
                return None
            first = rows[0]
            return first.get(columns[0] if columns else next(iter(first)))
        m = re.match(r"^(?:column|col)[:.](.+)$", t)
        if m:
            return [r.get(m.group(1)) for r in rows]
        m = re.match(r"^rows?\[(\d+)\](?:\.(.+))?$", t)
        if m:
            i = int(m.group(1))
            row = rows[i] if i < len(rows) else None
            return row.get(m.group(2)) if m.group(2) and row else row
        if t.startswith("$"):
            return json_path(rows, t)
        return rows[0].get(t) if rows else None
    if t == "status":
        return result["status"]
    if t in ("time", "timeMs"):
        return result["ms"]
    if t == "size":
        return result["size"]
    if t == "body":
        return result["body"]
    if t == "text":
        return result["text"]
    if t == "url":
        return result.get("url")
    if t.startswith(("header:", "headers.")):
        return result["headers"].get(re.sub(r"^headers?[.:]", "", t).lower())
    if t.startswith("$"):
        return json_path(result["body"], t)
    return None


def file_text(file):
    """A downloaded file's text (up to 5 MB, as StepForge reads it)."""
    if file["size"] > 5_000_000:
        return ""
    with open(file["path"], encoding="utf-8", errors="replace") as f:
        return f.read()
