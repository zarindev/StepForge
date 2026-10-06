package support;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Email checks for tests exported by StepForge (by Md Zarin Tasnim), against a Mailpit server (MAILPIT_URL). */
@SuppressWarnings("unchecked")
public final class Mail {
  private static final ObjectMapper JSON = new ObjectMapper();
  private static final HttpClient HTTP = HttpClient.newHttpClient();

  private Mail() {}

  private static String base() {
    String v = Config.get("MAILPIT_URL");
    return (v == null || v.isEmpty() ? "http://127.0.0.1:8025" : v).replaceAll("/$", "");
  }

  private static Map<String, Object> get(String path) throws Exception {
    HttpResponse<String> r = HTTP.send(HttpRequest.newBuilder(URI.create(base() + path)).build(), HttpResponse.BodyHandlers.ofString());
    if (r.statusCode() >= 400) throw new IllegalStateException("Mailpit answered " + r.statusCode() + " at " + base());
    return JSON.readValue(r.body(), Map.class);
  }

  private static boolean includes(Object a, Object b) {
    return b == null || String.valueOf(a == null ? "" : a).toLowerCase().contains(String.valueOf(b).toLowerCase());
  }

  private static String address(Object o) {
    return o instanceof Map<?, ?> m ? String.valueOf(m.get("Address")) : "";
  }

  /** Every http(s) link in the HTML (href) and text, in order, without duplicates. */
  public static List<String> links(String html, String text) {
    List<String> out = new ArrayList<>();
    java.util.function.Consumer<String> add = u -> {
      String url = u.trim().replace("&amp;", "&").replaceAll("[).,;'\"\\]>]+$", "");
      if (url.matches("(?i)^https?://.*") && !out.contains(url)) out.add(url);
    };
    Matcher m = Pattern.compile("(?i)href\\s*=\\s*[\"']([^\"']+)[\"']").matcher(html);
    while (m.find()) add.accept(m.group(1));
    m = Pattern.compile("(?i)https?://[^\\s<>\"']+").matcher(text + "\n" + html.replaceAll("<[^>]+>", " "));
    while (m.find()) add.accept(m.group());
    return out;
  }

  /** Waits for an email received after {@code since} that matches every criterion (case-insensitive "contains"). */
  public static Map<String, Object> waitForEmail(Instant since, Map<String, Object> c, long timeoutMs) throws Exception {
    long deadline = System.currentTimeMillis() + timeoutMs;
    while (true) {
      for (Map<String, Object> m : (List<Map<String, Object>>) get("/api/v1/messages?limit=50").get("messages")) {
        if (Instant.parse(String.valueOf(m.get("Created"))).isBefore(since.minusSeconds(1))) continue;
        if (!includes(address(m.get("From")), c.get("from")) || !includes(m.get("Subject"), c.get("subject"))) continue;
        if (c.get("to") != null && ((List<Object>) m.get("To")).stream().noneMatch(t -> includes(address(t), c.get("to")))) continue;
        Map<String, Object> full = get("/api/v1/message/" + m.get("ID"));
        String text = String.valueOf(full.getOrDefault("Text", "")), html = String.valueOf(full.getOrDefault("HTML", ""));
        if (!includes(text + "\n" + html, c.get("contains"))) continue;
        Map<String, Object> email = new LinkedHashMap<>();
        email.put("id", full.get("ID"));
        email.put("from", address(full.get("From")));
        email.put("to", ((List<Object>) full.getOrDefault("To", List.of())).stream().map(Mail::address).toList());
        email.put("subject", full.get("Subject"));
        email.put("date", full.get("Date"));
        email.put("text", text);
        email.put("html", html);
        email.put("links", links(html, text));
        email.put("attachments", ((List<Map<String, Object>>) full.getOrDefault("Attachments", List.of())).stream().map(a -> String.valueOf(a.get("FileName"))).toList());
        return email;
      }
      if (System.currentTimeMillis() > deadline) {
        throw new AssertionError("No email" + (c.get("to") != null ? " to " + c.get("to") : "") + " arrived within " + timeoutMs / 1000 + " s");
      }
      Thread.sleep(500);
    }
  }

  private static final Pattern OTP_WORDS = Pattern.compile(
      "(?i)\\b(code|otp|one[-\\s]?time|passcode|pass\\s?code|pin|verification|verify|confirm(?:ation)?|security|login|sign[-\\s]?in|token|password)\\b");

