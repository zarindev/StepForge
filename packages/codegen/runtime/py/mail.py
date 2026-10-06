"""Email checks for tests exported by StepForge (by Md Zarin Tasnim), against a Mailpit server (MAILPIT_URL)."""
import os
import re
import time
from datetime import datetime

import requests


def _base():
    return os.environ.get("MAILPIT_URL", "http://127.0.0.1:8025").rstrip("/")


def _includes(a, b):
    return b is None or str(b).lower() in (a or "").lower()


def links(html, text=""):
    """Every http(s) link in the HTML (href) and text, in order, without duplicates."""
    out = []

    def add(u):
        u = re.sub(r"[).,;'\"\]>]+$", "", u.strip().replace("&amp;", "&"))
        if re.match(r"^https?://", u, re.I) and u not in out:
            out.append(u)

    for m in re.finditer(r"href\s*=\s*[\"']([^\"']+)[\"']", html or "", re.I):
        add(m.group(1))
    for m in re.finditer(r"https?://[^\s<>\"']+", f"{text}\n{re.sub(r'<[^>]+>', ' ', html or '')}", re.I):
        add(m.group(0))
    return out


def _parse_time(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def wait_for_email(since, to=None, sender=None, subject=None, contains=None, timeout_ms=20_000):
    """Waits for an email received after `since` (a timestamp) matching every criterion (case-insensitive)."""
    deadline = time.time() + timeout_ms / 1000
    while True:
        res = requests.get(f"{_base()}/api/v1/messages", params={"limit": 50}, timeout=10)
        res.raise_for_status()
        for m in res.json().get("messages", []):
            if _parse_time(m["Created"]) < since - 1:
                continue
            if not _includes((m.get("From") or {}).get("Address"), sender) or not _includes(m.get("Subject"), subject):
                continue
            if to is not None and not any(_includes(t.get("Address"), to) for t in m.get("To") or []):
                continue
            full = requests.get(f"{_base()}/api/v1/message/{m['ID']}", timeout=10).json()
            if not _includes(f"{full.get('Text', '')}\n{full.get('HTML', '')}", contains):
                continue
            return {
                "id": full["ID"],
                "from": (full.get("From") or {}).get("Address", ""),
                "to": [t["Address"] for t in full.get("To") or []],
                "subject": full.get("Subject", ""),
                "date": full.get("Date", ""),
                "text": full.get("Text", ""),
                "html": full.get("HTML", ""),
                "links": links(full.get("HTML", ""), full.get("Text", "")),
                "attachments": [a["FileName"] for a in full.get("Attachments") or []],
            }
        if time.time() > deadline:
            raise AssertionError(f"No email{' to ' + to if to else ''} arrived within {round(timeout_ms / 1000)} s")
        time.sleep(0.5)


_OTP_WORDS = re.compile(
    r"\b(code|otp|one[-\s]?time|passcode|pass\s?code|pin|verification|verify|confirm(?:ation)?|security|login|sign[-\s]?in|token|password)\b",
    re.I,
)


def otp(email, min_length=4, max_length=8):
    """A one-time code (4–8 digits), preferring numbers next to words like "code" or "verification"."""
    text = re.sub(r"[*_]", " ", email["text"] or re.sub(r"<[^>]+>", " ", email["html"]))
    found = []
    for m in re.finditer(r"(?<![\d$€£#+])(?<!\d[.,:/-])(\d{3}[ -]\d{3}|\d+)(?![\d%])(?![.,:/]\d)", text):
        code = re.sub(r"[ -]", "", m.group(1))
        if not min_length <= len(code) <= max_length:
            continue
        before, after = text[max(0, m.start() - 60):m.start()], text[m.end():m.end() + 25]
        if re.match(r"^\s*[-/]\s*\d", after) or re.search(r"\d\s*[-/]\s*$", before):
            continue
        # Digits inside a link or an email address are never the code.
        token = re.search(r"\S*$", before).group(0) + m.group(1) + re.match(r"^\S*", after).group(0)
        if re.search(r"://|@|%[0-9a-f]{2}|[?&][\w-]+=", token, re.I):
            continue
        score = (10 if _OTP_WORDS.search(before) else 0) + (4 if _OTP_WORDS.search(after) else 0)
        score += 3 if re.search(r"[:：]\s*$", before) or re.search(r"\bis\s*$", before, re.I) else 0
        score -= 6 if re.match(r"^(19|20)\d\d$", code) else 0
        found.append((-score, m.start(), code))
    found.sort()
    if not found or (found[0][0] >= 0 and len(found) > 1):
        raise AssertionError(f'No one-time code found in "{email["subject"]}"')
    return found[0][2]


def link(email, contains=None, index=0):
    """The first link containing `contains`, or the `index`-th link."""
    pool = [l for l in email["links"] if contains is None or contains.lower() in l.lower()]
    if index >= len(pool):
        raise AssertionError(f'No link{" containing " + repr(contains) if contains else ""} in "{email["subject"]}"')
    return pool[index]


def extract(email, pattern):
    """The first capture group of `pattern` in the email text."""
    m = re.search(pattern, f"{email['text']}\n{email['html']}", re.I)
    if not m:
        raise AssertionError(f'/{pattern}/ found nothing in "{email["subject"]}"')
    return m.group(1) if m.groups() else m.group(0)


def assert_email(email, subject_contains=None, body_contains=None, sender=None, has_link=None, has_attachment=None):
    """StepForge's "Check email" step."""
    subject = email["subject"]
    if subject_contains is not None:
        assert _includes(subject, subject_contains), f'Email "{subject}": subject does not contain "{subject_contains}"'
    if body_contains is not None:
        assert _includes(f"{email['text']}\n{email['html']}", body_contains), f'Email "{subject}": body does not contain "{body_contains}"'
    if sender is not None:
        assert _includes(email["from"], sender), f'Email "{subject}": is not from "{sender}"'
    if has_link is not None:
        assert any(has_link is True or _includes(l, has_link) for l in email["links"]), f'Email "{subject}": has no matching link'
    if has_attachment is not None:
        assert any(has_attachment is True or _includes(a, has_attachment) for a in email["attachments"]), (
            f'Email "{subject}": has no matching attachment'
        )
