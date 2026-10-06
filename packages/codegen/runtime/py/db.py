"""Database access for tests exported by StepForge (by Md Zarin Tasnim).

Each connection name reads DB_<NAME>_URL: postgres://…, mysql://…, or sqlite:/path/to/file.db.
StepForge writes placeholders as $1 (PostgreSQL) or ? (MySQL, SQLite); they are converted for each driver.
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


def _question_marks_to_percent_s(sql):
    # Outside quoted strings only.
    return re.sub(r"('(?:[^']|'')*'|\"(?:[^\"]|\"\")*\")|\?", lambda m: m.group(1) or "%s", sql)


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
        if kind == "pg":
            sql = re.sub(r"\$\d+", "%s", sql)
        elif kind == "mysql":
            sql = _question_marks_to_percent_s(sql)
        cur = conn.cursor()
        cur.execute(sql, tuple(params))
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
