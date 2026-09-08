import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, rename, mkdir, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const KEEP_SECONDS = 14 * 86400;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

type TokenUsageRecord = {
  [key: string]: unknown;
  type?: string;
  timestamp?: string;
  payload?: {
    [key: string]: unknown;
    type?: string;
    model?: unknown;
    info?: {
      total_token_usage?: {
        total_tokens?: number;
        input_tokens?: number;
        output_tokens?: number;
        cached_input_tokens?: number;
      };
      last_token_usage?: { total_tokens?: number };
    };
  };
};

export type CollectedUsageEvent = {
  id: string;
  timestamp: number;
  tokens: number;
  model: string | null;
};

type UsageCursor = {
  identity?: string;
  offset?: number;
  previous?: number | null;
  model?: string | null;
  discarding?: boolean;
};

type CollectorState = { version: number; files: Record<string, UsageCursor> };
type CollectorConfig = { serverUrl?: string; deviceToken?: string; installationId?: string };
type UsagePost = (events: CollectedUsageEvent[]) => Promise<void>;

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function usageEvent(record: TokenUsageRecord, previous: number | null, now = Date.now(), model: string | null = null) {
  if (record?.type !== 'event_msg' || record.payload?.type !== 'token_count') return { previous };
  const info = record.payload.info;
  const total = info?.total_token_usage?.total_tokens;
  if (!Number.isSafeInteger(total) || total < 0) return { previous };
  const last = info?.last_token_usage?.total_tokens;
  const tokens = previous != null && total >= previous ? total - previous : last;
  const timestamp = Math.floor(Date.parse(record.timestamp || '') / 1000);
  if (!Number.isSafeInteger(tokens) || tokens <= 0 || tokens > 1e9 ||
      !Number.isFinite(timestamp) || timestamp < now / 1000 - KEEP_SECONDS || timestamp > now / 1000 + 300) {
    return { previous: total };
  }
  // A copied/forked rollout contains the same timestamp and cumulative counters.
  // Exclude file/device identifiers so replay on another machine also deduplicates.
  const u = info.total_token_usage;
  const fingerprint = [record.timestamp, total, u.input_tokens, u.output_tokens, u.cached_input_tokens, last];
  return { previous: total, event: {
    id: createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex'), timestamp, tokens,
    model: typeof model === 'string' && MODEL_PATTERN.test(model) ? model : null,
  } };
}

async function load<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (isErrno(error, 'ENOENT') || error instanceof SyntaxError) return fallback; throw error; }
}
async function save(path: string, value: unknown) {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await rename(temp, path);
}
async function* logs(root: string): AsyncGenerator<string> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (isErrno(error, 'ENOENT')) return; throw error; }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* logs(path);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield path;
  }
}

// Bounded streaming reader. An unfinished final line is reread on the next pass.
export async function scanFile(path: string, saved: UsageCursor = {}, now = Date.now()) {
  const meta = await stat(path);
  const identity = `${meta.dev}:${meta.ino}`;
  const resume = saved.identity === identity && (saved.offset || 0) <= meta.size;
  let offset = resume ? saved.offset || 0 : 0;
  let previous = resume ? saved.previous : null;
  let model = resume && typeof saved.model === 'string' && MODEL_PATTERN.test(saved.model) ? saved.model : null;
  if (offset === meta.size) return { cursor: { identity, offset, previous, model, discarding: !!saved.discarding }, events: [] };
  let pending = Buffer.alloc(0), skipped = 0, discarding = resume && saved.discarding;
  const events: CollectedUsageEvent[] = [];
  const stream = createReadStream(path, { start: offset, end: Math.min(meta.size, offset + 8 * 1024 * 1024) - 1, highWaterMark: 65536 });
  for await (const chunk of stream) {
    pending = Buffer.concat([pending, chunk]);
    let end;
    while ((end = pending.indexOf(10)) >= 0) {
      const line = pending.subarray(0, end);
      offset += skipped + end + 1;
      if (!skipped && !discarding && (line.includes(Buffer.from('"token_count"')) || line.includes(Buffer.from('"turn_context"')))) {
        try {
          const record = JSON.parse(line.toString('utf8')) as TokenUsageRecord;
          if (record?.type === 'turn_context') {
            const nextModel = record.payload?.model;
            model = typeof nextModel === 'string' && MODEL_PATTERN.test(nextModel) ? nextModel : null;
          } else {
            const result = usageEvent(record, previous, now, model);
            previous = result.previous;
            if (result.event) events.push(result.event);
          }
        } catch { /* malformed completed JSON line, not conversation content */ }
      }
      skipped = 0;
      discarding = false;
      pending = pending.subarray(end + 1);
    }
    if (pending.length > 1024 * 1024) { skipped += pending.length; pending = Buffer.alloc(0); }
  }
  if (skipped || discarding) {
    offset += skipped + pending.length;
    pending = Buffer.alloc(0);
    discarding = true;
  }
  return { cursor: { identity, offset, previous, model, discarding: !!discarding }, events, backlog: offset + pending.length < meta.size };
}

