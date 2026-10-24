package support;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.networknt.schema.JsonMetaSchema;
import com.networknt.schema.JsonSchemaFactory;
import com.networknt.schema.SchemaValidatorsConfig;
import com.networknt.schema.SpecVersion;
import com.networknt.schema.ValidationMessage;
import com.networknt.schema.format.PatternFormat;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** JSON Schema checks for tests exported by StepForge (by Md Zarin Tasnim), formats included, as StepForge checks them. */
public final class Schema {
  private static final ObjectMapper JSON = new ObjectMapper();
  /**
   * Emails as StepForge (Ajv) checks them: the validator's own check also requires a top-level domain it knows, so
   * reserved test domains (example.test) would fail.
   */
  private static final String EMAIL = "(?i)^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$";
  private static final JsonMetaSchema META = JsonMetaSchema.builder(JsonMetaSchema.getV7()).format(PatternFormat.of("email", EMAIL, "format")).build();
  private static final JsonSchemaFactory FACTORY = JsonSchemaFactory.getInstance(SpecVersion.VersionFlag.V7, b -> b.metaSchema(META));
  private static final SchemaValidatorsConfig CONFIG = SchemaValidatorsConfig.builder().formatAssertionsEnabled(true).build();

  private Schema() {}

  /** OpenAPI 3.0 `nullable: true` becomes JSON Schema, so null values validate. */
  @SuppressWarnings("unchecked")
  private static Object normalize(Object schema) {
    if (schema instanceof List<?> l) {
      List<Object> out = new ArrayList<>();
      for (Object x : l) out.add(normalize(x));
      return out;
    }
    if (!(schema instanceof Map<?, ?> m)) return schema;
    Map<String, Object> out = new LinkedHashMap<>();
    ((Map<String, Object>) m).forEach((k, v) -> out.put(k, normalize(v)));
    if (Boolean.TRUE.equals(out.get("nullable")) && out.get("type") instanceof String t) out.put("type", List.of(t, "null"));
    return out;
  }

  /** Fails the test unless the value matches the JSON Schema, naming the fields that do not. */
  public static void expect(Object value, Object schema, String what) {
    JsonNode node = JSON.valueToTree(value);
    Set<ValidationMessage> errors = FACTORY.getSchema(JSON.valueToTree(normalize(schema)), CONFIG).validate(node);
    if (!errors.isEmpty())
      throw new AssertionError(what + ": " + String.join("; ", errors.stream().limit(10).map(ValidationMessage::getMessage).toList()));
  }
}
