"""Browser steps for tests exported by StepForge (by Md Zarin Tasnim): network, downloads, storage, page conditions.

Each does what StepForge's own step does, so a test behaves the same here and there (Playwright, sync API).
"""
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse


def url_matcher(pattern):
    """A URL pattern as StepForge reads it: a glob with * (within a path segment) / ** (anything; ** then a slash also
    matches no segment at all), else a part of the URL. A glob starting with / is a path (any host), and a query string
    after the matched part is fine unless the glob itself has a ?."""
    p = pattern.strip()
    if "*" not in p:
        return lambda u: p in u
    glob = "**" + p if p.startswith("/") else p
    rx, i = "", 0
    while i < len(glob):
        if glob.startswith("**/", i):
            rx, i = rx + "(?:.*/)?", i + 3
        elif glob.startswith("**", i):
            rx, i = rx + ".*", i + 2
        elif glob[i] == "*":
            rx, i = rx + "[^/]*", i + 1
        else:
            rx, i = rx + re.escape(glob[i]), i + 1
    compiled = re.compile("^" + rx + ("" if "?" in glob else r"(?:[?#].*)?") + "$")
    return lambda u: compiled.match(u) is not None


# ─── Mocks ──────────────────────────────────────────────────────────────────

_mocks = {}


def mock_route(context, url, action="fulfill", method=None, status=200, body=None, content_type=None, delay_ms=0, times=None):
    """Answers matching requests with a fixed response, an error or a delay until the test ends; "remove" lets them
    reach the server again. A new mock for the same URL and method replaces the old one. Text bodies are sent as they
    are; any other value as JSON."""
    mocks = _mocks.setdefault(id(context), {})
    method = method.upper() if method else None
    key = f"{method or '*'} {url}"

    def drop(k):
        old = mocks.pop(k, None)
        if old:
            try:
                context.unroute(old["matcher"], old["handler"])
            except Exception:  # noqa: BLE001 - the context may be closing
                pass

    if action == "remove":
        # Without a method, every mock of that URL goes.
        for k in [key] if method else [k for k, m in mocks.items() if m["pattern"] == url]:
            drop(k)
        return
    drop(key)
    match = url_matcher(url)
    text = "" if body is None else body if isinstance(body, str) else json.dumps(body, separators=(",", ":"))
    ctype = content_type or ("application/json" if re.match(r"^\s*[\[{]", text) else "text/plain")
    used = [0]

    def handler(route):
        # Requests of another method fall through and do not use up the count.
        if method and route.request.method != method:
            return route.fallback()
        if times is not None:
            if used[0] >= times:
                return route.fallback()
            used[0] += 1
            if used[0] >= times and mocks.get(key, {}).get("handler") is handler:
                drop(key)
        if delay_ms:
            time.sleep(delay_ms / 1000)
        if action == "abort":
            return route.abort("failed")
        if action == "delay":
            return route.fallback()
        return route.fulfill(status=status, body=text, content_type=ctype)

    def matcher(u):
        return match(u)

    context.route(matcher, handler)
    mocks[key] = {"pattern": url, "matcher": matcher, "handler": handler}


# ─── Responses and traffic ──────────────────────────────────────────────────

_SECOND_LEVEL = set("co com org net ac gov edu ne or ltd plc sch nhs go gob mil nic gv gen biz info nom ind res".split())


def _site(host):
    """cdn.example.com belongs to example.com, www.example.co.uk to example.co.uk, app.localhost to localhost."""
    h = re.sub(r":\d+$", "", host).lower()
    if h == "localhost" or h.endswith(".localhost"):
        return "localhost"
    if re.match(r"^[\d.]+$", h) or h.startswith("[") or "." not in h:
        return h
    parts = h.split(".")
    two = len(parts) > 2 and len(parts[-1]) == 2 and parts[-2] in _SECOND_LEVEL
    return ".".join(parts[-3:] if two else parts[-2:])


def _host(u):
    try:
        return urlparse(u).netloc
    except ValueError:
        return ""


