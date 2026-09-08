import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('authenticated device API persists, deduplicates concurrent uploads and aggregates event time', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-api-test-'));
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('probe did not expose a TCP port');
  const port = address.port;
  await new Promise(ok => probe.close(ok));
  const token = 'test-device-token';
  await writeFile(join(dir, 'devices.json'), JSON.stringify([{ id: 'test-mac', name: 'Test', platform: 'mac', tokenHash: createHash('sha256').update(token).digest('hex') }]));
  const server = spawn(process.execPath, ['--experimental-strip-types', 'local/server.ts'], { env: { ...process.env, NODE_ENV: 'test', ACCOUNT_MANAGER_DATA_DIR: dir,
    ACCOUNT_MANAGER_PORT: String(port), ADMIN_PASSWORD: 'test-password', SESSION_SECRET: 'test-session-secret-only-32-characters' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await Promise.race([once(server.stdout, 'data'), once(server, 'exit').then(() => { throw new Error('Server failed to start'); }),
      new Promise((_, fail) => { const timer = setTimeout(() => fail(new Error('Server startup timeout')), 5000); timer.unref(); })]);
    const base = `http://127.0.0.1:${port}`;
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Switcher-Version': '1.8.0' };
    const timestamp = Math.floor(Date.now() / 1000) - 3600;
    const event = { id: 'a'.repeat(64), timestamp, tokens: 1234, model: 'gpt-6-astra' };
    assert.equal((await fetch(base + '/api/device/usage', { method: 'POST', body: '{}' })).status, 401);
    const responses = await Promise.all([1, 2].map(() => fetch(base + '/api/device/usage', { method: 'POST', headers, body: JSON.stringify({ events: [event] }) })));
    assert.ok(responses.every(response => response.status === 200));
    const responseBodies = await Promise.all(responses.map(response => response.json())) as Array<{ accepted: number }>;
    assert.equal(responseBodies.reduce((s, r) => s + r.accepted, 0), 1);
    const login = await fetch(base + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-password' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    const timeline = await (await fetch(base + '/api/usage-timeline', { headers: { cookie } })).json() as {
      totalTokens24h: number;
      buckets: Array<{ timestamp: number; tokens: number }>;
      deviceBuckets: Array<{ deviceId: string }>;
      modelTotals: Array<{ model: string; tokens: number }>;
      reports: Record<string, { updatedAt: string }>;
      source: string;
    };
    assert.equal(timeline.totalTokens24h, 1234);
    assert.equal(timeline.buckets.find(bucket => bucket.tokens)?.timestamp, Math.floor(timestamp / 1800) * 1800);
    assert.equal(timeline.deviceBuckets[0].deviceId, 'test-mac');
    assert.deepEqual(timeline.modelTotals, [{ model: 'gpt-6-astra', tokens: 1234 }]);
    assert.ok(timeline.reports['test-mac'].updatedAt);
    assert.equal(timeline.source, 'device-logs');
    const persisted = JSON.parse(await readFile(join(dir, 'device-usage.json'), 'utf8'));
    assert.equal(persisted.samples.length, 1);
    assert.equal(persisted.samples[0].model, 'gpt-6-astra');
    assert.equal((await fetch(base + '/api/device/usage', { method: 'POST', headers, body: JSON.stringify({ events: [{ ...event, tokens: -1 }] }) })).status, 400);
  } finally {
    const stopped = once(server, 'exit');
    server.kill('SIGTERM');
    await stopped;
    await rm(dir, { recursive: true, force: true });
  }
});
