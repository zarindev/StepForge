import { DOMParser } from '@xmldom/xmldom';
import * as xpath from 'xpath';

type XmlDoc = ReturnType<DOMParser['parseFromString']>;
const cache = new WeakMap<object, XmlDoc | null>();

/** Parses XML text (null when it is not XML). Results are cached per response object. */
export function parseXml(text: string, owner?: object): XmlDoc | null {
  if (owner && cache.has(owner)) return cache.get(owner)!;
  let doc: XmlDoc | null = null;
  if (/^\s*</.test(text)) {
    try {
      let failed = false;
      const parsed = new DOMParser({
        onError: (level) => {
          if (level !== 'warning') failed = true;
        },
      }).parseFromString(text, 'text/xml');
      doc = failed || !parsed.documentElement ? null : parsed;
    } catch {
      doc = null;
    }
  }
  if (owner) cache.set(owner, doc);
  return doc;
}

/** Every `xmlns:prefix` declared anywhere in the document, so XPath can use the document's own prefixes. */
function declaredNamespaces(doc: XmlDoc): Record<string, string> {
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

/**
 * Evaluates an XPath on XML text. Prefixes declared in the document work as written (`//soap:Body/m:Price`);
 * `namespaces` adds or overrides prefixes. One matching node gives its text, several give a list of texts;
 * functions such as `count(//item)` give their value. Returns undefined when nothing matches.
 */
export function xpathValue(
  text: string,
  expr: string,
  namespaces: Record<string, string> = {},
  owner?: object,
): unknown {
  const doc = parseXml(text, owner);
  if (!doc) return undefined;
  const select = xpath.useNamespaces({ ...declaredNamespaces(doc), ...namespaces });
  let result: unknown;
  try {
    result = select(expr, doc as unknown as Node);
  } catch (err) {
    throw new Error(`Invalid XPath "${expr}": ${(err as Error).message}`);
  }
  if (Array.isArray(result)) {
    const texts = result.map((n: Node) =>
      n.nodeType === 2 ? (n as Attr).value : (n.textContent ?? '').trim(),
    );
    return texts.length === 0 ? undefined : texts.length === 1 ? texts[0] : texts;
  }
  return result;
}

/** A SOAP fault in a response, if any: its code and message (SOAP 1.1 faultstring or 1.2 Reason/Text). */
export function soapFault(text: string, owner?: object): { code: string; message: string } | null {
  const doc = parseXml(text, owner);
  if (!doc) return null;
  const fault = xpath.select("//*[local-name()='Fault']", doc as unknown as Node) as Node[];
  if (!fault.length) return null;
  const pick = (expr: string) => {
    const n = xpath.select(expr, fault[0]!) as Node[];
    return n.length ? (n[0]!.textContent ?? '').trim() : '';
  };
  return {
    code: pick(".//*[local-name()='faultcode']") || pick(".//*[local-name()='Code']/*[local-name()='Value']"),
    message:
      pick(".//*[local-name()='faultstring']") || pick(".//*[local-name()='Reason']/*[local-name()='Text']"),
  };
}
