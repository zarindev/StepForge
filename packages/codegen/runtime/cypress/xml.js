// XML responses (SOAP) for Cypress tests exported by StepForge (by Md Zarin Tasnim): XPath values and SOAP faults,
// with the browser's own XML parser.
/* global DOMParser */

function parse(text) {
  if (!/^\s*</.test(String(text ?? ''))) return null;
  const doc = new DOMParser().parseFromString(String(text), 'text/xml');
  return doc.getElementsByTagName('parsererror').length ? null : doc;
}

/** Every `xmlns:prefix` declared in the document, so XPath can use the document's own prefixes. */
function declared(doc) {
  const out = {};
  const walk = (el) => {
    for (const a of el.attributes)
      if (a.name.startsWith('xmlns:') && !(a.name.slice(6) in out)) out[a.name.slice(6)] = a.value;
    for (const c of el.children) walk(c);
  };
  walk(doc.documentElement);
  return out;
}

/**
 * An XPath on an XML body: one node gives its text, several a list of texts, a function its value; undefined when
 * nothing matches. The document's prefixes work as written; `namespaces` adds or overrides some.
 */
export function xpathValue(text, expr, namespaces = {}) {
  const doc = parse(text);
  if (!doc) return undefined;
  const ns = { ...declared(doc), ...namespaces };
  const r = doc.evaluate(
    String(expr).replace(/^xpath:/, ''),
    doc,
    (prefix) => ns[prefix] ?? null,
    0 /* ANY */,
    null,
  );
  if (r.resultType === 1) return r.numberValue;
  if (r.resultType === 2) return r.stringValue;
  if (r.resultType === 3) return r.booleanValue;
  const texts = [];
  for (let n = r.iterateNext(); n; n = r.iterateNext())
    texts.push(n.nodeType === 2 ? n.value : (n.textContent ?? '').trim());
  return texts.length === 0 ? undefined : texts.length === 1 ? texts[0] : texts;
}

/** Fails the test when the response is a SOAP fault (a Fault directly in the envelope body). */
export function expectNoFault(text) {
  const doc = parse(text);
  if (!doc) return;
  const fault = "/*[local-name()='Envelope']/*[local-name()='Body']/*[local-name()='Fault']";
  if (!doc.evaluate(`count(${fault})`, doc, null, 1, null).numberValue) return;
  const pick = (expr) => doc.evaluate(`normalize-space(${fault}${expr})`, doc, null, 2, null).stringValue;
  const code =
    pick("//*[local-name()='faultcode']") || pick("//*[local-name()='Code']/*[local-name()='Value']");
  const reason =
    pick("//*[local-name()='faultstring']") || pick("//*[local-name()='Reason']/*[local-name()='Text']");
  throw new Error(`SOAP fault${code ? ` ${code}` : ''}: ${reason || 'no message'}`);
}
