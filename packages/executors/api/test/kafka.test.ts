import { DEFAULT_RUN_OPTIONS, newId, runTestCase, type StepInput } from '@stepforge/core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApiExecutor } from '../src/index.ts';

/**
 * Kafka steps against a real broker: set STEPFORGE_TEST_KAFKA (e.g. localhost:9092). CI starts one as a service
 * container; without it these tests are skipped.
 */
const BROKERS = process.env.STEPFORGE_TEST_KAFKA;

const steps = (...s: StepInput[]) =>
  s.map((x) => ({
    enabled: true,
    continueOnFail: false,
    retries: 0,
    params: {},
    locators: [],
    assertions: [],
    id: newId(),
    ...x,
  }));
const run = (...s: StepInput[]) =>
  runTestCase({
    runId: 'R',
    steps: steps(...s),
    executors: [createApiExecutor()],
    options: { ...DEFAULT_RUN_OPTIONS, defaultTimeoutMs: 15_000 },
    artifactsDir: mkdtempSync(join(tmpdir(), 'sf-kafka-')),
  });
const report = (r: Awaited<ReturnType<typeof run>>) =>
  r.steps.map((s) => `${s.type} ${s.status} ${s.message}`).join('\n');

describe.skipIf(!BROKERS)('Kafka', () => {
  const topic = `stepforge-test-${Date.now().toString(36)}`;

  it('sends a message, then finds it by key and by a JSONPath value; only messages since the test started count', async () => {
    const old = await run({
      type: 'api.kafkaProduce',
      params: { brokers: BROKERS, topic, key: 'order-1', value: { orderId: 1, status: 'created' } },
    });
    expect(old.status, report(old)).toBe('passed');
    await new Promise((r) => setTimeout(r, 2500)); // older than the 2 s clock allowance

    const r = await run(
      {
        type: 'api.kafkaProduce',
        params: {
          brokers: BROKERS,
          topic,
          key: 'order-2',
          value: { orderId: 2, status: 'paid' },
          headers: { source: 'test' },
        },
      },
      {
        type: 'api.kafkaConsume',
        params: { brokers: BROKERS, topic, path: '$.status', equals: 'paid' },
        captureAs: 'event',
        assertions: [
          { target: 'key', operator: 'equals', expected: 'order-2' },
          { target: '$.orderId', operator: 'equals', expected: 2 },
          { target: 'header:source', operator: 'equals', expected: 'test' },
        ],
      },
      { type: 'api.kafkaConsume', params: { brokers: BROKERS, topic, key: 'order-1' }, timeoutMs: 4000 },
    );
    expect(r.steps[1]!.status, report(r)).toBe('passed');
    expect((r.vars.event as { value: unknown }).value).toEqual({ orderId: 2, status: 'paid' });
    // order-1 was sent before this test started.
    expect(r.steps[2]).toMatchObject({ status: 'failed', errorKind: 'timeout' });
    expect(r.steps[2]!.message).toMatch(/No matching message on stepforge-test-/);

    const all = await run({
      type: 'api.kafkaConsume',
      params: { brokers: BROKERS, topic, key: 'order-1', since: 'beginning' },
      assertions: [{ target: '$.status', operator: 'equals', expected: 'created' }],
    });
    expect(all.status, report(all)).toBe('passed');
  }, 90_000);

  it('an unreachable broker is a network failure', async () => {
    const r = await run({
      type: 'api.kafkaProduce',
      params: { brokers: '127.0.0.1:1', topic, value: 'x' },
      timeoutMs: 3000,
    });
    expect(r.steps[0]).toMatchObject({ status: 'failed', errorKind: 'network' });
    expect(r.steps[0]!.message).toContain('Kafka at 127.0.0.1:1');
  }, 30_000);
});
