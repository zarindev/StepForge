"""HTTP calls for tests exported by StepForge (by Md Zarin Tasnim), with requests."""
import time
from urllib.parse import urljoin

import requests

from support.config import env


def url(path):
    """Relative URLs are resolved against BASE_URL."""
    return path if path.startswith(("http://", "https://")) else urljoin(env["base_url"].rstrip("/") + "/", path.lstrip("/"))


def call(session: requests.Session, method, path, headers=None, params=None, json=None, form=None, files=None, data=None, auth=None):
    """Sends a request; returns status, headers (lower-case), parsed body, text, time (ms) and size."""
    started = time.time()
    res = session.request(
        method,
        url(path),
        headers=headers,
        params=params,
        json=json,
        data=form if form is not None else data,
        files=files,
        auth=auth,
        timeout=30,
    )
    try:
        body = res.json() if res.content else None
    except ValueError:
        body = res.text
    return {
        "status": res.status_code,
        "headers": {k.lower(): v for k, v in res.headers.items()},
        "body": body,
        "text": res.text,
        "ms": round((time.time() - started) * 1000),
        "size": len(res.content),
    }
