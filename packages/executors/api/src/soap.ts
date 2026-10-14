import { parseXml } from './xml.ts';

const ENVELOPE_NS = {
  '1.1': 'http://schemas.xmlsoap.org/soap/envelope/',
  '1.2': 'http://www.w3.org/2003/05/soap-envelope',
} as const;

export type SoapVersion = keyof typeof ENVELOPE_NS;

/**
 * The XML and headers of a SOAP request. `body` is either a whole envelope (sent as written) or the content of
 * `<soap:Body>` (wrapped in an envelope of the chosen version, with an optional `<soap:Header>`). SOAP 1.1 sends
 * `text/xml` and a `SOAPAction` header; SOAP 1.2 sends `application/soap+xml` with the action as a parameter.
 */
export function soapRequest(input: { body: string; header?: string; action?: string; version?: string }): {
  xml: string;
  headers: Record<string, string>;
} {
  const body = input.body.trim();
  // A whole envelope may start with an XML declaration, comments, processing instructions or a DOCTYPE.
  const whole =
    /^(?:\s*(?:<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?\s*>))*\s*<([\w.-]+:)?Envelope[\s>/]/.test(
      body,
    );
  // Without a version, a whole envelope says which one it is through its namespace.
  const version: SoapVersion =
    input.version === '1.2' ||
    (!input.version && whole && parseXml(body)?.documentElement?.namespaceURI === ENVELOPE_NS['1.2'])
      ? '1.2'
      : '1.1';
  const xml = whole
    ? body
    : `<?xml version="1.0" encoding="utf-8"?>\n<soap:Envelope xmlns:soap="${ENVELOPE_NS[version]}">${
        input.header?.trim() ? `\n  <soap:Header>${input.header.trim()}</soap:Header>` : ''
      }\n  <soap:Body>${body}</soap:Body>\n</soap:Envelope>`;
  const action = input.action?.trim();
  const headers: Record<string, string> =
    version === '1.2'
      ? { 'content-type': `application/soap+xml; charset=utf-8${action ? `; action="${action}"` : ''}` }
      : { 'content-type': 'text/xml; charset=utf-8', soapaction: `"${action ?? ''}"` };
  return { xml, headers };
}
