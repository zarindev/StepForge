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


_tokens = {}


def oauth2_token(token_url, client_id, client_secret, scope=None):
    """An OAuth2 access token (client-credentials grant), as StepForge fetches it: the client id and secret as Basic
    auth, grant_type and scope as a form; kept until shortly before it expires."""
    key = (token_url, client_id, scope or "")
    hit = _tokens.get(key)
    if hit and hit[1] > time.time():
        return hit[0]
    form = {"grant_type": "client_credentials", **({"scope": scope} if scope else {})}
    res = requests.post(url(token_url), data=form, auth=(client_id, client_secret), timeout=30)
    try:
        token = res.json().get("access_token")
        expires = res.json().get("expires_in") or 300
    except ValueError:
        token, expires = None, 300
    if not res.ok or not token:
        raise AssertionError(f"OAuth2 token request failed with {res.status_code}")
    _tokens[key] = (token, time.time() + max(30, expires - 30))
    return token
