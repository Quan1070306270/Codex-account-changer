import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

type JsonRpcMessage = {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
};

type CodexClientOptions = {
  codexHome: string;
  codexBin?: string;
  disableHooks?: boolean;
  cwd?: string;
};

type NotificationListener = (method: string, params: any) => void;

const DEFAULT_CODEX_BIN = process.platform === "darwin"
  ? "/Applications/ChatGPT.app/Contents/Resources/codex"
  : "codex";

export class CodexClient {
  codexHome: string;
  codexBin: string;
  disableHooks: boolean;
  cwd?: string;
  child: ChildProcessWithoutNullStreams | null;
  pending: Map<string, PendingRequest>;
  listeners: Set<NotificationListener>;
  nextId: number;
  stderr: string;

  constructor({ codexHome, codexBin = process.env.CODEX_BIN || DEFAULT_CODEX_BIN, disableHooks = true, cwd }: CodexClientOptions) {
    this.codexHome = codexHome;
    this.codexBin = codexBin;
    this.disableHooks = disableHooks;
    this.cwd = cwd;
    this.child = null;
    this.pending = new Map();
    this.listeners = new Set();
    this.nextId = 1;
    this.stderr = "";
  }

  async start() {
    if (this.child) return;

    const args = ["app-server", "--stdio"];
    if (this.disableHooks) args.push("--disable", "hooks");
    this.child = spawn(this.codexBin, args, {
      cwd: this.cwd,
      env: { ...process.env, CODEX_HOME: this.codexHome },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-6000);
    });
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("exit", (code) => {
      if (code !== 0) {
        this.rejectAll(new Error(this.stderr.trim() || `Codex 服务已退出（${code ?? "unknown"}）`));
      }
      this.child = null;
    });

    await this.request("initialize", {
      clientInfo: {
        name: "gpt-account-manager",
        title: "GPT Account Manager",
        version: "0.2.0",
      },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");
  }

  handleLine(line: string) {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (Object.hasOwn(message, "id") && !message.method) {
      const entry = this.pending.get(String(message.id));
      if (!entry) return;
      this.pending.delete(String(message.id));
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message || "Codex 请求失败"));
      else entry.resolve(message.result);
      return;
    }

    if (message.method) {
      if (Object.hasOwn(message, "id")) this.handleServerRequest(message);
      for (const listener of this.listeners) listener(message.method, message.params);
    }
  }

  handleServerRequest(message: JsonRpcMessage) {
    const method = message.method;
    let result;

    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      result = { decision: "denied" };
    } else if (method === "item/permissions/requestApproval") {
      result = { permissions: {} };
    } else if (method === "item/tool/requestUserInput" || method === "tool/requestUserInput") {
      result = { answers: {} };
    } else if (method === "mcpServer/elicitation/request") {
      result = { action: "decline" };
    } else {
      this.child?.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: `不支持的服务请求：${method}` } })}\n`);
      return;
    }

    this.child?.stdin.write(`${JSON.stringify({ id: message.id, result })}\n`);
  }

  onNotification(listener: NotificationListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  request<T = any>(method: string, params: unknown = null, timeoutMs = 30_000): Promise<T> {
    if (!this.child?.stdin.writable) return Promise.reject(new Error("Codex 服务尚未启动"));
    const id = String(this.nextId++);

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 请求超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  notify(method: string, params?: unknown) {
    if (!this.child?.stdin.writable) return;
    const message = params === undefined ? { method } : { method, params };
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  rejectAll(error: Error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  close() {
    if (!this.child) return;
    this.child.kill("SIGTERM");
    this.child = null;
  }
}
