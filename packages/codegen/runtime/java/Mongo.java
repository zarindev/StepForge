package support;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.mongodb.client.FindIterable;
import com.mongodb.client.MongoClient;
import com.mongodb.client.MongoClients;
import com.mongodb.client.MongoCollection;
import com.mongodb.client.result.DeleteResult;
import com.mongodb.client.result.UpdateResult;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import org.bson.Document;
import org.bson.conversions.Bson;
import org.bson.json.JsonMode;
import org.bson.json.JsonWriterSettings;

/**
 * MongoDB for tests exported by StepForge (by Md Zarin Tasnim). Each connection name reads DB_<NAME>_URL:
 * mongodb://user:password@host:27017/database. A command is written as StepForge writes it (Extended JSON text, or the
 * same as a value): { "collection": "orders", "find": {…}, "sort": {…}, "limit": 10 }, aggregate, countDocuments,
 * distinct (+ filter), insertOne / insertMany, updateOne / updateMany { filter, update }, deleteOne / deleteMany.
 */
public final class Mongo {
  private static final ObjectMapper JSON = new ObjectMapper();
  private static final JsonWriterSettings RELAXED = JsonWriterSettings.builder().outputMode(JsonMode.RELAXED).build();
  private static final List<String> OPS = List.of("find", "aggregate", "countDocuments", "distinct", "insertOne", "insertMany", "updateOne", "updateMany", "deleteOne", "deleteMany");

  private Mongo() {}

  @SuppressWarnings("unchecked")
  private static Map<String, Object> plain(Document d) throws Exception {
    return JSON.readValue(d.toJson(RELAXED), Map.class);
  }

  @SuppressWarnings("unchecked")
  private static List<Document> docs(Object v) {
    List<Document> out = new ArrayList<>();
    for (Object x : (List<Object>) v) out.add(x instanceof Document d ? d : new Document((Map<String, Object>) x));
    return out;
  }

  /** The command is parsed as a whole, so its parts are documents already. */
  private static Document doc(Object v) {
    return v instanceof Document d ? d : new Document();
  }

  /** Runs one command; the result reads like a database result (rows, columns, rowCount, affected). */
  public static Db.Result run(String connection, Object command) throws Exception {
    // Extended JSON ({"$oid": …}, {"$date": …}) is read as such, whether the command came as text or as a value.
    Document cmd = Document.parse(command instanceof String s ? s : JSON.writeValueAsString(command));
    List<String> ops = OPS.stream().filter(cmd::containsKey).toList();
    if (!(cmd.get("collection") instanceof String name) || ops.size() != 1)
      throw new IllegalArgumentException("A Mongo command needs a \"collection\" and one of: " + String.join(", ", OPS));
    String key = "DB_" + connection.replaceAll("[^A-Za-z0-9]+", "_").toUpperCase() + "_URL";
    String url = Config.get(key);
    if (url == null || url.isEmpty()) throw new IllegalStateException("Set " + key + " for the \"" + connection + "\" database (see .env.example)");
    long started = System.currentTimeMillis();
    try (MongoClient client = MongoClients.create(url)) {
      String db = new com.mongodb.ConnectionString(url).getDatabase();
      MongoCollection<Document> col = client.getDatabase(db == null ? "test" : db).getCollection(name);
      List<Document> found = new ArrayList<>();
      switch (ops.get(0)) {
        case "find" -> {
          FindIterable<Document> it = col.find(doc(cmd.get("find")));
          if (cmd.get("projection") != null) it = it.projection(doc(cmd.get("projection")));
          if (cmd.get("sort") != null) it = it.sort(doc(cmd.get("sort")));
          if (cmd.get("skip") != null) it = it.skip(J.toInt(cmd.get("skip")));
          it.limit(cmd.get("limit") == null ? 1000 : J.toInt(cmd.get("limit"))).into(found);
        }
        case "aggregate" -> col.aggregate(new ArrayList<Bson>(docs(cmd.get("aggregate")))).into(found);
        case "countDocuments" -> found.add(new Document("count", col.countDocuments(doc(cmd.get("countDocuments")))));
        case "distinct" -> {
          for (Object v : col.distinct(cmd.getString("distinct"), doc(cmd.get("filter")), Object.class)) found.add(new Document("value", v));
        }
        case "insertOne" -> {
          Document d = doc(cmd.get("insertOne"));
          col.insertOne(d);
          return changed(1, Map.of("insertedId", String.valueOf(d.get("_id"))), started);
        }
        case "insertMany" -> {
          List<Document> many = docs(cmd.get("insertMany"));
          col.insertMany(many);
          return changed(many.size(), Map.of(), started);
        }
        case "updateOne", "updateMany" -> {
          Document spec = doc(cmd.get(ops.get(0)));
          Bson filter = doc(spec.get("filter"));
          Bson update = doc(spec.get("update"));
          UpdateResult r = ops.get(0).equals("updateOne") ? col.updateOne(filter, update) : col.updateMany(filter, update);
          return changed((int) r.getModifiedCount(), Map.of("matched", r.getMatchedCount()), started);
        }
        default -> {
          Document spec = doc(cmd.get(ops.get(0)));
          Bson filter = spec.get("filter") != null ? doc(spec.get("filter")) : spec;
          DeleteResult r = ops.get(0).equals("deleteOne") ? col.deleteOne(filter) : col.deleteMany(filter);
          return changed((int) r.getDeletedCount(), Map.of(), started);
        }
      }
      List<Map<String, Object>> rows = new ArrayList<>();
      LinkedHashSet<String> columns = new LinkedHashSet<>();
      for (Document d : found) {
        Map<String, Object> row = plain(d);
        rows.add(row);
        columns.addAll(row.keySet());
      }
      return new Db.Result(rows, new ArrayList<>(columns), rows.size(), 0, System.currentTimeMillis() - started);
    }
  }

  private static Db.Result changed(int affected, Map<String, Object> extra, long started) {
    List<Map<String, Object>> rows = extra.isEmpty() ? List.of() : List.of(new LinkedHashMap<>(extra));
    return new Db.Result(rows, new ArrayList<>(extra.keySet()), 0, affected, System.currentTimeMillis() - started);
  }
}
