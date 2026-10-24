"""JSON Schema checks for tests exported by StepForge (by Md Zarin Tasnim), with jsonschema (formats checked)."""
from jsonschema import Draft7Validator, FormatChecker
from jsonschema.validators import validator_for


def _normalize(schema):
    """OpenAPI 3.0 `nullable: true` becomes JSON Schema, so null values validate."""
    if isinstance(schema, list):
        return [_normalize(s) for s in schema]
    if not isinstance(schema, dict):
        return schema
    out = {k: _normalize(v) for k, v in schema.items()}
    if out.get("nullable") is True and isinstance(out.get("type"), str):
        out["type"] = [out["type"], "null"]
    return out


def _message(e):
    at = ".".join(str(p) for p in e.absolute_path) or "body"
    if e.validator == "required":
        missing = e.message.split("'")[1] if "'" in e.message else e.message
        return f"{'' if at == 'body' else at + '.'}{missing} is required but missing"
    return f"{at} {e.message}"


def expect_schema(value, schema, what):
    """Fails the test unless the value matches the JSON Schema, naming the fields that do not."""
    schema = _normalize(schema)
    cls = validator_for(schema, default=Draft7Validator)
    errors = sorted(cls(schema, format_checker=FormatChecker()).iter_errors(value), key=lambda e: list(e.absolute_path))
    if errors:
        raise AssertionError(f"{what}: " + "; ".join(_message(e) for e in errors[:10]))
