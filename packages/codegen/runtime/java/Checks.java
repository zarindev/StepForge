package support;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Runtime helpers for tests exported by StepForge (by Md Zarin Tasnim). Same rules as StepForge's own checks. */
public final class Checks {
  private static final ObjectMapper JSON = new ObjectMapper();

  private Checks() {}

  static String json(Object v) {
    try {
      return JSON.writeValueAsString(v);
    } catch (Exception e) {
      return String.valueOf(v);
    }
  }

  private static Integer lengthOf(Object v) {
    if (v instanceof String s) return s.length();
    if (v instanceof Collection<?> c) return c.size();
    if (v instanceof Map<?, ?> m) return m.size();
    return null;
  }

  private static boolean same(Object a, Object b) {
    if (Objects.equals(a, b)) return true;
    // "200" equals 200: values read from the page are always strings.
    if ((a instanceof Number && b instanceof String) || (a instanceof String && b instanceof Number)) {
      return text(a).equals(text(b));
    }
    if (a instanceof Number x && b instanceof Number y) return x.doubleValue() == y.doubleValue();
    return json(a).equals(json(b));
  }

  private static double number(Object v) {
    try {
      return v instanceof Number n ? n.doubleValue() : Double.parseDouble(String.valueOf(v));
    } catch (NumberFormatException e) {
      return Double.NaN;
    }
  }

  private static List<?> list(Object v) {
    return v instanceof List<?> l ? l : java.util.Collections.singletonList(v);
  }

  private static boolean empty(Object v) {
    Integer n = lengthOf(v);
    return v == null || "".equals(v) || (n != null && n == 0);
  }

  /** Compares a value with one of StepForge's operators (equals, contains, gt, matches, inRange…). */
  public static boolean compare(Object actual, String operator, Object expected) {
    switch (operator) {
      case "equals": return same(actual, expected);
      case "notEquals": return !same(actual, expected);
      case "contains":
        return actual instanceof List<?> l ? l.stream().anyMatch(x -> same(x, expected)) : text(actual).contains(text(expected));
      case "notContains": return !compare(actual, "contains", expected);
      case "matches": return Pattern.compile(String.valueOf(expected)).matcher(text(actual)).find();
      case "lt": return number(actual) < number(expected);
      case "lte": return number(actual) <= number(expected);
      case "gt": return number(actual) > number(expected);
      case "gte": return number(actual) >= number(expected);
      case "exists": return actual != null;
      case "notExists": return actual == null;
      case "isEmpty": return empty(actual);
      case "isNotEmpty": return !empty(actual);
      case "lengthEquals": return Objects.equals(lengthOf(actual), (int) number(expected));
      case "noNulls": return list(actual).stream().allMatch(Objects::nonNull);
      case "unique": {
        List<String> seen = list(actual).stream().map(Checks::json).toList();
        return new HashSet<>(seen).size() == seen.size();
      }
      case "inRange": {
        Double[] r = range(expected);
        return list(actual).stream().allMatch(x -> {
          double n = number(x);
          return x != null && !Double.isNaN(n) && (r[0] == null || n >= r[0]) && (r[1] == null || n <= r[1]);
        });
      }
      default: throw new IllegalArgumentException("Unknown operator \"" + operator + "\"");
    }
  }

  private static Double[] range(Object e) {
    if (e instanceof List<?> l) return new Double[] {l.size() > 0 && l.get(0) != null ? number(l.get(0)) : null, l.size() > 1 && l.get(1) != null ? number(l.get(1)) : null};
    if (e instanceof Map<?, ?> m) return new Double[] {m.get("min") != null ? number(m.get("min")) : null, m.get("max") != null ? number(m.get("max")) : null};
    Matcher m = Pattern.compile("^\\s*(-?[\\d.]*)\\s*\\.\\.\\s*(-?[\\d.]*)\\s*$").matcher(text(e));
    if (!m.find()) return new Double[] {null, null};
    return new Double[] {m.group(1).isEmpty() ? null : number(m.group(1)), m.group(2).isEmpty() ? null : number(m.group(2))};
  }

  /** Fails the test unless {@link #compare} holds. */
  public static void check(Object actual, String operator, Object expected, String what) {
    if (!compare(actual, operator, expected)) {
      throw new AssertionError("Expected " + what + (expected != null ? " " + json(expected) : "") + ", but got " + json(actual));
    }
  }

  private static final Pattern TOKEN = Pattern.compile("\\.\\.([\\w$-]+)|\\.([\\w$-]+)|\\[\\s*'([^']*)'\\s*\\]|\\[\\s*\"([^\"]*)\"\\s*\\]|\\[(\\*|-?\\d+)\\]|\\.(\\*)");

