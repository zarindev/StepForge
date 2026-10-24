// XML responses (SOAP) for tests exported by StepForge (by Md Zarin Tasnim): XPath values and SOAP faults.
import { DOMParser } from '@xmldom/xmldom';
import * as xpath from 'xpath';

type Doc = ReturnType<DOMParser['parseFromString']>;

function parse(text: string): Doc | null {
  if (!/^\s*</.test(text)) return null;
  let failed = false;
  const doc = new DOMParser({
    onError: (level) => void (level !== 'warning' && (failed = true)),
  }).parseFromString(text, 'text/xml');
  return failed || !doc.documentElement ? null : doc;
}

/** Every `xmlns:prefix` declared in the document, so XPath can use the document's own prefixes. */
function declared(doc: Doc): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (el: Element) => {
    for (let i = 0; i < el.attributes.length; i++) {
      const a = el.attributes[i]!;
      if (a.name.startsWith('xmlns:')) out[a.name.slice(6)] ??= a.value;
    }
    for (let c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) walk(c as Element);
  };
  walk(doc.documentElement as unknown as Element);
  return out;
}

/** True for the targets StepForge reads with XPath: `/…`, `//…`, `xpath:…`, count(…), string(…)… */
export const isXPath = (target: string) =>
  target.startsWith('/') ||
  target.startsWith('xpath:') ||
  /^(count|string|number|boolean|sum)\(/.test(target);

/**
 * An XPath on an XML body: one node gives its text, several a list of texts, a function its value; undefined when
 * nothing matches. The document's prefixes work as written; `namespaces` adds or overrides some.
 */
export function xpathValue(text: string, expr: string, namespaces: Record<string, string> = {}): unknown {
  const doc = parse(text);
  if (!doc) return undefined;
  const result = xpath.useNamespaces({ ...declared(doc), ...namespaces })(
    expr.replace(/^xpath:/, ''),
    doc as unknown as Node,
  );
  if (Array.isArray(result)) {
    const texts = result.map((n: Node) =>
      n.nodeType === 2 ? (n as Attr).value : (n.textContent ?? '').trim(),
    );
    return texts.length === 0 ? undefined : texts.length === 1 ? texts[0] : texts;
  }
  return result;
}

/** Fails the test when the response is a SOAP fault (a Fault directly in the envelope body). */
export function expectNoFault(text: string): void {
  const doc = parse(text);
  if (!doc) return;
  const fault = xpath.select(
    "/*[local-name()='Envelope']/*[local-name()='Body']/*[local-name()='Fault']",
    doc as unknown as Node,
  ) as Node[];
  if (!fault.length) return;
  const pick = (expr: string) => {
    const n = xpath.select(expr, fault[0]!) as Node[];
    return n.length ? (n[0]!.textContent ?? '').trim() : '';
  };
  const code =
    pick(".//*[local-name()='faultcode']") || pick(".//*[local-name()='Code']/*[local-name()='Value']");
  const reason =
    pick(".//*[local-name()='faultstring']") || pick(".//*[local-name()='Reason']/*[local-name()='Text']");
  throw new Error(`SOAP fault${code ? ` ${code}` : ''}: ${reason || 'no message'}`);
}
