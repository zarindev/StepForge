import { StepError, newId, type StepContext, type StepOutcome } from '@stepforge/core';
import { JSONPath } from 'jsonpath-plus';
import { Kafka, logLevel, type KafkaConfig, type SASLOptions } from 'kafkajs';

/** Messages are matched against the test's start, minus this much clock difference between the broker and here. */
const SINCE_SKEW_MS = 2000;

function client(p: Record<string, unknown>, timeoutMs: number): Kafka {
  const brokers = (Array.isArray(p.brokers) ? p.brokers : String(p.brokers ?? '').split(','))
    .map((b) => String(b).trim())
    .filter(Boolean);
  if (!brokers.length)
    throw new StepError('invalid_params', 'Kafka steps need "brokers", e.g. localhost:9092');
  const sasl = p.sasl as { mechanism?: string; username?: string; password?: string } | undefined;
  const config: KafkaConfig = {
    clientId: 'stepforge',
    brokers,
    ssl: !!p.ssl,
    connectionTimeout: Math.min(timeoutMs, 10_000),
    requestTimeout: Math.max(timeoutMs, 5000),
    // A new topic's partition leaders take a moment to be chosen ("not the leader for that topic-partition"):
    // enough retries to ride that out on a busy broker.
    retry: { retries: 6, initialRetryTime: 300, maxRetryTime: 5000 },
    logLevel: logLevel.NOTHING,
    ...(sasl?.username && {
      sasl: {
        mechanism: (sasl.mechanism ?? 'plain') as 'plain',
        username: sasl.username,
        password: sasl.password ?? '',
      } as SASLOptions,
    }),
  };
  return new Kafka(config);
}

const parse = (s: string | null) => {
  if (s === null) return null;
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return s;
  }
};

function kafkaError(err: unknown, brokers: unknown): never {
  if (err instanceof StepError) throw err;
  const e = err as Error & { name?: string };
  const msg = e.message ?? String(err);
  if (/ECONNREFUSED|ENOTFOUND|Connection|broker/i.test(msg) || e.name === 'KafkaJSConnectionError')
    throw new StepError('network', `Kafka at ${String(brokers)}: ${msg}`);
  throw new StepError('unknown', `Kafka: ${msg}`);
}

/** Kafka's "unknown topic" answer (kafkajs reports it as a protocol error of that type). */
const unknownTopic = (err: unknown) => {
  const e = err as { type?: string; message?: string };
  return (
    e.type === 'UNKNOWN_TOPIC_OR_PARTITION' ||
    /UNKNOWN_TOPIC_OR_PARTITION|does not host this topic-partition/i.test(e.message ?? '')
  );
};

/** Sends one message to a topic. */
export async function kafkaProduce(p: Record<string, unknown>, ctx: StepContext): Promise<StepOutcome> {
  const topic = String(p.topic ?? '');
  if (!topic) throw new StepError('invalid_params', 'kafkaProduce needs a "topic"');
  const kafka = client(p, ctx.timeoutMs);
  const producer = kafka.producer({ allowAutoTopicCreation: true });
  const value =
    p.value === undefined || p.value === null
      ? null
      : typeof p.value === 'string'
        ? p.value
        : JSON.stringify(p.value);
  try {
    await producer.connect();
    // A topic that does not exist yet is created first and its leaders awaited, so the message does not race the
    // broker's own creation. (A topic created meanwhile by someone else, or no permission to create: send anyway.)
    const admin = kafka.admin();
    try {
      await admin.connect();
      const topics = await admin.listTopics();
      if (!topics.includes(topic)) await admin.createTopics({ topics: [{ topic }], waitForLeaders: true });
    } catch {
      // the send below creates it, or reports the real problem
    } finally {
      await admin.disconnect().catch(() => {});
    }
    const [meta] = await producer.send({
      topic,
      timeout: ctx.timeoutMs,
      messages: [
        {
          key: p.key === undefined || p.key === '' ? null : String(p.key),
          value,
          headers: Object.fromEntries(
            Object.entries((p.headers as Record<string, unknown>) ?? {}).map(([k, v]) => [k, String(v)]),
          ),
          ...(p.partition !== undefined && p.partition !== '' && { partition: Number(p.partition) }),
        },
      ],
    });
    const out = { topic, partition: meta?.partition, offset: meta?.baseOffset };
    return {
      output: out,
      message: `Sent to ${topic} (partition ${out.partition}, offset ${out.offset})`,
      request: { topic, key: p.key ?? null, value: parse(value), headers: p.headers ?? {} },
      getTarget: (t) => (out as Record<string, unknown>)[t],
    };
  } catch (err) {
    kafkaError(err, p.brokers);
  } finally {
    await producer.disconnect().catch(() => {});
  }
}

