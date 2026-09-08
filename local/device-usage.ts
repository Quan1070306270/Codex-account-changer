// Only allowlisted usage metrics are persisted; never store rollout content.
export const RETENTION_SECONDS = 14 * 86400;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

export type DeviceUsageSample = {
  id: string;
  timestamp: number;
  tokens: number;
  deviceId: string;
  model: string | null;
};

export type DeviceUsageStore = {
  version?: number;
  establishedAt?: string;
  updatedAt?: string;
  samples?: DeviceUsageSample[];
  reports?: Record<string, { updatedAt: string }>;
};

export type IncomingUsageSample = Omit<DeviceUsageSample, "deviceId" | "model"> & {
  model?: string | null;
  [key: string]: unknown;
};

export function mergeDeviceUsage(
  store: DeviceUsageStore,
  deviceId: string,
  events: IncomingUsageSample[],
  now = Date.now(),
) {
  if (!Array.isArray(events) || events.length > 250) throw new Error("用量批次无效");
  const seconds = Math.floor(now / 1000);
  const clean = events.map(event => {
    if (!event || !/^[a-f0-9]{64}$/.test(event.id) ||
        !Number.isSafeInteger(event.timestamp) || !Number.isSafeInteger(event.tokens) ||
        event.tokens <= 0 || event.tokens > 1e9 || event.timestamp > seconds + 300 ||
        (event.model != null && (typeof event.model !== 'string' || !MODEL_PATTERN.test(event.model)))) {
      throw new Error("用量记录格式无效");
    }
    return { id: event.id, timestamp: event.timestamp, tokens: event.tokens, deviceId, model: event.model || null };
  });
  const samples = (store.samples || []).filter(event => event.timestamp >= seconds - RETENTION_SECONDS);
  const ids = new Map(samples.map(event => [event.id, event]));
  let accepted = 0;
  for (const event of clean) {
    if (event.timestamp < seconds - RETENTION_SECONDS) continue;
    const existing = ids.get(event.id);
    if (existing) {
      // A v1 collector may already have uploaded this exact usage sample. The
      // v2 replay safely fills only its previously missing model attribution.
      if (!existing.model && event.model) existing.model = event.model;
      continue;
    }
    ids.set(event.id, event);
    samples.push(event);
    accepted++;
  }
  return {
    store: { version: 2, establishedAt: store.establishedAt || new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(), samples,
      reports: { ...store.reports, [deviceId]: { updatedAt: new Date(now).toISOString() } } },
    accepted,
  };
}
