package support;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.restassured.response.Response;
import java.util.LinkedHashMap;
import java.util.Map;

/** REST Assured responses in the shape the checks read (by Md Zarin Tasnim). */
public final class Api {
  private static final ObjectMapper JSON = new ObjectMapper();

  private Api() {}

  /** Status, headers (lower-case names), parsed body, text, time in ms and size in bytes. */
  public record Result(int status, Map<String, String> headers, Object body, String text, long ms, int size) {}

  public static Result result(Response res) {
    Map<String, String> headers = new LinkedHashMap<>();
    res.getHeaders().forEach(h -> headers.put(h.getName().toLowerCase(), h.getValue()));
    String text = res.asString();
    Object body = text;
    try {
      body = text.isEmpty() ? null : JSON.readValue(text, Object.class);
    } catch (Exception notJson) {
      // keep the text
    }
    return new Result(res.getStatusCode(), headers, body, text, res.getTime(), res.asByteArray().length);
  }
}
