#!/usr/bin/env python3
"""
StepForge's Linux desktop helper (by Md Zarin Tasnim): a small WebDriver server for GTK and Qt apps, built on the
AT-SPI accessibility layer (PyGObject: gi.repository Atspi and Gdk). It speaks the subset of the W3C WebDriver
protocol that StepForge's native executor uses, so Linux apps share its steps, locators and evidence.

Needs: python3, python3-gi, gir1.2-atspi-2.0, gir1.2-gtk-3.0 (for screenshots), an X11 display (or Xwayland) and
the accessibility bus (at-spi2-core). Run: python3 stepforge_atspi.py --port 4723
"""
import argparse
import base64
import json
import os
import re
import subprocess
import sys
import threading
import time
import uuid
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import gi

gi.require_version("Atspi", "2.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Atspi, Gdk  # noqa: E402

ELEMENT_KEY = "element-6066-11e4-a386-3a7b2b1c0e5f"
LOCK = threading.Lock()  # AT-SPI calls are not thread-safe: one request at a time


class WdError(Exception):
    def __init__(self, error, message, status=400):
        super().__init__(message)
        self.error = error
        self.status = status


def role_tag(acc):
    """The element's role as an XML tag: 'push button' -> 'push_button'."""
    try:
        return re.sub(r"[^a-z0-9]+", "_", acc.get_role_name().lower()).strip("_") or "unknown"
    except Exception:
        return "unknown"


def safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def states(acc):
    s = safe(acc.get_state_set)
    if not s:
        return set()
    return {Atspi.StateType(v).value_nick for v in range(Atspi.StateType.LAST_DEFINED) if s.contains(Atspi.StateType(v))}


def extents(acc):
    comp = safe(acc.get_component_iface)
    if not comp:
        return None
    r = safe(lambda: comp.get_extents(Atspi.CoordType.SCREEN))
    return (r.x, r.y, r.width, r.height) if r else None


def field_text(acc):
    """A text field's own content ("" when empty; never its name or placeholder)."""
    t = safe(acc.get_text_iface)
    if not t:
        return ""
    return safe(lambda: t.get_text(0, t.get_character_count()), "") or ""


def text_of(acc):
    """What an element shows: a field's or label's text, else its accessible name."""
    return field_text(acc) or safe(acc.get_name, "") or ""


def walk(acc, depth=0):
    yield acc, depth
    if depth > 60:
        return
    for i in range(safe(acc.get_child_count, 0) or 0):
        child = safe(lambda: acc.get_child_at_index(i))
        if child is not None:
            yield from walk(child, depth + 1)


class Session:
    def __init__(self, caps):
        app = caps.get("stepforge:app")
        if not app:
            raise WdError("invalid argument", "Set the app to start (stepforge:app)")
        args = caps.get("stepforge:arguments") or []
        env = dict(os.environ)
        env.update(caps.get("stepforge:environment") or {})
        # Qt only exposes its accessibility tree when asked; GTK does by default.
        env.setdefault("QT_LINUX_ACCESSIBILITY_ALWAYS_ON", "1")
        env.setdefault("QT_ACCESSIBILITY", "1")
        try:
            self.proc = subprocess.Popen([app, *args], env=env, cwd=caps.get("stepforge:workingDir") or None)
        except OSError as e:
            raise WdError("session not created", f"The app could not be started: {e}", 500)
        self.elements = {}
        self.app = None
        deadline = time.time() + float(caps.get("stepforge:launchTimeout") or 30)
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise WdError("session not created", f"The app exited at once (code {self.proc.returncode})", 500)
            self.app = self.find_app()
            if self.app is not None and self.windows():
                break
            time.sleep(0.3)
        if self.app is None:
            self.quit()
            raise WdError("session not created", "The app started but did not appear on the accessibility bus", 500)

    def find_app(self):
        desktop = Atspi.get_desktop(0)
        for i in range(desktop.get_child_count()):
            a = safe(lambda: desktop.get_child_at_index(i))
            if a is not None and safe(a.get_process_id) == self.proc.pid:
                return a
        return None

    def windows(self):
        return [safe(lambda: self.app.get_child_at_index(i)) for i in range(safe(self.app.get_child_count, 0) or 0)]

    def ref(self, acc):
        for k, v in self.elements.items():
            if v == acc:
                return k
        k = uuid.uuid4().hex
        self.elements[k] = acc
        return k

    def element(self, ref):
        acc = self.elements.get(ref)
        if acc is None:
            raise WdError("no such element", "The element is not known", 404)
        if safe(acc.get_role_name) is None:
            raise WdError("stale element reference", "The element is gone", 404)
        return acc

    def tree(self):
        """The app's accessibility tree as XML (also the page source)."""
        root = ET.Element("application", {"name": safe(self.app.get_name, "") or ""})
        nodes = {}
        parents = {0: root}
        for acc, depth in walk(self.app):
            if depth == 0:
                nodes[id(root)] = acc
                continue
            attrs = {
                "name": safe(acc.get_name, "") or "",
                "id": safe(acc.get_accessible_id, "") or "",
                "description": safe(acc.get_description, "") or "",
            }
            e = extents(acc)
            if e:
                attrs.update({"x": str(e[0]), "y": str(e[1]), "width": str(e[2]), "height": str(e[3])})
            st = states(acc)
            attrs["enabled"] = "true" if "enabled" in st or "sensitive" in st else "false"
            attrs["visible"] = "true" if "showing" in st else "false"
            if "checked" in st:
                attrs["checked"] = "true"
            node = ET.SubElement(parents.get(depth - 1, root), role_tag(acc), attrs)
            parents[depth] = node
            nodes[id(node)] = acc
        return root, nodes

    def find(self, using, value):
        if using in ("accessibility id", "id"):
            return [a for a, d in walk(self.app) if d and safe(a.get_accessible_id) == value]
        if using == "name":
            return [a for a, d in walk(self.app) if d and safe(a.get_name) == value]
        if using == "partial name":
            return [a for a, d in walk(self.app) if d and value in (safe(a.get_name, "") or "")]
        if using == "xpath":
            root, nodes = self.tree()
            path = value
            # ElementTree's XPath subset: "//tag[@a='v']" is written ".//tag[@a='v']" there.
            if path.startswith("//"):
                path = "." + path
            elif path.startswith("/"):
                path = "." + path
            try:
                found = root.findall(path)
            except SyntaxError as e:
                raise WdError("invalid selector", f"Unsupported XPath (Linux helper): {e}")
            return [nodes[id(n)] for n in found if id(n) in nodes]
        raise WdError("invalid selector", f'The locator strategy "{using}" is not available for Linux apps')

    def click(self, acc):
        act = safe(acc.get_action_iface)
        if act:
            for i in range(safe(act.get_n_actions, 0) or 0):
                if (safe(lambda: act.get_action_name(i), "") or "").lower() in ("click", "press", "activate", "toggle", "jump"):
                    act.do_action(i)
                    return
        e = extents(acc)
        if not e:
            raise WdError("element not interactable", "The element has no position to click")
        Atspi.generate_mouse_event(e[0] + e[2] // 2, e[1] + e[3] // 2, "b1c")

    def set_text(self, acc, value):
        et = safe(acc.get_editable_text_iface)
        if not et:
            raise WdError("element not interactable", "The element does not take text")
        safe(lambda: acc.get_component_iface().grab_focus())
        et.set_text_contents(value)

    def screenshot(self, acc=None):
        win = Gdk.get_default_root_window()
        if acc is not None:
            e = extents(acc)
            if not e:
                raise WdError("unable to capture screen", "The element has no position")
            x, y, w, h = e
        else:
            x, y, w, h = 0, 0, win.get_width(), win.get_height()
        pb = Gdk.pixbuf_get_from_window(win, x, y, w, h)
        if pb is None:
            raise WdError("unable to capture screen", "No screenshot (an X11 display is needed)", 500)
        ok, data = pb.save_to_bufferv("png", [], [])
        return base64.b64encode(data).decode()

    def quit(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()


SESSIONS = {}

# W3C key values -> X keysym names (for synthetic key events).
W3C_KEYS = {
    "": "Return", "": "Return", "": "Tab", "": "Escape", "": "BackSpace",
    "": "Delete", "": "Left", "": "Up", "": "Right", "": "Down", "": "Home",
    "": "End", "": "Page_Up", "": "Page_Down", "": "Shift_L", "": "Control_L",
    "": "Alt_L", "": "Super_L",
}
for i in range(12):
    W3C_KEYS[chr(0xE031 + i)] = f"F{i + 1}"


def keyval(value):
    name = W3C_KEYS.get(value)
    if name:
        return Gdk.keyval_from_name(name)
    return Gdk.unicode_to_keyval(ord(value))


def perform(session, actions):
    for source in actions:
        for a in source.get("actions", []):
            t = a.get("type")
            if t == "pause":
                time.sleep((a.get("duration") or 0) / 1000)
            elif t in ("keyDown", "keyUp"):
                kind = Atspi.KeySynthType.PRESS if t == "keyDown" else Atspi.KeySynthType.RELEASE
                Atspi.generate_keyboard_event(keyval(a["value"]), None, kind)
            elif t == "pointerMove":
                session.pointer = (int(a.get("x", 0)), int(a.get("y", 0)))
                Atspi.generate_mouse_event(session.pointer[0], session.pointer[1], "abs")
            elif t in ("pointerDown", "pointerUp"):
                x, y = getattr(session, "pointer", (0, 0))
                Atspi.generate_mouse_event(x, y, "b1p" if t == "pointerDown" else "b1r")


def handle(method, parts, body):
    if parts == ["status"]:
        return {"ready": True, "message": "StepForge Linux helper"}
    if parts == ["session"] and method == "POST":
        caps = (body.get("capabilities") or {}).get("alwaysMatch") or {}
        s = Session(caps)
        sid = uuid.uuid4().hex
        SESSIONS[sid] = s
        return {"sessionId": sid, "capabilities": caps}
    if len(parts) < 2 or parts[0] != "session":
        raise WdError("unknown command", "Unknown command", 404)
    s = SESSIONS.get(parts[1])
    if s is None:
        raise WdError("invalid session id", "No such session", 404)
    rest = parts[2:]
    if not rest and method == "DELETE":
        s.quit()
        del SESSIONS[parts[1]]
        return None
    if rest == ["elements"] or rest == ["element"]:
        found = s.find(body.get("using"), body.get("value"))
        if rest == ["element"]:
            if not found:
                raise WdError("no such element", "No element matches", 404)
            return {ELEMENT_KEY: s.ref(found[0])}
        return [{ELEMENT_KEY: s.ref(a)} for a in found]
    if rest == ["element", "active"]:
        for a, d in walk(s.app):
            if d and "focused" in states(a):
                return {ELEMENT_KEY: s.ref(a)}
        raise WdError("no such element", "Nothing has the focus", 404)
    if len(rest) >= 3 and rest[0] == "element":
        acc = s.element(rest[1])
        cmd = rest[2]
        if cmd == "click":
            s.click(acc)
            return None
        if cmd == "value":
            # Typing adds to the field's own text (never to its name or placeholder).
            s.set_text(acc, field_text(acc) + body.get("text", ""))
            return None
        if cmd == "clear":
            s.set_text(acc, "")
            return None
        if cmd == "text":
            return text_of(acc)
        if cmd == "attribute":
            name = rest[3] if len(rest) > 3 else ""
            if name in ("name", "title", "label"):
                return safe(acc.get_name, "")
            if name in ("id", "identifier"):
                return safe(acc.get_accessible_id, "")
            if name == "description":
                return safe(acc.get_description, "")
            if name == "role":
                return safe(acc.get_role_name, "")
            if name in ("checked", "value"):
                return "true" if "checked" in states(acc) else "false"
            return None
        if cmd == "displayed":
            return "showing" in states(acc)
        if cmd == "enabled":
            st = states(acc)
            return "enabled" in st or "sensitive" in st
        if cmd == "rect":
            e = extents(acc) or (0, 0, 0, 0)
            return {"x": e[0], "y": e[1], "width": e[2], "height": e[3]}
        if cmd == "screenshot":
            return s.screenshot(acc)
    if rest == ["screenshot"]:
        return s.screenshot()
    if rest == ["source"]:
        root, _ = s.tree()
        return ET.tostring(root, encoding="unicode")
    if rest == ["window", "rect"]:
        win = Gdk.get_default_root_window()
        return {"x": 0, "y": 0, "width": win.get_width(), "height": win.get_height()}
    if rest == ["actions"]:
        perform(s, body.get("actions") or [])
        return None
    if rest == ["se", "log"]:
        return []
    raise WdError("unknown command", f"Not available for Linux apps: {method} /{'/'.join(rest)}", 404)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def respond(self, status, value):
        data = json.dumps({"value": value}).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def run(self, method):
        length = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}") if length else {}
        parts = [p for p in self.path.split("?")[0].split("/") if p]
        try:
            with LOCK:
                value = handle(method, parts, body)
            self.respond(200, value)
        except WdError as e:
            self.respond(e.status, {"error": e.error, "message": str(e)})
        except Exception as e:  # report, do not crash the helper
            self.respond(500, {"error": "unknown error", "message": f"{type(e).__name__}: {e}"})

    def do_GET(self):
        self.run("GET")

    def do_POST(self):
        self.run("POST")

    def do_DELETE(self):
        self.run("DELETE")


def main():
    parser = argparse.ArgumentParser(description="StepForge Linux desktop helper (AT-SPI)")
    parser.add_argument("--port", type=int, default=4723)
    args = parser.parse_args()
    Atspi.init()
    # An app that stops answering (busy, or stuck in a nested loop) fails a call after 5 s instead of 25.
    Atspi.set_timeout(5000, 15000)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"StepForge Linux helper on port {args.port}", flush=True)
    try:
        server.serve_forever()
    finally:
        for s in SESSIONS.values():
            s.quit()


if __name__ == "__main__":
    sys.exit(main())