type Found = {
  key: string | null;
  value: unknown;
  headers: Record<string, string>;
  partition: number;
  offset: string;
  timestamp: number;
};

/**
 * Waits for a message on a topic that matches: `key` equals, `contains` (text in the value), or `path` + `equals`
 * (a JSONPath in a JSON value). By default only messages since the test started count (`since: beginning` reads the
 * whole topic). Times out with the step timeout.
 */
export async function kafkaConsume(p: Record<string, unknown>, ctx: StepContext): Promise<StepOutcome> {
  const topic = String(p.topic ?? '');
  if (!topic) throw new StepError('invalid_params', 'kafkaConsume needs a "topic"');
  const since = p.since === 'beginning' ? 0 : ctx.startedAt - SINCE_SKEW_MS;
  const kafka = client(p, ctx.timeoutMs);
  const groupId = `stepforge-${ctx.runId}-${newId()}`.toLowerCase();
  const consumer = kafka.consumer({ groupId, allowAutoTopicCreation: true });
  const admin = kafka.admin();
  const matches = (m: Found) => {
    if (p.key !== undefined && p.key !== '' && m.key !== String(p.key)) return false;
    const text = typeof m.value === 'string' ? m.value : JSON.stringify(m.value);
    if (p.contains !== undefined && p.contains !== '' && !text?.includes(String(p.contains))) return false;
    if (p.path) {
      const got = JSONPath({
        path: String(p.path),
        json: (m.value ?? null) as object,
        wrap: false,
      }) as unknown;
      if (p.equals !== undefined && String(got) !== String(p.equals)) return false;
      if (p.equals === undefined && (got === undefined || got === null)) return false;
    }
    return true;
  };
  let seen = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.all([consumer.connect(), admin.connect()]);
    // Start each partition at the first message since the test began (or the beginning).
    let offsets: { partition: number; offset: string }[] = [];
    let missing = false;
    try {
      offsets =
        since > 0
          ? await admin.fetchTopicOffsetsByTimestamp(topic, since)
          : (await admin.fetchTopicOffsets(topic)).map((o) => ({ partition: o.partition, offset: o.low }));
    } catch (err) {
      // The admin client never creates topics: one that does not exist yet has no offsets to seek to.
      // The consumer creates it; reading from the beginning is safe since the timestamp filter still applies.
      if (!unknownTopic(err)) throw err;
      missing = true;
    }
    // Create it now (and wait for its partition leaders), so the app's first message lands on a ready topic instead
    // of racing the broker's own creation. A topic created meanwhile by someone else is fine.
    if (missing) await admin.createTopics({ topics: [{ topic }], waitForLeaders: true }).catch(() => false);
    await consumer.subscribe({ topic, fromBeginning: since === 0 || missing });
    const found = await new Promise<Found>((resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new StepError(
              'timeout',
              `No matching message on ${topic} within ${ctx.timeoutMs} ms (${seen} message(s) checked since ${since ? 'the test started' : 'the beginning'})`,
            ),
          ),
        ctx.timeoutMs,
      );
      onAbort = () => reject(new StepError('aborted', 'Run was cancelled'));
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener('abort', onAbort, { once: true });
      consumer
        .run({
          eachMessage: async ({ partition, message }) => {
            const m: Found = {
              key: message.key?.toString() ?? null,
              value: parse(message.value?.toString() ?? null),
              headers: Object.fromEntries(
                Object.entries(message.headers ?? {}).map(([k, v]) => [k, v?.toString() ?? '']),
              ),
              partition,
              offset: message.offset,
              timestamp: Number(message.timestamp),
            };
            if (m.timestamp < since) return;
            seen++;
            if (matches(m)) resolve(m);
          },
        })
        .then(() => {
          for (const o of offsets) consumer.seek({ topic, partition: o.partition, offset: o.offset });
        })
        .catch(reject);
    });
    return {
      output: found,
      message: `Received from ${topic} (partition ${found.partition}, offset ${found.offset})${found.key ? `, key ${found.key}` : ''}`,
      response: { body: found },
      getTarget: (t) => {
        if (t.startsWith('$'))
          return JSONPath({ path: t, json: (found.value ?? null) as object, wrap: false }) as unknown;
        if (t.startsWith('header:')) return found.headers[t.slice(7)];
        return (found as unknown as Record<string, unknown>)[t];
      },
    };
  } catch (err) {
    return kafkaError(err, p.brokers);
  } finally {
    clearTimeout(timer);
    if (onAbort) ctx.signal.removeEventListener('abort', onAbort);
    await consumer.disconnect().catch(() => {});
    await admin.deleteGroups([groupId]).catch(() => {});
    await admin.disconnect().catch(() => {});
  }
}
