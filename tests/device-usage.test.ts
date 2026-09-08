import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, appendFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { usageEvent, scanFile, collectOnce } from '../local/usage-collector.ts';
import { mergeDeviceUsage, type DeviceUsageStore } from '../local/device-usage.ts';

const now = Date.now();
const record = (total, last = total, ago = 0) => ({ timestamp: new Date(now - ago).toISOString(), type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total, input_tokens: total - 10, output_tokens: 10 }, last_token_usage: { total_tokens: last } } } });
test('counts cumulative deltas without adding cached/reasoning tokens twice', () => {
  assert.equal(usageEvent(record(100), null, now).event.tokens, 100);
  assert.equal(usageEvent(record(150, 50), 100, now).event.tokens, 50);
  assert.equal(usageEvent(record(150, 50), 150, now).event, undefined);
  assert.equal(usageEvent(record(20, 20), 150, now).event.tokens, 20);
  assert.equal(usageEvent(record(900, 30), null, now).event.tokens, 30);
  assert.equal(usageEvent({ type: 'response_item', payload: { content: 'SECRET' } }, null).event, undefined);
  assert.equal(usageEvent(record(100, 100, 15 * 86400000), null, now).event, undefined);
  assert.equal(usageEvent(record(100), null, now, 'gpt-5.6-sol').event.model, 'gpt-5.6-sol');
});
test('ingestion is globally idempotent, atomic on invalid batches, allowlisted and time bounded', () => {
  const event = usageEvent(record(100), null, now).event;
  const first = mergeDeviceUsage({}, 'mac', [{ ...event, content: 'SECRET' }], now);
  assert.equal(first.accepted, 1);
  assert.equal(mergeDeviceUsage(first.store, 'windows', [event, event], now).accepted, 0);
  assert.ok(!JSON.stringify(first.store).includes('SECRET'));
  assert.throws(() => mergeDeviceUsage(first.store, 'mac', [event, { ...event, tokens: -1 }], now));
  assert.equal(first.store.samples.length, 1);
  assert.throws(() => mergeDeviceUsage({}, 'mac', [{ ...event, timestamp: Math.floor(now / 1000) + 301 }], now));
  assert.equal(mergeDeviceUsage(first.store, 'mac', [event], now + 15 * 86400000).store.samples.length, 0);
  assert.throws(() => mergeDeviceUsage({}, 'mac', [{ ...event, model: 'bad model name' }], now));
  const enriched = mergeDeviceUsage(first.store, 'mac', [{ ...event, model: 'gpt-6-astra' }], now);
  assert.equal(enriched.accepted, 0);
  assert.equal(enriched.store.samples[0].model, 'gpt-6-astra');
});
test('streaming attributes token deltas to the active turn model without retaining turn content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-model-test-'));
  try {
    const path = join(dir, 'rollout.jsonl');
    const context = (model) => ({ timestamp: new Date(now).toISOString(), type: 'turn_context', payload: { model, effort: 'high', secret: 'DO_NOT_STORE' } });
    await writeFile(path, [context('gpt-6-astra'), record(100), context('gpt-5.6-sol'), record(160, 60)].map(value => JSON.stringify(value)).join('\n') + '\n');
    const result = await scanFile(path, {}, now);
    assert.deepEqual(result.events.map((event) => [event.tokens, event.model]), [[100, 'gpt-6-astra'], [60, 'gpt-5.6-sol']]);
    assert.ok(!JSON.stringify(result).includes('DO_NOT_STORE'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('streaming supports partial lines, appends, truncation and retries after lost acknowledgement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-test-'));
  try {
    const logs = join(dir, 'sessions');
    await mkdir(logs);
    const file = join(logs, 'rollout.jsonl');
    await writeFile(file, JSON.stringify(record(100)) + '\n' + JSON.stringify(record(150, 50)).slice(0, 40));
    const first = await scanFile(file);
    assert.equal(first.events.length, 1);
    await appendFile(file, JSON.stringify(record(150, 50)).slice(40) + '\n');
    const second = await scanFile(file, first.cursor);
    assert.equal(second.events[0].tokens, 50);
    assert.equal((await scanFile(file, second.cursor)).events.length, 0);
    let store: DeviceUsageStore = {}, calls = 0;
    const post = async events => {
      store = mergeDeviceUsage(store, 'mac', events).store;
      if (++calls === 1) throw new Error('response lost after durable write');
    };
    await assert.rejects(collectOnce(dir, post, dir));
    await collectOnce(dir, post, dir);
    await collectOnce(dir, post, dir);
    assert.equal(store.samples.reduce((s, e) => s + e.tokens, 0), 150);
    await mkdir(join(dir, 'archived_sessions'));
    await writeFile(join(dir, 'archived_sessions', 'copy.jsonl'), await readFile(file));
    await collectOnce(dir, post, dir);
    assert.equal(store.samples.length, 2);
    await writeFile(file, JSON.stringify(record(10)) + '\n');
    await collectOnce(dir, post, dir);
    assert.equal(store.samples.reduce((s, e) => s + e.tokens, 0), 160);
    assert.ok(!JSON.stringify(store).includes('payload'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('very large conversation lines cannot stall the incremental cursor or leak content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-large-test-'));
  try {
    const path = join(dir, 'rollout.jsonl');
    await writeFile(path, 'x'.repeat(9 * 1024 * 1024) + '\n' + JSON.stringify(record(50)) + '\n');
    const first = await scanFile(path);
    assert.equal(first.events.length, 0);
    assert.equal(first.backlog, true);
    assert.ok(first.cursor.offset > 0);
    const second = await scanFile(path, first.cursor);
    assert.equal(second.events[0].tokens, 50);
    assert.equal(second.backlog, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
