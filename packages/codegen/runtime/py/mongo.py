"""MongoDB access for tests exported by StepForge (by Md Zarin Tasnim), with pymongo.

Each connection name reads DB_<NAME>_URL: mongodb://user:password@host:27017/database
"""
import json
import os
import re
import time

from bson import json_util
from pymongo import MongoClient

READ = ["find", "aggregate", "countDocuments", "distinct"]
WRITE = ["insertOne", "insertMany", "updateOne", "updateMany", "deleteOne", "deleteMany"]


def _url(connection):
    key = "DB_" + re.sub(r"[^A-Za-z0-9]+", "_", connection).upper() + "_URL"
    value = os.environ.get(key)
    if not value:
        raise RuntimeError(f'Set {key} for the "{connection}" database (see .env.example)')
    return value


def run(connection, command):
    """Runs one Mongo command, written as StepForge writes it (Extended JSON text, or the same as a value):
    {"collection": "orders", "find": {...}, "sort": {...}, "limit": 10}, aggregate, countDocuments, distinct (+ filter),
    insertOne / insertMany, updateOne / updateMany {filter, update}, deleteOne / deleteMany. The result reads like a
    database result: rows (documents), columns, rowCount, affected."""
    cmd = json_util.loads(command if isinstance(command, str) else json.dumps(command))
    ops = [k for k in READ + WRITE if k in cmd]
    if not isinstance(cmd.get("collection"), str) or len(ops) != 1:
        raise AssertionError(f'A Mongo command needs a "collection" and one of: {", ".join(READ + WRITE)}')
    started = time.time()
    client = MongoClient(_url(connection), serverSelectionTimeoutMS=10_000)
    try:
        col = client.get_default_database("test")[cmd["collection"]]

        def rows(docs):
            plain = [json.loads(json_util.dumps(d, json_options=json_util.RELAXED_JSON_OPTIONS)) for d in docs]
            columns = list(dict.fromkeys(k for r in plain for k in r))
            return {"rows": plain, "columns": columns, "rowCount": len(plain), "ms": round((time.time() - started) * 1000)}

        def changed(affected, extra=None):
            extra = extra or {}
            return {
                "rows": [extra] if extra else [],
                "columns": list(extra),
                "rowCount": 0,
                "affected": affected,
                "ms": round((time.time() - started) * 1000),
            }

        if "find" in cmd:
            cur = col.find(cmd.get("find") or {}, cmd.get("projection"))
            if cmd.get("sort"):
                cur = cur.sort(list(cmd["sort"].items()))
            if cmd.get("skip"):
                cur = cur.skip(int(cmd["skip"]))
            return rows(cur.limit(int(cmd.get("limit") or 1000)))
        if "aggregate" in cmd:
            return rows(col.aggregate(cmd["aggregate"]))
        if "countDocuments" in cmd:
            return rows([{"count": col.count_documents(cmd["countDocuments"] or {})}])
        if "distinct" in cmd:
            return rows([{"value": v} for v in col.distinct(str(cmd["distinct"]), cmd.get("filter") or {})])
        if "insertOne" in cmd:
            return changed(1, {"insertedId": str(col.insert_one(cmd["insertOne"]).inserted_id)})
        if "insertMany" in cmd:
            return changed(len(col.insert_many(cmd["insertMany"]).inserted_ids))
        spec = cmd.get("updateOne") or cmd.get("updateMany") or cmd.get("deleteOne") or cmd.get("deleteMany") or {}
        if "updateOne" in cmd or "updateMany" in cmd:
            fn = col.update_one if "updateOne" in cmd else col.update_many
            r = fn(spec.get("filter") or {}, spec.get("update") or {})
            return changed(r.modified_count, {"matched": r.matched_count})
        flt = spec.get("filter", spec)
        r = col.delete_one(flt) if "deleteOne" in cmd else col.delete_many(flt)
        return changed(r.deleted_count)
    finally:
        client.close()