class Network:
    """Records the responses and the traffic of every page of the context from the start of the test, for "wait for
    response" (the first matching response no earlier step took) and the network summary."""

    def __init__(self, context, base_url):
        self.base_url = base_url
        self.responses = []
        self.requests = []
        self.mark = 0
        context.on("response", lambda r: self.responses.append({"response": r, "taken": False}))
        context.on("requestfinished", lambda r: self.requests.append({"request": r, "failed": False, "mark": self.mark}))
        context.on("requestfailed", lambda r: self.requests.append({"request": r, "failed": True, "mark": self.mark}))

    def navigated(self):
        """Called before opening a page: the summary "since the last navigation" starts here."""
        self.mark += 1

    def wait_for_response(self, page, url, method=None, status=None, timeout_ms=15000):
        """The first matching response since the test started that no earlier step took, else the next one."""
        match = url_matcher(url)
        method = method.upper() if method else None

        def fits(r):
            return match(r.url) and (not method or r.request.method == method) and (status is None or r.status == status)

        deadline = time.time() + timeout_ms / 1000
        while True:
            found = next((x for x in self.responses if not x["taken"] and fits(x["response"])), None)
            if found:
                break
            if time.time() >= deadline:
                raise AssertionError(
                    f"No response from {url}{f' ({method})' if method else ''}"
                    f"{f' with status {status}' if status is not None else ''} within {timeout_ms} ms"
                )
            page.wait_for_timeout(100)  # lets Playwright deliver the events meanwhile
        found["taken"] = True
        r = found["response"]
        try:
            text = r.text()
        except Exception:  # noqa: BLE001 - a redirect or a closed page has no body
            text = ""
        try:
            body = json.loads(text)
        except ValueError:
            body = text
        timing = r.request.timing
        return {
            "status": r.status,
            "headers": r.all_headers(),
            "body": body,
            "text": text,
            "ms": round(timing["responseEnd"]) if timing.get("responseEnd", 0) > 0 else 0,
            "size": len(text),
            "url": r.url,
        }

    def summary(self, page, since="test"):
        """The traffic since the test started (or since the last navigation), once the page is quiet."""
        try:
            page.wait_for_load_state("networkidle", timeout=5000)
        except Exception:  # noqa: BLE001 - a page that never goes quiet is summarised as it is
            pass
        entries = []
        for e in self.requests:
            req = e["request"]
            if not re.match(r"^https?:", req.url) or (since != "test" and e["mark"] != self.mark):
                continue
            status, size, failed = None, 0, e["failed"]
            if not failed:
                try:
                    res = req.response()
                    status = res.status if res else None
                    sizes = req.sizes()
                    size = sizes["responseBodySize"] + sizes["responseHeadersSize"]
                except Exception:  # noqa: BLE001 - sizes of a closed page are unknown
                    pass
                failed = (status or 0) >= 400
            entries.append({"url": req.url, "type": req.resource_type, "bytes": size, "failed": failed})
        own = _site(_host(self.base_url) or (_host(entries[0]["url"]) if entries else ""))
        hosts = list(dict.fromkeys(_host(e["url"]) for e in entries))
        third = [h for h in hosts if own and _site(h) != own]
        by_type = {}
        for e in entries:
            g = by_type.setdefault(e["type"], {"requests": 0, "bytes": 0})
            g["requests"] += 1
            g["bytes"] += e["bytes"]
        total = sum(e["bytes"] for e in entries)
        return {
            "requests": len(entries),
            "bytes": total,
            "kb": round(total / 100) / 10,
            "failed": sum(1 for e in entries if e["failed"]),
            "thirdPartyRequests": sum(1 for e in entries if _host(e["url"]) in third),
            "thirdPartyHosts": len(third),
            "hosts": hosts,
            "thirdPartyHostNames": third,
            "byType": by_type,
        }


def watch_network(context, base_url):
    return Network(context, base_url)


# ─── Downloads, storage, page conditions, clock ─────────────────────────────


def download(page, element, folder="test-results/downloads"):
    """Clicks the element and keeps the file it downloads."""
    with page.expect_download() as info:
        element.click()
    d = info.value
    name = d.suggested_filename
    path = Path(folder) / re.sub(r"[^\w.-]+", "_", name)
    d.save_as(path)
    failure = d.failure()
    if failure:
        raise AssertionError(f"The download failed: {failure}")
    return {"fileName": name, "size": path.stat().st_size, "path": str(path)}


def storage(page, kind, action, name="", value=""):
    """Cookies, localStorage and sessionStorage: set, get, remove one, or clear. "get" gives the value (or None)."""
    context = page.context
    if kind == "cookie":
        if action == "set":
            if not re.match(r"^https?:", page.url):
                raise AssertionError("Open a page before setting a cookie")
            context.add_cookies([{"name": name, "value": value, "url": page.url}])
        elif action == "clear":
            context.clear_cookies()
        elif action == "remove":
            context.clear_cookies(name=name)
        else:
            c = next((x for x in context.cookies() if x["name"] == name), None)
            return {"value": c["value"] if c else None, "exists": c is not None}
        return {"value": None, "exists": False}
    area = "sessionStorage" if kind == "session" else "localStorage"
    # about:blank has no origin: the browser would throw a SecurityError nobody understands.
    if not re.match(r"^https?:", page.url):
        raise AssertionError(f"Open a page before using {area}")
    got = page.evaluate(
        """([a, act, k, v]) => {
            const store = globalThis[a];
            if (act === 'set') store.setItem(k, v);
            else if (act === 'remove') store.removeItem(k);
            else if (act === 'clear') store.clear();
            else return store.getItem(k);
            return null;
        }""",
        [area, action, name, value],
    )
    return {"value": got, "exists": got is not None}


def page_condition(element, check, expected=None, timeout_ms=2000):
    """A page condition (if / repeat while): tried every 100 ms for up to timeout_ms before it counts as false. It
    never fails the test by itself."""
    want = "" if expected is None else str(expected)

    def holds():
        n = element.count()
        first = element.first
        if check == "present":
            return n > 0
        if check == "absent":
            return n == 0
        if check == "visible":
            return n > 0 and first.is_visible()
        if check == "hidden":
            return not (n > 0 and first.is_visible())
        if check == "enabled":
            return n > 0 and first.is_enabled()
        if check == "textContains":
            return n > 0 and want in (first.text_content() or "")
        if check == "count":
            return str(n) == want or (want.replace(".", "", 1).isdigit() and n == float(want))
        raise ValueError(f"Unknown page check {check}")

    deadline = time.time() + max(0, timeout_ms) / 1000
    while True:
        try:
            ok = holds()
        except Exception:  # noqa: BLE001 - not ready yet counts as false
            ok = False
        if ok or time.time() >= deadline:
            return ok
        element.page.wait_for_timeout(100)


def clock_time(value):
    """A clock time as StepForge reads it: epoch milliseconds (a number or digits) or a date text."""
    if isinstance(value, (int, float)) or (isinstance(value, str) and value.strip().lstrip("-").isdigit()):
        return datetime.fromtimestamp(float(value) / 1000, tz=timezone.utc)
    return datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
