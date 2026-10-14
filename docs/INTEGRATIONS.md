# SOAP, Kafka and FTP

_By Md Zarin Tasnim · part of the StepForge documentation_

Many systems talk through more than REST: SOAP web services, message queues and file drops. StepForge has steps for
them, in the **API** group, so they share variables, test data
and assertions with every other step. Everything is free and runs locally: the libraries are open source (kafkajs,
basic-ftp, ssh2-sftp-client, xmldom, xpath) and connect straight to your servers.

## SOAP (`api.soap`)

Write only what goes inside `<soap:Body>`; StepForge wraps it in an envelope:

```xml
<m:GetPrice xmlns:m="http://example.com/prices"><m:Item>{{data.item}}</m:Item></m:GetPrice>
```

- **Version 1.1** (default) sends `text/xml` and a `SOAPAction` header; **1.2** sends `application/soap+xml` with the
  action as a parameter. A body that is already a whole `Envelope` is sent as written. *SOAP header* adds
  `<soap:Header>` content (e.g. WS-Security).
- **Faults** — a `soap:Fault` in the answer fails the step with its code and message ("SOAP fault soap:Client: Unknown
  item"). Tick *A SOAP fault is expected* to test error cases, and check the target `fault`.
- **Checking the answer** — any assertion target that is an XPath reads the XML: `//m:Price` equals `1.90`,
  `//m:Price/@currency` equals `EUR`, `count(//m:Item)` equals `3`. Prefixes declared in the response work as written;
  `namespaces` adds others. `api.extract` with an XPath keeps a value for later steps (`captureAs`).
- XPath targets work on **any XML response**, so XML REST APIs are covered too.

## Kafka (`api.kafkaProduce`, `api.kafkaConsume`)

Put the broker list in an environment variable (`kafkaBrokers = localhost:9092`) and use `{{env.kafkaBrokers}}` in the
steps, so each environment points at its own cluster.

- **Send** — topic, key, value (text or JSON) and headers. Output: partition and offset.
- **Wait for a message** — the first message on the topic that matches: *key equals*, *value contains*, or a JSONPath
  in a JSON value (`$.status` equals `paid`). By default only messages **since the test started** count, so an
  event left over from an earlier run never satisfies the check; *since: beginning* reads the whole topic. The step
  waits up to its timeout. Check the message with targets `key`, `$.orderId`, `header:source`, `partition`, `offset`;
  `captureAs` keeps `{ key, value, headers, partition, offset, timestamp }`.
- A typical test: click "Pay" in the UI → wait for the `payments` event with `$.orderId` = `{{vars.orderId}}` → check
  the database row.
- **Security** — TLS (`ssl`) and SASL (`plain`, `scram-sha-256`, `scram-sha-512`) with the password from a secret.
- Each wait uses a temporary consumer group that is deleted afterwards.

## FTP, FTPS and SFTP (`api.ftp`)

One step, five actions: **upload** (a local file, or text typed in the step), **download** (kept with the run's
evidence; check `content` and `size`), **list** a folder (`count`, `names`), **delete**, and **exists**. FTPS accepts
self-signed certificates; SFTP signs in with a password or a private key file. Keep passwords in secrets
(`{{secret.ftpPassword}}`).

Example — a report export: run the export in the UI → `api.ftp` *exists* `/outbox/report-{{vars.date}}.csv` →
*download* it → check `content` contains the expected total.

## Testing these steps

StepForge's own tests start a SOAP service, an FTP server and an SFTP server in-process; the Kafka tests run against
a real broker (Apache Kafka in CI) and are skipped locally unless `STEPFORGE_TEST_KAFKA` is set.

## Limits

Code export marks these steps `TODO(StepForge)` for now. Kafka: messages are read as text or JSON (no Avro / Schema
Registry yet). SFTP does not check the server's host key (test servers). See [KNOWN_ISSUES.md](KNOWN_ISSUES.md).
