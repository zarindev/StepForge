package support;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Small builders for exported tests (by Md Zarin Tasnim): ordered maps and lists that accept nulls. */
public final class J {
  private J() {}

  /** map("a", 1, "b", 2) → an ordered, mutable map. */
  public static Map<String, Object> map(Object... keysAndValues) {
    Map<String, Object> m = new LinkedHashMap<>();
    for (int i = 0; i + 1 < keysAndValues.length; i += 2) m.put(String.valueOf(keysAndValues[i]), keysAndValues[i + 1]);
    return m;
  }

  public static List<Object> list(Object... items) {
    return new ArrayList<>(Arrays.asList(items));
  }

  /** Loops over a list (or a single value). */
  @SuppressWarnings("unchecked")
  public static List<Object> items(Object v) {
    return v instanceof List<?> l ? (List<Object>) l : v == null ? List.of() : List.of(v);
  }

  public static int toInt(Object v) {
    return v instanceof Number n ? n.intValue() : Integer.parseInt(String.valueOf(v).trim());
  }
}
