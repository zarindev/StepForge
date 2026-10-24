"""Kafka for tests exported by StepForge (by Md Zarin Tasnim), with kafka-python: send a message, wait for one."""
import json
import time

from kafka import KafkaAdminClient, KafkaConsumer, KafkaProducer, TopicPartition
from kafka.admin import NewTopic
from kafka.errors import TopicAlreadyExistsError

from support.helpers import json_path

SINCE_SKEW_MS = 2000
"""Messages count from the test's start, minus this much clock difference between the broker and here."""


def _config(o):
    brokers = o.get("brokers") or ""
    servers = [b.strip() for b in (brokers if isinstance(brokers, list) else str(brokers).split(",")) if b.strip()]
    sasl = o.get("sasl") or {}
    config = {"bootstrap_servers": servers}
    if sasl.get("username"):
        config.update(
            security_protocol="SASL_SSL" if o.get("ssl") else "SASL_PLAINTEXT",
            sasl_mechanism=str(sasl.get("mechanism") or "plain").upper(),
            sasl_plain_username=sasl["username"],
            sasl_plain_password=sasl.get("password") or "",
        )
    elif o.get("ssl"):
        config["security_protocol"] = "SSL"
    return config


def _ensure_topic(config, topic):
    """Creates the topic when it does not exist yet, so the first message does not race the broker creating it."""
    try:
        admin = KafkaAdminClient(**config)
        try:
            if topic not in admin.list_topics():
                admin.create_topics([NewTopic(topic, num_partitions=1, replication_factor=1)])
        finally:
            admin.close()
    except TopicAlreadyExistsError:
        pass
    except Exception:  # noqa: BLE001 - the send or the read reports the real problem
        pass


def _parse(raw):
    if raw is None:
        return None
    s = raw.decode("utf-8", "replace")
    try:
        return json.loads(s)
    except ValueError:
        return s


def produce(o, timeout_ms=15000):
    """Sends one message (a value that is not text is sent as JSON)."""
    config = _config(o)
    _ensure_topic(config, o["topic"])
    producer = KafkaProducer(**config)
    try:
        value = o.get("value")
        key = o.get("key")
        meta = producer.send(
            o["topic"],
            key=None if key in (None, "") else str(key).encode(),
            value=None if value is None else (value if isinstance(value, str) else json.dumps(value)).encode(),
            headers=[(k, str(v).encode()) for k, v in (o.get("headers") or {}).items()],
            partition=None if o.get("partition") in (None, "") else int(o["partition"]),
        ).get(timeout=timeout_ms / 1000)
        return {"topic": meta.topic, "partition": meta.partition, "offset": str(meta.offset)}
    finally:
        producer.close()


def consume(o, since, timeout_ms=15000):
    """Waits for the first message on the topic that matches: key equals, contains (text in the value), or path +
    equals (a JSONPath in a JSON value). Only messages since `since` (epoch seconds) count unless o["since"] is
    "beginning"."""
    config = _config(o)
    topic = o["topic"]
    start = 0 if o.get("since") == "beginning" else int(since * 1000) - SINCE_SKEW_MS
    _ensure_topic(config, topic)
    consumer = KafkaConsumer(**config, group_id=None, enable_auto_commit=False)
    seen = 0
    try:
        parts = [TopicPartition(topic, p) for p in sorted(consumer.partitions_for_topic(topic) or [0])]
        consumer.assign(parts)
        if start > 0:
            found = consumer.offsets_for_times({tp: start for tp in parts})
            for tp in parts:
                if found.get(tp):
                    consumer.seek(tp, found[tp].offset)
                else:
                    consumer.seek_to_end(tp)
        else:
            consumer.seek_to_beginning(*parts)
        deadline = time.time() + timeout_ms / 1000
        while time.time() < deadline:
            for records in consumer.poll(timeout_ms=500).values():
                for r in records:
                    if r.timestamp < start:
                        continue
                    seen += 1
                    m = {
                        "key": r.key.decode() if r.key is not None else None,
                        "value": _parse(r.value),
                        "headers": {k: (v or b"").decode() for k, v in (r.headers or [])},
                        "partition": r.partition,
                        "offset": str(r.offset),
                        "timestamp": r.timestamp,
                    }
                    if _matches(o, m):
                        return m
        raise AssertionError(f"No matching message on {topic} within {timeout_ms} ms ({seen} checked)")
    finally:
        consumer.close()


def _matches(o, m):
    if o.get("key") not in (None, "") and m["key"] != str(o["key"]):
        return False
    text = m["value"] if isinstance(m["value"], str) else json.dumps(m["value"])
    if o.get("contains") not in (None, "") and str(o["contains"]) not in (text or ""):
        return False
    if o.get("path"):
        got = json_path(m["value"], o["path"])
        if o.get("equals") is not None and str(got) != str(o["equals"]):
            return False
        if o.get("equals") is None and got is None:
            return False
    return True


def pick_message(m, target):
    """Reads an assertion target from a message: key, value, $… (in the value), header:<name>, partition, offset."""
    if target.startswith("$"):
        return json_path(m.get("value"), target)
    if target.startswith("header:"):
        return (m.get("headers") or {}).get(target[7:])
    return m.get(target)
