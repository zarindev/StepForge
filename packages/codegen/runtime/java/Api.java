package support;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.restassured.response.Response;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

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

  private record Token(String value, long expires) {}

  private static final Map<String, Token> TOKENS = new ConcurrentHashMap<>();

  /**
   * An OAuth2 access token (client-credentials grant), as StepForge fetches it: the client id and secret as Basic auth,
   * grant_type and scope as a form; kept until shortly before it expires.
   */
  public static String oauth2Token(String tokenUrl, String clientId, String clientSecret, String scope) throws Exception {
    String key = tokenUrl + "|" + clientId + "|" + (scope == null ? "" : scope);
    Token hit = TOKENS.get(key);
    if (hit != null && hit.expires() > System.currentTimeMillis()) return hit.value();
    String form = "grant_type=client_credentials" + (scope == null || scope.isEmpty() ? "" : "&scope=" + URLEncoder.encode(scope, StandardCharsets.UTF_8));
    String basic = Base64.getEncoder().encodeToString((clientId + ":" + clientSecret).getBytes(StandardCharsets.UTF_8));
    HttpResponse<String> res = HttpClient.newHttpClient().send(
        HttpRequest.newBuilder(URI.create(tokenUrl))
            .header("Content-Type", "application/x-www-form-urlencoded")
            .header("Authorization", "Basic " + basic)
            .POST(HttpRequest.BodyPublishers.ofString(form))
            .build(),
        HttpResponse.BodyHandlers.ofString());
    Map<?, ?> json = Map.of();
    try {
      json = JSON.readValue(res.body(), Map.class);
    } catch (Exception notJson) {
      // reported below
    }
    Object token = json.get("access_token");
    if (res.statusCode() >= 400 || token == null) throw new IllegalStateException("OAuth2 token request failed with " + res.statusCode());
    long expiresIn = json.get("expires_in") instanceof Number n ? n.longValue() : 300;
    TOKENS.put(key, new Token(String.valueOf(token), System.currentTimeMillis() + Math.max(30, expiresIn - 30) * 1000));
    return String.valueOf(token);
  }
}
