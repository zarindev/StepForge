"""XML responses (SOAP) for tests exported by StepForge (by Md Zarin Tasnim): XPath values and SOAP faults, with lxml."""
from lxml import etree


def _parse(text):
    if not text or not text.lstrip().startswith("<"):
        return None
    try:
        return etree.fromstring(text.encode("utf-8"), etree.XMLParser(resolve_entities=False, no_network=True))
    except etree.XMLSyntaxError:
        return None


def _declared(root):
    """Every prefix declared in the document, so XPath can use the document's own prefixes."""
    out = {}
    for el in root.iter():
        for prefix, uri in (el.nsmap or {}).items():
            if prefix:
                out.setdefault(prefix, uri)
    return out


def is_xpath(target):
    """True for the targets StepForge reads with XPath: /…, //…, xpath:…, count(…), string(…)…"""
    return target.startswith(("/", "xpath:")) or target.split("(")[0] in ("count", "string", "number", "boolean", "sum")


def xpath_value(text, expr, namespaces=None):
    """An XPath on an XML body: one node gives its text, several a list of texts, a function its value; None when
    nothing matches. The document's prefixes work as written; namespaces adds or overrides some."""
    root = _parse(text)
    if root is None:
        return None
    expr = expr[6:] if expr.startswith("xpath:") else expr
    result = root.getroottree().xpath(expr, namespaces={**_declared(root), **(namespaces or {})})
    if isinstance(result, list):
        texts = [r if isinstance(r, str) else "".join(r.itertext()).strip() for r in result]
        return None if not texts else texts[0] if len(texts) == 1 else texts
    if isinstance(result, float) and result.is_integer():
        return int(result)
    return result


def expect_no_fault(text):
    """Fails the test when the response is a SOAP fault (a Fault directly in the envelope body)."""
    root = _parse(text)
    if root is None:
        return
    fault = root.getroottree().xpath("/*[local-name()='Envelope']/*[local-name()='Body']/*[local-name()='Fault']")
    if not fault:
        return

    def pick(expr):
        found = fault[0].xpath(expr)
        return "".join(found[0].itertext()).strip() if found else ""

    code = pick(".//*[local-name()='faultcode']") or pick(".//*[local-name()='Code']/*[local-name()='Value']")
    reason = pick(".//*[local-name()='faultstring']") or pick(".//*[local-name()='Reason']/*[local-name()='Text']")
    raise AssertionError(f"SOAP fault{' ' + code if code else ''}: {reason or 'no message'}")