  /** A one-time code (4–8 digits), preferring numbers next to words like "code" or "verification". */
  public static String otp(Map<String, Object> email) {
    String text = String.valueOf(email.get("text"));
    if (text.isBlank()) text = String.valueOf(email.get("html")).replaceAll("<[^>]+>", " ");
    text = text.replaceAll("[*_]", " ");
    record Candidate(String code, int index, int score) {}
    List<Candidate> found = new ArrayList<>();
    Matcher m = Pattern.compile("(?<![\\d$€£#+])(?<!\\d[.,:/-])(\\d{3}[ -]\\d{3}|\\d+)(?![\\d%])(?![.,:/]\\d)").matcher(text);
    while (m.find()) {
      String code = m.group(1).replaceAll("[ -]", "");
      if (code.length() < 4 || code.length() > 8) continue;
      String before = text.substring(Math.max(0, m.start() - 60), m.start());
      String after = text.substring(m.end(), Math.min(text.length(), m.end() + 25));
      if (after.matches("(?s)^\\s*[-/]\\s*\\d.*") || before.matches("(?s).*\\d\\s*[-/]\\s*$")) continue;
      // Digits inside a link or an email address are never the code.
      Matcher tb = Pattern.compile("\\S*$").matcher(before), ta = Pattern.compile("^\\S*").matcher(after);
      String token = (tb.find() ? tb.group() : "") + m.group(1) + (ta.find() ? ta.group() : "");
      if (Pattern.compile("(?i)://|@|%[0-9a-f]{2}|[?&][\\w-]+=").matcher(token).find()) continue;
      int score = (OTP_WORDS.matcher(before).find() ? 10 : 0) + (OTP_WORDS.matcher(after).find() ? 4 : 0);
      if (before.matches("(?s).*[:：]\\s*$") || before.matches("(?is).*\\bis\\s*$")) score += 3;
      if (code.matches("^(19|20)\\d\\d$")) score -= 6;
      found.add(new Candidate(code, m.start(), score));
    }
    found.sort(Comparator.comparingInt(Candidate::score).reversed().thenComparingInt(Candidate::index));
    if (found.isEmpty() || (found.get(0).score() <= 0 && found.size() > 1)) {
      throw new AssertionError("No one-time code found in \"" + email.get("subject") + "\"");
    }
    return found.get(0).code();
  }

  /** The first link containing {@code contains} (or any link when null), skipping {@code index} matches. */
  public static String link(Map<String, Object> email, String contains, int index) {
    List<String> pool = ((List<String>) email.get("links")).stream().filter(l -> contains == null || l.toLowerCase().contains(contains.toLowerCase())).toList();
    if (index >= pool.size()) throw new AssertionError("No link" + (contains != null ? " containing \"" + contains + "\"" : "") + " in \"" + email.get("subject") + "\"");
    return pool.get(index);
  }

  /** The first capture group of {@code pattern} in the email text. */
  public static String extract(Map<String, Object> email, String pattern) {
    Matcher m = Pattern.compile("(?i)" + pattern).matcher(email.get("text") + "\n" + email.get("html"));
    if (!m.find()) throw new AssertionError("/" + pattern + "/ found nothing in \"" + email.get("subject") + "\"");
    return m.groupCount() > 0 ? m.group(1) : m.group();
  }

  /** StepForge's "Check email" step: subjectContains, bodyContains, from, hasLink, hasAttachment. */
  public static void assertEmail(Map<String, Object> email, Map<String, Object> c) {
    String subject = String.valueOf(email.get("subject"));
    if (c.containsKey("subjectContains") && !includes(subject, c.get("subjectContains"))) throw new AssertionError("Email \"" + subject + "\": subject does not contain \"" + c.get("subjectContains") + "\"");
    if (c.containsKey("bodyContains") && !includes(email.get("text") + "\n" + email.get("html"), c.get("bodyContains"))) throw new AssertionError("Email \"" + subject + "\": body does not contain \"" + c.get("bodyContains") + "\"");
    if (c.containsKey("from") && !includes(email.get("from"), c.get("from"))) throw new AssertionError("Email \"" + subject + "\": is not from \"" + c.get("from") + "\"");
    Object link = c.get("hasLink");
    if (link != null && ((List<String>) email.get("links")).stream().noneMatch(l -> Boolean.TRUE.equals(link) || includes(l, link))) throw new AssertionError("Email \"" + subject + "\": has no matching link");
    Object att = c.get("hasAttachment");
    if (att != null && ((List<String>) email.get("attachments")).stream().noneMatch(a -> Boolean.TRUE.equals(att) || includes(a, att))) throw new AssertionError("Email \"" + subject + "\": has no matching attachment");
  }
}
