package support;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Database access for tests exported by StepForge (by Md Zarin Tasnim). Each connection name reads DB_<NAME>_URL:
 * postgres://…, mysql://… or sqlite:/path/to/file.db. StepForge's $1 placeholders become JDBC's ?, bound by their
 * number.
 */
public final class Db {
  private Db() {}

  public record Result(List<Map<String, Object>> rows, List<String> columns, int rowCount, int affected, long ms) {}

  private static Connection connect(String connection) throws Exception {
    String key = "DB_" + connection.replaceAll("[^A-Za-z0-9]+", "_").toUpperCase() + "_URL";
    String url = Config.get(key);
    if (url == null || url.isEmpty()) throw new IllegalStateException("Set " + key + " for the \"" + connection + "\" database (see .env.example)");
    if (url.startsWith("sqlite:")) return DriverManager.getConnection("jdbc:sqlite:" + url.replaceFirst("^sqlite:(//)?", ""));
    URI u = URI.create(url);
    String scheme = url.startsWith("mysql:") ? "mysql" : "postgresql";
    String jdbc = "jdbc:" + scheme + "://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "") + u.getPath();
    String[] auth = u.getRawUserInfo() == null ? new String[] {"", ""} : u.getRawUserInfo().split(":", 2);
    return DriverManager.getConnection(jdbc, URLDecoder.decode(auth[0], StandardCharsets.UTF_8), auth.length > 1 ? URLDecoder.decode(auth[1], StandardCharsets.UTF_8) : "");
  }

  private static final Pattern TOKENS = Pattern.compile("'(?:[^']|'')*'|\"(?:[^\"]|\"\")*\"|\\$(\\d+)|\\?");

  private record Bound(String sql, List<Object> params) {}

  /**
   * $1, $2… become ? with the parameters in the order they appear, so $2 before $1 or $1 used twice bind the right
   * values; a ? takes the next parameter. Quoted text is left as it is.
   */
  private static Bound bind(String sql, List<Object> params) {
    StringBuilder out = new StringBuilder();
    List<Object> bound = new ArrayList<>();
    Matcher m = TOKENS.matcher(sql);
    int last = 0;
    int position = 0;
    while (m.find()) {
      String token = m.group();
      if (token.startsWith("'") || token.startsWith("\"")) continue;
      out.append(sql, last, m.start()).append('?');
      last = m.end();
      if (m.group(1) != null) {
        int n = Integer.parseInt(m.group(1));
        if (n < 1 || n > params.size()) throw new IllegalArgumentException("$" + n + " in the SQL, but " + params.size() + " parameter(s) were given");
        bound.add(params.get(n - 1));
      } else {
        if (position >= params.size()) throw new IllegalArgumentException("More ? in the SQL than the " + params.size() + " parameter(s) given");
        bound.add(params.get(position++));
      }
    }
    out.append(sql.substring(last));
    return new Bound(out.toString(), bound);
  }

  /** Runs one statement with bound parameters. */
  public static Result query(String connection, String sql, List<Object> params) throws Exception {
    long started = System.currentTimeMillis();
    Bound b = params.isEmpty() ? new Bound(sql, params) : bind(sql, params);
    try (Connection c = connect(connection); PreparedStatement st = c.prepareStatement(b.sql())) {
      for (int i = 0; i < b.params().size(); i++) st.setObject(i + 1, b.params().get(i));
      if (st.execute()) {
        try (ResultSet rs = st.getResultSet()) {
          ResultSetMetaData md = rs.getMetaData();
          List<String> columns = new ArrayList<>();
          for (int i = 1; i <= md.getColumnCount(); i++) columns.add(md.getColumnLabel(i));
          List<Map<String, Object>> rows = new ArrayList<>();
          while (rs.next()) {
            Map<String, Object> row = new LinkedHashMap<>();
            for (int i = 1; i <= columns.size(); i++) row.put(columns.get(i - 1), rs.getObject(i));
            rows.add(row);
          }
          return new Result(rows, columns, rows.size(), 0, System.currentTimeMillis() - started);
        }
      }
      return new Result(List.of(), List.of(), 0, st.getUpdateCount(), System.currentTimeMillis() - started);
    }
  }

  public static Result query(String connection, String sql) throws Exception {
    return query(connection, sql, List.of());
  }

  /** Runs several statements separated by semicolons. */
  public static Result script(String connection, String sql) throws Exception {
    long started = System.currentTimeMillis();
    try (Connection c = connect(connection); Statement st = c.createStatement()) {
      for (String statement : sql.split(";")) if (!statement.isBlank()) st.execute(statement);
      return new Result(List.of(), List.of(), 0, 0, System.currentTimeMillis() - started);
    }
  }
}
