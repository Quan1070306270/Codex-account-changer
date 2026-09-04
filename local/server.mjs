import { createServer } from "node:http";
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexClient } from "./codex-client.mjs";

const localDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(localDirectory, "..");
const dataRoot = resolve(
  process.env.ACCOUNT_MANAGER_DATA_DIR || join(projectRoot, ".server-data"),
);
const accountRoot = join(dataRoot, "accounts");
const deviceAuthRoot = join(dataRoot, "device-auth");
const registryPath = join(dataRoot, "accounts.json");
const settingsPath = join(dataRoot, "settings.json");
const devicesPath = join(dataRoot, "devices.json");
const commandsPath = join(dataRoot, "commands.json");
const switchHistoryPath = join(dataRoot, "switch-history.json");
const downloadFiles = new Map([
  ["install-mac.sh", join(projectRoot, "mac", "install-mac.sh")],
  ["mac-agent.sh", join(projectRoot, "mac", "mac-agent.sh")],
  ["apply-switch.sh", join(projectRoot, "mac", "apply-switch.sh")],
  ["uninstall-mac.sh", join(projectRoot, "mac", "uninstall-mac.sh")],
  ["install-windows.ps1", join(projectRoot, "windows", "install-windows.ps1")],
  ["windows-agent.ps1", join(projectRoot, "windows", "windows-agent.ps1")],
  ["apply-switch-windows.ps1", join(projectRoot, "windows", "apply-switch.ps1")],
  ["uninstall-windows.ps1", join(projectRoot, "windows", "uninstall-windows.ps1")],
]);
const legacyDataRoot = join(projectRoot, ".local", "codex-accounts");
const port = Number(process.env.ACCOUNT_MANAGER_PORT || 3210);
const host = process.env.ACCOUNT_MANAGER_HOST || "127.0.0.1";
const production = process.env.NODE_ENV === "production";
const adminPassword = process.env.ADMIN_PASSWORD || (production ? "" : "1110");
const sessionSecret = process.env.SESSION_SECRET || (production ? "" : "local-development-session-secret-change-me");
const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const refreshIntervalMs = Math.max(60_000, Number(process.env.USAGE_REFRESH_INTERVAL_MS || 600_000));
const sessionCookieName = "gpt_accounts_session";
const pendingLogins = new Map();
const pairingCodes = new Map();
const loginAttempts = new Map();
const storageLocks = new Map();
let refreshing = false;
let lastRefreshAt = null;
let nextRefreshAt = new Date(Date.now() + refreshIntervalMs).toISOString();

if (!adminPassword || !sessionSecret || sessionSecret.length < 24) {
  throw new Error("生产环境必须配置 ADMIN_PASSWORD 和至少 24 个字符的 SESSION_SECRET");
}

async function ensureDataRoot() {
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await mkdir(accountRoot, { recursive: true, mode: 0o700 });
  await mkdir(deviceAuthRoot, { recursive: true, mode: 0o700 });
}