  /** A small JSONPath: $, .key, ['key'], [n], [*] and ..key. Lists come back for wildcards. */
  public static Object jsonPath(Object data, String path) {
    List<Object> nodes = new ArrayList<>();
    nodes.add(data);
    boolean multi = false;
    Matcher m = TOKEN.matcher(path.replaceFirst("^\\$", ""));
    while (m.find()) {
      String deep = m.group(1), key = m.group(2) != null ? m.group(2) : m.group(3) != null ? m.group(3) : m.group(4), idx = m.group(5);
      List<Object> next = new ArrayList<>();
      if (deep != null) {
        multi = true;
        for (Object n : nodes) collect(n, deep, next);
      } else if ("*".equals(idx) || m.group(6) != null) {
        multi = true;
        for (Object n : nodes) next.addAll(children(n));
      } else if (idx != null) {
        int i = Integer.parseInt(idx);
        for (Object n : nodes) if (n instanceof List<?> l && i < l.size() && i >= -l.size()) next.add(l.get(i < 0 ? l.size() + i : i));
      } else {
        for (Object n : nodes) if (n instanceof Map<?, ?> map && map.containsKey(key)) next.add(map.get(key));
      }
      nodes = next;
    }
    return multi ? nodes : nodes.isEmpty() ? null : nodes.get(0);
  }

  private static List<Object> children(Object n) {
    if (n instanceof List<?> l) return new ArrayList<>(l);
    if (n instanceof Map<?, ?> m) return new ArrayList<>(m.values());
    return List.of();
  }

  private static void collect(Object n, String key, List<Object> out) {
    if (n instanceof Map<?, ?> m && m.containsKey(key)) out.add(m.get(key));
    for (Object c : children(n)) collect(c, key, out);
  }

  /** Reads {@code user.email}-style nested values. */
  public static Object field(Map<String, Object> obj, String path) {
    Object cur = obj;
    for (String k : path.split("\\.")) cur = cur instanceof Map<?, ?> m ? m.get(k) : null;
    return cur;
  }

  /** First capture group of a regular expression (or the whole match). */
  public static String capture(Object text, String pattern) {
    Matcher m = Pattern.compile(pattern).matcher(text(text));
    if (!m.find()) return null;
    return m.groupCount() > 0 ? m.group(1) : m.group(0);
  }

  /** A value as text, the way StepForge types it into a field. */
  public static String text(Object v) {
    if (v == null) return "";
    if (v instanceof Double d && d == Math.rint(d)) return String.valueOf(d.longValue());
    if (v instanceof Map || v instanceof List) return json(v);
    return String.valueOf(v);
  }

  /** Reads an assertion target from an API or database result, as StepForge does. */
  public static Object pick(Object result, String target) {
    String t = target.trim();
    if (result instanceof Db.Result r) {
      switch (t) {
        case "rowCount": case "count": return r.rowCount();
        case "affected": case "affectedRows": return r.affected();
        case "rows": return r.rows();
        case "columns": return r.columns();
        case "time": case "durationMs": return r.ms();
        case "value": case "scalar":
          return r.rows().isEmpty() ? null : r.rows().get(0).get(r.columns().isEmpty() ? r.rows().get(0).keySet().iterator().next() : r.columns().get(0));
        default:
      }
      Matcher col = Pattern.compile("^(?:column|col)[:.](.+)$").matcher(t);
      if (col.find()) return r.rows().stream().map(row -> row.get(col.group(1))).toList();
      Matcher cell = Pattern.compile("^rows?\\[(\\d+)\\](?:\\.(.+))?$").matcher(t);
      if (cell.find()) {
        int i = Integer.parseInt(cell.group(1));
        Map<String, Object> row = i < r.rows().size() ? r.rows().get(i) : null;
        return cell.group(2) != null && row != null ? row.get(cell.group(2)) : row;
      }
      if (t.startsWith("$")) return jsonPath(r.rows(), t);
      return r.rows().isEmpty() ? null : r.rows().get(0).get(t);
    }
    Api.Result r = (Api.Result) result;
    switch (t) {
      case "status": return r.status();
      case "time": return r.ms();
      case "size": return r.size();
      case "body": return r.body();
      case "text": return r.text();
      default:
    }
    if (t.startsWith("header:")) return r.headers().get(t.substring(7).toLowerCase());
    if (t.startsWith("$")) return jsonPath(r.body(), t);
    return null;
  }
}
