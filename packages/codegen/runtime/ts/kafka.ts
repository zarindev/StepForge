// Kafka for tests exported by StepForge (by Md Zarin Tasnim), with kafkajs: send a message, wait for one.
import { Kafka, logLevel, type SASLOptions } from 'kafkajs';
import { jsonPath } from './helpers';

export type KafkaOptions = {
  /** `host:port,host:port` or a list. */
  brokers: string | string[];
  topic: string;
  key?: unknown;
  value?: unknown;
  headers?: Record<string, unknown>;
  partition?: unknown;
  ssl?: boolean;
  sasl?: { mechanism?: string; username?: string; password?: string };
  /** consume: `testStart` (default) or `beginning`; and what to match: key, contains, or path (+ equals). */
  since?: string;
  contains?: unknown;
  path?: string;
  equals?: unknown;
  timeoutMs?: number;
};

export type KafkaMessage = {
  key: string | null;
  value: unknown;
  headers: Record<string, string>;
  partition: number;
  offset: string;
  timestamp: number;
};

/** Messages count from the test's start, minus this much clock difference between the broker and here. */
const SINCE_SKEW_MS = 2000;

function client(o: KafkaOptions, timeoutMs: number): Kafka {
  const brokers = (Array.isArray(o.brokers) ? o.brokers : String(o.brokers ?? '').split(','))
    .map((b) => b.trim())
    .filter(Boolean);
  return new Kafka({
    clientId: 'stepforge-tests',
    brokers,
    ssl: !!o.ssl,
    connectionTimeout: Math.min(timeoutMs, 10_000),
    requestTimeout: Math.max(timeoutMs, 5000),
    retry: { retries: 6, initialRetryTime: 300, maxRetryTime: 5000 },
    logLevel: logLevel.NOTHING,
    ...(o.sasl?.username && {
      sasl: {
        mechanism: o.sasl.mechanism ?? 'plain',
        username: o.sasl.username,
        password: o.sasl.password ?? '',
      } as SASLOptions,
    }),
  });
}

const parse = (s: string | null): unknown => {
  if (s === null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

/** Creates the topic (and waits for its leaders) when it does not exist yet, so the first message does not race it. */
async function ensureTopic(kafka: Kafka, topic: string): Promise<void> {
  const admin = kafka.admin();
  try {
    await admin.connect();
    if (!(await admin.listTopics()).includes(topic))
      await admin.createTopics({ topics: [{ topic }], waitForLeaders: true });
  } catch {
    // the send or subscribe reports the real problem
  } finally {
    await admin.disconnect().catch(() => {});
  }
}

/** Sends one message (a value that is not text is sent as JSON). */
export async function produce(
  o: KafkaOptions,
  timeoutMs = 15_000,
): Promise<{ topic: string; partition?: number; offset?: string }> {
  const kafka = client(o, timeoutMs);
  const producer = kafka.producer({ allowAutoTopicCreation: true });
  await producer.connect();
  try {
    await ensureTopic(kafka, o.topic);
    const [meta] = await producer.send({
      topic: o.topic,
      timeout: timeoutMs,
      messages: [
        {
          key: o.key === undefined || o.key === '' || o.key === null ? null : String(o.key),
          value:
            o.value === undefined || o.value === null
              ? null
              : typeof o.value === 'string'
                ? o.value
                : JSON.stringify(o.value),
          headers: Object.fromEntries(Object.entries(o.headers ?? {}).map(([k, v]) => [k, String(v)])),
          ...(o.partition !== undefined && o.partition !== '' && { partition: Number(o.partition) }),
        },
      ],
    });
    return { topic: o.topic, partition: meta?.partition, offset: meta?.baseOffset };
  } finally {
    await producer.disconnect().catch(() => {});
  }
}

/**
 * Waits for the first message on the topic that matches: `key` equals, `contains` (text in the value), or `path` +
 * `equals` (a JSONPath in a JSON value). Only messages since `since` count unless `o.since` is `beginning`.
 */
export async function consume(o: KafkaOptions, since: Date, timeoutMs = 15_000): Promise<KafkaMessage> {
  const from = o.since === 'beginning' ? 0 : since.getTime() - SINCE_SKEW_MS;
  const kafka = client(o, timeoutMs);
  const groupId = `stepforge-tests-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
  const consumer = kafka.consumer({ groupId, allowAutoTopicCreation: true });
  const admin = kafka.admin();
  const matches = (m: KafkaMessage) => {
    if (o.key !== undefined && o.key !== '' && m.key !== String(o.key)) return false;
    const text = typeof m.value === 'string' ? m.value : JSON.stringify(m.value);
    if (o.contains !== undefined && o.contains !== '' && !text?.includes(String(o.contains))) return false;
    if (o.path) {
      const got = jsonPath(m.value ?? null, o.path);
      if (o.equals !== undefined && String(got) !== String(o.equals)) return false;
      if (o.equals === undefined && (got === undefined || got === null)) return false;
    }
    return true;
  };
  let seen = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.all([consumer.connect(), admin.connect()]);
    await ensureTopic(kafka, o.topic);
    const offsets =
      from > 0
        ? await admin.fetchTopicOffsetsByTimestamp(o.topic, from)
        : (await admin.fetchTopicOffsets(o.topic)).map((x) => ({ partition: x.partition, offset: x.low }));
    await consumer.subscribe({ topic: o.topic, fromBeginning: from === 0 });
    return await new Promise<KafkaMessage>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`No matching message on ${o.topic} within ${timeoutMs} ms (${seen} checked)`)),
        timeoutMs,
      );
      consumer
        .run({
          eachMessage: async ({ partition, message }) => {
            const m: KafkaMessage = {
              key: message.key?.toString() ?? null,
              value: parse(message.value?.toString() ?? null),
              headers: Object.fromEntries(
                Object.entries(message.headers ?? {}).map(([k, v]) => [k, v?.toString() ?? '']),
              ),
              partition,
              offset: message.offset,
              timestamp: Number(message.timestamp),
            };
            if (m.timestamp < from) return;
            seen++;
            if (matches(m)) resolve(m);
          },
        })
        .then(async () => {
          // run() can return before the group is ready, and seek() throws until it is: try again shortly.
          for (let i = 0; ; i++) {
            try {
              for (const x of offsets)
                consumer.seek({ topic: o.topic, partition: x.partition, offset: x.offset });
              return;
            } catch (err) {
              if (i >= 50 || !/not initialized|run must be called/i.test((err as Error).message)) throw err;
              await new Promise((r) => setTimeout(r, 100));
            }
          }
        })
        .catch(reject);
    });
  } finally {
    clearTimeout(timer);
    await consumer.disconnect().catch(() => {});
    await admin.deleteGroups([groupId]).catch(() => {});
    await admin.disconnect().catch(() => {});
  }
}

/** Reads an assertion target from a received message: key, value, `$…` (in the value), header:<name>, partition, offset. */
export function pickMessage(m: KafkaMessage | Record<string, unknown>, target: string): unknown {
  if (target.startsWith('$')) return jsonPath((m as KafkaMessage).value ?? null, target);
  if (target.startsWith('header:')) return (m as KafkaMessage).headers?.[target.slice(7)];
  return (m as Record<string, unknown>)[target];
}