async function migrateLegacyData() {
  if (process.env.ACCOUNT_MANAGER_DATA_DIR || legacyDataRoot === dataRoot) return;
  try {
    await stat(registryPath);
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  let legacyAccounts;
  try {
    legacyAccounts = JSON.parse(await readFile(join(legacyDataRoot, "accounts.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  await ensureDataRoot();
  const migrated = [];
  for (const account of Array.isArray(legacyAccounts) ? legacyAccounts : []) {
    if (!/^[0-9a-f-]+$/i.test(String(account.id || ""))) continue;
    const destination = await prepareAccountHome(account.id);
    try {
      await copyFile(join(legacyDataRoot, account.id, "auth.json"), join(destination, "auth.json"));
      await chmod(join(destination, "auth.json"), 0o600);
      migrated.push(account);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (migrated.length) {
    await writeJson(registryPath, migrated);
    process.stdout.write(`已迁移 ${migrated.length} 个旧版账号到新数据目录。\n`);
  }
}

async function readJson(path, fallback) {
  await ensureDataRoot();
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(path, value) {
  await ensureDataRoot();
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function withStorageLock(name, operation) {
  const previous = storageLocks.get(name) || Promise.resolve();
  let release;
  const current = new Promise((resolveLock) => { release = resolveLock; });
  storageLocks.set(name, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (storageLocks.get(name) === current) storageLocks.delete(name);
  }
}

const readRegistry = () => readJson(registryPath, []);
const writeRegistry = (value) => writeJson(registryPath, value);
const readSettings = () => readJson(settingsPath, { activeAccountId: null });
const writeSettings = (value) => writeJson(settingsPath, value);
const readDevices = () => readJson(devicesPath, []);
const writeDevices = (value) => writeJson(devicesPath, value);
const readCommands = () => readJson(commandsPath, []);
const writeCommands = (value) => writeJson(commandsPath, value.slice(-500));
const readSwitchHistory = () => readJson(switchHistoryPath, []);
const writeSwitchHistory = (value) => writeJson(switchHistoryPath, value.slice(-300));
const accountHome = (id) => join(accountRoot, id);

async function prepareAccountHome(id) {
  const home = accountHome(id);
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(join(home, "config.toml"), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
  return home;
}

function safeAccount(account, activeAccountId) {
  return {
    id: account.id,
    email: account.email,
    note: account.note ?? "",
    planType: account.planType,
    createdAt: account.createdAt,
    lastSyncedAt: account.lastSyncedAt,
    rateLimits: account.rateLimits ?? null,
    usage: account.usage ?? null,
    availableModels: account.availableModels ?? [],
    syncError: account.syncError ?? null,
    isActive: account.id === activeAccountId,
  };
}

function deviceDisplayName(device) {
  return device.customName || device.name;
}

function isDeviceOnline(device) {
  const lastSeenMs = device.lastSeenAt ? new Date(device.lastSeenAt).getTime() : 0;
  return lastSeenMs > 0 && Date.now() - lastSeenMs < 20_000;
}

function safeDevice(device) {
  return {
    id: device.id,
    name: deviceDisplayName(device),
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt ?? null,
    activeAccountId: device.activeAccountId ?? null,
    activeAccountEmail: device.activeAccountEmail ?? null,
    lastError: device.lastError ?? null,
    agentVersion: device.agentVersion ?? null,
    codexAuthState: device.codexAuthState ?? null,
    platform: device.platform === "windows" ? "windows" : "mac",
    isOnline: isDeviceOnline(device),
  };
}

async function snapshotFromClient(client, id, createdAt = new Date().toISOString(), metadata = {}) {
  try {
    await readFile(join(accountHome(id), "auth.json"), "utf8");
  } catch (error) {
    if (error.code === "EACCES") throw new Error("服务器无法读取账号登录凭据，请检查数据目录权限");
    if (error.code === "ENOENT") throw new Error("账号登录凭据不存在，请重新添加该账号");
    throw error;
  }
  let accountResponse = await client.request("account/read", { refreshToken: false }, 45_000);
  let account = accountResponse?.account;
  if (!account || account.type !== "chatgpt") {
    accountResponse = await client.request("account/read", { refreshToken: true }, 45_000);
    account = accountResponse?.account;
  }
  if (!account || account.type !== "chatgpt") throw new Error("未找到有效的 ChatGPT 登录账号");
  const [rateLimitResult, usageResult, modelResult] = await Promise.allSettled([
    client.request("account/rateLimits/read", null, 45_000),
    client.request("account/usage/read", null, 45_000),
    client.request("model/list", { includeHidden: false }, 45_000),
  ]);
  const availableModels = modelResult.status === "fulfilled"
    ? (modelResult.value?.data ?? []).map((model) => model.id).filter(Boolean)
    : [];
  return {
    id,
    email: account.email || "ChatGPT 账号",
    note: String(metadata.note || "").slice(0, 40),
    planType: account.planType || "unknown",
    createdAt,
    lastSyncedAt: new Date().toISOString(),
    rateLimits: rateLimitResult.status === "fulfilled" ? rateLimitResult.value : null,
    usage: usageResult.status === "fulfilled" ? usageResult.value : null,
    availableModels,
    syncError:
      rateLimitResult.status === "rejected" && usageResult.status === "rejected"
        ? "暂时无法读取账号用量"
        : null,
  };
}

function defaultModelForAccount(account) {
  const availableModels = Array.isArray(account.availableModels) ? account.availableModels : [];
  if (availableModels.includes("gpt-5.6-sol")) return "gpt-5.6-sol";
  if (availableModels.includes("gpt-5.6-terra")) return "gpt-5.6-terra";
  return account.planType === "free" ? "gpt-5.6-terra" : "gpt-5.6-sol";
}

const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

async function snapshotFromFreshClient(id, createdAt) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt) await wait(500 * attempt);
    const client = new CodexClient({ codexHome: accountHome(id), cwd: projectRoot });
    try {
      await client.start();
      return await snapshotFromClient(client, id, createdAt);
    } catch (error) {
      lastError = error;
    } finally {
      client.close();
    }
  }
  throw lastError || new Error("未找到有效的 ChatGPT 登录账号");
}

async function recoverAuthenticatedAccounts() {
  const registered = new Set((await readRegistry()).map((account) => account.id));
  const entries = await readdir(accountRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || registered.has(entry.name)) continue;
    try {
      await stat(join(accountHome(entry.name), "auth.json"));
      await upsertAccount(await snapshotFromFreshClient(entry.name));
      process.stdout.write(`已找回一个完成验证的 ChatGPT 账号。\n`);
    } catch (error) {
      if (error.code !== "ENOENT") process.stderr.write(`找回登录账号失败：${error.message}\n`);
    }
  }
}

async function upsertAccount(account) {
  return withStorageLock("accounts", async () => {
    const accounts = await readRegistry();
    const duplicateIndex = accounts.findIndex((item) => item.email === account.email && item.id !== account.id);
    if (duplicateIndex >= 0) {
      const duplicate = accounts[duplicateIndex];
      if (!account.note && duplicate.note) account.note = duplicate.note;
      accounts.splice(duplicateIndex, 1);
      await rm(accountHome(duplicate.id), { recursive: true, force: true });
    }
    const index = accounts.findIndex((item) => item.id === account.id);
    if (index >= 0) accounts[index] = { ...account, note: account.note ?? accounts[index].note ?? "" };
    else accounts.unshift(account);
    await writeRegistry(accounts);
    return account;
  });
}

async function refreshAccount(id) {
  const accounts = await readRegistry();
  const existing = accounts.find((account) => account.id === id);
  if (!existing) throw httpError(404, "账号不存在");
  const client = new CodexClient({ codexHome: accountHome(id), cwd: projectRoot });
  try {
    await client.start();
    return await upsertAccount(await snapshotFromClient(client, id, existing.createdAt, { note: existing.note }));
  } catch (error) {
    const updated = {
      ...existing,
      lastSyncedAt: new Date().toISOString(),
      syncError: error.message || "刷新失败",
    };
    await upsertAccount(updated);
    throw error;
  } finally {
    client.close();
  }
}

async function refreshAllAccounts() {
  if (refreshing) return;
  refreshing = true;
  try {
    const accounts = await readRegistry();
    for (const account of accounts) {
      try {
        await refreshAccount(account.id);
      } catch (error) {
        process.stderr.write(`刷新 ${account.email} 失败：${error.message}\n`);
      }
    }
    lastRefreshAt = new Date().toISOString();
  } finally {
    refreshing = false;
    nextRefreshAt = new Date(Date.now() + refreshIntervalMs).toISOString();
  }
}

async function startLogin() {
  const id = randomUUID();
  const client = new CodexClient({ codexHome: await prepareAccountHome(id), cwd: projectRoot });
  const pending = { status: "starting", error: null, client, createdAt: Date.now() };
  pendingLogins.set(id, pending);
  client.onNotification((method, params) => {
    if (method !== "account/login/completed") return;
    if (params?.success) {
      if (pending.finalizing) return;
      pending.finalizing = true;
      pending.status = "syncing";
      client.close();
      void snapshotFromFreshClient(id)
        .then(upsertAccount)
        .then(() => {
          pending.status = "complete";
        })
        .catch((error) => {
          pending.status = "error";
          pending.error = error.message;
        })
        .finally(() => {
          pending.finalizing = false;
        });
    } else {
      pending.status = "error";
      pending.error = params?.error || "ChatGPT 登录未完成";
      client.close();
    }
  });
  await client.start();
  const result = await client.request("account/login/start", { type: "chatgptDeviceCode" }, 45_000);
  pending.status = "waiting";
  pending.userCode = result.userCode;
  return { id, authUrl: result.verificationUrl, userCode: result.userCode };
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function makeSession() {
  const payload = base64url(JSON.stringify({ exp: Date.now() + 7 * 24 * 60 * 60 * 1000 }));
  const signature = createHmac("sha256", sessionSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function validSession(value) {
  if (!value) return false;
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return false;
  const expected = createHmac("sha256", sessionSecret).update(payload).digest("base64url");
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).exp > Date.now();
  } catch {
    return false;
  }
}

function cookieValue(request, name) {
  const cookies = String(request.headers.cookie || "").split(";");
  for (const cookie of cookies) {
    const [key, ...parts] = cookie.trim().split("=");
    if (key === name) return decodeURIComponent(parts.join("="));
  }
  return null;
}

function passwordMatches(candidate) {
  const left = Buffer.from(hash(candidate));
  const right = Buffer.from(hash(adminPassword));
  return left.length === right.length && timingSafeEqual(left, right);
}

function requestIp(request) {
  return String(request.headers["x-forwarded-for"] || request.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function checkLoginRateLimit(request) {
  const ip = requestIp(request);
  const now = Date.now();
  const attempts = (loginAttempts.get(ip) || []).filter((time) => now - time < 15 * 60_000);
  if (attempts.length >= 8) throw httpError(429, "登录尝试过多，请 15 分钟后再试");
  attempts.push(now);
  loginAttempts.set(ip, attempts);
}

function clearLoginRateLimit(request) {
  loginAttempts.delete(requestIp(request));
}

function isAdmin(request) {
  return validSession(cookieValue(request, sessionCookieName));
}

function requireAdmin(request) {
  if (!isAdmin(request)) throw httpError(401, "请先登录");
}

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

async function readBody(request, limit = 64 * 1024) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > limit) throw httpError(413, "请求内容过大");
  }
  const contentType = String(request.headers["content-type"] || "");
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(body));
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw httpError(400, "请求内容不是有效 JSON");
  }
}

function corsHeaders(request) {
  const origin = String(request.headers.origin || "");
  const allowed = !origin || /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin) || origin === publicBaseUrl;
  return allowed && origin
    ? {
      "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
        Vary: "Origin",
      }
    : {};
}

function json(request, response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...corsHeaders(request),
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

function noContent(request, response) {
  response.writeHead(204, { "Cache-Control": "no-store", ...corsHeaders(request) });
  response.end();
}

function resolvePublicUrl(request) {
  if (publicBaseUrl) return publicBaseUrl;
  const protocol = String(request.headers["x-forwarded-proto"] || "http").split(",")[0];
  return `${protocol}://${request.headers.host}`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function powershellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function createPairingCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let value = "";
  for (const byte of randomBytes(10)) value += alphabet[byte % alphabet.length];
  return `${value.slice(0, 5)}-${value.slice(5)}`;
}

function normalizeInstallationId(value) {
  const installationId = String(value || "").trim().slice(0, 128);
  return /^[a-zA-Z0-9._-]{8,128}$/.test(installationId) ? installationId : null;
}

async function registerDevice(code, name, installationIdValue) {
  const pairing = pairingCodes.get(String(code || "").toUpperCase());
  if (!pairing || pairing.expiresAt < Date.now()) throw httpError(400, "配对码无效或已过期");
  const installationId = normalizeInstallationId(installationIdValue);
  if (pairing.registeredResponse) {
    if ((pairing.installationId || null) !== installationId) throw httpError(400, "配对码已被另一台设备使用");
    return { ...pairing.registeredResponse, reused: true };
  }
  const token = `device_${randomBytes(32).toString("base64url")}`;
  const device = await withStorageLock("devices", async () => {
    const devices = await readDevices();
    const existingIndex = installationId ? devices.findIndex((item) => item.installationId === installationId) : -1;
    const legacyIndex = existingIndex < 0 ? devices.findIndex((item) => (
      !item.installationId &&
      item.platform === (pairing.platform === "windows" ? "windows" : "mac") &&
      item.name === String(name || "").slice(0, 80)
    )) : -1;
    const matchingIndex = existingIndex >= 0 ? existingIndex : legacyIndex;
    const nextDevice = matchingIndex >= 0 ? {
      ...devices[matchingIndex],
      name: String(name || devices[matchingIndex].name).slice(0, 80),
      platform: pairing.platform === "windows" ? "windows" : "mac",
      tokenHash: hash(token),
      installationId,
      lastError: null,
    } : {
      id: randomUUID(),
      name: String(name || (pairing.platform === "windows" ? "Windows PC" : "Mac")).slice(0, 80),
      platform: pairing.platform === "windows" ? "windows" : "mac",
      tokenHash: hash(token),
      installationId,
      createdAt: new Date().toISOString(),
      lastSeenAt: null,
      activeAccountId: null,
      activeAccountEmail: null,
      lastError: null,
    };
    if (matchingIndex >= 0) devices[matchingIndex] = nextDevice;
    else devices.push(nextDevice);
    await writeDevices(devices);
    return nextDevice;
  });
  const registeredResponse = { deviceId: device.id, token, installationId };
  pairing.installationId = installationId;
  pairing.registeredResponse = registeredResponse;
  return registeredResponse;
}

async function authenticateDevice(request) {
  const authorization = String(request.headers.authorization || "");
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) throw httpError(401, "设备令牌缺失");
  const reportedOpenAiAccountId = String(request.headers["x-codex-active-account"] || "").trim();
  let reportedAccount = null;
  let reportedAuthState = null;
  if (reportedOpenAiAccountId) {
    if (reportedOpenAiAccountId === "signed-out") {
      reportedAuthState = "signed-out";
    } else if (/^[A-Za-z0-9._:-]{1,200}$/.test(reportedOpenAiAccountId)) {
      const accounts = await readRegistry();
      for (const account of accounts) {
        try {
          const auth = await globalAccountAuth(account.id);
          if (auth.parsed.tokens.account_id === reportedOpenAiAccountId) {
            reportedAccount = account;
            reportedAuthState = "signed-in";
            break;
          }
        } catch { }
      }
      if (!reportedAuthState) reportedAuthState = "unknown-account";
    }
  }
  return withStorageLock("devices", async () => {
    const devices = await readDevices();
    const index = devices.findIndex((device) => device.tokenHash === hash(token));
    if (index < 0) throw httpError(401, "设备令牌无效");
    const installationId = normalizeInstallationId(request.headers["x-device-installation-id"]);
    if (installationId) devices[index].installationId = installationId;
    devices[index].lastSeenAt = new Date().toISOString();
    const reportedVersion = String(request.headers["x-switcher-version"] || "unknown").slice(0, 30);
    if (devices[index].agentVersion && devices[index].agentVersion !== reportedVersion) {
      devices[index].lastError = null;
    }
    devices[index].agentVersion = reportedVersion;
    if (reportedAuthState) {
      devices[index].codexAuthState = reportedAuthState;
      devices[index].activeAccountId = reportedAccount?.id ?? null;
      devices[index].activeAccountEmail = reportedAccount?.email ?? null;
    }
    await writeDevices(devices);
    return { ...devices[index] };
  });
}

async function enqueueSwitch(accountId, targetDeviceId = null, force = false) {
  const accounts = await readRegistry();
  const account = accounts.find((item) => item.id === accountId);
  if (!account) throw httpError(404, "账号不存在");
  const allDevices = await readDevices();
  const devices = targetDeviceId
    ? allDevices.filter((device) => device.id === targetDeviceId)
    : allDevices;
  if (targetDeviceId && devices.length === 0) throw httpError(404, "目标设备不存在");
  const now = new Date().toISOString();
  const availableAt = new Date(Date.now() + 1_500).toISOString();
  const switchId = randomUUID();
  const commandPlan = await withStorageLock("commands", async () => {
    const commands = await readCommands();
    const queuedDevices = [];
    const deduplicatedDevices = [];
    for (const device of devices) {
      const outstanding = commands.filter((item) => item.deviceId === device.id && ["pending", "delivered"].includes(item.status));
      if (outstanding.some((item) => item.accountId === accountId)) {
        for (const pending of outstanding.filter((item) => item.accountId !== accountId)) {
          pending.status = "superseded";
          pending.completedAt = now;
        }
        deduplicatedDevices.push(device);
        continue;
      }
      const recentSameAccount = [...commands].reverse().find((item) => (
        item.deviceId === device.id &&
        item.accountId === accountId &&
        item.status === "complete" &&
        Date.now() - new Date(item.completedAt || item.createdAt).getTime() < 90_000
      ));
      if (!force && outstanding.length === 0 && recentSameAccount && device.activeAccountId === accountId && isDeviceOnline(device)) {
        deduplicatedDevices.push(device);
        continue;
      }
      for (const pending of outstanding) {
        pending.status = "superseded";
        pending.completedAt = now;
      }
      commands.push({
        id: randomUUID(),
        switchId,
        deviceId: device.id,
        accountId,
        status: "pending",
        createdAt: now,
        availableAt,
        deliveredAt: null,
        completedAt: null,
        error: null,
      });
      queuedDevices.push(device);
    }
    await writeCommands(commands);
    return { queuedDevices, deduplicatedDevices };
  });
  if (commandPlan.queuedDevices.length) {
    await withStorageLock("switch-history", async () => {
      const history = await readSwitchHistory();
      history.push({
        id: switchId,
        accountId,
        accountEmail: account.email,
        accountNote: account.note || "",
        createdAt: now,
        deviceIds: commandPlan.queuedDevices.map((device) => device.id),
        deviceNames: commandPlan.queuedDevices.map(deviceDisplayName),
      });
      await writeSwitchHistory(history);
    });
  }
  if (!targetDeviceId) await writeSettings({ activeAccountId: accountId, updatedAt: now });
  return {
    account,
    deviceCount: devices.length,
    enqueuedCount: commandPlan.queuedDevices.length,
    deduplicatedCount: commandPlan.deduplicatedDevices.length,
    switchId,
    targeted: Boolean(targetDeviceId),
  };
}

async function safeSwitchHistory() {
  const [history, commands, devices, accounts] = await Promise.all([
    readSwitchHistory(),
    readCommands(),
    readDevices(),
    readRegistry(),
  ]);
  const deviceById = new Map(devices.map((device) => [device.id, device]));
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const legacyBySwitch = new Map();
  for (const command of commands.filter((item) => !item.switchId)) {
    const key = `${command.accountId}:${command.createdAt}`;
    const existing = legacyBySwitch.get(key) || {
      id: `legacy-${key}`,
      accountId: command.accountId,
      accountEmail: accountById.get(command.accountId)?.email || "已删除账号",
      accountNote: accountById.get(command.accountId)?.note || "",
      createdAt: command.createdAt,
      deviceIds: [],
      deviceNames: [],
      legacyCommands: [],
    };
    existing.deviceIds.push(command.deviceId);
    existing.deviceNames.push(deviceById.has(command.deviceId) ? deviceDisplayName(deviceById.get(command.deviceId)) : "已移除设备");
    existing.legacyCommands.push(command);
    legacyBySwitch.set(key, existing);
  }
  const entries = [...history, ...legacyBySwitch.values()]
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    .slice(0, 100);
  return entries.map((entry) => {
    const related = entry.legacyCommands || commands.filter((command) => command.switchId === entry.id);
    const completeCount = related.filter((command) => command.status === "complete").length;
    const failedCount = related.filter((command) => command.status === "failed").length;
    const pendingCount = related.filter((command) => ["pending", "delivered"].includes(command.status)).length;
    const supersededCount = related.filter((command) => command.status === "superseded").length;
    let status = "selected";
    if (related.length && pendingCount) status = "pending";
    else if (related.length && supersededCount === related.length) status = "superseded";
    else if (related.length && failedCount === related.length) status = "failed";
    else if (related.length && failedCount) status = "partial";
    else if (related.length && completeCount === related.length) status = "complete";
    const account = accountById.get(entry.accountId);
    return {
      id: entry.id,
      accountId: entry.accountId,
      accountEmail: account?.email || entry.accountEmail || "已删除账号",
      accountNote: account?.note || entry.accountNote || "",
      createdAt: entry.createdAt,
      status,
      devices: related.length
        ? related.map((command) => ({
            id: command.deviceId,
            name: deviceById.has(command.deviceId) ? deviceDisplayName(deviceById.get(command.deviceId)) : "已移除设备",
            status: command.status,
            error: command.error || null,
          }))
        : (entry.deviceIds || []).map((id, index) => ({
            id,
            name: deviceById.has(id) ? deviceDisplayName(deviceById.get(id)) : entry.deviceNames?.[index] || "已移除设备",
            status: "selected",
            error: null,
          })),
    };
  });
}

function parseChatGptAuth(raw, expectedOpenAiAccountId = null) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw httpError(400, "登录凭据不是有效 JSON");
  }
  if (parsed.auth_mode !== "chatgpt" || !parsed.tokens?.refresh_token || !parsed.tokens?.account_id) {
    throw httpError(409, "登录凭据不完整，请重新登录该账号");
  }
  if (expectedOpenAiAccountId && parsed.tokens.account_id !== expectedOpenAiAccountId) {
    throw httpError(409, "登录凭据与所选账号不匹配");
  }
  return parsed;
}

function authRefreshTimestamp(auth) {
  const timestamp = Date.parse(String(auth?.last_refresh || ""));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

async function globalAccountAuth(accountId) {
  const raw = await readFile(join(accountHome(accountId), "auth.json"), "utf8");
  return { raw, parsed: parseChatGptAuth(raw) };
}

function deviceAccountAuthPath(deviceId, accountId) {
  return join(deviceAuthRoot, deviceId, accountId, "auth.json");
}

async function saveDeviceAccountAuth(device, accountId, authBase64) {
  const accounts = await readRegistry();
  const account = accounts.find((item) => item.id === accountId);
  if (!account) throw httpError(404, "账号不存在");
  let raw;
  try {
    raw = Buffer.from(String(authBase64 || ""), "base64").toString("utf8");
  } catch {
    throw httpError(400, "登录凭据编码无效");
  }
  if (!raw || Buffer.byteLength(raw) > 48 * 1024) throw httpError(413, "登录凭据内容过大");
  const globalAuth = await globalAccountAuth(account.id);
  const parsed = parseChatGptAuth(raw, globalAuth.parsed.tokens.account_id);
  const path = deviceAccountAuthPath(device.id, account.id);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, raw, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
  if (authRefreshTimestamp(parsed) > authRefreshTimestamp(globalAuth.parsed)) {
    const globalPath = join(accountHome(account.id), "auth.json");
    const globalTemporary = `${globalPath}.${randomUUID()}.tmp`;
    await writeFile(globalTemporary, raw, { mode: 0o600 });
    await rename(globalTemporary, globalPath);
    await chmod(globalPath, 0o600);
  }
  await withStorageLock("devices", async () => {
    const devices = await readDevices();
    const index = devices.findIndex((item) => item.id === device.id);
    if (index >= 0) {
      devices[index].credentialAccountId = account.id;
      devices[index].credentialSyncedAt = new Date().toISOString();
      await writeDevices(devices);
    }
  });
}

async function accountAuthBase64(accountId, deviceId) {
  const globalAuth = await globalAccountAuth(accountId);
  let selectedRaw = globalAuth.raw;
  let selectedTimestamp = authRefreshTimestamp(globalAuth.parsed);
  const deviceIds = [];
  if (deviceId) deviceIds.push(deviceId);
  const deviceDirectories = await readdir(deviceAuthRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of deviceDirectories) {
    if (entry.isDirectory() && !deviceIds.includes(entry.name)) deviceIds.push(entry.name);
  }
  for (const candidateDeviceId of deviceIds) {
    try {
      const raw = await readFile(deviceAccountAuthPath(candidateDeviceId, accountId), "utf8");
      const parsed = parseChatGptAuth(raw, globalAuth.parsed.tokens.account_id);
      const deviceTimestamp = authRefreshTimestamp(parsed);
      if (deviceTimestamp > selectedTimestamp) {
        selectedRaw = raw;
        selectedTimestamp = deviceTimestamp;
      }
    } catch (error) {
      if (!["ENOENT", 400, 409].includes(error.code || error.statusCode)) throw error;
    }
  }
  if (selectedTimestamp > authRefreshTimestamp(globalAuth.parsed)) {
    const globalPath = join(accountHome(accountId), "auth.json");
    const globalTemporary = `${globalPath}.${randomUUID()}.tmp`;
    await writeFile(globalTemporary, selectedRaw, { mode: 0o600 });
    await rename(globalTemporary, globalPath);
    await chmod(globalPath, 0o600);
  }
  return Buffer.from(selectedRaw).toString("base64");
}

async function nextDeviceCommand(device) {
  const command = await withStorageLock("commands", async () => {
    const commands = await readCommands();
    const now = Date.now();
    const staleBefore = Date.now() - 2 * 60_000;
    const selected = [...commands].reverse().find((item) => {
      if (item.deviceId !== device.id) return false;
      const availableAtMs = item.availableAt ? new Date(item.availableAt).getTime() : 0;
      return (
        (item.status === "pending" && (!Number.isFinite(availableAtMs) || availableAtMs <= now)) ||
        (item.status === "delivered" && new Date(item.deliveredAt || 0).getTime() < staleBefore)
      );
    });
    if (!selected) return null;
    selected.status = "delivered";
    selected.deliveredAt = new Date().toISOString();
    await writeCommands(commands);
    return { ...selected };
  });
  if (!command) return null;
  const accounts = await readRegistry();
  const account = accounts.find((item) => item.id === command.accountId);
  if (!account) {
    await withStorageLock("commands", async () => {
      const commands = await readCommands();
      const selected = commands.find((item) => item.id === command.id);
      if (selected) {
        selected.status = "failed";
        selected.error = "账号已被删除";
        selected.completedAt = new Date().toISOString();
        await writeCommands(commands);
      }
    });
    return null;
  }
  return {
    id: command.id,
    type: "switch-account",
    accountId: account.id,
    accountEmail: account.email,
    defaultModel: defaultModelForAccount(account),
    authBase64: await accountAuthBase64(account.id, device.id),
  };
}

async function acknowledgeCommand(device, commandId, result) {
  const acknowledgement = await withStorageLock("commands", async () => {
    const commands = await readCommands();
    const selected = commands.find((item) => item.id === commandId && item.deviceId === device.id);
    if (!selected) throw httpError(404, "切换指令不存在");
    if (["complete", "failed"].includes(selected.status)) {
      return { command: { ...selected }, updateDevice: false };
    }
    if (selected.status === "superseded") {
      selected.acknowledgedAt = selected.acknowledgedAt || new Date().toISOString();
      selected.executionResult = result.ok ? "complete" : "failed";
      if (!result.ok && !selected.error) selected.error = String(result.error || "切换失败").slice(0, 500);
      await writeCommands(commands);
      return { command: { ...selected }, updateDevice: false };
    }
    selected.status = result.ok ? "complete" : "failed";
    selected.completedAt = new Date().toISOString();
    selected.acknowledgedAt = selected.completedAt;
    selected.error = result.ok ? null : String(result.error || "切换失败").slice(0, 500);
    await writeCommands(commands);
    return { command: { ...selected }, updateDevice: true };
  });

  const { command, updateDevice } = acknowledgement;
  if (!updateDevice) return command;

  await withStorageLock("devices", async () => {
    const devices = await readDevices();
    const index = devices.findIndex((item) => item.id === device.id);
    if (index >= 0) {
      devices[index].lastSeenAt = new Date().toISOString();
      devices[index].lastError = command.error;
      if (result.ok) {
        const accounts = await readRegistry();
        const account = accounts.find((item) => item.id === command.accountId);
        devices[index].activeAccountId = account?.id || command.accountId;
        devices[index].activeAccountEmail = account?.email || null;
      }
      await writeDevices(devices);
    }
  });
  return command;
}

async function serveDownload(request, response, filename) {
  const path = downloadFiles.get(filename);
  if (!path) throw httpError(404, "文件不存在");
  await stat(path);
  const content = await readFile(path);
  response.writeHead(200, {
    "Content-Type": [".sh", ".ps1"].includes(extname(filename)) ? "text/plain; charset=utf-8" : "application/octet-stream",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...corsHeaders(request),
  });
  response.end(content);
}

async function handle(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || `127.0.0.1:${port}`}`);

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      ...corsHeaders(request),
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Switcher-Version",
    });
    return response.end();
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    return json(request, response, 200, { ok: true, refreshing, lastRefreshAt, nextRefreshAt });
  }
  if (request.method === "GET" && url.pathname === "/api/session") {
    return json(request, response, isAdmin(request) ? 200 : 401, { authenticated: isAdmin(request) });
  }
  if (request.method === "POST" && url.pathname === "/api/session") {
    checkLoginRateLimit(request);
    const body = await readBody(request);
    if (!passwordMatches(String(body.password || ""))) throw httpError(401, "密码错误");
    clearLoginRateLimit(request);
    const secure = production || resolvePublicUrl(request).startsWith("https://");
    return json(request, response, 200, { authenticated: true }, {
      "Set-Cookie": `${sessionCookieName}=${encodeURIComponent(makeSession())}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${secure ? "; Secure" : ""}`,
    });
  }
  if (request.method === "DELETE" && url.pathname === "/api/session") {
    return json(request, response, 200, { authenticated: false }, {
      "Set-Cookie": `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
    });
  }

  const downloadMatch = url.pathname.match(/^\/downloads\/([^/]+)$/);
  if (request.method === "GET" && downloadMatch) return serveDownload(request, response, downloadMatch[1]);

  if (request.method === "POST" && url.pathname === "/api/device/register") {
    const body = await readBody(request);
    return json(request, response, 201, await registerDevice(body.code, body.name, body.installationId));
  }
  if (request.method === "GET" && url.pathname === "/api/device/ping") {
    const device = await authenticateDevice(request);
    return json(request, response, 200, {
      ok: true,
      deviceId: device.id,
      activeAccountId: device.activeAccountId ?? null,
    });
  }
  if (request.method === "POST" && url.pathname === "/api/device/credentials") {
    const device = await authenticateDevice(request);
    const body = await readBody(request);
    const accountId = String(body.accountId || "").trim();
    if (!/^[0-9a-f-]+$/i.test(accountId)) throw httpError(400, "账号编号无效");
    await saveDeviceAccountAuth(device, accountId, body.authBase64);
    return noContent(request, response);
  }
  if (request.method === "GET" && url.pathname === "/api/device/commands/next") {
    const device = await authenticateDevice(request);
    const command = await nextDeviceCommand(device);
    return command ? json(request, response, 200, command) : noContent(request, response);
  }
  const acknowledgeMatch = url.pathname.match(/^\/api\/device\/commands\/([0-9a-f-]+)\/ack$/i);
  if (request.method === "POST" && acknowledgeMatch) {
    const device = await authenticateDevice(request);
    await acknowledgeCommand(device, acknowledgeMatch[1], await readBody(request));
    return json(request, response, 200, { ok: true });
  }

  requireAdmin(request);

  if (request.method === "GET" && url.pathname === "/api/accounts") {
    const [accounts, settings] = await Promise.all([readRegistry(), readSettings()]);
    return json(request, response, 200, {
      accounts: accounts.map((account) => safeAccount(account, settings.activeAccountId)),
      refresh: { refreshing, lastRefreshAt, nextRefreshAt, intervalMs: refreshIntervalMs },
    });
  }
  if (request.method === "POST" && url.pathname === "/api/accounts/login") {
    return json(request, response, 201, await startLogin());
  }
  const loginMatch = url.pathname.match(/^\/api\/accounts\/login\/([0-9a-f-]+)$/i);
  if (request.method === "GET" && loginMatch) {
    const pending = pendingLogins.get(loginMatch[1]);
    if (!pending) throw httpError(404, "登录任务不存在");
    return json(request, response, 200, {
      status: pending.status,
      error: pending.error,
      userCode: pending.userCode || null,
    });
  }
  const refreshMatch = url.pathname.match(/^\/api\/accounts\/([0-9a-f-]+)\/refresh$/i);
  if (request.method === "POST" && refreshMatch) {
    const settings = await readSettings();
    const account = await refreshAccount(refreshMatch[1]);
    return json(request, response, 200, { account: safeAccount(account, settings.activeAccountId) });
  }
  if (request.method === "POST" && url.pathname === "/api/accounts/refresh-all") {
    void refreshAllAccounts();
    return json(request, response, 202, { ok: true });
  }
  const activateMatch = url.pathname.match(/^\/api\/accounts\/([0-9a-f-]+)\/activate$/i);
  if (request.method === "POST" && activateMatch) {
    const body = await readBody(request);
    const targetDeviceId = String(body.deviceId || "").trim() || null;
    const force = Boolean(targetDeviceId && body.force === true);
    const result = await enqueueSwitch(activateMatch[1], targetDeviceId, force);
    try {
      await refreshAccount(activateMatch[1]);
    } catch (error) {
      process.stderr.write(`切换时刷新 ${result.account.email} 失败：${error.message}\n`);
    }
    return json(request, response, 200, {
      ok: true,
      accountId: result.account.id,
      accountEmail: result.account.email,
      deviceCount: result.deviceCount,
      enqueuedCount: result.enqueuedCount,
      deduplicatedCount: result.deduplicatedCount,
      switchId: result.switchId,
      targeted: result.targeted,
    });
  }
  const accountMatch = url.pathname.match(/^\/api\/accounts\/([0-9a-f-]+)$/i);
  if (request.method === "PATCH" && accountMatch) {
    const body = await readBody(request);
    const note = String(body.note || "").trim().slice(0, 40);
    const account = await withStorageLock("accounts", async () => {
      const accounts = await readRegistry();
      const index = accounts.findIndex((item) => item.id === accountMatch[1]);
      if (index < 0) throw httpError(404, "账号不存在");
      accounts[index].note = note;
      await writeRegistry(accounts);
      return accounts[index];
    });
    const settings = await readSettings();
    return json(request, response, 200, { account: safeAccount(account, settings.activeAccountId) });
  }
  if (request.method === "DELETE" && accountMatch) {
    const accounts = await readRegistry();
    const next = accounts.filter((account) => account.id !== accountMatch[1]);
    if (next.length === accounts.length) throw httpError(404, "账号不存在");
    await writeRegistry(next);
    const settings = await readSettings();
    if (settings.activeAccountId === accountMatch[1]) await writeSettings({ activeAccountId: null });
    await rm(accountHome(accountMatch[1]), { recursive: true, force: true });
    for (const deviceDirectory of await readdir(deviceAuthRoot, { withFileTypes: true })) {
      if (deviceDirectory.isDirectory()) {
        await rm(join(deviceAuthRoot, deviceDirectory.name, accountMatch[1]), { recursive: true, force: true });
      }
    }
    return json(request, response, 200, { ok: true });
  }

  if (request.method === "GET" && url.pathname === "/api/devices") {
    const devices = await readDevices();
    return json(request, response, 200, { devices: devices.map(safeDevice) });
  }
  if (request.method === "GET" && url.pathname === "/api/switch-history") {
    return json(request, response, 200, { history: await safeSwitchHistory() });
  }
  if (request.method === "POST" && url.pathname === "/api/devices/pair") {
    const body = await readBody(request);
    const platform = body.platform === "windows" ? "windows" : "mac";
    for (const [code, pairing] of pairingCodes) if (pairing.expiresAt < Date.now()) pairingCodes.delete(code);
    const code = createPairingCode();
    pairingCodes.set(code, { platform, expiresAt: Date.now() + 10 * 60_000 });
    const baseUrl = resolvePublicUrl(request);
    const windowsInstallerUrl = `${baseUrl}/downloads/install-windows.ps1`;
    const windowsCommand = `$p = Join-Path $env:TEMP 'install-gpt-switcher.ps1'; Write-Host 'Downloading the Windows switcher...'; Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 ${powershellQuote(windowsInstallerUrl)} -OutFile $p; powershell.exe -NoProfile -ExecutionPolicy Bypass -File $p -ServerUrl ${powershellQuote(baseUrl)} -PairingCode ${powershellQuote(code)}; Remove-Item $p -Force -ErrorAction SilentlyContinue`;
    return json(request, response, 201, {
      code,
      platform,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      installCommand: platform === "windows"
        ? windowsCommand
        : `curl -fsSL ${shellQuote(`${baseUrl}/downloads/install-mac.sh`)} | bash -s -- ${shellQuote(baseUrl)} ${shellQuote(code)}`,
    });
  }
  const repairDeviceMatch = url.pathname.match(/^\/api\/devices\/([0-9a-f-]+)\/repair$/i);
  if (request.method === "POST" && repairDeviceMatch) {
    const devices = await readDevices();
    const device = devices.find((item) => item.id === repairDeviceMatch[1]);
    if (!device) throw httpError(404, "设备不存在");
    const baseUrl = resolvePublicUrl(request);
    if (device.platform === "windows") {
      const installerUrl = `${baseUrl}/downloads/install-windows.ps1`;
      const command = `$p = Join-Path $env:TEMP 'repair-gpt-switcher.ps1'; Write-Host 'Downloading the Windows switcher...'; Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 ${powershellQuote(installerUrl)} -OutFile $p; powershell.exe -NoProfile -ExecutionPolicy Bypass -File $p -ServerUrl ${powershellQuote(baseUrl)} -Repair; Remove-Item $p -Force -ErrorAction SilentlyContinue`;
      return json(request, response, 200, { command, platform: "windows" });
    }
    const command = `curl -fsSL ${shellQuote(`${baseUrl}/downloads/install-mac.sh`)} | bash -s -- ${shellQuote(baseUrl)}`;
    return json(request, response, 200, { command, platform: "mac" });
  }
  const deviceMatch = url.pathname.match(/^\/api\/devices\/([0-9a-f-]+)$/i);
  if (request.method === "PATCH" && deviceMatch) {
    const body = await readBody(request);
    const customName = String(body.name || "").trim().slice(0, 80);
    if (!customName) throw httpError(400, "设备名称不能为空");
    const device = await withStorageLock("devices", async () => {
      const devices = await readDevices();
      const index = devices.findIndex((item) => item.id === deviceMatch[1]);
      if (index < 0) throw httpError(404, "设备不存在");
      devices[index].customName = customName;
      await writeDevices(devices);
      return devices[index];
    });
    return json(request, response, 200, { device: safeDevice(device) });
  }
  if (request.method === "DELETE" && deviceMatch) {
    const devices = await readDevices();
    const next = devices.filter((device) => device.id !== deviceMatch[1]);
    if (next.length === devices.length) throw httpError(404, "设备不存在");
    await writeDevices(next);
    const commands = (await readCommands()).filter((command) => command.deviceId !== deviceMatch[1]);
    await writeCommands(commands);
    await rm(join(deviceAuthRoot, deviceMatch[1]), { recursive: true, force: true });
    return json(request, response, 200, { ok: true });
  }

  throw httpError(404, "接口不存在");
}

const server = createServer((request, response) => {
  void handle(request, response).catch((error) => {
    if (response.headersSent) return response.end();
    json(request, response, error.statusCode || 500, { error: error.message || "账号服务错误" });
  });
});
await migrateLegacyData();
await recoverAuthenticatedAccounts();
server.listen(port, host, () => {
  process.stdout.write(`GPT 账号服务：http://${host}:${port}\n`);
  setTimeout(() => void refreshAllAccounts(), 10_000).unref();
});

const refreshTimer = setInterval(() => void refreshAllAccounts(), refreshIntervalMs);
refreshTimer.unref();
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, pending] of pendingLogins) {
    if (now - pending.createdAt > 30 * 60_000) {
      pending.client.close();
      pendingLogins.delete(id);
    }
  }
}, 10 * 60_000);
cleanupTimer.unref();

function shutdown() {
  clearInterval(refreshTimer);
  clearInterval(cleanupTimer);
  for (const pending of pendingLogins.values()) pending.client.close();
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
