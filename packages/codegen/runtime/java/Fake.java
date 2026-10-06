package support;

import java.time.LocalDate;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;
import net.datafaker.Faker;

/** Test data for exported tests (by Md Zarin Tasnim), like StepForge's "Generate data" step and {{random.*}}. */
public final class Fake {
  private static final Faker FAKER = new Faker(Locale.ENGLISH);
  private static final ThreadLocalRandom R = ThreadLocalRandom.current();

  private Fake() {}

  public static Object random(String kind) {
    switch (kind) {
      case "email": return "sf." + Long.toHexString(System.currentTimeMillis()) + R.nextInt(1000, 10000) + "@example.test";
      case "uuid": return UUID.randomUUID().toString();
      case "number": return R.nextInt(0, 1_000_000);
      case "digits6": return String.format("%06d", R.nextInt(0, 1_000_000));
      case "timestamp": return System.currentTimeMillis();
      default: return FAKER.regexify("[a-z0-9]{8}");
    }
  }

  private static String pattern(String p) {
    StringBuilder out = new StringBuilder();
    for (char c : p.toCharArray()) {
      if (c == '#') out.append(R.nextInt(10));
      else if (c == '?') out.append((char) ('A' + R.nextInt(26)));
      else if (c == '*') out.append("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".charAt(R.nextInt(36)));
      else out.append(c);
    }
    return out.toString();
  }

  private static String opt(Map<String, Object> o, String key, Object fallback) {
    Object v = o.get(key);
    return String.valueOf(v == null ? fallback : v);
  }

  public static Object data(String kind) {
    return data(kind, Map.of());
  }

  public static Object data(String kind, Map<String, Object> o) {
    switch (kind) {
      case "name": return FAKER.name().fullName();
      case "firstName": return FAKER.name().firstName();
      case "lastName": return FAKER.name().lastName();
      case "email": return (FAKER.internet().username() + R.nextInt(1, 1000) + "@" + opt(o, "domain", "example.test")).toLowerCase();
      case "phone": return pattern(opt(o, "pattern", "+1-555-###-####"));
      case "date":
        return "future".equals(o.get("direction"))
            ? LocalDate.now().plusDays(R.nextInt(1, Integer.parseInt(opt(o, "days", 30)) + 1)).toString()
            : LocalDate.now().minusDays(R.nextInt(1, 365 * Integer.parseInt(opt(o, "years", 1)) + 1)).toString();
      case "birthdate":
        return FAKER.timeAndDate()
            .birthday(Integer.parseInt(opt(o, "minAge", 18)), Integer.parseInt(opt(o, "maxAge", 80)))
            .toString();
      case "number": return R.nextInt(Integer.parseInt(opt(o, "min", 0)), Integer.parseInt(opt(o, "max", 1000)) + 1);
      case "uuid": return UUID.randomUUID().toString();
      case "word": return FAKER.lorem().word();
      case "sentence": return FAKER.lorem().sentence();
      case "address": return FAKER.address().streetAddress();
      case "company": return FAKER.company().name();
      case "pattern": return pattern(opt(o, "pattern", "####"));
      default: throw new IllegalArgumentException("Unknown data kind \"" + kind + "\"");
    }
  }
}