export async function collectOnce(supportDir: string, post: UsagePost, codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')) {
  const path = join(supportDir, 'usage-cursors.json');
  let state = await load<CollectorState>(path, { version: 2, files: {} });
  // Version 2 rescans the bounded 14-day window once so earlier samples can be
  // enriched with the model from their surrounding turn_context records.
  if (state.version !== 2) state = { version: 2, files: {} };
  let uploaded = 0, backlog = false;
  for (const root of ['sessions', 'archived_sessions']) {
    for await (const file of logs(join(codexHome, root))) {
      let meta;
      try { meta = await stat(file); } catch (error) { if (isErrno(error, 'ENOENT')) continue; throw error; }
      if (meta.mtimeMs < Date.now() - KEEP_SECONDS * 1000) { delete state.files[file]; continue; }
      const result = await scanFile(file, state.files[file]);
      for (let index = 0; index < result.events.length; index += 250) {
        await post(result.events.slice(index, index + 250));
        uploaded += Math.min(250, result.events.length - index);
      }
      // Advance only AFTER durable acknowledgement. A crash replays safely.
      state.files[file] = result.cursor;
      await save(path, state);
      backlog ||= result.backlog;
    }
  }
  await post([]); // successful empty scan is still a useful freshness heartbeat
  await save(join(supportDir, 'usage-status.json'), { updatedAt: new Date().toISOString(), uploaded, backlog });
  return { uploaded, backlog };
}

async function main() {
  const supportDir = resolve(process.argv[2]);
  const parent = Number(process.argv[3]);
  await mkdir(supportDir, { recursive: true, mode: 0o700 });
  // Parent lifetime plus a local TCP lock prevents duplicate collectors on reinstall.
  const { createServer } = await import('node:net');
  const lock = createServer();
  const port = 42000 + parseInt(createHash('sha256').update(supportDir).digest('hex').slice(0, 4), 16) % 15000;
  try { await new Promise<void>((ok, fail) => { lock.once('error', fail); lock.listen(port, '127.0.0.1', () => ok()); }); }
  catch (error) { if (isErrno(error, 'EADDRINUSE')) return; throw error; }
  const parentTimer = setInterval(() => {
    if (parent) { try { process.kill(parent, 0); } catch { process.exit(0); } }
  }, 5000);
  try {
    while (true) {
      let delay = 60000;
      try {
        const config = await load<CollectorConfig | null>(join(supportDir, 'config.json'), null);
        if (!config?.serverUrl || !config.deviceToken) throw new Error('Configuration unavailable');
        const url = new URL('/api/device/usage', config.serverUrl);
        if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('HTTPS required');
        const post: UsagePost = async events => {
          const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.deviceToken}`,
              'X-Device-Installation-Id': config.installationId || '', 'X-Switcher-Version': '1.8.0' }, body: JSON.stringify({ events }) });
          if (!response.ok) throw new Error(`Usage upload HTTP ${response.status}`);
          const result = await response.json() as { ok?: boolean };
          if (result.ok !== true) throw new Error('Usage upload was not acknowledged');
        };
        const result = await collectOnce(supportDir, post);
        if (result.backlog) delay = 1000;
      } catch (error) {
        // Do not log request headers, config, or any rollout lines.
        const message = error instanceof Error ? error.message : String(error);
        await save(join(supportDir, 'usage-status.json'), { failedAt: new Date().toISOString(), error: message.slice(0, 180) }).catch(() => {});
      }
      await new Promise(ok => setTimeout(ok, delay));
    }
  } finally { clearInterval(parentTimer); lock.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { process.exitCode = 1; });
}
