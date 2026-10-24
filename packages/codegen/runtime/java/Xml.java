package support;

import java.io.StringReader;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import javax.xml.XMLConstants;
import javax.xml.namespace.NamespaceContext;
import javax.xml.parsers.DocumentBuilderFactory;
import javax.xml.xpath.XPath;
import javax.xml.xpath.XPathConstants;
import javax.xml.xpath.XPathExpressionException;
import javax.xml.xpath.XPathFactory;
import org.w3c.dom.Attr;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NamedNodeMap;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;
import org.xml.sax.InputSource;

/** XML responses (SOAP) for tests exported by StepForge (by Md Zarin Tasnim): XPath values and SOAP faults. */
public final class Xml {
  private Xml() {}

  private static Document parse(String text) {
    if (text == null || !text.stripLeading().startsWith("<")) return null;
    try {
      DocumentBuilderFactory f = DocumentBuilderFactory.newInstance();
      f.setNamespaceAware(true);
      f.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
      return f.newDocumentBuilder().parse(new InputSource(new StringReader(text)));
    } catch (Exception notXml) {
      return null;
    }
  }

  /** Every xmlns:prefix declared in the document, so XPath can use the document's own prefixes. */
  private static void declared(Element el, Map<String, String> out) {
    NamedNodeMap attrs = el.getAttributes();
    for (int i = 0; i < attrs.getLength(); i++) {
      Node a = attrs.item(i);
      if (a.getNodeName().startsWith("xmlns:")) out.putIfAbsent(a.getNodeName().substring(6), a.getNodeValue());
    }
    for (Node c = el.getFirstChild(); c != null; c = c.getNextSibling()) if (c instanceof Element e) declared(e, out);
  }

  private static XPath xpath(Map<String, String> prefixes) {
    XPath x = XPathFactory.newInstance().newXPath();
    x.setNamespaceContext(new NamespaceContext() {
      public String getNamespaceURI(String prefix) {
        return prefixes.getOrDefault(prefix, XMLConstants.NULL_NS_URI);
      }

      public String getPrefix(String uri) {
        return null;
      }

      public Iterator<String> getPrefixes(String uri) {
        return List.<String>of().iterator();
      }
    });
    return x;
  }

  /** True for the targets StepForge reads with XPath: /…, //…, xpath:…, count(…), string(…)… */
  public static boolean isXPath(String target) {
    return target.startsWith("/") || target.startsWith("xpath:") || target.matches("^(count|string|number|boolean|sum)\\(.*");
  }

  /**
   * An XPath on an XML body: one node gives its text, several a list of texts, a function its value; null when nothing
   * matches. The document's prefixes work as written; `namespaces` adds or overrides some.
   */
  public static Object value(String text, String expr, Map<String, Object> namespaces) {
    Document doc = parse(text);
    if (doc == null) return null;
    Map<String, String> prefixes = new HashMap<>();
    declared(doc.getDocumentElement(), prefixes);
    if (namespaces != null) namespaces.forEach((k, v) -> prefixes.put(k, String.valueOf(v)));
    String e = expr.replaceFirst("^xpath:", "");
    XPath x = xpath(prefixes);
    try {
      if (e.matches("^(count|number|sum)\\(.*")) {
        double d = (Double) x.evaluate(e, doc, XPathConstants.NUMBER);
        return d == Math.rint(d) ? (Object) (long) d : (Object) d;
      }
      if (e.startsWith("boolean(")) return x.evaluate(e, doc, XPathConstants.BOOLEAN);
      if (e.startsWith("string(")) return x.evaluate(e, doc, XPathConstants.STRING);
      NodeList nodes = (NodeList) x.evaluate(e, doc, XPathConstants.NODESET);
      List<Object> texts = new ArrayList<>();
      for (int i = 0; i < nodes.getLength(); i++) {
        Node n = nodes.item(i);
        texts.add(n instanceof Attr a ? a.getValue() : n.getTextContent().trim());
      }
      return texts.isEmpty() ? null : texts.size() == 1 ? texts.get(0) : texts;
    } catch (XPathExpressionException err) {
      throw new IllegalArgumentException("Invalid XPath \"" + e + "\": " + err.getMessage());
    }
  }

  public static Object value(String text, String expr) {
    return value(text, expr, null);
  }

  /** Fails the test when the response is a SOAP fault (a Fault directly in the envelope body). */
  public static void expectNoFault(String text) {
    Document doc = parse(text);
    if (doc == null) return;
    XPath x = xpath(Map.of());
    try {
      Node fault = (Node) x.evaluate("/*[local-name()='Envelope']/*[local-name()='Body']/*[local-name()='Fault']", doc, XPathConstants.NODE);
      if (fault == null) return;
      String code = pick(x, fault, ".//*[local-name()='faultcode']", ".//*[local-name()='Code']/*[local-name()='Value']");
      String reason = pick(x, fault, ".//*[local-name()='faultstring']", ".//*[local-name()='Reason']/*[local-name()='Text']");
      throw new AssertionError("SOAP fault" + (code.isEmpty() ? "" : " " + code) + ": " + (reason.isEmpty() ? "no message" : reason));
    } catch (XPathExpressionException e) {
      throw new IllegalStateException(e);
    }
  }

  private static String pick(XPath x, Node at, String... exprs) throws XPathExpressionException {
    for (String e : exprs) {
      Node n = (Node) x.evaluate(e, at, XPathConstants.NODE);
      if (n != null) return n.getTextContent().trim();
    }
    return "";
  }
}
