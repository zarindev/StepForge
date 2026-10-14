import { describe, expect, it } from 'vitest';
import { kafkaConsume, kafkaProduce } from '../src/kafka.ts';

/** Against a real broker (STEPFORGE_TEST_KAFKA): waiting on a topic the app creates only later. */
const BROKERS = process.env.STEPFORGE_TEST_KAFKA;
const ctx = (ms: number) =>
  ({ timeoutMs: ms, runId: 'R', startedAt: Date.now(), signal: new AbortController().signal }) as never;

describe.skipIf(!BROKERS)('Kafka: a topic that does not exist yet', () => {
  it('waits for a message on a topic created after the wait started', async () => {
    const topic = `stepforge-fresh-${Date.now().toString(36)}`;
    const wait = kafkaConsume({ brokers: BROKERS, topic, key: 'k1' }, ctx(20_000));
    await new Promise((r) => setTimeout(r, 2000));
    await kafkaProduce({ brokers: BROKERS, topic, key: 'k1', value: { ok: 1 } }, ctx(10_000));
    const out = (await wait) as { output: { key: string; value: unknown } };
    expect(out.output).toMatchObject({ key: 'k1', value: { ok: 1 } });
  }, 40_000);
});
