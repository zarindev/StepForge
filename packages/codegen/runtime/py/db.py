"""Database access for tests exported by StepForge (by Md Zarin Tasnim).

Each connection name reads DB_<NAME>_URL: postgres://…, mysql://…, or sqlite:/path/to/file.db.
StepForge writes placeholders as $1 (by number) or ? (MySQL, SQLite, in order); they are converted for each driver.
"""
import os
import re
import sqlite3
import time
from urllib.parse import unquote, urlparse


def _url(connection):
    key = "DB_" + re.sub(r"[^A-Za-z0-9]+", "_", connection).upper() + "_URL"
    value = os.environ.get(key)
    if not value:
        raise RuntimeError(f'Set {key} for the "{connection}" database (see .env.example)')
    return value


_TOKENS = re.compile(r"('(?:[^']|'')*'|\"(?:[^\"]|\"\")*\")|\$(\d+)|\?")


def _prepare(sql, params, kind):
    """The SQL and parameters for the driver, or (sql, None) without parameters so a % in the SQL stays as it is.

    $1, $2… are bound by their number (in any order, or more than once); ? takes the next parameter (not on
    PostgreSQL, where ? is a JSON operator). psycopg and PyMySQL read %s, so a literal % is doubled there.
    """
    params = list(params or ())
    if not params:
        return sql, None
    mark, escape = ("?", False) if kind == "sqlite" else ("%s", True)
    out, bound, last, position = [], [], 0, 0
    for m in _TOKENS.finditer(sql):
        if m.group(1) is None and m.group(2) is None and kind == "pg":
            continue
        text = sql[last:m.start()] + (m.group(1) or "")
        out.append(text.replace("%", "%%") if escape else text)
        last = m.end()
        if m.group(1) is not None:
            continue
        if m.group(2) is not None:
            n = int(m.group(2))
            if not 1 <= n <= len(params):
                raise ValueError(f"${n} in the SQL, but {len(params)} parameter(s) were given")
            bound.append(params[n - 1])
        else:
            if position >= len(params):
                raise ValueError(f"More ? in the SQL than the {len(params)} parameter(s) given")
            bound.append(params[position])
            position += 1
        out.append(mark)
    tail = sql[last:]
    out.append(tail.replace("%", "%%") if escape else tail)
    return "".join(out), tuple(bound)


def _result(cursor, started):
    if cursor.description:
        columns = [c[0] for c in cursor.description]
        rows = [dict(zip(columns, r)) for r in cursor.fetchall()]
        return {"rows": rows, "columns": columns, "rowCount": len(rows), "ms": round((time.time() - started) * 1000)}
    return {"rows": [], "columns": [], "rowCount": 0, "affected": cursor.rowcount, "ms": round((time.time() - started) * 1000)}


def _connect(url):
    if url.startswith(("postgres://", "postgresql://")):
        import psycopg

        return psycopg.connect(url, autocommit=True), "pg"
    if url.startswith("mysql://"):
        import pymysql

        u = urlparse(url)
        return pymysql.connect(
            host=u.hostname, port=u.port or 3306, user=unquote(u.username or ""), password=unquote(u.password or ""),
            database=u.path.lstrip("/"), autocommit=True,
        ), "mysql"
    path = re.sub(r"^sqlite:(//)?", "", url)
    return sqlite3.connect(path, isolation_level=None), "sqlite"


def query(connection, sql, params=()):
    """Runs one statement with bound parameters."""
    conn, kind = _connect(_url(connection))
    started = time.time()
    try:
        sql, bound = _prepare(sql, params, kind)
        cur = conn.cursor()
        if bound is None:
            cur.execute(sql)
        else:
            cur.execute(sql, bound)
        return _result(cur, started)
    finally:
        conn.close()


def script(connection, sql):
    """Runs several statements separated by semicolons."""
    conn, kind = _connect(_url(connection))
    started = time.time()
    try:
        if kind == "sqlite":
            conn.executescript(sql)
        else:
            cur = conn.cursor()
            for statement in [s for s in sql.split(";") if s.strip()]:
                cur.execute(statement)
        return {"rows": [], "columns": [], "rowCount": 0, "ms": round((time.time() - started) * 1000)}
    finally:
        conn.close()
