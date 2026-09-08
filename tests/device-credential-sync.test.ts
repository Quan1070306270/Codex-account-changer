import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not expose a TCP port");
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function waitForServer(url) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch {
      // The server may not be listening during its short startup window.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("test account server did not start");
}

test("device credentials stay isolated and repeated switches are deduplicated", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "gpt-device-auth-test-"));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const accountId = "11111111-1111-4111-8111-111111111111";
  const secondAccountId = "55555555-5555-4555-8555-555555555555";
  const openAiAccountId = "account-openai-test";
  const secondOpenAiAccountId = "account-openai-second";
  const deviceId = "22222222-2222-4222-8222-222222222222";
  const deviceToken = "device-test-token";
  const globalAuth = { auth_mode: "chatgpt", last_refresh: "2026-01-01T00:00:00.000Z", tokens: { account_id: openAiAccountId, refresh_token: "global-refresh" } };
  const deviceAuth = { auth_mode: "chatgpt", last_refresh: "2026-01-02T00:00:00.000Z", tokens: { account_id: openAiAccountId, refresh_token: "device-refresh" } };
  const secondGlobalAuth = { auth_mode: "chatgpt", tokens: { account_id: secondOpenAiAccountId, refresh_token: "second-refresh" } };
  await mkdir(join(dataRoot, "accounts", accountId), { recursive: true });
  await mkdir(join(dataRoot, "accounts", secondAccountId), { recursive: true });
  await writeJson(join(dataRoot, "accounts.json"), [
    { id: accountId, email: "test@example.com", note: "test", planType: "plus" },
    { id: secondAccountId, email: "second@example.com", note: "second", planType: "plus" },
  ]);
  await writeJson(join(dataRoot, "accounts", accountId, "auth.json"), globalAuth);
  await writeJson(join(dataRoot, "accounts", secondAccountId, "auth.json"), secondGlobalAuth);
  await writeJson(join(dataRoot, "devices.json"), [{
    id: deviceId,
    name: "test-device",
    platform: "mac",
    tokenHash: createHash("sha256").update(deviceToken).digest("hex"),
    activeAccountId: null,
    activeAccountEmail: null,
    createdAt: new Date().toISOString(),
  }]);
  await writeJson(join(dataRoot, "commands.json"), [{
    id: "33333333-3333-4333-8333-333333333333",
    switchId: "44444444-4444-4444-8444-444444444444",
    deviceId,
    accountId,
    status: "pending",
    createdAt: new Date().toISOString(),
    deliveredAt: null,
    completedAt: null,
    error: null,
  }]);

  const child = spawn(process.execPath, ["--experimental-strip-types", "local/server.ts"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: "production",
      ACCOUNT_MANAGER_DATA_DIR: dataRoot,
      ACCOUNT_MANAGER_HOST: "127.0.0.1",
      ACCOUNT_MANAGER_PORT: String(port),
      ADMIN_PASSWORD: "test-password",
      SESSION_SECRET: "test-session-secret-with-more-than-24-characters",
      PUBLIC_BASE_URL: url,
      USAGE_REFRESH_INTERVAL_MS: "3600000",
      TIBO_MONITOR_INTERVAL_MS: "3600000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await rm(dataRoot, { recursive: true, force: true });
  });
  await waitForServer(url);

  const collectorResponse = await fetch(`${url}/downloads/usage-collector.mjs`);
  assert.equal(collectorResponse.status, 200);
  const collectorPath = join(dataRoot, "downloaded-usage-collector.mjs");
  await writeFile(collectorPath, await collectorResponse.text());
  assert.equal(spawnSync(process.execPath, ["--check", collectorPath]).status, 0);

  const deviceHeaders = {
    Authorization: `Bearer ${deviceToken}`,
    "Content-Type": "application/json",
    "X-Switcher-Version": "1.5.0",
    "X-Codex-Active-Account": openAiAccountId,
  };
  const synced = await fetch(`${url}/api/device/credentials`, {
    method: "POST",
    headers: deviceHeaders,
    body: JSON.stringify({ accountId, authBase64: Buffer.from(JSON.stringify(deviceAuth)).toString("base64") }),
  });
  assert.equal(synced.status, 204);
  assert.deepEqual(JSON.parse(await readFile(join(dataRoot, "accounts", accountId, "auth.json"), "utf8")), deviceAuth);

  const next = await fetch(`${url}/api/device/commands/next`, { headers: deviceHeaders });
  assert.equal(next.status, 200);
  const command = await next.json();
  assert.deepEqual(JSON.parse(Buffer.from(command.authBase64, "base64").toString("utf8")), deviceAuth);

  const acknowledged = await fetch(`${url}/api/device/commands/${command.id}/ack`, {
    method: "POST",
    headers: deviceHeaders,
    body: JSON.stringify({ ok: true }),
  });
  assert.equal(acknowledged.status, 200);
  const reportedSignedIn = JSON.parse(await readFile(join(dataRoot, "devices.json"), "utf8"));
  assert.equal(reportedSignedIn[0].activeAccountId, accountId);
  assert.equal(reportedSignedIn[0].codexAuthState, "signed-in");

  const session = await fetch(`${url}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "test-password" }),
  });
  assert.equal(session.status, 200);
  const cookie = session.headers.get("set-cookie").split(";")[0];
  const repeated = await fetch(`${url}/api/accounts/${accountId}/activate`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId }),
  });
  const repeatedBody = await repeated.json();
  assert.equal(repeated.status, 200);
  assert.equal(repeatedBody.enqueuedCount, 0);
  assert.equal(repeatedBody.deduplicatedCount, 1);

  const commands = JSON.parse(await readFile(join(dataRoot, "commands.json"), "utf8"));
  assert.equal(commands.length, 1);

  const selectSecond = await fetch(`${url}/api/accounts/${secondAccountId}/activate`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId }),
  });
  assert.equal(selectSecond.status, 200);
  assert.equal((await selectSecond.json()).enqueuedCount, 1);

  const beforeCoalescingWindow = await fetch(`${url}/api/device/commands/next`, { headers: deviceHeaders });
  assert.equal(beforeCoalescingWindow.status, 204);
  await new Promise((resolve) => setTimeout(resolve, 1_650));

  const secondNext = await fetch(`${url}/api/device/commands/next`, { headers: deviceHeaders });
  assert.equal(secondNext.status, 200);
  const secondCommand = await secondNext.json();
  assert.equal(secondCommand.accountId, secondAccountId);

  const changeMind = await fetch(`${url}/api/accounts/${accountId}/activate`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId }),
  });
  assert.equal(changeMind.status, 200);
  assert.equal((await changeMind.json()).enqueuedCount, 1);

  const staleAck = await fetch(`${url}/api/device/commands/${secondCommand.id}/ack`, {
    method: "POST",
    headers: deviceHeaders,
    body: JSON.stringify({ ok: true }),
  });
  assert.equal(staleAck.status, 200);
  const afterStaleAck = JSON.parse(await readFile(join(dataRoot, "commands.json"), "utf8"));
  assert.equal(afterStaleAck.find((item) => item.id === secondCommand.id).status, "superseded");
  const afterStaleDevice = JSON.parse(await readFile(join(dataRoot, "devices.json"), "utf8"));
  assert.equal(afterStaleDevice[0].activeAccountId, accountId);

  const stillCoalescing = await fetch(`${url}/api/device/commands/next`, { headers: deviceHeaders });
  assert.equal(stillCoalescing.status, 204);
  await new Promise((resolve) => setTimeout(resolve, 1_650));
  const finalNext = await fetch(`${url}/api/device/commands/next`, { headers: deviceHeaders });
  assert.equal(finalNext.status, 200);
  const finalCommand = await finalNext.json();
  assert.equal(finalCommand.accountId, accountId);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const finalAck = await fetch(`${url}/api/device/commands/${finalCommand.id}/ack`, {
      method: "POST",
      headers: deviceHeaders,
      body: JSON.stringify({ ok: true }),
    });
    assert.equal(finalAck.status, 200);
  }
  const finalCommands = JSON.parse(await readFile(join(dataRoot, "commands.json"), "utf8"));
  assert.equal(finalCommands.find((item) => item.id === finalCommand.id).status, "complete");

  const forcedRetry = await fetch(`${url}/api/accounts/${accountId}/activate`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId, force: true }),
  });
  assert.equal(forcedRetry.status, 200);
  assert.equal((await forcedRetry.json()).enqueuedCount, 1);

  const duplicateForcedRetry = await fetch(`${url}/api/accounts/${accountId}/activate`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId, force: true }),
  });
  assert.equal(duplicateForcedRetry.status, 200);
  const duplicateForcedBody = await duplicateForcedRetry.json();
  assert.equal(duplicateForcedBody.enqueuedCount, 0);
  assert.equal(duplicateForcedBody.deduplicatedCount, 1);

  const refreshedGlobalAuth = { ...globalAuth, last_refresh: "2026-01-03T00:00:00.000Z", tokens: { ...globalAuth.tokens, refresh_token: "new-global-refresh" } };
  await writeJson(join(dataRoot, "accounts", accountId, "auth.json"), refreshedGlobalAuth);
  await new Promise((resolve) => setTimeout(resolve, 1_650));
  const freshCredentialCommand = await fetch(`${url}/api/device/commands/next`, { headers: deviceHeaders });
  assert.equal(freshCredentialCommand.status, 200);
  const freshCredentialBody = await freshCredentialCommand.json();
  assert.deepEqual(JSON.parse(Buffer.from(freshCredentialBody.authBase64, "base64").toString("utf8")), refreshedGlobalAuth);
  const freshCredentialAck = await fetch(`${url}/api/device/commands/${freshCredentialBody.id}/ack`, {
    method: "POST",
    headers: deviceHeaders,
    body: JSON.stringify({ ok: true }),
  });
  assert.equal(freshCredentialAck.status, 200);

  const otherDeviceAuth = { ...globalAuth, last_refresh: "2026-01-04T00:00:00.000Z", tokens: { ...globalAuth.tokens, refresh_token: "other-device-refresh" } };
  await mkdir(join(dataRoot, "device-auth", "99999999-9999-4999-8999-999999999999", accountId), { recursive: true });
  await writeJson(join(dataRoot, "device-auth", "99999999-9999-4999-8999-999999999999", accountId, "auth.json"), otherDeviceAuth);
  const crossDeviceRetry = await fetch(`${url}/api/accounts/${accountId}/activate`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId, force: true }),
  });
  assert.equal(crossDeviceRetry.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 1_650));
  const crossDeviceCommand = await fetch(`${url}/api/device/commands/next`, { headers: deviceHeaders });
  assert.equal(crossDeviceCommand.status, 200);
  const crossDeviceBody = await crossDeviceCommand.json();
  assert.deepEqual(JSON.parse(Buffer.from(crossDeviceBody.authBase64, "base64").toString("utf8")), otherDeviceAuth);
  assert.deepEqual(JSON.parse(await readFile(join(dataRoot, "accounts", accountId, "auth.json"), "utf8")), otherDeviceAuth);

  const signedOutHeaders = { ...deviceHeaders, "X-Codex-Active-Account": "signed-out" };
  const signedOutPing = await fetch(`${url}/api/device/commands/next`, { headers: signedOutHeaders });
  assert.equal(signedOutPing.status, 204);
  const reportedSignedOut = JSON.parse(await readFile(join(dataRoot, "devices.json"), "utf8"));
  assert.equal(reportedSignedOut[0].activeAccountId, null);
  assert.equal(reportedSignedOut[0].codexAuthState, "signed-out");
});
